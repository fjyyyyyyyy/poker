#!/usr/bin/env node
/**
 * River Room 联机服务
 *
 * 同一份目录既可以继续静态托管（单人练习），也可以用它开一场联网牌局：
 *   node server.mjs            # 默认 0.0.0.0:8787
 *   PORT=9000 node server.mjs  # 自定义端口
 *
 * 服务端职责：
 *   - 托管当前目录的静态页面
 *   - 维护房间与权威牌局状态，替 AI 座位行动
 *   - 按每位玩家的视角重排座位（自己永远是 0 号座），并且只下发自己的底牌
 *
 * 房间、牌局与最近聊天记录随房间快照保存，可在进程重启后恢复。
 */
import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, AI_LEVELS, MIN_SEATS, MAX_SEATS, TURN_LIMIT_MS } from './engine.js';
import { EMOTES, EMOTE_COOLDOWN_MS } from './emotes.js';
import { CHAT_MAX_LENGTH, CHAT_HISTORY_LIMIT, CHAT_COOLDOWN_MS, cleanChatText } from './chat-rules.js';
import { decide } from './ai.js';
import { evaluate } from './evaluator.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LEADERBOARD_FILE = resolve(ROOT, '.leaderboard.json');
const PUBLIC_ORIGIN_FILE = resolve(ROOT, '.public-origin');
const ROOMS_FILE = process.env.ROOMS_FILE ? resolve(process.env.ROOMS_FILE) : resolve(ROOT, '.rooms.json');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';

const TICK_MS = 200;          // 牌局推进的心跳
const DEAL_MS = 650;          // 发下一条街的节奏
const THINK_MIN_MS = 450;     // AI 思考时间下限
const THINK_SPREAD_MS = 900;  // AI 思考时间抖动
const TURN_MS = TURN_LIMIT_MS; // 默认回合时限；每个房间可在创建时覆盖
const TURN_OPTIONS = [15, 30, 45, 60, 120, 300]; // 秒
const DISCONNECT_MS = 30000;   // 30 秒没有轮询：AI 代打，但保留 token，回来可自动重连
const IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 12 * 60 * 60 * 1000;
const HISTORY_IN_STATE = 6;   // 每次下发最近几手牌（完整历史仍留在服务端）
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const rooms = new Map();
let recentLeaderboard = [];
let saveRoomsTimer = null;
let roomsSaving = false;
let roomsDirty = false;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function cleanName(value) {
  return String(value ?? '')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12) || '玩家';
}

function randomCode() {
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function uniqueCode() {
  let code = randomCode();
  while (rooms.has(code)) code = randomCode();
  return code;
}

function humanSeats(room) {
  return [...room.humans.values()].map(human => human.seat);
}

function lanUrls(port) {
  const addresses = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address);
    }
  }
  const rank = ip => ip.startsWith('192.168.') ? 0
    : ip.startsWith('10.') ? 1
      : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  addresses.sort((a, b) => rank(a) - rank(b));
  return addresses.map(ip => `http://${ip}:${port}`);
}

/* ------------------------------------------------------------------ *
 * 房间与牌局
 * ------------------------------------------------------------------ */

function createRoom({ name, seatCount, aiLevel, turnSeconds = 30 }) {
  const game = new Game({ seatCount, aiLevel, stack: 2000 });
  game.players.forEach(player => { player.isHuman = false; });
  const room = {
    code: uniqueCode(),
    game,
    turnMs: Math.max(15000, Math.min(300000, Math.round(turnSeconds) * 1000)),
    version: 0,
    humans: new Map(),      // token -> { seat, name, joinedAt, lastSeen }
    spectators: new Map(),  // token -> { name, joinedAt, lastSeen }
    hostSeat: 0,
    turnKey: '',
    actorSince: 0,
    nextThinkAt: 0,
    nextDealAt: 0,
    aiMemory: {},
    emoteCooldowns: {},
    pendingSwaps: [],
    recent: new Map(),      // token:requestId -> 时间，用于请求去重
    chatVersion: 0,
    chatMessages: [],
    chatRecent: new Map(),
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  rooms.set(room.code, room);
  const token = addHuman(room, 0, name);
  bump(room);
  return { room, token };
}

function addHuman(room, seat, name) {
  const token = randomBytes(24).toString('base64url');
  const player = room.game.players[seat];
  player.name = name;
  player.isHuman = true;
  room.humans.set(token, { seat, name, chatId: randomBytes(12).toString('base64url'), joinedAt: Date.now(), lastSeen: Date.now() });
  return token;
}

function removeSpectator(room, token) {
  room.spectators.delete(token);
  room.lastActivity = Date.now();
}

function markAway(room, seat, reason) {
  const entry = [...room.humans].find(([, human]) => human.seat === seat);
  if (!entry) return false;
  const human = entry[1];
  if (human.away) return false;
  human.away = true;
  human.awayReason = reason;
  const player = room.game.players[seat];
  if (player) player.isHuman = false;
  if (room.hostSeat === seat) {
    const next = [...room.humans.values()].filter(item => !item.away).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) room.hostSeat = next.seat;
  }
  const label = reason === 'timeout' ? '回合超时' : reason === 'manual' ? '暂时离开' : '掉线';
  console.log(`[river] ${human.name} ${label}，AI 代打座位 ${seat}（保留重连）`);
  bump(room);
  return true;
}

function reclaimHuman(room, human) {
  if (!human.away) return false;
  human.away = false;
  human.awayReason = null;
  human.lastSeen = Date.now();
  const player = room.game.players[human.seat];
  if (player) player.isHuman = true;
  const host = [...room.humans.values()].find(item => item.seat === room.hostSeat);
  if (!host || host.away) room.hostSeat = human.seat;
  return true;
}

function removeHuman(room, token) {
  const human = room.humans.get(token);
  if (!human) return;
  room.humans.delete(token);
  const player = room.game.players[human.seat];
  // 保留筹码与牌局，由 AI 接管这个座位，避免中途缺人。
  if (player) player.isHuman = false;
  if (room.humans.size === 0) {
    rooms.delete(room.code);
    scheduleSaveRooms();
    return;
  }
  if (room.hostSeat === human.seat) {
    const next = [...room.humans.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    room.hostSeat = next.seat;
  }
  bump(room);
}

function gameSnapshot(game) {
  const { random, ...data } = game;
  return data;
}

function roomSnapshot(room) {
  return {
    code: room.code,
    game: gameSnapshot(room.game),
    humans: [...room.humans.entries()],
    spectators: [...room.spectators.entries()],
    recent: [...room.recent.entries()],
    chatVersion: room.chatVersion,
    chatMessages: room.chatMessages,
    chatRecent: [...room.chatRecent.entries()],
    hostSeat: room.hostSeat,
    turnMs: room.turnMs,
    version: room.version,
    turnKey: room.turnKey,
    aiMemory: room.aiMemory,
    emoteCooldowns: room.emoteCooldowns,
    pendingSwaps: room.pendingSwaps,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    lastLeaderboardKey: room.lastLeaderboardKey
  };
}

function restoreGame(data) {
  if (!data || !Array.isArray(data.players) || data.players.length < 2) return null;
  const game = new Game({ seatCount: data.players.length, aiLevel: data.aiLevel || 'normal', stack: data.buyin || 2000 });
  Object.assign(game, data);
  return game;
}

function restoreRoom(data) {
  if (!data || typeof data.code !== 'string') return null;
  const game = restoreGame(data.game);
  if (!game) return null;
  const room = {
    code: data.code,
    game,
    turnMs: data.turnMs || 30000,
    version: Number.isFinite(data.version) ? data.version : 0,
    humans: new Map(Array.isArray(data.humans) ? data.humans : []),
    spectators: new Map(Array.isArray(data.spectators) ? data.spectators : []),
    hostSeat: Number.isInteger(data.hostSeat) ? data.hostSeat : 0,
    turnKey: typeof data.turnKey === 'string' ? data.turnKey : '',
    actorSince: Date.now(),
    nextThinkAt: 0,
    nextDealAt: 0,
    aiMemory: data.aiMemory && typeof data.aiMemory === 'object' ? data.aiMemory : {},
    emoteCooldowns: data.emoteCooldowns && typeof data.emoteCooldowns === 'object' ? data.emoteCooldowns : {},
    pendingSwaps: Array.isArray(data.pendingSwaps) ? data.pendingSwaps : [],
    recent: new Map(Array.isArray(data.recent) ? data.recent : []),
    chatVersion: Number.isFinite(data.chatVersion) ? data.chatVersion : 0,
    chatMessages: Array.isArray(data.chatMessages) ? data.chatMessages.slice(-CHAT_HISTORY_LIMIT) : [],
    chatRecent: new Map(Array.isArray(data.chatRecent) ? data.chatRecent.slice(-300) : []),
    createdAt: Number.isFinite(data.createdAt) ? data.createdAt : Date.now(),
    lastActivity: Date.now(),
    lastLeaderboardKey: data.lastLeaderboardKey
  };
  for (const human of room.humans.values()) {
    human.chatId ||= randomBytes(12).toString('base64url');
    if (!human.away) human.lastSeen = Date.now();
  }
  for (const watcher of room.spectators.values()) watcher.chatId ||= randomBytes(12).toString('base64url');
  room.version = (room.version || 0) + 1;
  room.turnKey = `${game.sessionId}.${game.hand}.${game.events.length}.${game.actor ?? '-'}`;
  return room;
}

async function loadRooms() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(ROOMS_FILE, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  const now = Date.now();
  for (const item of parsed) {
    try {
      if (!item || now - Number(item.lastActivity) > IDLE_TTL_MS || now - Number(item.createdAt) > MAX_TTL_MS) continue;
      const room = restoreRoom(item);
      if (room && !rooms.has(room.code)) rooms.set(room.code, room);
    } catch (error) {
      console.warn('[river] 恢复房间失败：', error.message);
    }
  }
  if (rooms.size) console.log(`[river] 已恢复 ${rooms.size} 个房间`);
}

function scheduleSaveRooms() {
  roomsDirty = true;
  if (saveRoomsTimer) return;
  saveRoomsTimer = setTimeout(() => {
    saveRoomsTimer = null;
    flushRooms().catch(error => console.error('[river] 保存房间失败：', error.message));
  }, 180);
  saveRoomsTimer.unref?.();
}

async function flushRooms() {
  if (roomsSaving) { roomsDirty = true; return; }
  if (!roomsDirty) return;
  roomsSaving = true;
  roomsDirty = false;
  try {
    const tempFile = `${ROOMS_FILE}.tmp`;
    const payload = JSON.stringify([...rooms.values()].map(roomSnapshot));
    await writeFile(tempFile, payload);
    await rename(tempFile, ROOMS_FILE);
  } catch (error) {
    roomsDirty = true;
    throw error;
  } finally {
    roomsSaving = false;
    if (roomsDirty && !saveRoomsTimer) scheduleSaveRooms();
  }
}

async function loadLeaderboard() {
 try {
  const parsed = JSON.parse(await readFile(LEADERBOARD_FILE, 'utf8'));
  if (Array.isArray(parsed)) recentLeaderboard = parsed.filter(entry => entry && Number.isFinite(entry.at));
 } catch { recentLeaderboard = []; }
}

function saveLeaderboard() {
 writeFile(LEADERBOARD_FILE, JSON.stringify(recentLeaderboard)).catch(() => {});
}

function recordLeaderboard(room) {
 const game = room.game;
 if (game.phase !== 'complete' || !game.result) return;
 const key = `${game.sessionId}:${game.hand}`;
 if (room.lastLeaderboardKey === key) return;
 room.lastLeaderboardKey = key;
 const isHuman = id => !!game.players[id]?.isHuman;
 const revealed = new Map((game.result.revealed || []).map(entry => [entry.id, entry]));
 const board = [...game.board];
 const at = Date.now();
 const detailFor = (winnerId, entry, amount) => {
  const winner = game.players[winnerId];
  return {
   winner: { name: winner.name, seat: winnerId + 1, isHuman: isHuman(winnerId) },
   hand: entry?.hand || '未摊牌', amount, pot: game.result.total, board,
   hole: entry?.hole || [],
   players: game.players.map((player, id) => ({
    name: player.name, seat: id + 1, isHuman: isHuman(id), folded: player.folded,
    hole: revealed.get(id)?.hole || [], hand: revealed.get(id)?.hand || null, stack: player.stack
   })),
   winners: (game.result.winningSeats || []).map(id => ({ name: game.players[id].name, seat: id + 1, amount: game.result.contestAwards[id] || 0 }))
  };
 };
 const entries = [];
 for (const winnerId of game.result.winningSeats || []) {
  if (!isHuman(winnerId)) continue;
  const amount = game.result.contestAwards[winnerId] || 0;
  if (amount <= 0) continue;
  const entry = revealed.get(winnerId);
  entries.push({
   id: `win:${game.sessionId}:${game.hand}:${winnerId}`, kind: 'win', amount, score: amount, at,
   winner: game.players[winnerId].name, hand: entry?.hand || '未摊牌',
   board, hole: entry?.hole || [], detail: detailFor(winnerId, entry, amount)
  });
 }
 let best = null;
 for (const entry of game.result.revealed || []) {
  if (!isHuman(entry.id)) continue;
  const ranked = evaluate([...entry.hole, ...game.board]);
  if (!best || ranked.score > best.score) best = { ...entry, name: ranked.name, score: ranked.score };
 }
 if (best) {
  const amount = game.result.contestAwards[best.id] || 0;
  entries.push({
   id: `hand:${game.sessionId}:${game.hand}`, kind: 'hand', amount, score: best.score, at,
   winner: game.players[best.id].name, hand: best.name,
   board, hole: best.hole || [], detail: detailFor(best.id, best, amount)
  });
 }
 if (!entries.length) return;
 const seen = new Set(recentLeaderboard.map(entry => entry.id));
 recentLeaderboard.push(...entries.filter(entry => !seen.has(entry.id)));
 const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
 recentLeaderboard = recentLeaderboard.filter(entry => entry.at >= cutoff).slice(-500);
 saveLeaderboard();
}

function leaderboardPayload() {
 const by = (kind, field) => recentLeaderboard.filter(entry => entry.kind === kind)
  .sort((a, b) => (b[field] || 0) - (a[field] || 0) || b.at - a.at).slice(0, 10);
 return { wins: by('win', 'amount'), hands: by('hand', 'score'), updatedAt: Date.now() };
}

function bump(room) {
  const game = room.game;
  room.version++;
  room.turnKey = `${game.sessionId}.${game.hand}.${game.events.length}.${game.actor ?? '-'}`;
  room.actorSince = Date.now();
  room.nextThinkAt = 0;
  room.nextDealAt = 0;
  room.lastActivity = Date.now();
 recordLeaderboard(room);
}

function pickJoinSeat(room) {
  const game = room.game;
  const taken = new Set(humanSeats(room));
  const bots = game.players.filter(player => !taken.has(player.id));
  if (!bots.length) return null;
  const priority = player => {
    if (game.phase !== 'playing') return 0;
    if (player.folded) return 0;          // 优先坐已经弃牌的座位，不影响本手
    if (game.actor === player.id) return 2; // 最后才打断正在行动的座位
    return 1;
  };
  bots.sort((a, b) => priority(a) - priority(b) || a.id - b.id);
  return bots[0].id;
}

function seatHuman(room, seat, name) {
  const game = room.game;
  const player = game.players[seat];
  player.isHuman = true;
  player.name = name;
  // 牌局进行中入座：本手直接坐出，下一手正常参与。
  if (game.phase === 'playing' && !player.folded) {
    if (game.actor === seat) {
      try { game.act(seat, 'fold'); } catch { /* 由下面的兜底处理 */ }
    } else {
      player.folded = true;
      player.lastAction = '弃牌';
      player.stats.folds++;
      game.events.push({
        kind: 'action', seat, type: 'fold', amount: 0, to: player.bet,
        pot: game.pot, street: game.street, allin: false, fullRaise: false,
        board: [...game.board], facing: 0
      });
      game.resolveProgress(seat);
    }
  }
  // 新加入的真人重新买入 2,000：清空原 AI 的筹码、欠款、借还记录和个人数据。
  player.stack = game.buyin;
  player.debt = 0;
  player.pendingLoan = 0;
  player.loans = [];
  player.net = 0;
  player.hole = [];
  player.startStack = game.buyin;
  player.stats = { hands: 0, vpip: 0, pfr: 0, raises: 0, calls: 0, folds: 0, faced: 0, foldToBet: 0, showdowns: 0, shownBluffs: 0 };
}

function swapSeatState(room, a, b) {
  const game = room.game;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return false;
  if (a < 0 || b < 0 || a >= game.players.length || b >= game.players.length) return false;
  [game.players[a], game.players[b]] = [game.players[b], game.players[a]];
  game.players[a].id = a;
  game.players[b].id = b;
  if (Array.isArray(game.personalities)) {
    [game.personalities[a], game.personalities[b]] = [game.personalities[b], game.personalities[a]];
  }
  for (const human of room.humans.values()) {
    if (human.seat === a) human.seat = b;
    else if (human.seat === b) human.seat = a;
  }
  if (room.hostSeat === a) room.hostSeat = b;
  else if (room.hostSeat === b) room.hostSeat = a;
  [room.aiMemory[a], room.aiMemory[b]] = [room.aiMemory[b], room.aiMemory[a]];
  [room.emoteCooldowns[a], room.emoteCooldowns[b]] = [room.emoteCooldowns[b], room.emoteCooldowns[a]];
  return true;
}

function resetGame(room) {
  const humans = [...room.humans.values()];
  const { seatCount, aiLevel } = room.game;
  const game = new Game({ seatCount, aiLevel, stack: 2000 });
  game.players.forEach(player => { player.isHuman = false; });
  for (const human of humans) {
    const player = game.players[human.seat];
    if (!player) continue;
    player.name = human.name;
    player.isHuman = true;
  }
  room.game = game;
  room.aiMemory = {};
  room.emoteCooldowns = {};
  room.pendingSwaps = [];
  room.recent.clear();
}

/* ------------------------------------------------------------------ *
 * 视角状态：把请求者的座位旋转到 0 号座，客户端只认识这个视角
 * ------------------------------------------------------------------ */

function buildChat(room, token) {
  const member = room.humans.get(token) || room.spectators.get(token);
  return {
    version: room.chatVersion,
    messages: room.chatMessages.map(({ senderId, ...message }) => ({ ...message, own: senderId === member?.chatId }))
  };
}

function sendChat(room, token, body) {
  const member = room.humans.get(token) || room.spectators.get(token);
  const requestId = typeof body.requestId === 'string' ? body.requestId : '';
  if (!requestId || requestId.length > 100) throw new HttpError(400, '消息缺少有效的请求编号');
  const key = `${token}:${requestId}`;
  // An acknowledged retry must not publish or charge the cooldown twice.
  if (room.chatRecent.has(key)) return;
  const text = cleanChatText(body.text);
  if (!text) throw new HttpError(400, '请输入消息内容');
  if (text.length > CHAT_MAX_LENGTH) throw new HttpError(400, `消息最多 ${CHAT_MAX_LENGTH} 字`);
  const now = Date.now();
  if (now - (member.chatAt || 0) < CHAT_COOLDOWN_MS) throw new HttpError(429, '发送太快了，请稍等一秒');
  room.chatMessages.push({
    id: ++room.chatVersion,
    senderId: member.chatId,
    name: member.name,
    spectator: room.spectators.has(token),
    text,
    time: now
  });
  if (room.chatMessages.length > CHAT_HISTORY_LIMIT) room.chatMessages.shift();
  member.chatAt = now;
  room.chatRecent.set(key, now);
  while (room.chatRecent.size > 300) room.chatRecent.delete(room.chatRecent.keys().next().value);
  // Chat does not bump the game version or reset the turn / AI / dealing timers.
  room.lastActivity = now;
  scheduleSaveRooms();
}

function buildState(room, seat, spectator = false, token = '') {
  const game = room.game;
  const count = game.players.length;
  const viewer = spectator ? null : [...room.humans.values()].find(human => human.seat === seat);
  const away = !!viewer?.away;
  const map = index => (typeof index === 'number' && index >= 0
    ? (index - seat + count) % count
    : index);
  const remapList = list => {
    const out = new Array(list.length);
    for (let i = 0; i < list.length; i++) out[map(i)] = list[i];
    return out;
  };

  const players = new Array(count);
  for (let i = 0; i < count; i++) {
    const player = game.players[i];
    players[map(i)] = {
      id: map(i),
      absoluteSeat: i,
      name: player.name,
      stack: player.stack,
      debt: player.debt,
      pendingLoan: spectator ? 0 : player.pendingLoan,
      net: spectator ? 0 : player.net,
      loans: spectator ? [] : (i === seat ? player.loans.map(loan => ({ ...loan })) : []),
      // 只下发自己的底牌，其他人的牌在摊牌时通过 result.revealed 公开；观战者看不到任何底牌。
      hole: spectator ? [] : (i === seat ? [...player.hole] : []),
      folded: player.folded,
      bet: player.bet,
      total: player.total,
      lastAction: player.lastAction,
      isHuman: !!player.isHuman,
      stats: { ...player.stats }
    };
  }

  const remapEvent = event => (event.seat == null ? { ...event } : { ...event, seat: map(event.seat) });
  const remapResult = (result, heroDelta) => {
    if (!result) return null;
    const awards = new Array(count);
    const contestAwards = new Array(count);
    for (let i = 0; i < count; i++) {
      awards[map(i)] = result.awards[i] || 0;
      contestAwards[map(i)] = result.contestAwards[i] || 0;
    }
    return {
      showdown: !!result.showdown,
      awards,
      contestAwards,
      pots: result.pots.map(pot => ({
        amount: pot.amount,
        winners: pot.winners.map(map),
        refund: !!pot.refund
      })),
      winningSeats: result.winningSeats.map(map),
      total: result.total,
      revealed: result.revealed.map(item => ({
        id: map(item.id),
        hole: [...item.hole],
        hand: item.hand
      })),
      heroDelta
    };
  };

  const self = game.players[seat];
  const heroDelta = spectator ? 0 : (Number.isFinite(self.startStack) ? self.stack - self.startStack : 0);

  const history = game.history.slice(0, HISTORY_IN_STATE).map(hand => ({
    hand: hand.hand,
    board: [...hand.board],
    heroCards: spectator ? [] : [...(hand.privateHands[seat] || [])],
    deltas: remapList(hand.deltas),
    names: remapList(hand.names),
    events: hand.events.map(remapEvent),
    result: remapResult(hand.result, spectator ? 0 : (hand.deltas[seat] || 0)),
    stacks: remapList(hand.stacks)
  }));

  // AI 辅助只在自己行动时使用；不在自己回合时不下发，省一半流量。
  const actionOptions = spectator || away ? null : game.legal(seat);
  let reviewView = null;
  if (actionOptions) {
    const view = game.publicView(seat);
    reviewView = {
      ...view,
      seat: 0,
      button: map(view.button),
      sbSeat: map(view.sbSeat),
      bbSeat: map(view.bbSeat),
      players: view.players.map(player => ({ ...player, id: map(player.id) })),
      events: view.events.map(remapEvent)
    };
  }

  return {
    code: room.code,
    version: room.version,
    chat: buildChat(room, token),
    host: !spectator && room.hostSeat === seat,
    spectator,
    away,
    awayReason: spectator ? null : (viewer?.awayReason || null),
    spectators: room.spectators.size,
    humans: room.humans.size,
    humanSeats: spectator ? [] : [...room.humans.values()].map(item => map(item.seat)),
    turnKey: room.turnKey,
    turnRemaining: spectator || away ? 0 : (game.actor != null ? Math.max(0, room.actorSince + (room.turnMs || TURN_MS) - Date.now()) : 0),
    turnMs: room.turnMs || TURN_MS,
    emoteCooldown: spectator || away ? 0 : Math.max(0, (room.emoteCooldowns?.[seat] || 0) - Date.now()),
    seatCount: count,
    aiLevel: game.aiLevel,
    sessionId: game.sessionId,
    hand: game.hand,
    phase: game.phase,
    street: game.street,
    actor: map(game.actor),
    board: [...game.board],
    button: map(game.button),
    sbSeat: map(game.sbSeat),
    bbSeat: map(game.bbSeat),
    sb: game.sb,
    bb: game.bb,
    betUnit: game.betUnit,
    pot: game.pot,
    currentBet: game.currentBet,
    minRaise: game.minRaise,
    players,
    personalities: remapList(game.personalities.map(persona => ({ ...persona }))),
    events: game.events.map(remapEvent),
    result: remapResult(game.result, heroDelta),
    history,
    completedHands: game.completedHands,
    net: spectator ? 0 : (self.net || 0),
    actionOptions,
    reviewView
  };
}

/* ------------------------------------------------------------------ *
 * 牌局推进：发牌、AI 行动、真人超时
 * ------------------------------------------------------------------ */

function botAct(room, seat) {
  const game = room.game;
  const legal = game.legal(seat);
  if (!legal) return;
  const attempts = [];
  try {
    const choice = decide(game.publicView(seat), { memory: room.aiMemory[seat] ||= {} });
    if (choice && choice.type) {
      attempts.push([choice.type, choice.type === 'raise' ? Number(choice.to) || 0 : 0]);
    }
  } catch (error) {
    console.warn('[river] AI 决策失败：', error.message);
  }
  attempts.push([legal.canCheck ? 'check' : 'call', 0]);
  attempts.push(['fold', 0]);
  for (const [type, to] of attempts) {
    try {
      game.act(seat, type, to);
      bump(room);
      return;
    } catch { /* 尝试下一种合法兜底 */ }
  }
}

function autoAct(room, seat) {
  const game = room.game;
  const legal = game.legal(seat);
  if (!legal) return;
  try { game.act(seat, legal.canCheck ? 'check' : 'fold'); } catch (error) {
    console.warn('[river] 自动行动失败：', error.message);
  }
  // 30 秒不响应：先自动过牌/弃牌，座位交给 AI 代打；token 保留，可点「重新接管」。
  if (!markAway(room, seat, 'timeout')) bump(room);
}

function tick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    const game = room.game;
    // 超过 DISCONNECT_MS 没轮询：标记为 AI 代打，但保留 token；下次轮询自动重连。
    for (const [, human] of [...room.humans]) {
      if (human.away) continue;
      if (now - human.lastSeen > DISCONNECT_MS) markAway(room, human.seat, 'disconnect');
    }
    if (game.phase === 'dealing') {
      if (!room.nextDealAt) room.nextDealAt = now + DEAL_MS;
      else if (now >= room.nextDealAt) {
        room.nextDealAt = 0;
        try { game.advanceStreet(); } catch (error) {
          console.warn('[river] 发牌失败：', error.message);
        }
        bump(room);
      }
      continue;
    }
    if (game.phase !== 'playing' || game.actor == null) continue;
    const actor = game.actor;
    const human = [...room.humans.values()].find(item => item.seat === actor);
    if (human && !human.away) {
      if (!room.actorSince) room.actorSince = now;
      else if (now - room.actorSince > (room.turnMs || TURN_MS)) autoAct(room, actor);
      continue;
    }
    if (!room.nextThinkAt) {
      const hard = game.aiLevel === 'hard';
      room.nextThinkAt = now + (hard ? 280 : THINK_MIN_MS) + Math.random() * (hard ? 520 : THINK_SPREAD_MS);
    } else if (now >= room.nextThinkAt) {
      room.nextThinkAt = 0;
      botAct(room, actor);
    }
  }
}

function cleanup() {
  const now = Date.now();
  let removed = false;
  for (const room of rooms.values()) {
    if (now - room.lastActivity > IDLE_TTL_MS || now - room.createdAt > MAX_TTL_MS) {
      rooms.delete(room.code);
      removed = true;
    }
  }
  if (removed) scheduleSaveRooms();
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function sendJson(req, res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
  if (body.length > 1024 && acceptsGzip) {
    const packed = gzipSync(body, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : packed);
    return;
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendText(req, res, status, text) {
  const body = Buffer.from(text);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求格式有误');
  }
}

function authRoom(req, code) {
  const room = rooms.get(code);
  if (!room) throw new HttpError(404, '房间不存在或已关闭');
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const human = room.humans.get(token);
  if (human) {
    const stale = Date.now() - human.lastSeen > DISCONNECT_MS;
    if (human.away && (human.awayReason === 'disconnect' || stale)) {
      reclaimHuman(room, human);
      bump(room);
    }
    human.lastSeen = Date.now();
    room.lastActivity = Date.now();
    return { room, human, token, spectator: false };
  }
  const watcher = room.spectators.get(token);
  if (watcher) {
    watcher.lastSeen = Date.now();
    room.lastActivity = Date.now();
    return { room, human: null, token, spectator: true };
  }
  throw new HttpError(401, '登录状态已失效，请重新加入房间');
}

async function handleApi(req, res, url, segments) {
  const method = req.method;

  if (!segments[2]) {
    if (method !== 'POST') throw new HttpError(405, '不支持的请求方法');
    const body = await readJson(req);
    const seatCount = Number(body.seatCount);
    const aiLevel = String(body.aiLevel || 'normal');
    if (!Number.isInteger(seatCount) || seatCount < MIN_SEATS || seatCount > MAX_SEATS) {
      throw new HttpError(400, `人数请选择 ${MIN_SEATS}–${MAX_SEATS} 人`);
    }
    if (!AI_LEVELS.includes(aiLevel)) throw new HttpError(400, '请选择 AI 强度');
    const turnSeconds = Number(body.turnSeconds ?? 30);
    if (!TURN_OPTIONS.includes(turnSeconds)) throw new HttpError(400, '回合时间不在可选范围内');
    const { room, token } = createRoom({ name: cleanName(body.name), seatCount, aiLevel, turnSeconds });
    sendJson(req, res, 200, { token, state: buildState(room, 0, false, token) });
    return;
  }

  const code = String(segments[2]).toUpperCase();

  if (segments[3] === 'lobby') {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '不支持的请求方法');
    const room = rooms.get(code);
    if (!room) throw new HttpError(404, '房间不存在或已关闭');
    const humanSeats = new Set([...room.humans.values()].map(human => human.seat));
    sendJson(req, res, 200, {
      code: room.code,
      seatCount: room.game.players.length,
      aiLevel: room.game.aiLevel,
      turnMs: room.turnMs || TURN_MS,
      phase: room.game.phase,
      players: room.game.players.map(player => ({
        id: player.id,
        name: player.name,
        stack: player.stack,
        isHuman: !!player.isHuman,
        available: !humanSeats.has(player.id)
      }))
    });
    return;
  }

  if (segments[3] === 'join') {
    if (method !== 'POST') throw new HttpError(405, '不支持的请求方法');
    const room = rooms.get(code);
    if (!room) throw new HttpError(404, '房间不存在或已关闭');
    const body = await readJson(req);
    if (body.spectate) {
      const token = randomBytes(24).toString('base64url');
      room.spectators.set(token, { name: cleanName(body.name), chatId: randomBytes(12).toString('base64url'), joinedAt: Date.now(), lastSeen: Date.now() });
      room.lastActivity = Date.now();
      sendJson(req, res, 200, { token, spectator: true, state: buildState(room, 0, true, token) });
      return;
    }
    if (room.game.phase === 'dealing') {
      throw new HttpError(409, '牌局正在发牌，请稍后再试', { retry: true });
    }
    const name = cleanName(body.name);
    let seat;
    if (body.seat !== undefined && body.seat !== null) {
      const requested = Number(body.seat);
      if (!Number.isInteger(requested) || requested < 0 || requested >= room.game.players.length) {
        throw new HttpError(400, '座位不存在');
      }
      if ([...room.humans.values()].some(human => human.seat === requested)) {
        throw new HttpError(409, '这个座位已经有人了');
      }
      seat = requested;
    } else {
      seat = pickJoinSeat(room);
    }
    if (seat === null) throw new HttpError(409, '房间已满');
    seatHuman(room, seat, name);
    const token = addHuman(room, seat, name);
    bump(room);
    sendJson(req, res, 200, { token, state: buildState(room, seat, false, token) });
    return;
  }

  if (segments[3]) throw new HttpError(404, '接口不存在');

  if (method === 'GET' || method === 'HEAD') {
    const { room, human, spectator, token } = authRoom(req, code);
    const seat = human ? human.seat : 0;
    const since = Number(url.searchParams.get('since'));
    if (Number.isFinite(since) && since === room.version) {
      const chatSince = Number(url.searchParams.get('chatSince') ?? -1);
      sendJson(req, res, 200, { unchanged: true, ...(chatSince === room.chatVersion ? {} : { chat: buildChat(room, token) }) });
    } else {
      sendJson(req, res, 200, { state: buildState(room, seat, spectator, token) });
    }
    return;
  }

  if (method !== 'POST') throw new HttpError(405, '不支持的请求方法');
  const { room, human, token, spectator } = authRoom(req, code);
  const body = await readJson(req);
  const op = String(body.op || '');
  if (op === 'leave') {
    if (spectator) removeSpectator(room, token);
    else removeHuman(room, token);
    sendJson(req, res, 200, { ok: true });
    return;
  }
  if (op === 'chat') {
    sendChat(room, token, body);
    sendJson(req, res, 200, { chat: buildChat(room, token) });
    return;
  }
  if (spectator) throw new HttpError(403, '观战模式不能操作牌局');
  if (human.away && op !== 'reclaim' && op !== 'away') throw new HttpError(409, '座位暂由 AI 代打，请先点“重新接管”');
  const requestId = body.requestId ? String(body.requestId) : '';
  const dedupeKey = requestId ? `${token}:${requestId}` : '';
  if (dedupeKey && room.recent.has(dedupeKey)) {
    sendJson(req, res, 200, { state: buildState(room, human.seat, false, token) });
    return;
  }

  const game = room.game;
  const isHost = room.hostSeat === human.seat;

  if (op === 'reclaim') {
    reclaimHuman(room, human);
  } else if (op === 'swapSeats') {
    if (!isHost) throw new HttpError(403, '只有房主可以交换位置');
    const a = Number(body.a);
    const b = Number(body.b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= game.players.length || b >= game.players.length) {
      throw new HttpError(400, '座位不存在');
    }
    if (a === b) throw new HttpError(400, '请选择两个不同的座位');
    if (game.phase === 'idle') {
      swapSeatState(room, a, b);
    } else {
      room.pendingSwaps.push([a, b]);
    }
  } else if (op === 'kick') {
    if (!isHost) throw new HttpError(403, '只有房主可以踢出玩家');
    const seat = Number(body.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= game.players.length) throw new HttpError(400, '座位不存在');
    if (seat === human.seat) throw new HttpError(400, '不能踢出自己');
    const target = [...room.humans.entries()].find(([, item]) => item.seat === seat);
    if (!target) throw new HttpError(404, '这个座位没有真人');
    removeHuman(room, target[0]);
  } else if (op === 'fillAI') {
    if (!isHost) throw new HttpError(403, '只有房主可以补 AI');
    const seat = Number(body.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= game.players.length) throw new HttpError(400, '座位不存在');
    if ([...room.humans.values()].some(item => item.seat === seat)) throw new HttpError(409, '这个座位有真人，请先踢出');
    if (!['idle', 'complete'].includes(game.phase)) throw new HttpError(409, '本手结束后才能补 AI');
    const player = game.players[seat];
    player.isHuman = false;
    player.stack = game.buyin;
    player.debt = 0;
    player.pendingLoan = 0;
    player.loans = [];
    player.hole = [];
    player.folded = false;
    player.bet = 0;
    player.total = 0;
    player.lastAction = '';
    player.stats = { hands: 0, vpip: 0, pfr: 0, raises: 0, calls: 0, folds: 0, faced: 0, foldToBet: 0, showdowns: 0, shownBluffs: 0 };
    room.aiMemory[seat] = {};
    room.emoteCooldowns[seat] = 0;
  } else if (op === 'away') {
    markAway(room, human.seat, 'manual');
  } else if (op === 'start') {
    if (!isHost) throw new HttpError(403, '只有房主可以开始牌局');
    if (!['idle', 'complete'].includes(game.phase)) throw new HttpError(409, '牌局正在进行中');
    if (room.pendingSwaps.length) {
      for (const [a, b] of room.pendingSwaps) swapSeatState(room, a, b);
      room.pendingSwaps = [];
    }
    game.refillBusted(humanSeats(room));
    game.startHand();
  } else if (op === 'action') {
    if (game.phase !== 'playing' || game.actor == null) throw new HttpError(409, '现在不能行动');
    if (String(body.turnKey ?? '') !== room.turnKey) throw new HttpError(409, '牌局已更新，请重试');
    if (game.actor !== human.seat) throw new HttpError(409, '还没轮到你行动');
    const type = String(body.type || '');
    if (!['fold', 'check', 'call', 'raise'].includes(type)) throw new HttpError(400, '未知的操作');
    const to = type === 'raise' ? Number(body.to) : 0;
    game.act(human.seat, type, Number.isFinite(to) ? to : 0);
  } else if (op === 'emote') {
    const emote = EMOTES.find(item => item.id === String(body.emote || ''));
    if (!emote) throw new HttpError(400, '未知的表情');
    const now = Date.now();
    const remaining = (room.emoteCooldowns[human.seat] || 0) - now;
    if (remaining > 0) throw new HttpError(429, `表情冷却中，还需 ${Math.ceil(remaining / 1000)} 秒`);
    const player = room.game.players[human.seat];
    if (player.stack < emote.cost) throw new HttpError(409, `筹码不足，这个表情要 ${emote.cost} 筹码`);
    player.stack -= emote.cost;
    room.emoteCooldowns[human.seat] = now + EMOTE_COOLDOWN_MS;
    room.game.events.push({ kind: 'emote', seat: human.seat, id: emote.id, emoji: emote.emoji, text: emote.text, cost: emote.cost, hand: room.game.hand, time: now });
  } else if (op === 'borrow') {
    game.borrow(human.seat);
  } else if (op === 'repay') {
    game.repay(human.seat);
  } else if (op === 'reset') {
    if (!isHost) throw new HttpError(403, '只有房主可以重置牌桌');
    resetGame(room);
  } else {
    throw new HttpError(400, '未知的房间操作');
  }

  bump(room);
  if (dedupeKey) {
    room.recent.set(dedupeKey, Date.now());
    while (room.recent.size > 300) room.recent.delete(room.recent.keys().next().value);
  }
  sendJson(req, res, 200, { state: buildState(room, human.seat, false, token) });
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持的请求方法');
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, '地址格式有误');
  }
  if (relative === '/' || relative === '') relative = '/index.html';
  if (relative.endsWith('/')) relative += 'index.html';
  if (relative.includes('\0')) throw new HttpError(400, '地址格式有误');
  const segments = relative.split('/').filter(Boolean);
  if (segments.some(segment => segment.startsWith('.') || segment === 'node_modules')) {
    throw new HttpError(404, 'Not Found');
  }
  const filePath = resolve(ROOT, '.' + relative);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) throw new HttpError(403, 'Forbidden');
  let data;
  try {
    data = await readFile(filePath);
  } catch {
    throw new HttpError(404, 'Not Found');
  }
  const ext = extname(filePath).toLowerCase();
  const isMedia = ['.mp3', '.m4a', '.ogg', '.wav'].includes(ext);
  const isText = ['.html', '.js', '.mjs', '.css', '.json', '.svg', '.md', '.txt'].includes(ext);
  const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes'
  };
  let body = data;
  let status = 200;
  if (isText && data.length > 1024 && acceptsGzip) {
    body = gzipSync(data, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  const range = req.headers.range;
  if (range && isMedia && /^bytes=\d*-\d*$/.test(range)) {
    const [startText, endText] = range.slice(6).split('-');
    let start = startText ? Number(startText) : 0;
    let end = endText ? Number(endText) : data.length - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= data.length) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${data.length}` });
      res.end();
      return;
    }
    end = Math.min(end, data.length - 1);
    body = data.subarray(start, end + 1);
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'api') {
    if (segments[1] === 'server-info') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持的请求方法');
      const port = server.address()?.port || PORT;
      let publicOrigin = '';
      try {
        const candidate = (await readFile(PUBLIC_ORIGIN_FILE, 'utf8')).trim();
        if (/^https?:\/\/\S+$/.test(candidate)) publicOrigin = candidate.replace(/\/$/, '');
      } catch { /* no active public share */ }
      sendJson(req, res, 200, {
        urls: lanUrls(port),
        port,
        publicOrigin,
        capabilities: { publicOrigin: true, maxSeats: 10 },
        origin: `${req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')}://${req.headers.host}`
      });
      return;
    }
    if (segments[1] === 'leaderboard') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持的请求方法');
      sendJson(req, res, 200, leaderboardPayload());
      return;
    }
    if (segments[1] !== 'rooms') throw new HttpError(404, '接口不存在');
    await handleApi(req, res, url, segments);
    return;
  }
  await serveStatic(req, res, url.pathname);
}

const server = createServer((req, res) => {
  handle(req, res).catch(error => {
    if (res.headersSent) { res.destroy(); return; }
    const status = error instanceof HttpError ? error.status : 400;
    if (!(error instanceof HttpError)) console.error('[river]', error);
    const isApi = (req.url || '').startsWith('/api/');
    if (isApi) {
      sendJson(req, res, status, { error: error.message || '服务异常', ...(error.extra || {}) });
    } else {
      sendText(req, res, status, error.message || '服务异常');
    }
  });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。请换一个端口：PORT=8788 node server.mjs`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

await loadLeaderboard();
await loadRooms();

server.listen(PORT, HOST, () => {
  const port = server.address().port;
  console.log('');
  console.log('  River Room 联机服务已启动');
  console.log(`  本机:     http://127.0.0.1:${port}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const address of lanUrls(port)) console.log(`  局域网:   ${address}`);
    console.log('  同一 Wi-Fi 下的朋友打开局域网地址即可加入。');
  }
  console.log('  房间和当前牌局会自动保存，重启后可恢复。按 Ctrl+C 停止。');
  console.log('');
});

setInterval(() => { try { tick(); } catch (error) { console.error('[river] tick 异常：', error); } }, TICK_MS);
setInterval(() => { try { cleanup(); } catch (error) { console.error('[river] cleanup 异常：', error); } }, 60000);
function saveRoomsSync() {
  try {
    const tempFile = `${ROOMS_FILE}.tmp`;
    writeFileSync(tempFile, JSON.stringify([...rooms.values()].map(roomSnapshot)));
    renameSync(tempFile, ROOMS_FILE);
  } catch (error) {
    console.warn('[river] 退出前保存房间失败：', error.message);
  }
}

function shutdownServer() {
  console.log('\n正在关闭 River Room 联机服务…');
  saveRoomsSync();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdownServer);
process.on('SIGTERM', shutdownServer);
process.on('uncaughtException', error => console.error('[river] 未捕获异常：', error));
process.on('unhandledRejection', error => console.error('[river] 未处理 Promise：', error));
