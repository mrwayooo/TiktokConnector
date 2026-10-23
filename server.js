import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TikTokLiveConnection,
  WebcastEvent,
  ControlEvent,
} from 'tiktok-live-connector';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '16kb' }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.BRIDGE_API_KEY; // ใช้กับ Roblox Poller เท่านั้น
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // ใช้ล็อกอินหน้าเว็บ

if (!API_KEY) {
  console.error('Missing BRIDGE_API_KEY environment variable. Set one before starting.');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error('Missing ADMIN_PASSWORD environment variable. Set one before starting.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Gift Mapping: ชื่อ Gift จาก TikTok -> ชื่อ Ability ใน Roblox       */
/* ------------------------------------------------------------------ */
const GIFT_TO_ABILITY = {
  'Rose': 'Tung LV.1',
  'Finger Heart': 'Tung LV.2',
  'Rosa': 'Tung LV.3',
  'GG': 'Ghost LV.1',
  'Gala GG': 'Ghost LV.1',
  'Good Game': 'Ghost LV.1',
  'Tiny Diny': 'Ghost LV.2',
  'Dinosaur': 'Ghost LV.2',
  'Perfume': 'Ghost LV.3',
  'Perfume Box': 'Ghost LV.3',
  'Doughnut': 'Meteor',
  'Donut': 'Meteor',
  'Cap': 'No Jar',
  'Cowboy Hat': 'No Jar',
  'Confetti': 'Reset',
  'Party Popper': 'Reset',
  'Music Note': 'Totem Attack',
  'Raving Snail': 'Web',
  'Paper Crane': 'Spawn Jar', // TODO: ยังไม่ยืนยันว่า Roblox มี Handler
  'Baby Hippo': 'Shield',
  'Moo Deng': 'Shield',
  'Hand Heart': 'Attack +1 Win',
  'Racing Car': 'Speed', // TODO: ยืนยันชื่อ Gift จริง + Handler ก่อนใช้
};

const giftLookup = new Map(
  Object.entries(GIFT_TO_ABILITY).map(([gift, ability]) => [gift.toLowerCase(), ability])
);
const abilityNames = new Set(Object.values(GIFT_TO_ABILITY));

function resolveAbility(giftName) {
  return giftLookup.get(String(giftName).trim().toLowerCase()) ?? null;
}

/* ------------------------------------------------------------------ */
/* Event Queue (ใช้ร่วมกันทั้ง Mock และ TikTok จริง)                    */
/* ------------------------------------------------------------------ */
const MAX_QUEUE = 200;
const MAX_REPEAT = 20;
const events = [];
let nextId = 1;

function enqueue({ giftName, ability, username, source }) {
  if (events.length >= MAX_QUEUE) return null;
  const event = {
    id: nextId++,
    type: 'GIFT',
    giftName, // ชื่อ Gift ตามที่ TikTok ส่งมา (หรือชื่อที่ใช้ทดสอบ)
    ability, // ชื่อ Ability ที่แปลงแล้ว
    username,
    createdAt: Date.now(),
    source,
  };
  events.push(event);
  return event;
}

/* ------------------------------------------------------------------ */
/* Auth                                                               */
/*  - x-bridge-key  : Roblox Poller (ไม่เคยส่งให้ Browser)             */
/*  - session cookie: เจ้าของ LIVE ที่ล็อกอินผ่านหน้าเว็บ                */
/* ------------------------------------------------------------------ */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiresAt

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hasSession(req) {
  const token = parseCookies(req.get('cookie')).session;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function hasBridgeKey(req) {
  const key = req.get('x-bridge-key');
  return typeof key === 'string' && safeEqual(key, API_KEY);
}

function requireSession(req, res, next) {
  if (!hasSession(req)) return res.status(401).json({ error: 'Please log in first.' });
  next();
}

function requireBridgeKey(req, res, next) {
  if (!hasBridgeKey(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireKeyOrSession(req, res, next) {
  if (!hasBridgeKey(req) && !hasSession(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// จำกัดการเดารหัสผ่าน: 10 ครั้ง / 15 นาที ต่อ IP
const loginFails = new Map();
function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (rec.resetAt < Date.now()) {
    loginFails.delete(ip);
    return false;
  }
  return rec.count >= 10;
}
function recordLoginFail(ip) {
  const rec = loginFails.get(ip);
  if (!rec || rec.resetAt < Date.now()) {
    loginFails.set(ip, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
  } else {
    rec.count++;
  }
}

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (loginBlocked(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || !safeEqual(password, ADMIN_PASSWORD)) {
    recordLoginFail(ip);
    return res.status(401).json({ error: 'Wrong password.' });
  }
  loginFails.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader(
    'Set-Cookie',
    `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`
  );
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.get('cookie')).session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* TikTok LIVE connection (state machine: idle/connecting/connected)   */
/* ------------------------------------------------------------------ */
const bridge = {
  state: 'idle',
  username: null,
  roomId: null,
  since: null,
  connection: null,
  gen: 0, // เพิ่มทุกครั้งที่เริ่ม/ยกเลิก เพื่อกัน Event จาก Connection เก่า
  giftsSeen: 0,
  giftsQueued: 0,
  lastError: null,
};

const streaks = new Map(); // `${userId}:${giftId}` -> repeatCount ล่าสุดที่นับไปแล้ว

function publicStatus() {
  return {
    state: bridge.state,
    username: bridge.username,
    roomId: bridge.roomId,
    since: bridge.since,
    giftsSeen: bridge.giftsSeen,
    giftsQueued: bridge.giftsQueued,
    queuedEvents: events.length,
    lastError: bridge.lastError,
  };
}

function resetBridge() {
  bridge.state = 'idle';
  bridge.username = null;
  bridge.roomId = null;
  bridge.since = null;
  bridge.connection = null;
  streaks.clear();
}

function safeDisconnect(connection) {
  try {
    connection?.disconnect();
  } catch (err) {
    console.warn('disconnect error:', err?.message);
  }
}

function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^@/, '');
  return /^[a-zA-Z0-9._]{1,24}$/.test(name) ? name : null;
}

function friendlyError(err) {
  if (err?.name === 'UserOfflineError') return 'This user is not LIVE right now.';
  if (err?.name === 'InvalidUniqueIdError') return 'Invalid TikTok username.';
  return `Could not connect to TikTok LIVE: ${String(err?.message || 'unknown error').slice(0, 200)}`;
}

function handleGift(data) {
  const giftName = data.giftDetails?.giftName ?? data.giftName;
  const giftType = data.giftDetails?.giftType ?? data.giftType;
  const username = data.user?.uniqueId ?? data.uniqueId ?? 'UnknownViewer';
  const userId = data.user?.userId ?? data.userId ?? username;
  const repeatCount = Number.isInteger(data.repeatCount) ? data.repeatCount : 1;

  if (typeof giftName !== 'string' || !giftName) return;
  bridge.giftsSeen++;

  const ability = resolveAbility(giftName);
  if (!ability) {
    console.log(`[gift] ${username} sent "${giftName}" (no mapping, ignored)`);
    return;
  }

  // จำนวนที่ต้องยิงในครั้งนี้
  let count = 1;
  if (giftType === 1) {
    // Gift แบบ streak: event มาซ้ำโดย repeatCount เพิ่มขึ้นเรื่อย ๆ
    // นับเฉพาะส่วนที่เพิ่ม (delta) เพื่อให้ตอบสนองทันทีและไม่ยิงซ้ำ
    const key = `${userId}:${data.giftId}`;
    const last = streaks.get(key) ?? 0;
    count = Math.max(repeatCount - last, 0);
    if (data.repeatEnd) streaks.delete(key);
    else streaks.set(key, repeatCount);
  } else {
    count = Math.max(repeatCount, 1);
  }
  count = Math.min(count, MAX_REPEAT);
  if (count === 0) return;

  let queued = 0;
  for (let i = 0; i < count; i++) {
    if (!enqueue({ giftName, ability, username, source: 'tiktok' })) {
      console.warn('[queue] full, dropping gift event');
      break;
    }
    queued++;
  }
  bridge.giftsQueued += queued;
  console.log(`[gift] ${username} sent ${giftName} x${count} -> ${ability}`);
}

function attachHandlers(connection, gen) {
  connection.on(WebcastEvent.GIFT, (data) => {
    if (gen !== bridge.gen) return;
    try {
      handleGift(data);
    } catch (err) {
      console.error('gift handler error:', err);
    }
  });

  connection.on(ControlEvent.DISCONNECTED, () => {
    if (gen !== bridge.gen) return;
    console.log('TikTok LIVE disconnected');
    bridge.lastError = 'Disconnected from TikTok LIVE.';
    resetBridge();
  });

  connection.on(WebcastEvent.STREAM_END, () => {
    if (gen !== bridge.gen) return;
    console.log('LIVE stream ended');
    bridge.lastError = 'The LIVE stream has ended.';
    safeDisconnect(connection);
    resetBridge();
  });

  connection.on(ControlEvent.ERROR, (err) => {
    console.error('TikTok connection error:', err?.message || err);
  });
}

app.post('/api/connect', requireSession, async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  if (!username) {
    return res.status(400).json({ error: 'Please enter a valid TikTok username.' });
  }
  if (bridge.state !== 'idle') {
    return res.status(409).json({
      error: `Already ${bridge.state}. Disconnect first.`,
      status: publicStatus(),
    });
  }

  const gen = ++bridge.gen;
  bridge.state = 'connecting';
  bridge.username = username;
  bridge.lastError = null;
  bridge.giftsSeen = 0;
  bridge.giftsQueued = 0;

  const connection = new TikTokLiveConnection(username, { enableExtendedGiftInfo: true });
  bridge.connection = connection;
  attachHandlers(connection, gen);

  try {
    const state = await connection.connect();
    if (gen !== bridge.gen) {
      // ถูกยกเลิกระหว่างกำลังเชื่อม
      safeDisconnect(connection);
      return res.status(409).json({ error: 'Connection was cancelled.' });
    }
    bridge.state = 'connected';
    bridge.roomId = state?.roomId ?? null;
    bridge.since = Date.now();
    console.log(`Connected to @${username} (room ${bridge.roomId})`);
    res.json({ ok: true, message: `Connected to @${username}.`, status: publicStatus() });
  } catch (err) {
    console.error('connect failed:', err?.message || err);
    if (gen === bridge.gen) {
      safeDisconnect(connection);
      resetBridge();
      bridge.lastError = friendlyError(err);
    }
    if (!res.headersSent) res.status(502).json({ error: friendlyError(err) });
  }
});

app.post('/api/disconnect', requireSession, (_req, res) => {
  if (bridge.state === 'idle') {
    return res.json({ ok: true, message: 'Already disconnected.', status: publicStatus() });
  }
  bridge.gen++; // ทำให้ Event/Promise ของ Connection เก่าถูกทิ้ง
  safeDisconnect(bridge.connection);
  resetBridge();
  bridge.lastError = null;
  res.json({ ok: true, message: 'Disconnected.', status: publicStatus() });
});

app.get('/api/status', requireSession, (_req, res) => {
  res.json(publicStatus());
});

/* ------------------------------------------------------------------ */
/* Mock Gift (ใช้ทดสอบ) — ต้องมี x-bridge-key หรือ session              */
/* ------------------------------------------------------------------ */
app.get('/api/gifts', requireSession, (_req, res) => {
  res.json({ gifts: Object.keys(GIFT_TO_ABILITY), abilities: [...abilityNames] });
});

app.post('/api/test-gift', requireKeyOrSession, (req, res) => {
  const giftName = typeof req.body?.giftName === 'string' ? req.body.giftName.trim() : '';
  const username =
    (typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 64) : '') ||
    'MockViewer';
  const repeatCount = Number.isInteger(req.body?.repeatCount)
    ? Math.min(Math.max(req.body.repeatCount, 1), MAX_REPEAT)
    : 1;

  // รับได้ทั้งชื่อ Gift ของ TikTok และชื่อ Ability ตรง ๆ (สำหรับเทสต์)
  const ability = resolveAbility(giftName) ?? (abilityNames.has(giftName) ? giftName : null);
  if (!ability) {
    return res.status(400).json({
      error: 'Unknown mock gift',
      allowedGifts: Object.keys(GIFT_TO_ABILITY),
      allowedAbilities: [...abilityNames],
    });
  }
  if (events.length + repeatCount > MAX_QUEUE) {
    return res.status(429).json({ error: 'Event queue full' });
  }

  const created = [];
  for (let i = 0; i < repeatCount; i++) {
    created.push(enqueue({ giftName, ability, username, source: 'mock' }));
  }
  res.json({ ok: true, created });
});

/* ------------------------------------------------------------------ */
/* Roblox Poller                                                      */
/* ------------------------------------------------------------------ */
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'TikTok-Roblox Bridge', queuedEvents: events.length });
});

// พฤติกรรมเดิม: ดึงแล้วลบออกจากคิวทันที (ยังไม่เพิ่ม ack — รอดู Poller ก่อน)
app.get('/api/events', requireBridgeKey, (_req, res) => {
  const batch = events.splice(0, 25);
  res.json({ events: batch });
});

/* ------------------------------------------------------------------ */
/* Frontend (เสิร์ฟเฉพาะไฟล์เดียว ไม่เปิดทั้งโฟลเดอร์)                      */
/* ------------------------------------------------------------------ */
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// JSON ผิดรูปแบบ -> 400 แทน stack trace
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(400).json({ error: 'Invalid request body.' });
  }
  next(err);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TikTok-Roblox Bridge listening on port ${PORT}`);
});