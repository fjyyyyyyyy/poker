#!/usr/bin/env node
/**
 * 一键公网联机助手
 *
 *   npm run share              # 启动、申请地址并自动打开建房页
 *   npm run share -- --no-open # 只启动并打印公网地址
 *
 * 做三件事：
 *   1. 如果本机 8787 端口还没有游戏服务，先帮你启动 server.mjs
 *   2. 用 Cloudflare Quick Tunnel 把本地服务映射成一个公网 https 地址
 *   3. 打印公网地址，发给不在同一 Wi-Fi 的朋友
 *
 * 这个地址是临时的：关闭本程序（或电脑休眠/断网）后失效，重新运行会换一个新地址。
 * 想要固定地址，请把项目部署到云服务器，见 README。
 *
 * 环境变量：
 *   PORT=8787                 本地端口
 *   CLOUDFLARED=/path/to/bin  指定 cloudflared 可执行文件
 *   SHARE_TIMEOUT_MS=180000  等待公网地址的最长时间
 */
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const OPEN = !process.argv.includes('--no-open');
const LOCAL = `http://127.0.0.1:${PORT}`;
const INFO = `${LOCAL}/api/server-info`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WAIT_MS = Number(process.env.SHARE_TIMEOUT_MS) || 180000;
const startedAt = Date.now();

let serverChild = null;
let tunnelChild = null;
let closing = false;
let tunnelTail = '';

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
}

function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  killTree(tunnelChild);
  if (serverChild) killTree(serverChild);
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => {
  console.log('\n正在关闭公网隧道…');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
// 关闭 Terminal 窗口时 macOS 会发 SIGHUP，顺手把子进程一起收掉。
process.on('SIGHUP', () => {
  console.log('\n窗口已关闭，正在停止联机服务…');
  shutdown(0);
});

async function serverIsUp() {
  try {
    const response = await fetch(INFO, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function hasCommand(name) {
  if (name.includes('/') || name.includes('\\')) {
    try {
      return spawnSync(name, ['--version'], { stdio: 'ignore', timeout: 4000 }).error?.code !== 'ENOENT';
    } catch {
      return false;
    }
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [name], { stdio: 'ignore' }).status === 0;
}

function openExternal(url) {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* 打不开浏览器也不影响服务 */ }
}

async function openWhenReady(url) {
  // 新域名刚分配时 Cloudflare 可能还在预热，先探活几次再打开，避免首屏 502。
  for (let attempt = 0; attempt < 6; attempt++) {
    if (closing) return;
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
      if (response.status < 500) break;
    } catch { /* 继续重试 */ }
    await sleep(1200);
  }
  if (!closing) {
    console.log('  正在打开浏览器…');
    openExternal(url);
  }
}

function printInstallHelp() {
  console.error('');
  console.error('  没有找到 cloudflared，也没有可用的 npx。');
  console.error('  任选一种方式安装后再运行 npm run share：');
  console.error('');
  console.error('    macOS:   brew install cloudflared');
  console.error('    Windows: winget install --id Cloudflare.cloudflared');
  console.error('    Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  console.error('');
  console.error('  也可以把项目部署到云服务器，获得固定地址，见 README。');
  console.error('');
}

async function startServerIfNeeded() {
  if (await serverIsUp()) {
    console.log(`  检测到 ${LOCAL} 已在运行，直接建立公网隧道。`);
    return true;
  }
  console.log(`  启动游戏服务 ${LOCAL} …`);
  serverChild = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
    detached: process.platform !== 'win32'
  });
  for (let i = 0; i < 80; i++) {
    if (await serverIsUp()) {
      serverChild.on('exit', code => {
        if (closing) return;
        console.error(`  游戏服务意外退出（code ${code}）。`);
        shutdown(1);
      });
      return true;
    }
    if (serverChild.exitCode !== null) return false;
    await sleep(250);
  }
  return false;
}

function isExecutable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function cachedCloudflared() {
  const home = homedir();
  const names = process.platform === 'win32' ? ['cloudflared.exe'] : ['cloudflared'];
  const direct = [
    process.env.CLOUDFLARED,
    ...names.map(name => join(ROOT, 'bin', name)),
    ...names.map(name => join(home, '.cache', 'river-room', name))
  ].filter(Boolean);
  for (const path of direct) if (isExecutable(path)) return path;
  // npx already downloaded cloudflared once; reuse that binary instead of resolving npm on every run.
  const npxRoot = join(home, '.npm', '_npx');
  if (existsSync(npxRoot)) {
    try {
      for (const entry of readdirSync(npxRoot)) {
        for (const name of names) {
          const path = join(npxRoot, entry, 'node_modules', 'cloudflared', 'bin', name);
          if (isExecutable(path)) return path;
        }
      }
    } catch { /* fall back to npx */ }
  }
  return '';
}

function tunnelCommand() {
  const cached = cachedCloudflared();
  if (cached) {
    console.log('  使用已缓存的 cloudflared，跳过 npx 下载。');
    return { command: cached, args: ['tunnel', '--url', LOCAL, '--no-autoupdate'] };
  }
  const custom = process.env.CLOUDFLARED;
  if (custom && hasCommand(custom)) {
    return { command: custom, args: ['tunnel', '--url', LOCAL, '--no-autoupdate'] };
  }
  if (hasCommand('cloudflared')) {
    return { command: 'cloudflared', args: ['tunnel', '--url', LOCAL, '--no-autoupdate'] };
  }
  if (hasCommand('npx')) {
    console.log('  没有找到 cloudflared，改用 npx 自动下载（首次运行会慢一点）…');
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['--yes', 'cloudflared@0.7.3', 'tunnel', '--url', LOCAL, '--no-autoupdate'],
      viaNpx: true
    };
  }
  return null;
}

async function main() {
  console.log('');
  console.log('  River Room · 公网联机助手');
  console.log('  ────────────────────────────────────────────');

  const tunnel = tunnelCommand();
  if (!tunnel) {
    printInstallHelp();
    shutdown(1);
    return;
  }

  if (!(await startServerIfNeeded())) {
    console.error(`  游戏服务没能启动，请检查 ${PORT} 端口是否被占用。`);
    console.error(`  换端口：PORT=8788 npm run share`);
    shutdown(1);
    return;
  }

  console.log('  正在向 Cloudflare 申请公网地址…');
  if (tunnel.viaNpx) console.log('  首次运行需要下载 cloudflared，通常 20–90 秒；下载后再次运行通常几秒即可。');
  else console.log('  已缓存客户端时通常 3–10 秒。');
  tunnelChild = spawn(tunnel.command, tunnel.args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  tunnelChild.on('exit', code => {
    if (closing) return;
    console.error(`\n  公网隧道已断开（code ${code}）。`);
    if (tunnelTail) console.error('  最后输出：\n' + tunnelTail.split('\n').slice(-6).map(line => '    ' + line).join('\n'));
    shutdown(1);
  });
  tunnelChild.on('error', error => {
    console.error('\n  无法启动 cloudflared：' + error.message);
    printInstallHelp();
    shutdown(1);
  });

  let output = '';
  let announced = false;
  let progress = null;
  const collect = chunk => {
    const text = chunk.toString();
    output = (output + text).slice(-8192);
    tunnelTail = output;
    if (announced) return;
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (!match) return;
    announced = true;
    clearInterval(progress);
    console.log('');
    console.log('  ────────────────────────────────────────────');
    console.log('  公网地址：' + match[0] + `（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）`);
    console.log('  ────────────────────────────────────────────');
    console.log('');
    if (OPEN) console.log('  正在自动打开建房页；若没有打开，请手动访问：' + match[0] + '/#host=1');
    else console.log('  打开下面地址建房：' + match[0] + '/#host=1');
    console.log('  建房后点「房间」即可看到二维码；手机扫码，或把邀请链接发给朋友即可加入。');
    console.log('');
    console.log('  这个窗口需要一直开着；关闭、休眠或断网后链接失效。');
    console.log('  想给朋友一个固定地址，请部署到云服务器（见 README）。');
    console.log('');
    if (OPEN) openWhenReady(match[0] + '/#host=1').catch(() => {});
  };
  tunnelChild.stdout.on('data', collect);
  tunnelChild.stderr.on('data', collect);

  progress = setInterval(() => {
    if (announced || closing) return;
    console.log('  仍在等待公网地址…（首次下载 cloudflared 时可能需要 1–3 分钟）');
  }, 15000);
  setTimeout(() => {
    clearInterval(progress);
    if (announced || closing) return;
    console.error(`\n  等了 ${Math.round(WAIT_MS / 1000)} 秒还没拿到公网地址，可能是网络无法连接 Cloudflare。`);
    if (tunnelTail) console.error(tunnelTail.split('\n').slice(-8).map(line => '    ' + line).join('\n'));
    console.error('  可以试着重跑一次；仍失败就安装 cloudflared，或改用云服务器部署（见 README）。');
    shutdown(1);
  }, WAIT_MS);
}

main().catch(error => {
  console.error(error);
  shutdown(1);
});
