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
 * 房间数据保存在内存里，进程重启即清空。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { randomBytes, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, AI_LEVELS, MIN_SEATS, MAX_SEATS, TURN_LIMIT_MS } from './engine.js';
import { EMOTES, EMOTE_COOLDOWN_MS } from './emotes.js';
import { decide } from './ai.js';
import { rankingRecord } from './rankings.js';
import { RankingStore } from './ranking-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT === '0' ? 0 : Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = resolve(process.env.RIVER_DATA_DIR || resolve(ROOT, '.data'));

const TICK_MS = 100;
const DEAL_MS = 360;
const THINK_MIN_MS = 120;
const THINK_SPREAD_MS = 110;
const TURN_MS = TURN_LIMIT_MS; // 默认回合时限；每个房间可在创建时覆盖
const TURN_OPTIONS = [15, 30, 45, 60, 120, 300]; // 秒
const DISCONNECT_MS = 30000;   // 30 秒没有轮询：AI 代打，但保留 token，回来可自动重连
const AFK_MS = 60000;          // 60 秒没有任何用户操作：视为人不在，AI 代打
const IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 12 * 60 * 60 * 1000;
const HISTORY_IN_STATE = 6;   // 每次下发最近几手牌（完整历史仍留在服务端）
const SEAT_INVITE_MS = 15 * 60 * 1000;
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
const rankings = new RankingStore(resolve(DATA_DIR, 'rankings'));

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

function humanAt(room, seat) {
  return [...room.humans].find(([, human]) => human.seat === seat);
}

function seatNumber(room, value) {
  if (!Number.isInteger(value) || value < 0 || value >= room.game.players.length) {
    throw new HttpError(400, '座位不存在');
  }
  return value;
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
    writesHand: null,
    rosterVersion: 0,
    seatChanges: new Map(),
    pendingSwaps: [],
    seatInvites: new Map(),
    joins: new Map(),
    kicked: new Set(),
    recent: new Map(),      // token:requestId -> 时间，用于请求去重
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
  const pending = room.game.phase !== 'idle';
  const now = Date.now();
  if (!pending) replaceRoomSeat(room, seat, { name, human: true });
  room.humans.set(token, { seat, name, pending, handSeats: new Map(), joinedAt: now, lastSeen: now, lastActive: now });
  room.seatChanges.delete(seat);
  room.seatInvites.delete(seat);
  room.rosterVersion++;
  return token;
}

function removeSpectator(room, token) {
  room.spectators.delete(token);
  room.lastActivity = Date.now();
}

function markAway(room, seat, reason) {
  const entry = humanAt(room, seat);
  if (!entry) return false;
  const human = entry[1];
  if (human.away || human.pending) return false;
  human.away = true;
  human.awayReason = reason;
  const player = room.game.players[seat];
  if (player) player.isHuman = false;
  if (room.hostSeat === seat) {
    const next = [...room.humans.values()].filter(item => !item.away).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) room.hostSeat = next.seat;
  }
  const label = reason === 'timeout' ? '回合超时' : reason === 'manual' ? '暂时离开' : reason === 'afk' ? '1 分钟未操作' : '掉线';
  console.log(`[river] ${human.name} ${label}，AI 代打座位 ${seat}（保留重连）`);
  bump(room);
  return true;
}

function reclaimHuman(room, human) {
  if (!human.away) return false;
  human.away = false;
  human.awayReason = null;
  human.lastSeen = Date.now();
  human.lastActive = Date.now();
  const player = room.game.players[human.seat];
  if (player && !human.pending) player.isHuman = true;
  if (room.game.actor === human.seat) {
    room.actorSince = Date.now();
    room.nextThinkAt = 0;
  }
  const host = [...room.humans.values()].find(item => item.seat === room.hostSeat);
  if (!host || host.away) room.hostSeat = human.seat;
  return true;
}

function removeHuman(room, token, kicked = false) {
  const human = room.humans.get(token);
  if (!human) return;
  room.humans.delete(token);
  const player = room.game.players[human.seat];
  // 保留筹码与牌局，由 AI 接管这个座位，避免中途缺人。
  if (player && !human.pending) player.isHuman = false;
  if (kicked) room.kicked.add(token);
  room.seatInvites.delete(human.seat);
  room.rosterVersion++;
  if (room.humans.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostSeat === human.seat) {
    const next = [...room.humans.values()].sort((a, b) => Number(!!a.away || a.pending) - Number(!!b.away || b.pending) || a.joinedAt - b.joinedAt)[0];
    room.hostSeat = next.seat;
  }
}

function bump(room) {
  const game = room.game;
  room.version++;
  const turnKey = `${game.sessionId}.${game.hand}.${game.street}.${game.actionCount||0}.${game.actor ?? '-'}.${game.phase}`;
  if (turnKey !== room.turnKey) {
    room.turnKey = turnKey;
    room.actorSince = Date.now();
    room.nextThinkAt = 0;
    room.nextDealAt = 0;
  }
  room.lastActivity = Date.now();
  const hand = game.phase === 'complete' ? game.history[0] : null;
  if (hand && room.writesHand !== hand) {
    rankings.add(rankingRecord(hand, randomUUID(), 'online'));
    room.writesHand = hand;
  }
}

function pickJoinSeat(room) {
  const taken = new Set(humanSeats(room));
  const available = room.game.players.filter(player => !taken.has(player.id));
  return (available.find(player => (room.seatChanges.get(player.id) || (player.vacant?'empty':'bot'))==='empty') || available[0])?.id ?? null;
}

function replaceRoomSeat(room, seat, options) {
  room.game.replaceSeat(seat, options);
  delete room.aiMemory[seat];
  delete room.emoteCooldowns[seat];
}

function changeSeat(room, seat, type) {
  const member = humanAt(room, seat);
  if (member) removeHuman(room, member[0], true);
  room.seatInvites.delete(seat);
  if (room.game.phase === 'idle') replaceRoomSeat(room, seat, { vacant: type === 'empty' });
  else room.seatChanges.set(seat, type);
  room.rosterVersion++;
}

function swapSeats(room, a, b) {
  const { game } = room;
  for (const slots of [game.players, game.personalities, room.emoteCooldowns]) {
    [slots[a], slots[b]] = [slots[b], slots[a]];
  }
  for (const seat of [a,b]) {
    game.players[seat].id = seat;
    game.personalities[seat].id = seat;
    room.seatInvites.delete(seat);
    delete room.aiMemory[seat];
  }
  for (const member of room.humans.values()) {
    if (member.seat === a) member.seat = b;
    else if (member.seat === b) member.seat = a;
  }
  if (room.hostSeat === a) room.hostSeat = b;
  else if (room.hostSeat === b) room.hostSeat = a;
}

function applySeatChanges(room) {
  const hasChanges = room.seatChanges.size || room.pendingSwaps.length;
  for (const [seat,type] of room.seatChanges) {
    replaceRoomSeat(room, seat, { vacant: type === 'empty' });
  }
  room.seatChanges.clear();
  let added = false;
  for (const member of room.humans.values()) {
    if (!member.pending) continue;
    replaceRoomSeat(room, member.seat, { name: member.name, human: true });
    member.pending = false;
    added = true;
  }
  for (const [a,b] of room.pendingSwaps) swapSeats(room,a,b);
  room.pendingSwaps.length = 0;
  if (hasChanges || added) room.rosterVersion++;
}

function startRoomHand(room) {
  const { game } = room;
  const funded = game.players.filter(player => {
    const type = room.seatChanges.get(player.id), member = humanAt(room, player.id)?.[1];
    if (member?.pending || type === 'bot') return true;
    if (type === 'empty' || player.vacant) return false;
    return player.stack + player.pendingLoan > 0 || (!member && game.canBorrow(player.id));
  }).length;
  if (funded < 2) throw new HttpError(409, '至少需要两个有筹码的座位，请先补入玩家或 AI');
  applySeatChanges(room);
  game.refillBusted(humanSeats(room));
  game.startHand();
  for (const member of room.humans.values()) {
    member.handSeats.set(game.hand, member.seat);
    while (member.handSeats.size > HISTORY_IN_STATE) member.handSeats.delete(member.handSeats.keys().next().value);
  }
}

function readSeatInvite(room, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
    throw new HttpError(403, '座位邀请无效');
  }
  for (const [seat,invite] of room.seatInvites) {
    if (invite.token === token && invite.expiresAt > Date.now()) return seat;
  }
  throw new HttpError(403, '座位邀请已失效，请房主重新发送');
}

function resetGame(room) {
  applySeatChanges(room);
  const humans = [...room.humans.values()];
  const { seatCount, aiLevel, players } = room.game;
  const game = new Game({ seatCount, aiLevel, stack: 2000 });
  game.players.forEach(player => { player.isHuman = false; });
  for (const player of players) if (player.vacant) game.replaceSeat(player.id, { vacant: true });
  for (const human of humans) {
    const player = game.players[human.seat];
    if (!player) continue;
    player.name = human.name;
    player.isHuman = !human.away;
    human.handSeats.clear();
  }
  room.game = game;
  room.writesHand = null;
  room.rosterVersion++;
  room.aiMemory = {};
  room.emoteCooldowns = {};
  room.seatInvites.clear();
  room.recent.clear();
}

/* ------------------------------------------------------------------ *
 * 视角状态：把请求者的座位旋转到 0 号座，客户端只认识这个视角
 * ------------------------------------------------------------------ */

function buildState(room, seat, spectator = false) {
  const game = room.game;
  const count = game.players.length;
  const viewer = spectator ? null : humanAt(room,seat)?.[1];
  const away = !!viewer?.away;
  const waiting = !!viewer?.pending;
  const host = !spectator && room.hostSeat === seat;
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
    const humanSeat = humanAt(room,i)?.[1];
    players[map(i)] = {
      id: map(i),
      absoluteSeat: i,
      name: player.name,
      occupantName: humanSeat?.name || player.name,
      stack: player.stack,
      debt: player.debt,
      pendingLoan: spectator ? 0 : player.pendingLoan,
      net: spectator ? 0 : player.net,
      loans: spectator || waiting ? [] : (i === seat ? player.loans.map(loan => ({ ...loan })) : []),
      // 只下发自己的底牌，其他人的牌在摊牌时通过 result.revealed 公开；观战者看不到任何底牌。
      hole: spectator || waiting ? [] : (i === seat ? [...player.hole] : []),
      folded: player.folded,
      bet: player.bet,
      total: player.total,
      lastAction: player.lastAction,
      isHuman: !!player.isHuman,
      human: !!humanSeat,
      away: !!humanSeat?.away,
      vacant: !!player.vacant,
      joining: !!humanSeat?.pending,
      nextSeatType: room.seatChanges.get(i) || null,
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
  const playedSeat = viewer?.handSeats.get(game.hand);
  const heroDelta = game.result && playedSeat != null ? (game.history[0]?.deltas[playedSeat] || 0) : 0;

  const history = game.history.slice(0, HISTORY_IN_STATE).map(hand => {
    const ownedSeat = viewer?.handSeats.get(hand.hand);
    return {
      hand: hand.hand,
      board: [...hand.board],
      heroCards: [...(hand.privateHands[ownedSeat] || [])],
      deltas: remapList(hand.deltas),
      names: remapList(hand.names),
      events: hand.events.map(remapEvent),
      result: remapResult(hand.result, hand.deltas[ownedSeat] || 0),
      stacks: remapList(hand.stacks)
    };
  });

  // AI 辅助只在自己行动时使用；不在自己回合时不下发，省一半流量。
  const actionOptions = spectator || away || waiting ? null : game.legal(seat);
  let reviewView = null;
  if (actionOptions) {
    const view = game.publicView(seat);
    reviewView = {
      ...view,
      seat: 0,
      button: map(view.button),
      sbSeat: map(view.sbSeat),
      bbSeat: map(view.bbSeat),
      players: remapList(view.players.map(player => ({ ...player, id: map(player.id) }))),
      events: view.events.map(remapEvent)
    };
  }

  return {
    code: room.code,
    version: room.version,
    host,
    spectator,
    away,
    waiting,
    rosterVersion: room.rosterVersion,
    pendingSwaps: host ? room.pendingSwaps : [],
    awayReason: spectator ? null : (viewer?.awayReason || null),
    spectators: room.spectators.size,
    humans: room.humans.size,
    turnKey: room.turnKey,
    turnRemaining: spectator || away || waiting ? 0 : (game.actor != null ? Math.max(0, room.actorSince + (room.turnMs || TURN_MS) - Date.now()) : 0),
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
    net: spectator || waiting ? 0 : (self.net || 0),
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

function autoAct(room, seat, reason = 'timeout') {
  const game = room.game;
  const legal = game.legal(seat);
  if (!legal) return;
  try { game.act(seat, legal.canCheck ? 'check' : 'fold', 0, {automatic: true}); } catch (error) {
    console.warn('[river] 自动行动失败：', error.message);
  }
  // 30 秒不响应：先自动过牌/弃牌，座位交给 AI 代打；token 保留，可点「重新接管」。
  if (!markAway(room, seat, reason)) bump(room);
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
    const human = humanAt(room,actor)?.[1];
    if (human && !human.away && !human.pending) {
      if (!room.actorSince) room.actorSince = now;
      const activeSince = Math.max(room.actorSince || now, human.lastActive || 0);
      if (now - activeSince > AFK_MS) autoAct(room, actor, 'afk');
      else if (now - room.actorSince > (room.turnMs || TURN_MS)) autoAct(room, actor, 'timeout');
      continue;
    }
    if (!room.nextThinkAt) {
      room.nextThinkAt = now + THINK_MIN_MS + Math.random() * THINK_SPREAD_MS;
    } else if (now >= room.nextThinkAt) {
      room.nextThinkAt = 0;
      botAct(room, actor);
    }
  }
}

function cleanup() {
  const now = Date.now();
  rankings.cleanup(now);
  for (const room of rooms.values()) {
    if (now - room.lastActivity > IDLE_TTL_MS || now - room.createdAt > MAX_TTL_MS) {
      rooms.delete(room.code);
    }
  }
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
  if (room.kicked?.has(token)) throw new HttpError(403, '你已被房主移出房间');
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
    sendJson(req, res, 200, { token, state: buildState(room, 0) });
    return;
  }

  const code = String(segments[2]).toUpperCase();

  if (segments[3] === 'lobby') {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '不支持的请求方法');
    const room = rooms.get(code);
    if (!room) throw new HttpError(404, '房间不存在或已关闭');
    const invite = url.searchParams.get('invite');
    const invitedSeat = invite === null ? null : readSeatInvite(room,invite);
    const humanSeats = new Set([...room.humans.values()].map(human => human.seat));
    const awaySeats = new Set([...room.humans.values()].filter(human => human.away).map(human => human.seat));
    sendJson(req, res, 200, {
      code: room.code,
      seatCount: room.game.players.length,
      aiLevel: room.game.aiLevel,
      turnMs: room.turnMs || TURN_MS,
      phase: room.game.phase,
      invitedSeat,
      players: room.game.players.map(player => ({
        id: player.id,
        name: player.name,
        stack: player.stack,
        isHuman: !!player.isHuman,
        human: humanSeats.has(player.id),
        away: awaySeats.has(player.id),
        vacant: (room.seatChanges.get(player.id) || (player.vacant?'empty':'bot'))==='empty',
        available: invitedSeat===player.id || !humanSeats.has(player.id)
      }))
    });
    return;
  }

  if (segments[3] === 'join') {
    if (method !== 'POST') throw new HttpError(405, '不支持的请求方法');
    const body = await readJson(req);
    const room = rooms.get(code);
    if (!room) throw new HttpError(404, '房间不存在或已关闭');
    if (body.spectate) {
      const token = randomBytes(24).toString('base64url');
      room.spectators.set(token, { name: cleanName(body.name), joinedAt: Date.now(), lastSeen: Date.now() });
      bump(room);
      sendJson(req, res, 200, { token, spectator: true, state: buildState(room, 0, true) });
      return;
    }
    const attempt = typeof body.requestId==='string'&&/^[0-9a-f-]{32,36}$/i.test(body.requestId) ? body.requestId : null;
    const previous = attempt && room.joins.get(attempt);
    if (previous) {
      const member = room.humans.get(previous);
      if (!member) throw new HttpError(403, '这个座位已释放');
      sendJson(req, res, 200, { token:previous, state:buildState(room,member.seat) });
      return;
    }
    let seat;
    if (body.invite != null) {
      seat = readSeatInvite(room,body.invite);
      if (seat === room.hostSeat) throw new HttpError(409, '该座位现在由房主使用');
      const previousMember = humanAt(room,seat);
      if (previousMember) removeHuman(room,previousMember[0],true);
    } else {
      if (body.reclaim) throw new HttpError(403, '接替真人需要房主的座位邀请');
      seat = body.seat == null ? pickJoinSeat(room) : seatNumber(room,body.seat);
      if (seat === null) throw new HttpError(409, '房间已满');
      if (humanAt(room,seat)) throw new HttpError(409, '这个座位已经有人了');
    }
    const token = addHuman(room, seat, cleanName(body.name));
    if (attempt) {
      room.joins.set(attempt,token);
      while (room.joins.size>128) room.joins.delete(room.joins.keys().next().value);
    }
    bump(room);
    sendJson(req, res, 200, { token, state: buildState(room, seat) });
    return;
  }

  if (segments[3]) throw new HttpError(404, '接口不存在');

  if (method === 'GET' || method === 'HEAD') {
    const { room, human, spectator } = authRoom(req, code);
    const seat = human ? human.seat : 0;
    const active = url.searchParams.get('active') === '1';
    if (human && active) {
      human.lastActive = Date.now();
      if (human.away && human.awayReason === 'afk') { reclaimHuman(room, human); bump(room); }
    }
    const since = Number(url.searchParams.get('since'));
    if (Number.isFinite(since) && since === room.version) {
      sendJson(req, res, 200, { unchanged: true });
    } else {
      sendJson(req, res, 200, { state: buildState(room, seat, spectator) });
    }
    return;
  }

  if (method !== 'POST') throw new HttpError(405, '不支持的请求方法');
  const body = await readJson(req);
  const { room, human, token, spectator } = authRoom(req, code);
  if (human) human.lastActive = Date.now();
  const op = String(body.op || '');
  if (op === 'leave') {
    if (spectator) removeSpectator(room, token);
    else removeHuman(room, token);
    if (rooms.has(code)) bump(room);
    sendJson(req, res, 200, { ok: true });
    return;
  }
  if (spectator) throw new HttpError(403, '观战模式不能操作牌局');
  if (human.away && op !== 'reclaim' && op !== 'away') throw new HttpError(409, '座位暂由 AI 代打，请先点“重新接管”');
  if (human.pending && ['action','emote','borrow','repay','away'].includes(op)) throw new HttpError(409, '下一手发牌后可以操作');
  const requestId = body.requestId ? String(body.requestId) : '';
  const dedupeKey = requestId ? `${token}:${requestId}` : '';
  if (dedupeKey && room.recent.has(dedupeKey)) {
    sendJson(req, res, 200, { ...room.recent.get(dedupeKey), state: buildState(room, human.seat) });
    return;
  }

  const game = room.game;
  const isHost = room.hostSeat === human.seat;
  const extra = {};
  if (['kick','replaceBot','seatInvite','swapSeats'].includes(op)) {
    if (!isHost) throw new HttpError(403,'只有房主可以管理座位');
    if (body.rosterVersion != null && body.rosterVersion !== room.rosterVersion) {
      throw new HttpError(409,'座位已更新，请重新打开房间设置');
    }
  }

  if (op === 'reclaim') {
    reclaimHuman(room, human);
  } else if (op === 'away') {
    markAway(room, human.seat, 'manual');
  } else if (op === 'kick' || op === 'replaceBot' || op === 'seatInvite') {
    const target = op === 'kick' && body.absoluteSeat == null
      ? (seatNumber(room,body.seat)+human.seat)%game.players.length
      : seatNumber(room,body.absoluteSeat??body.seat);
    if (target === human.seat) throw new HttpError(400,'房主席位可以换位');
    const planned = room.seatChanges.get(target);
    if (op === 'kick' && !humanAt(room,target) && (planned==='empty'||!planned&&game.players[target].vacant)) {
      throw new HttpError(409,'这个座位已经空了');
    }
    if (op === 'seatInvite') {
      const invite = {token:randomBytes(24).toString('base64url'),expiresAt:Date.now()+SEAT_INVITE_MS};
      room.seatInvites.set(target,invite);
      extra.invite = {...invite,seat:target};
    } else {
      changeSeat(room,target,op==='kick'?'empty':'bot');
    }
  } else if (op === 'swapSeats') {
    const a=seatNumber(room,body.a),b=seatNumber(room,body.b);
    if (a===b) throw new HttpError(400,'请选择两个不同的座位');
    if(game.phase==='idle')swapSeats(room,a,b);
    else room.pendingSwaps.push([a,b]);
    room.rosterVersion++;
  } else if (op === 'start') {
    if (!isHost) throw new HttpError(403, '只有房主可以开始牌局');
    if (!['idle', 'complete'].includes(game.phase)) throw new HttpError(409, '牌局正在进行中');
    startRoomHand(room);
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
    if (remaining > 0) throw new HttpError(429, `表情冷却中，还需 ${remaining < 1000 ? (remaining / 1000).toFixed(1) : Math.ceil(remaining / 1000)} 秒`);
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
    room.recent.set(dedupeKey, extra);
    while (room.recent.size > 300) room.recent.delete(room.recent.keys().next().value);
  }
  sendJson(req, res, 200, { ...extra,state: buildState(room, human.seat) });
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
  const headers = {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  };
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'api') {
    if (segments[1] === 'leaderboard') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405,'不支持的请求方法');
      if (segments.length===2) {
        sendJson(req,res,200,rankings.list());
      } else if (segments.length===3) {
        const record=await rankings.get(segments[2]);
        if(!record)throw new HttpError(404,'记录已过期或不存在');
        sendJson(req,res,200,{record});
      } else throw new HttpError(404,'接口不存在');
      return;
    }
    if (segments[1] === 'server-info') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持的请求方法');
      const port = server.address()?.port || PORT;
      const loopback = ['127.0.0.1','::1','localhost'].includes(HOST);
      sendJson(req, res, 200, {
        urls: loopback ? [] : lanUrls(port),
        port,
        origin: `${req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')}://${req.headers.host}`
      });
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

try {await rankings.load(resolve(process.env.RIVER_DATA_DIR||ROOT,'.leaderboard.json'));}
catch(error){console.warn('[river] 排行榜暂未加载',error.code||error.name);}
server.listen(PORT, HOST, () => {
  const port = server.address().port;
  console.log('');
  console.log('  River Room 联机服务已启动');
  console.log(`  本机:     http://127.0.0.1:${port}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const address of lanUrls(port)) console.log(`  局域网:   ${address}`);
    console.log('  同一 Wi-Fi 下的朋友打开局域网地址即可加入。');
  }
  console.log('  房间数据保存在内存中，重启服务会清空。按 Ctrl+C 停止。');
  console.log('');
});

setInterval(tick, TICK_MS);
setInterval(cleanup, 60000);
function shutdown() {
  console.log('\n正在关闭 River Room 联机服务…');
  server.close(async()=>{await rankings.flush();process.exit(0);});
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGINT',shutdown);
process.once('SIGTERM',shutdown);
