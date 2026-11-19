import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import { CHAT_HISTORY_LIMIT, CHAT_MAX_LENGTH } from '../chat-rules.js';

let server;
let testDir;
let roomsFile;
const port = 20000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;

before(async () => {
  testDir = await mkdtemp(joinPath(tmpdir(), 'river-room-chat-'));
  roomsFile = joinPath(testDir, 'rooms.json');
  await startServer();
});

async function startServer() {
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ROOMS_FILE: roomsFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`Server did not start: ${output}`)), 5000);
    server.once('error', reject);
    server.once('exit', code => { clearTimeout(timeout); reject(Error(`Server exited (${code}): ${output}`)); });
    server.stderr.on('data', chunk => { output += chunk; });
    server.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('本机:')) { clearTimeout(timeout); resolve(); }
    });
  });
}

after(async () => {
  await stopServer();
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

async function stopServer() {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
  }
}

async function api(path = '', { token, body } = {}) {
  const response = await fetch(`${origin}/api/rooms${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, ...await response.json() };
}

async function room(name = '房主') {
  const result = await api('', { body: { name, seatCount: 2, aiLevel: 'normal', turnSeconds: 300 } });
  assert.equal(result.status, 200);
  return { ...result, code: result.state.code };
}

async function join(code, name, spectate = false) {
  const result = await api(`/${code}/join`, { body: { name, spectate } });
  assert.equal(result.status, 200);
  return result;
}

const chat = (member, code, text, requestId = randomUUID(), extra = {}) => api(`/${code}`, {
  token: member.token, body: { op: 'chat', text, requestId, ...extra }
});
const operation = (member, code, op, extra = {}) => api(`/${code}`, { token: member.token, body: { op, requestId: randomUUID(), ...extra } });

test('room members exchange plain text with authenticated names and viewer-specific ownership', async () => {
  const host = await room();
  const guest = await join(host.code, '小周');
  const watcher = await join(host.code, '观众', true);
  const sent = await chat(host, host.code, '  大家\n好！<b>一起玩</b>  ', undefined, { name: '伪造昵称', spectator: true });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.chat.messages.map(({ text, name, own, spectator }) => ({ text, name, own, spectator })), [
    { text: '大家 好！<b>一起玩</b>', name: '房主', own: true, spectator: false }
  ]);
  await chat(guest, host.code, '你好 🃏');
  const watching = await chat(watcher, host.code, '我来观战');
  assert.equal(watching.status, 200);
  assert.equal(watching.chat.messages.at(-1).spectator, true);
  assert.equal(watching.chat.messages.at(-1).own, true);
  assert.equal(watching.chat.messages[0].own, false);
  const polled = await api(`/${host.code}`, { token: guest.token });
  assert.deepEqual(polled.state.chat.messages.map(message => message.own), [false, true, false]);
  const payload = JSON.stringify(polled.state.chat);
  for (const member of [host, guest, watcher]) assert.ok(!payload.includes(member.token));
  assert.ok(!payload.includes('senderId'));
  assert.equal((await operation(watcher, host.code, 'start')).status, 403);
});

test('chat is room-scoped, requires membership, and rejects removed members', async () => {
  const first = await room();
  const second = await room();
  assert.equal((await chat({}, first.code, '匿名')).status, 401);
  assert.equal((await chat(second, first.code, '串房')).status, 401);
  await chat(first, first.code, '仅本房间可见');
  const other = await api(`/${second.code}`, { token: second.token });
  assert.equal(other.state.chat.messages.length, 0);
  const guest = await join(first.code, '离席者');
  await operation(guest, first.code, 'leave');
  assert.equal((await chat(guest, first.code, '离席后')).status, 401);
});

test('empty, invalid and oversized messages are rejected; the exact limit is accepted', async () => {
  const host = await room();
  for (const text of ['', ' \n\t\u0000 ', null, {}, 42, 'a'.repeat(CHAT_MAX_LENGTH + 1)]) {
    assert.equal((await chat(host, host.code, text)).status, 400);
  }
  assert.equal((await chat(host, host.code, '有效', '')).status, 400);
  assert.equal((await chat(host, host.code, '有效', 'a'.repeat(101))).status, 400);
  const result = await chat(host, host.code, '字'.repeat(CHAT_MAX_LENGTH));
  assert.equal(result.status, 200);
  assert.equal(result.chat.messages[0].text.length, CHAT_MAX_LENGTH);
});

test('cooldown limits new messages while retries are idempotent, including after a table reset', async () => {
  const host = await room();
  const id = randomUUID();
  const first = await chat(host, host.code, '一条消息', id);
  assert.equal((await chat(host, host.code, '一条消息', id)).chat.version, first.chat.version);
  assert.equal((await chat(host, host.code, '连续刷屏')).status, 429);
  const reset = await operation(host, host.code, 'reset');
  assert.equal(reset.state.chat.messages.length, 1);
  assert.equal((await chat(host, host.code, '一条消息', id)).chat.messages.length, 1);
  await delay(1050);
  assert.equal((await chat(host, host.code, '稍后发送')).status, 200);
});

test('chat-only polling and sends preserve game version, turn identity, deadline, events and chips', async () => {
  const host = await room();
  const guest = await join(host.code, '对手');
  const before = (await operation(host, host.code, 'start')).state;
  assert.equal(before.phase, 'playing');
  await delay(130);
  await chat(guest, host.code, '轮到你了');
  const change = await api(`/${host.code}?since=${before.version}&chatSince=0`, { token: host.token });
  assert.equal(change.unchanged, true);
  assert.equal(change.state, undefined);
  assert.equal(change.chat.messages.at(-1).text, '轮到你了');
  const idle = await api(`/${host.code}?since=${before.version}&chatSince=${change.chat.version}`, { token: host.token });
  assert.deepEqual(idle, { status: 200, unchanged: true });
  const current = (await api(`/${host.code}`, { token: host.token })).state;
  assert.equal(current.version, before.version);
  assert.equal(current.turnKey, before.turnKey);
  assert.ok(current.turnRemaining <= before.turnRemaining - 80);
  assert.deepEqual(current.events, before.events);
  assert.deepEqual(current.players.map(player => player.stack), before.players.map(player => player.stack));
});

test('away players can chat without reclaiming their seats', async () => {
  const host = await room();
  await operation(host, host.code, 'away');
  assert.equal((await chat(host, host.code, '稍等我一下')).status, 200);
  const state = (await api(`/${host.code}`, { token: host.token })).state;
  assert.equal(state.away, true);
});

test('history is bounded, ordered and available to late joiners', async () => {
  const host = await room();
  await chat(host, host.code, '最早的消息');
  // Distinct authenticated senders exercise the bound without bypassing rate limits.
  for (let index = 0; index < CHAT_HISTORY_LIMIT; index++) {
    const watcher = await join(host.code, `观众${index}`, true);
    assert.equal((await chat(watcher, host.code, `消息${index}`)).status, 200);
  }
  const late = await join(host.code, '后来者');
  const { messages, version } = late.state.chat;
  assert.equal(messages.length, CHAT_HISTORY_LIMIT);
  assert.equal(version, CHAT_HISTORY_LIMIT + 1);
  assert.equal(messages[0].id, 2);
  assert.equal(messages.at(-1).text, `消息${CHAT_HISTORY_LIMIT - 1}`);
  assert.ok(messages.every(message => !message.own));
});

test('seat swaps preserve the chat identity of each authenticated player', async () => {
  const host = await room();
  const guest = await join(host.code, '换位玩家');
  await chat(host, host.code, '换位前发言');
  assert.equal((await operation(host, host.code, 'swapSeats', { a: 0, b: 1 })).status, 200);
  await chat(guest, host.code, '换位后发言');
  const state = (await api(`/${host.code}`, { token: host.token })).state;
  assert.equal(state.players[0].absoluteSeat, 1);
  assert.deepEqual(state.chat.messages.map(message => message.own), [true, false]);
});

test('room restart restores history, ownership, sequence and retry deduplication', async () => {
  const host = await room();
  const watcher = await join(host.code, '恢复后的观众', true);
  const requestId = randomUUID();
  await chat(host, host.code, '重启前的消息', requestId);
  await chat(watcher, host.code, '观战消息');
  await stopServer();
  await startServer();
  const state = (await api(`/${host.code}`, { token: host.token })).state;
  assert.equal(state.chat.version, 2);
  assert.deepEqual(state.chat.messages.map(message => message.own), [true, false]);
  assert.equal((await chat(host, host.code, '重启前的消息', requestId)).chat.messages.length, 2);
  await delay(1050);
  const next = await chat(watcher, host.code, '重启后继续聊');
  assert.equal(next.status, 200);
  assert.equal(next.chat.messages.at(-1).id, 3);
  assert.equal(next.chat.messages.at(-1).own, true);
});

test('rooms saved before the chat feature receive independent player and spectator identities', async () => {
  const host = await room();
  const watcher = await join(host.code, '旧房间观众', true);
  await stopServer();
  const saved = JSON.parse(await readFile(roomsFile, 'utf8'));
  const legacy = saved.find(item => item.code === host.code);
  delete legacy.chatVersion;
  delete legacy.chatMessages;
  delete legacy.chatRecent;
  for (const [, member] of [...legacy.humans, ...legacy.spectators]) delete member.chatId;
  await writeFile(roomsFile, JSON.stringify(saved));
  await startServer();
  assert.equal((await api(`/${host.code}`, { token: host.token })).state.chat.messages.length, 0);
  await chat(host, host.code, '旧房间玩家');
  const result = await chat(watcher, host.code, '旧房间观众');
  assert.equal(result.status, 200);
  assert.deepEqual(result.chat.messages.map(message => message.own), [false, true]);
});
