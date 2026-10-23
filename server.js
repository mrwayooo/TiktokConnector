import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TikTokLiveConnection,
  WebcastEvent,
  ControlEvent,
} from 'tiktok-live-connector';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// หลัง Proxy ของโฮสต์ (Railway/Render) ตั้ง TRUST_PROXY=1 เพื่อให้รู้ IP จริงของผู้ใช้
// (ใช้กับระบบกันเดารหัสผ่าน ไม่งั้นทุกคนจะถูกนับเป็น IP เดียวกัน)
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.use(express.json({ limit: '16kb' }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.BRIDGE_API_KEY; // ใช้กับ Roblox Poller (ของเจ้าของเกม) เท่านั้น
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // รหัสของ Admin (ID: admin)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 20);

if (!API_KEY) {
  console.error('Missing BRIDGE_API_KEY environment variable. Set one before starting.');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error('Missing ADMIN_PASSWORD environment variable. Set one before starting.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Gift Mapping: ชื่อ Gift จาก TikTok -> ชื่อ Ability                   */
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
  'Paper Crane': 'Spawn Jar', // ยังไม่มี Handler ใน Roblox
  'Baby Hippo': 'Shield',
  'Moo Deng': 'Shield',
  'Hand Heart': 'Attack +1 Win',
  'Racing Car': 'Speed', // ยังไม่มี Handler ใน Roblox
};
const NOT_IMPLEMENTED = new Set(['Paper Crane', 'Racing Car']);

const giftLookup = new Map(
  Object.entries(GIFT_TO_ABILITY).map(([gift, ability]) => [gift.toLowerCase(), ability])
);
const abilityNames = new Set(Object.values(GIFT_TO_ABILITY));

function resolveAbility(giftName) {
  return giftLookup.get(String(giftName).trim().toLowerCase()) ?? null;
}

/* ------------------------------------------------------------------ */
/* Tenants (ผู้เช่า) — รหัสผ่านเก็บแบบ hash                              */
/*  - มี FIRESTORE_CREDENTIALS : เก็บใน Google Cloud Firestore          */
/*  - ไม่มี                    : เก็บในไฟล์ DATA_DIR/tenants.json       */
/* ------------------------------------------------------------------ */
const tenants = new Map(); // id (ตัวพิมพ์เล็ก) -> tenant

function createFileStore() {
  const file = path.join(DATA_DIR, 'tenants.json');
  const writeList = (list) => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tenants: list }, null, 2));
    fs.renameSync(tmp, file);
  };
  return {
    name: `file ${file}`,
    async loadAll() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).tenants || [];
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
    async put(t) {
      const k = t.id.toLowerCase();
      writeList([...[...tenants.entries()].filter(([x]) => x !== k).map(([, v]) => v), t]);
    },
    async remove(k) {
      writeList([...tenants.entries()].filter(([x]) => x !== k).map(([, v]) => v));
    },
  };
}

async function createFirestoreStore(raw) {
  const { Firestore } = await import('@google-cloud/firestore');
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const creds = JSON.parse(json);
  const db = new Firestore({
    projectId: creds.project_id,
    credentials: { client_email: creds.client_email, private_key: creds.private_key },
  });
  const col = db.collection(process.env.FIRESTORE_COLLECTION || 'tenants');
  return {
    name: `Firestore ${creds.project_id}/${col.id}`,
    async loadAll() {
      const snap = await col.get();
      return snap.docs.map((d) => d.data());
    },
    async put(t) {
      await col.doc(t.id.toLowerCase()).set(t);
    },
    async remove(k) {
      await col.doc(k).delete();
    },
  };
}

let store;
try {
  store = process.env.FIRESTORE_CREDENTIALS
    ? await createFirestoreStore(process.env.FIRESTORE_CREDENTIALS)
    : createFileStore();
  for (const t of await store.loadAll()) tenants.set(t.id.toLowerCase(), t);
  console.log(`Tenant storage: ${store.name}. Loaded ${tenants.size} tenant(s).`);
} catch (err) {
  console.error('Failed to load tenants, refusing to start:', err.message);
  process.exit(1);
}

// บันทึกก่อน แล้วค่อยใช้ค่าใหม่ในหน่วยความจำ (ถ้าบันทึกพัง ข้อมูลไม่เพี้ยน)
async function saveTenant(t) {
  await store.put(t);
  tenants.set(t.id.toLowerCase(), t);
}

async function deleteTenant(k) {
  await store.remove(k);
  tenants.delete(k);
}

// สำหรับการเปลี่ยนเล็ก ๆ ที่มีผลทันทีในหน่วยความจำอยู่แล้ว: บันทึกเบื้องหลัง
function saveTenantInBackground(t) {
  store.put(t).catch((err) => console.error(`[${t.id}] background save failed:`, err.message));
}

const SAVE_FAILED = { error: 'Could not save. Please try again.' };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

function checkPassword(password, t) {
  const h = crypto.scryptSync(password, t.salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(t.hash, 'hex'));
}

const DUMMY = { id: 'dummy', ...hashPassword('dummy-password') };

function newPassword() {
  return crypto.randomBytes(12).toString('base64url'); // 16 ตัวอักษร
}

function isActive(t) {
  return !t.disabled && (!t.expiresAt || t.expiresAt > Date.now());
}

const key = (t) => t.id.toLowerCase();

function findTenantByRoblox(name) {
  const n = String(name).toLowerCase();
  for (const t of tenants.values()) if (t.robloxName && t.robloxName.toLowerCase() === n) return t;
  return null;
}

/* ------------------------------------------------------------------ */
/* Runtime ต่อผู้เช่า: คิว Gift + การเชื่อม TikTok                       */
/* ------------------------------------------------------------------ */
const MAX_QUEUE = 200;
const MAX_REPEAT = 20;
let nextId = 1;
const BOOT_ID = Date.now().toString(36); // ID ไม่ซ้ำแม้รีสตาร์ท

const runtimes = new Map(); // tenantKey -> runtime
const activeTikTok = new Map(); // tiktok username (พิมพ์เล็ก) -> tenantKey

function getRuntime(k) {
  let rt = runtimes.get(k);
  if (!rt) {
    rt = {
      key: k,
      events: [],
      state: 'idle',
      username: null,
      roomId: null,
      since: null,
      connection: null,
      gen: 0,
      giftsSeen: 0,
      giftsQueued: 0,
      lastError: null,
      streaks: new Map(),
      recent: [], // Gift ล่าสุด แสดงบนหน้าเว็บของผู้ใช้
    };
    runtimes.set(k, rt);
  }
  return rt;
}

const RECENT_MAX = 20;

// บัญชี Test ไม่มีชื่อ Roblox: Gift แสดงบนหน้าเว็บอย่างเดียว ไม่เข้าคิวของเกม
function isTestRuntime(rt) {
  const t = tenants.get(rt.key);
  return !!t && planOf(t) === 'test';
}

function enqueue(rt, { giftName, ability, username, source }) {
  const test = isTestRuntime(rt);
  const full = !test && rt.events.length >= MAX_QUEUE;
  const event = {
    id: `${BOOT_ID}-${nextId++}`,
    type: 'GIFT',
    giftName,
    ability,
    username,
    createdAt: Date.now(),
    source,
  };
  rt.recent.unshift({
    id: event.id,
    giftName,
    ability,
    username,
    source,
    at: event.createdAt,
    delivery: test ? 'web-only' : full ? 'queue-full' : 'game',
  });
  if (rt.recent.length > RECENT_MAX) rt.recent.length = RECENT_MAX;
  if (full) return null;
  if (!test) rt.events.push(event);
  return event;
}

function publicStatus(rt) {
  return {
    state: rt.state,
    username: rt.username,
    roomId: rt.roomId,
    since: rt.since,
    giftsSeen: rt.giftsSeen,
    giftsQueued: rt.giftsQueued,
    queuedEvents: rt.events.length,
    lastError: rt.lastError,
    recent: rt.recent,
  };
}

function resetRuntime(rt) {
  if (rt.username && activeTikTok.get(rt.username.toLowerCase()) === rt.key) {
    activeTikTok.delete(rt.username.toLowerCase());
  }
  rt.state = 'idle';
  rt.username = null;
  rt.roomId = null;
  rt.since = null;
  rt.connection = null;
  rt.streaks.clear();
}

function safeDisconnect(connection) {
  try {
    connection?.disconnect();
  } catch (err) {
    console.warn('disconnect error:', err?.message);
  }
}

function forceStop(rt, reason = null) {
  rt.gen++; // ทำให้ Event/Promise ของ Connection เก่าถูกทิ้ง
  safeDisconnect(rt.connection);
  resetRuntime(rt);
  rt.lastError = reason;
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

function handleGift(rt, data) {
  const giftName = data.giftDetails?.giftName ?? data.giftName;
  const giftType = data.giftDetails?.giftType ?? data.giftType;
  const username = data.user?.uniqueId ?? data.uniqueId ?? 'UnknownViewer';
  const userId = data.user?.userId ?? data.userId ?? username;
  const repeatCount = Number.isInteger(data.repeatCount) ? data.repeatCount : 1;

  if (typeof giftName !== 'string' || !giftName) return;
  rt.giftsSeen++;

  const ability = resolveAbility(giftName);
  if (!ability) {
    console.log(`[${rt.key}] ${username} sent "${giftName}" (no mapping, ignored)`);
    return;
  }

  let count = 1;
  if (giftType === 1) {
    // Gift แบบ streak: นับเฉพาะส่วนที่เพิ่มของ repeatCount
    const sk = `${userId}:${data.giftId}`;
    const last = rt.streaks.get(sk) ?? 0;
    count = Math.max(repeatCount - last, 0);
    if (data.repeatEnd) rt.streaks.delete(sk);
    else rt.streaks.set(sk, repeatCount);
  } else {
    count = Math.max(repeatCount, 1);
  }
  count = Math.min(count, MAX_REPEAT);
  if (count === 0) return;

  let queued = 0;
  for (let i = 0; i < count; i++) {
    if (!enqueue(rt, { giftName, ability, username, source: 'tiktok' })) {
      console.warn(`[${rt.key}] queue full, dropping gift event`);
      break;
    }
    queued++;
  }
  rt.giftsQueued += queued;
  console.log(`[${rt.key}] ${username} sent ${giftName} x${count} -> ${ability}`);
}

function attachHandlers(rt, connection, gen) {
  connection.on(WebcastEvent.GIFT, (data) => {
    if (gen !== rt.gen) return;
    try {
      handleGift(rt, data);
    } catch (err) {
      console.error('gift handler error:', err);
    }
  });

  connection.on(ControlEvent.DISCONNECTED, () => {
    if (gen !== rt.gen) return;
    console.log(`[${rt.key}] TikTok LIVE disconnected`);
    resetRuntime(rt);
    rt.lastError = 'Disconnected from TikTok LIVE.';
  });

  connection.on(WebcastEvent.STREAM_END, () => {
    if (gen !== rt.gen) return;
    console.log(`[${rt.key}] LIVE stream ended`);
    safeDisconnect(connection);
    resetRuntime(rt);
    rt.lastError = 'The LIVE stream has ended.';
  });

  connection.on(ControlEvent.ERROR, (err) => {
    console.error(`[${rt.key}] TikTok connection error:`, err?.message || err);
  });
}

/* ------------------------------------------------------------------ */
/* Auth                                                               */
/*  - x-bridge-key  : Roblox Poller (ของเจ้าของเกม)                    */
/*  - session cookie: Admin (ID "admin") หรือผู้เช่า                    */
/* ------------------------------------------------------------------ */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // จำการล็อกอิน 30 วัน

// Session เป็น token ที่เซ็นด้วย secret จึงไม่หายเมื่อเซิร์ฟเวอร์รีสตาร์ท
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}
const SESSION_SECRET = loadSessionSecret();
// เปลี่ยน ADMIN_PASSWORD แล้ว session ของ admin เดิมใช้ไม่ได้ทันที
const ADMIN_VERSION = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex').slice(0, 16);

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp && p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

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

function getAuth(req) {
  const token = parseCookies(req.get('cookie')).session;
  if (!token) return null;
  const p = verifyToken(token);
  if (!p) return null;
  if (p.r === 'admin') return p.v === ADMIN_VERSION ? { role: 'admin' } : null;
  const tenant = tenants.get(p.k);
  if (!tenant || !isActive(tenant) || (tenant.sessionVersion ?? 0) !== p.v) return null;
  return { role: 'tenant', tenant };
}

// ทำให้ทุก session ของผู้เช่าคนนี้ใช้ไม่ได้ (เช่น รีเซ็ตรหัส / ปิดบัญชี)
function dropSessions(k) {
  const t = tenants.get(k);
  if (!t) return;
  t.sessionVersion = (t.sessionVersion ?? 0) + 1;
  saveTenantInBackground(t);
}

function hasBridgeKey(req) {
  const k = req.get('x-bridge-key');
  return typeof k === 'string' && safeEqual(k, API_KEY);
}

function requireAuth(req, res, next) {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: 'Please log in first.' });
  req.auth = auth;
  next();
}

function requireAdmin(req, res, next) {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: 'Please log in first.' });
  if (auth.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  req.auth = auth;
  next();
}

function requireTenant(req, res, next) {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: 'Please log in first.' });
  if (auth.role !== 'tenant') {
    return res.status(403).json({ error: 'Log in with a tenant account to use this.' });
  }
  req.auth = auth;
  req.tenant = auth.tenant;
  next();
}

function requireBridgeKey(req, res, next) {
  if (!hasBridgeKey(req)) return res.status(401).json({ error: 'Unauthorized' });
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
  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!id || !password) return res.status(400).json({ error: 'ID and password are required.' });

  let session = null;
  if (id.toLowerCase() === 'admin') {
    if (safeEqual(password, ADMIN_PASSWORD)) session = { r: 'admin', v: ADMIN_VERSION };
  } else {
    const t = tenants.get(id.toLowerCase());
    const okPw = checkPassword(password, t ?? DUMMY);
    if (t && okPw) {
      if (!isActive(t)) {
        return res.status(403).json({ error: 'This account is disabled or expired.' });
      }
      session = { r: 'tenant', k: key(t), v: t.sessionVersion ?? 0 };
    }
  }

  if (!session) {
    recordLoginFail(ip);
    return res.status(401).json({ error: 'Wrong ID or password.' });
  }

  loginFails.delete(ip);
  const token = signToken({ ...session, exp: Date.now() + SESSION_TTL_MS });
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader(
    'Set-Cookie',
    `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`
  );
  res.json({ ok: true, role: session.r });
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  if (req.auth.role === 'admin') return res.json({ role: 'admin', id: 'admin' });
  const t = req.auth.tenant;
  res.json({
    role: 'tenant',
    id: t.id,
    robloxName: t.robloxName,
    expiresAt: t.expiresAt,
    plan: planOf(t),
    lastTikTok: t.lastTikTok ?? null,
  });
});

/* ------------------------------------------------------------------ */
/* ผู้เช่า: Connect / Disconnect / Status / Mock                       */
/* ------------------------------------------------------------------ */
app.get('/api/status', requireTenant, (req, res) => {
  res.json({ ...publicStatus(getRuntime(key(req.tenant))), lastTikTok: req.tenant.lastTikTok ?? null });
});

app.post('/api/connect', requireTenant, async (req, res) => {
  const rt = getRuntime(key(req.tenant));
  const username = normalizeUsername(req.body?.username);
  if (!username) {
    return res.status(400).json({ error: 'Please enter a valid TikTok username.' });
  }
  if (rt.state !== 'idle') {
    return res.status(409).json({
      error: `Already ${rt.state}. Disconnect first.`,
      status: publicStatus(rt),
    });
  }
  const owner = activeTikTok.get(username.toLowerCase());
  if (owner && owner !== rt.key) {
    return res.status(409).json({ error: 'This TikTok account is already in use by another user.' });
  }
  const busyCount = [...runtimes.values()].filter((r) => r.state !== 'idle').length;
  if (busyCount >= MAX_CONNECTIONS) {
    return res.status(503).json({ error: 'Server is at its connection limit. Try again later.' });
  }

  const gen = ++rt.gen;
  rt.state = 'connecting';
  rt.username = username;
  rt.lastError = null;
  rt.giftsSeen = 0;
  rt.giftsQueued = 0;
  activeTikTok.set(username.toLowerCase(), rt.key);

  const connection = new TikTokLiveConnection(username, { enableExtendedGiftInfo: true });
  rt.connection = connection;
  attachHandlers(rt, connection, gen);

  try {
    const state = await connection.connect();
    if (gen !== rt.gen) {
      safeDisconnect(connection);
      return res.status(409).json({ error: 'Connection was cancelled.' });
    }
    rt.state = 'connected';
    rt.roomId = state?.roomId ?? null;
    rt.since = Date.now();
    if (req.tenant.lastTikTok !== username) {
      req.tenant.lastTikTok = username; // จำไว้ให้กด Connect ครั้งหน้าได้ทันที
      saveTenantInBackground(req.tenant);
    }
    console.log(`[${rt.key}] connected to @${username} (room ${rt.roomId})`);
    res.json({ ok: true, message: `Connected to @${username}.`, status: publicStatus(rt) });
  } catch (err) {
    console.error(`[${rt.key}] connect failed:`, err?.message || err);
    if (gen === rt.gen) {
      safeDisconnect(connection);
      resetRuntime(rt);
      rt.lastError = friendlyError(err);
    }
    if (!res.headersSent) res.status(502).json({ error: friendlyError(err) });
  }
});

app.post('/api/disconnect', requireTenant, (req, res) => {
  const rt = getRuntime(key(req.tenant));
  if (rt.state !== 'idle') forceStop(rt, null);
  res.json({ ok: true, message: 'Disconnected.', status: publicStatus(rt) });
});

app.get('/api/gifts', requireAuth, (_req, res) => {
  res.json({
    gifts: Object.entries(GIFT_TO_ABILITY).map(([gift, ability]) => ({
      gift,
      ability,
      implemented: !NOT_IMPLEMENTED.has(gift),
    })),
    abilities: [...abilityNames],
  });
});

// Mock Gift: ผู้เช่าส่งเข้าคิวตัวเอง / Admin หรือ x-bridge-key ต้องระบุ tenantId
app.post('/api/test-gift', (req, res) => {
  const auth = getAuth(req);
  let tenant = null;
  if (auth?.role === 'tenant') {
    tenant = auth.tenant;
  } else if (auth?.role === 'admin' || hasBridgeKey(req)) {
    tenant = tenants.get(String(req.body?.tenantId ?? '').toLowerCase()) ?? null;
    if (!tenant) return res.status(400).json({ error: 'tenantId is required.' });
  } else {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isActive(tenant)) return res.status(403).json({ error: 'Tenant is disabled or expired.' });

  const rt = getRuntime(key(tenant));
  const giftName = typeof req.body?.giftName === 'string' ? req.body.giftName.trim() : '';
  const username =
    (typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 64) : '') ||
    'MockViewer';
  const repeatCount = Number.isInteger(req.body?.repeatCount)
    ? Math.min(Math.max(req.body.repeatCount, 1), MAX_REPEAT)
    : 1;

  const ability = resolveAbility(giftName) ?? (abilityNames.has(giftName) ? giftName : null);
  if (!ability) {
    return res.status(400).json({
      error: 'Unknown mock gift',
      allowedGifts: Object.keys(GIFT_TO_ABILITY),
    });
  }
  if (!isTestRuntime(rt) && rt.events.length + repeatCount > MAX_QUEUE) {
    return res.status(429).json({ error: 'Event queue full' });
  }

  const created = [];
  for (let i = 0; i < repeatCount; i++) {
    created.push(enqueue(rt, { giftName, ability, username, source: 'mock' }));
  }
  res.json({ ok: true, created });
});

/* ------------------------------------------------------------------ */
/* Admin: จัดการผู้เช่า                                                */
/* ------------------------------------------------------------------ */
// lifetime = ซื้อขาด (ไม่มีวันหมดอายุ), rental = เช่า (มีวันหมดอายุ)
function planOf(t) {
  return t.plan ?? (t.expiresAt ? 'rental' : 'lifetime');
}

function publicTenant(t) {
  const rt = runtimes.get(key(t));
  return {
    id: t.id,
    robloxName: t.robloxName,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    plan: planOf(t),
    disabled: !!t.disabled,
    active: isActive(t),
    tiktok: rt && rt.state !== 'idle' ? { state: rt.state, username: rt.username } : null,
    queued: rt ? rt.events.length : 0,
  };
}

function parseDays(value) {
  if (value === undefined || value === null || value === '' || Number(value) === 0) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 3650) return undefined;
  return n;
}

app.get('/api/admin/tenants', requireAdmin, (_req, res) => {
  res.json({ tenants: [...tenants.values()].map(publicTenant) });
});

app.post('/api/admin/tenants', requireAdmin, async (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  const robloxName = typeof req.body?.robloxName === 'string' ? req.body.robloxName.trim() : '';
  const plan = ['lifetime', 'rental', 'test'].includes(req.body?.plan) ? req.body.plan : null;
  const days = plan === 'lifetime' ? null : parseDays(req.body?.days);

  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || id.toLowerCase() === 'admin') {
    return res.status(400).json({ error: 'ID must be 1-32 chars (A-Z, 0-9, _ -) and not "admin".' });
  }
  if (plan !== 'test' && !/^[A-Za-z0-9_]{3,20}$/.test(robloxName)) {
    return res.status(400).json({ error: 'Invalid Roblox username (3-20 chars: letters, numbers, _).' });
  }
  if (days === undefined) return res.status(400).json({ error: 'Days must be between 0 and 3650.' });
  if (plan === 'rental' && !days) return res.status(400).json({ error: 'Rental needs a number of days (1-3650).' });
  if (tenants.has(id.toLowerCase())) return res.status(409).json({ error: 'This ID already exists.' });
  if (plan !== 'test' && findTenantByRoblox(robloxName)) {
    return res.status(409).json({ error: 'This Roblox username is already assigned to another tenant.' });
  }

  const password = newPassword();
  const t = {
    id,
    robloxName: plan === 'test' ? null : robloxName, // บัญชี Test ไม่ผูก Roblox
    ...hashPassword(password),
    createdAt: Date.now(),
    plan: plan === 'test' ? 'test' : days ? 'rental' : 'lifetime',
    expiresAt: days ? Date.now() + days * 86400000 : null,
    disabled: false,
  };
  try {
    await saveTenant(t);
  } catch (err) {
    console.error('save failed:', err.message);
    return res.status(500).json(SAVE_FAILED);
  }
  res.json({ ok: true, tenant: publicTenant(t), password }); // แสดงรหัสผ่านครั้งเดียวเท่านั้น
});

app.patch('/api/admin/tenants/:id', requireAdmin, async (req, res) => {
  const current = tenants.get(String(req.params.id).toLowerCase());
  if (!current) return res.status(404).json({ error: 'Tenant not found.' });
  const t = { ...current }; // แก้บนสำเนา บันทึกสำเร็จค่อยใช้จริง
  const body = req.body ?? {};

  if (body.robloxName !== undefined && planOf(current) === 'test' && body.plan === undefined) {
    return res.status(400).json({ error: 'Test accounts have no Roblox username. Change the plan to Rental or Lifetime first.' });
  }
  if (body.robloxName !== undefined) {
    const name = String(body.robloxName).trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
      return res.status(400).json({ error: 'Invalid Roblox username.' });
    }
    const other = findTenantByRoblox(name);
    if (other && other !== current) {
      return res.status(409).json({ error: 'This Roblox username is already assigned to another tenant.' });
    }
    t.robloxName = name;
  }
  if (body.plan === 'lifetime') {
    // เปลี่ยนเป็นซื้อขาด: ไม่มีวันหมดอายุ
    t.plan = 'lifetime';
    t.expiresAt = null;
  } else if (body.plan === 'rental') {
    const n = Number(body.days);
    if (!Number.isFinite(n) || n <= 0 || n > 3650) {
      return res.status(400).json({ error: 'Rental needs a number of days (1-3650).' });
    }
    t.plan = 'rental';
    t.expiresAt = Date.now() + n * 86400000;
  } else if (body.plan !== undefined) {
    return res.status(400).json({ error: 'plan must be "lifetime" or "rental".' });
  }
  if (body.plan !== undefined && !t.robloxName) {
    return res.status(400).json({ error: 'A Roblox username is required for Rental or Lifetime.' });
  }
  if (body.extendDays !== undefined) {
    if (!t.expiresAt) {
      return res.status(400).json({ error: 'This account does not expire.' });
    }
    const n = Number(body.extendDays);
    if (!Number.isFinite(n) || n <= 0 || n > 3650) {
      return res.status(400).json({ error: 'extendDays must be between 1 and 3650.' });
    }
    t.expiresAt = Math.max(Date.now(), t.expiresAt ?? 0) + n * 86400000;
  }
  if (body.disabled !== undefined) t.disabled = !!body.disabled;

  try {
    await saveTenant(t);
  } catch (err) {
    console.error('save failed:', err.message);
    return res.status(500).json(SAVE_FAILED);
  }
  if (!isActive(t)) {
    const rt = runtimes.get(key(t));
    if (rt) {
      if (rt.state !== 'idle') forceStop(rt, 'Account disabled or expired.');
      rt.events.length = 0; // ล้างคิวค้าง
    }
    dropSessions(key(t));
  }
  res.json({ ok: true, tenant: publicTenant(t) });
});

app.post('/api/admin/tenants/:id/reset-password', requireAdmin, async (req, res) => {
  const current = tenants.get(String(req.params.id).toLowerCase());
  if (!current) return res.status(404).json({ error: 'Tenant not found.' });
  const password = newPassword();
  const t = { ...current, ...hashPassword(password) };
  try {
    await saveTenant(t);
  } catch (err) {
    console.error('save failed:', err.message);
    return res.status(500).json(SAVE_FAILED);
  }
  dropSessions(key(t));
  res.json({ ok: true, id: t.id, password });
});

app.delete('/api/admin/tenants/:id', requireAdmin, async (req, res) => {
  const k = String(req.params.id).toLowerCase();
  const t = tenants.get(k);
  if (!t) return res.status(404).json({ error: 'Tenant not found.' });
  try {
    await deleteTenant(k);
  } catch (err) {
    console.error('delete failed:', err.message);
    return res.status(500).json(SAVE_FAILED);
  }
  const rt = runtimes.get(k);
  if (rt) {
    forceStop(rt, null);
    runtimes.delete(k);
  }
  res.json({ ok: true });
});

// ตัวช่วยสุ่มค่าลับ (เช่น สำหรับตั้ง BRIDGE_API_KEY / ADMIN_PASSWORD ที่โฮสต์)
app.get('/api/admin/random', requireAdmin, (_req, res) => {
  res.json({ value: crypto.randomBytes(24).toString('hex') });
});

// กวาดบัญชีที่หมดอายุทุก 30 วินาที: ตัดการเชื่อมและล้าง session
setInterval(() => {
  for (const t of tenants.values()) {
    if (!isActive(t)) {
      const rt = runtimes.get(key(t));
      if (rt && rt.state !== 'idle') forceStop(rt, 'Account disabled or expired.');
    }
  }
}, 30000).unref();

/* ------------------------------------------------------------------ */
/* Roblox Poller: ดึงเฉพาะ Gift ของผู้เช่าที่ผูกกับชื่อ Roblox นั้น        */
/* ------------------------------------------------------------------ */
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'TikTok-Roblox Bridge' });
});

// GET /api/events?player=<Roblox username>  (ต้องมี x-bridge-key)
// ดึงแล้วลบออกจากคิวทันที ครั้งละ 20 ให้ตรงกับ MAX_EVENTS_PER_POLL ของ Poller
app.get('/api/events', requireBridgeKey, (req, res) => {
  const player = typeof req.query.player === 'string' ? req.query.player.trim().slice(0, 40) : '';
  if (!player) return res.status(400).json({ error: 'player query parameter is required.' });
  const t = findTenantByRoblox(player);
  if (!t || !isActive(t)) return res.json({ events: [] });
  const rt = getRuntime(key(t));
  res.json({ events: rt.events.splice(0, 20) });
});

/* ------------------------------------------------------------------ */
/* Frontend                                                           */
/* ------------------------------------------------------------------ */
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(400).json({ error: 'Invalid request body.' });
  }
  next(err);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TikTok-Roblox Bridge listening on port ${PORT}`);
});
