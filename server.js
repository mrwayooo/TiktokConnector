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
/* กฎ (Actions & Events): ผู้เช่าตั้งเองในเกม เก็บใน tenant.rules       */
/* trigger: gift / chat / likeUser / likeTotal / follow / share / join */
/* ------------------------------------------------------------------ */
// ชื่อ Ability ต้องตรงกับ HANDLERS ใน Abilitysystem ของเกม
const ABILITIES = [
  { id: 'Tung1', label: 'Tung LV.1' },
  { id: 'Tung2', label: 'Tung LV.2' },
  { id: 'Tung3', label: 'Tung LV.3' },
  { id: 'Ghost1', label: 'ผีจิ๋ว LV.1' },
  { id: 'Ghost2', label: 'ผีจีน LV.2' },
  { id: 'Ghost3', label: 'ผีเปรต LV.3' },
  { id: 'Meteor', label: 'อุกกาบาต (Meteor)' },
  { id: 'NoJar', label: 'ห้ามซ่อนไห (No Jar)' },
  { id: 'Reset', label: 'รีเซ็ต (Reset)' },
  { id: 'Totem', label: 'Totem Attack' },
  { id: 'Web', label: 'ใยแมงมุม (Web)' },
  { id: 'Shield', label: 'โล่ (Shield)' },
  { id: 'Win', label: 'Attack +1 Win' },
  { id: 'Jar', label: 'เสกไห (Jar)' },
  { id: 'Speed', label: 'เพิ่มความเร็ว (Speed)' },
];
const ABILITY_LABEL = new Map(ABILITIES.map((a) => [a.id, a.label]));

// รายการ Gift ให้เลือกในเกม: ชื่อและราคาจาก TikTok ประเทศไทย (streamtoearn.io/gifts?region=TH, 25 ต.ค. 2026)
// 1-10 เหรียญครบทุกชิ้น, ราคาสูงกว่านั้นคัดเฉพาะที่นิยม (พิมพ์ชื่อเองในเกมได้ถ้าไม่อยู่ในรายการ)
// ชื่อต้องตรงตัวพิมพ์เล็ก/ใหญ่ เช่น "Love you" (1) กับ "Love You" (199) เป็นคนละชิ้น
const GIFT_TIERS = [
  [1, ['Rose', "You're awesome", 'Mantap', 'Ice Cream Cone', 'Eye for an Eye', 'Love you so much', 'Wink wink',
    'Cake Slice', 'TikTok', 'GG', 'Mate Melody', 'Welcome Dallah', 'Mirwas Beat', 'Pop', 'Glow Stick', 'Oldies',
    'A Shard of Hope', 'Freestyle', 'My First Rose', 'Heart Me', 'Blow a kiss', 'LUVX Cheer', 'Halloween mood',
    'Music on Stage', 'LUVE Cheer', 'Community Heart', 'SEA Shell', 'Love KSA', 'Starfish', 'Light', 'Thumbs Up',
    'Heart', 'Love you', 'Music Album', 'coldy', 'Red Lightning', 'Blue Lightning', 'Yellow Lightning',
    'Treasure Clover', 'Palm of Protection', 'Lucky Pig', 'Wink Charm', 'Go Popular', 'Community Gift', 'Club Cheers']],
  [2, ['Team Bracelet']],
  [5, ['Finger Heart', 'Spinning Soccer', 'Overreact', 'Love in Scent', 'Encore Ticket', 'Name shoutout', 'Brown Paw']],
  [6, ['Divine Fingers']],
  [9, ['The Lucky 9', 'Super Popular', 'Cheer You Up', 'Club Power']],
  [10, ['Rosa', 'Friendship Necklace', 'Slow motion', 'I Like What I See', 'Journey Pass', 'Courage potion', 'DJ Vinyl',
    'LIVE Ranking Ticket', 'Black Paw', 'Squirrel', 'I love you', 'Tiny Diny', 'Style Me Up', 'Banana Peel',
    'Songs of LIVE', "Treasure's Key", "I'm Yours", 'Magic Feather', 'PK Cheer bump', 'Shamrock', 'Heart Gaze']],
  [15, ['Bravo!', 'Lyric Mail', 'Flower Garland', 'Baby Hippo']],
  [20, ['Perfume', 'LOL', 'Tiny Blush', 'Rage Mode', 'Huh?', 'No Comment', 'Headphones', 'Traffic Cone', 'Mushroom']],
  [30, ['Doughnut', 'Bouquet Flower', 'Warm Cocoa', 'Energy Capsule', 'Ghostfire']],
  [70, ['Single Strike']],
  [99, ['Paper Crane', 'Cap', 'Little Crown', 'Hat and Mustache', 'Like-Pop', 'Love Painting', 'Bubble Gum',
    'Mark of Love', 'Sundae Bowl', 'Candy Blast']],
  [100, ['Confetti', 'Hand Heart', 'Scooter', 'Bouquet', 'Mishka Bear', 'Balloon Gift Box', 'Marvelous Confetti']],
  [149, ['Raving Snail', 'Bowknot', 'Big Shout Out', 'Chatting Popcorn', 'Masquerade', 'Love Glasses']],
  [150, ['Puffer Fish', 'Cruiser']],
  [199, ['Sunglasses', 'Hearts', 'Garland Headpiece', 'Suitcase', 'Love You', 'Cheer For You', 'Night Star',
    'Twinkling Star', 'Floating Octopus', 'Panda Climb', 'Rose Hand']],
  [200, ['Balloons', 'Magic Genie']],
  [222, ['Cat']],
  [249, ['Pinch Face', 'Candy Bouquet', 'Star Goggles', 'Surfing Penguin']],
  [299, ['Boxing Gloves', 'Corgi', 'Fruit Friends', 'Naughty Chicken', 'Rock Star', 'Butterfly for You',
    'Puppy Kisses', 'Spider on web', 'Hawaiian Lei']],
  [300, ['Feather Mask']],
  [349, ['Become Kitten', 'Gingerbread Man']],
  [399, ['Forever Rosa', 'Relaxed Goose', "Tom's Hug", 'Lucky Cat', 'Alien Buddy']],
  [400, ['Moped', 'Crystal Dreams', 'Wishing Cake']],
  [449, ['Beating Heart', "Pirate's Treasure", 'Space Love']],
  [450, ['Superwoman', 'Sloth Peek']],
  [499, ['Crystal Heart', 'Coral', 'Music', 'Hands Up']],
  [500, ['Mermaid', 'Money Gun', 'VR Goggles', 'DJ Glasses', 'Dragon Crown', 'Racing Helmet', 'Mystery Box', 'Gem Gun']],
  [599, ['Fruit Box']],
  [699, ['Swan']],
  [700, ['Cafe Racer', 'Colorful Wings']],
  [899, ['Train']],
  [999, ['Travel with You', 'Lucky Airdrop Box', 'Grand show']],
  [1000, ['Galaxy', 'Watermelon Love', 'Blooming Ribbons', 'Fairy Wings', 'Magic Potion', 'Shiny Air Balloon']],
  [1088, ['Fireworks']],
  [1500, ['Viking Hammer', 'Chasing the Dream', 'Lover’s Lock', 'Greeting Card', 'Future Encounter',
    'Under Control', 'Racing Debut', 'Astrobear']],
  [1580, ['Shooting Stars']],
  [1800, ['Love Drop', 'Fox Legend']],
  [1999, ['Star of Red Carpet', 'Mystery Firework', 'Let Us Dance', 'Carousel']],
  [2000, ['Sky Drift', 'Cooper Picnic']],
  // ราคาสูงกว่า 2,000: ตามรายการที่ได้รับ (ยังไม่ได้เทียบกับรายชื่อจริง)
  [3000, ['Sports Car', 'Motorcycle', 'Ferris Wheel']],
  [4000, ['Submarine', 'Volcanic Eruption']],
  [5000, ['Aircraft Carrier', 'Phoenix', 'Dream Spaceship']],
  [10000, ['Interstellar', 'Golden Whale']],
  [20000, ['Leon the Kitten', 'Zeus']],
  [26999, ['Dragon Flame']],
  [29999, ['Lion', 'Gorilla']],
  [34000, ['Leon & Lion']],
  [39999, ['TikTok Stars', 'Thunder Falcon']],
  [44999, ['TikTok Universe']],
];
const GIFT_CATALOG = [];
{
  const seen = new Set();
  for (const [coins, names] of GIFT_TIERS) {
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      GIFT_CATALOG.push({ name, coins });
    }
  }
}

const TRIGGERS = [
  { type: 'chat', label: '💬 แชท (พิมพ์ข้อความ)', value: 'text' },
  { type: 'gift', label: '🎁 ของขวัญ', value: 'gift' },
  { type: 'likeUser', label: '💗 หัวใจสะสมรายคน (ทุกๆ N)', value: 'number' },
  { type: 'likeTotal', label: '💖 หัวใจรวมทั้งไลฟ์ (ทุกๆ N)', value: 'number' },
  { type: 'follow', label: '👤 กดติดตาม', value: 'none' },
  { type: 'share', label: '🔗 แชร์ไลฟ์', value: 'none' },
  { type: 'join', label: '👋 เข้าห้องไลฟ์', value: 'none' },
];
const TRIGGER_TYPES = new Set(TRIGGERS.map((t) => t.type));
const CATALOG = { abilities: ABILITIES, gifts: GIFT_CATALOG, triggers: TRIGGERS };

// กฎเริ่มต้น = ตาราง Gift เดิม (ใช้เมื่อผู้เช่ายังไม่เคยตั้งเอง)
const DEFAULT_GIFT_RULES = [
  ['Rose', 'Tung1'], ['Finger Heart', 'Tung2'], ['Rosa', 'Tung3'],
  ['GG', 'Ghost1'], ['Tiny Diny', 'Ghost2'], ['Perfume', 'Ghost3'],
  ['Doughnut', 'Meteor'], ['Cap', 'NoJar'], ['Confetti', 'Reset'],
  ['Raving Snail', 'Web'], ['Paper Crane', 'Jar'], ['Baby Hippo', 'Shield'],
  ['Hand Heart', 'Win'], ['Journey Pass', 'Speed'],
  // Totem: ยังไม่มี Gift เริ่มต้น (Music Note ไม่มีในไทย) ตั้งเองในเกมได้
];

function defaultRules() {
  return DEFAULT_GIFT_RULES.map(([gift, ability], i) => ({
    id: `r${i + 1}`,
    trigger: { type: 'gift', value: gift },
    actions: [{ ability, count: 1 }],
  }));
}

function rulesOf(t) {
  return Array.isArray(t?.rules) ? t.rules : defaultRules();
}

// ตรวจและจัดรูปกฎที่ส่งมาจากเกม (โยน Error พร้อมข้อความภาษาไทยถ้าผิด)
function normalizeRules(input) {
  if (!Array.isArray(input)) throw new Error('รูปแบบกฎไม่ถูกต้อง');
  if (input.length > 60) throw new Error('ตั้งได้สูงสุด 60 เงื่อนไข');
  return input.map((r, i) => {
    const n = i + 1;
    const type = r?.trigger?.type;
    if (!TRIGGER_TYPES.has(type)) throw new Error(`เงื่อนไขที่ ${n}: ไม่รู้จักประเภทนี้`);
    let value = null;
    if (type === 'gift') {
      value = String(r.trigger.value ?? '').trim();
      if (!value || value.length > 40) throw new Error(`เงื่อนไขที่ ${n}: กรุณาเลือกของขวัญ`);
    } else if (type === 'chat') {
      value = String(r.trigger.value ?? '').trim().slice(0, 50); // ว่าง = ทุกข้อความ
    } else if (type === 'likeUser' || type === 'likeTotal') {
      value = Number(r.trigger.value);
      if (!Number.isInteger(value) || value < 1 || value > 1000000) {
        throw new Error(`เงื่อนไขที่ ${n}: จำนวนหัวใจต้องเป็นเลข 1-1,000,000`);
      }
    }
    const actions = Array.isArray(r.actions) ? r.actions : [];
    if (actions.length < 1 || actions.length > 5) throw new Error(`เงื่อนไขที่ ${n}: ต้องมีคำสั่ง 1-5 คำสั่ง`);
    return {
      id: `r${n}`,
      trigger: { type, value },
      actions: actions.map((a) => {
        if (!ABILITY_LABEL.has(a?.ability)) throw new Error(`เงื่อนไขที่ ${n}: ไม่รู้จักคำสั่งนี้`);
        const count = Number(a.count);
        if (!Number.isInteger(count) || count < 1 || count > 20) {
          throw new Error(`เงื่อนไขที่ ${n}: จำนวนครั้งต้องเป็นเลข 1-20`);
        }
        return { ability: a.ability, count };
      }),
    };
  });
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

function findTenantByUserId(userId) {
  const u = String(userId);
  for (const t of tenants.values()) if (t.robloxUserId && String(t.robloxUserId) === u) return t;
  return null;
}

/* ------------------------------------------------------------------ */
/* คีย์เกม: ผู้เล่นใส่ในเกม แล้วคีย์ผูกกับบัญชี Roblox ที่ใส่ครั้งแรก      */
/* ------------------------------------------------------------------ */
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ไม่มี 0 O 1 I กันสับสน
const normKey = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function findTenantByKey(value) {
  const n = normKey(value);
  if (n.length !== 8) return null;
  for (const t of tenants.values()) if (t.gameKey && normKey(t.gameKey) === n) return t;
  return null;
}

function newGameKey() {
  let k;
  do {
    let s = '';
    for (const b of crypto.randomBytes(8)) s += KEY_ALPHABET[b % 32];
    k = `${s.slice(0, 4)}-${s.slice(4)}`;
  } while (findTenantByKey(k));
  return k;
}

// บัญชีเก่าที่ยังไม่มีคีย์: สร้างให้ตอนเปิดเซิร์ฟเวอร์
for (const t of tenants.values()) {
  if (!t.gameKey) {
    t.gameKey = newGameKey();
    saveTenantInBackground(t);
  }
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
      recent: [], // เหตุการณ์ล่าสุด แสดงบนหน้าเว็บของผู้ใช้
      likeByUser: new Map(), // หัวใจสะสมรายคน (รอบ LIVE นี้)
      likeTotal: 0, // หัวใจรวมทั้งไลฟ์ (รอบ LIVE นี้)
    };
    runtimes.set(k, rt);
  }
  return rt;
}

const RECENT_MAX = 20;

// บัญชีที่ไม่มีชื่อ Roblox (บัญชี Test ที่ไม่ได้ใส่ชื่อ): Gift แสดงบนหน้าเว็บอย่างเดียว
// บัญชี Test ที่ใส่ชื่อ Roblox: Gift เข้าเกมจริงเหมือนบัญชีปกติ
function isTestRuntime(rt) {
  const t = tenants.get(rt.key);
  return !!t && !t.robloxName;
}

function addRecent(rt, entry) {
  rt.recent.unshift(entry);
  if (rt.recent.length > RECENT_MAX) rt.recent.length = RECENT_MAX;
}

// คำสั่งที่ส่งเข้าเกม: { type: 'ACTION', ability } (Poller เรียก Ability ตามชื่อ)
function enqueue(rt, { trigger, ability, username, source }) {
  const test = isTestRuntime(rt);
  const full = !test && rt.events.length >= MAX_QUEUE;
  const event = {
    id: `${BOOT_ID}-${nextId++}`,
    type: 'ACTION',
    ability,
    trigger,
    username,
    createdAt: Date.now(),
    source,
  };
  addRecent(rt, {
    id: event.id,
    giftName: trigger, // ชื่อฟิลด์เดิมที่หน้าเว็บใช้แสดง "ตัวเรียก"
    ability: ABILITY_LABEL.get(ability) ?? ability,
    username,
    source,
    at: event.createdAt,
    delivery: test ? 'web-only' : full ? 'queue-full' : 'game',
  });
  if (full) return null;
  if (!test) rt.events.push(event);
  return event;
}

const MAX_ACTIONS_PER_EVENT = 40; // กันเหตุการณ์เดียวยิงคำสั่งมากเกินไป

function runRule(rt, rule, times, username, source, label, budget) {
  let sent = 0;
  for (const action of rule.actions) {
    const n = Math.min(times * action.count, MAX_REPEAT, budget.left);
    for (let i = 0; i < n; i++) {
      budget.left--;
      if (enqueue(rt, { trigger: label, ability: action.ability, username, source })) sent++;
    }
  }
  rt.giftsQueued += sent;
  return sent;
}

// เรียกกฎที่ตรงกับเหตุการณ์ คืนจำนวนกฎที่ตรง
function fireTrigger(rt, type, { value = null, times = 1, username, source, label }) {
  const t = tenants.get(rt.key);
  if (!t) return 0;
  const budget = { left: MAX_ACTIONS_PER_EVENT };
  let matched = 0;
  for (const rule of rulesOf(t)) {
    if (rule.trigger.type !== type) continue;
    if (type === 'gift' && String(rule.trigger.value).trim() !== String(value).trim()) continue; // ตรงตัวพิมพ์
    if (type === 'chat' && rule.trigger.value &&
      !String(value).toLowerCase().includes(String(rule.trigger.value).toLowerCase())) continue;
    matched++;
    runRule(rt, rule, times, username, source, label, budget);
  }
  return matched;
}

// หัวใจ: นับสะสมรายคนและรวมทั้งไลฟ์ เรียกกฎทุกครั้งที่ข้ามเลข N
function handleLikes(rt, likeCount, username, source) {
  const t = tenants.get(rt.key);
  if (!t || !(likeCount > 0)) return 0;
  const oldUser = rt.likeByUser.get(username) ?? 0;
  const newUser = oldUser + likeCount;
  if (rt.likeByUser.size < 50000 || rt.likeByUser.has(username)) rt.likeByUser.set(username, newUser);
  const oldTotal = rt.likeTotal;
  rt.likeTotal += likeCount;

  const budget = { left: MAX_ACTIONS_PER_EVENT };
  let matched = 0;
  for (const rule of rulesOf(t)) {
    const N = rule.trigger.value;
    let times = 0;
    if (rule.trigger.type === 'likeUser') times = Math.floor(newUser / N) - Math.floor(oldUser / N);
    else if (rule.trigger.type === 'likeTotal') times = Math.floor(rt.likeTotal / N) - Math.floor(oldTotal / N);
    if (times <= 0) continue;
    matched++;
    const label = rule.trigger.type === 'likeUser' ? `หัวใจ ${N} ดวง` : `หัวใจรวม ${N} ดวง`;
    runRule(rt, rule, times, username, source, label, budget);
  }
  return matched;
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
  rt.likeByUser.clear();
  rt.likeTotal = 0;
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

  const matched = fireTrigger(rt, 'gift', { value: giftName, times: count, username, source: 'tiktok', label: giftName });
  if (!matched) {
    // ไม่มีกฎสำหรับ Gift นี้: แสดงบนหน้าเว็บให้ผู้เช่ารู้ชื่อจริง
    addRecent(rt, { id: `${BOOT_ID}-n${nextId++}`, giftName, ability: '—', username, source: 'tiktok', at: Date.now(), delivery: 'no-rule' });
    console.log(`[${rt.key}] ${username} sent "${giftName}" x${count} (no rule)`);
  } else {
    console.log(`[${rt.key}] ${username} sent ${giftName} x${count}`);
  }
}

const viewerOf = (d) => d?.user?.uniqueId ?? d?.uniqueId ?? 'UnknownViewer';

function attachHandlers(rt, connection, gen) {
  connection.on(WebcastEvent.GIFT, (data) => {
    if (gen !== rt.gen) return;
    try {
      handleGift(rt, data);
    } catch (err) {
      console.error('gift handler error:', err);
    }
  });

  const listen = (event, fn) =>
    connection.on(event, (data) => {
      if (gen !== rt.gen) return;
      try {
        fn(data);
      } catch (err) {
        console.error(`${event} handler error:`, err);
      }
    });
  listen(WebcastEvent.CHAT, (d) => {
    const text = String(d.comment ?? '');
    fireTrigger(rt, 'chat', { value: text, username: viewerOf(d), source: 'tiktok', label: `แชท: ${text.slice(0, 30)}` });
  });
  listen(WebcastEvent.LIKE, (d) => handleLikes(rt, Number(d.likeCount) || 0, viewerOf(d), 'tiktok'));
  listen(WebcastEvent.FOLLOW, (d) => fireTrigger(rt, 'follow', { username: viewerOf(d), source: 'tiktok', label: 'กดติดตาม' }));
  listen(WebcastEvent.SHARE, (d) => fireTrigger(rt, 'share', { username: viewerOf(d), source: 'tiktok', label: 'แชร์ไลฟ์' }));
  listen(WebcastEvent.MEMBER, (d) => fireTrigger(rt, 'join', { username: viewerOf(d), source: 'tiktok', label: 'เข้าห้องไลฟ์' }));

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
    gameKey: t.gameKey,
    bound: !!t.robloxUserId,
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

  // enableExtendedGiftInfo ปิดไว้: ตัวเลือกนี้ต้องใช้ Euler แผน Business (เสียเงิน)
  // ชื่อ Gift มากับ Event อยู่แล้ว (giftDetails.giftName) จึงไม่จำเป็น
  const connection = new TikTokLiveConnection(username, {
    enableExtendedGiftInfo: false,
    ...(process.env.EULER_API_KEY ? { signApiKey: process.env.EULER_API_KEY } : {}),
  });
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

// รายการ Gift สำหรับช่อง Mock บนเว็บ พร้อมคำสั่งตามกฎของผู้เช่า
app.get('/api/gifts', requireAuth, (req, res) => {
  const rules = req.auth.role === 'tenant' ? rulesOf(req.auth.tenant) : defaultRules();
  const actionsFor = (gift) =>
    rules
      .filter((r) => r.trigger.type === 'gift' && String(r.trigger.value) === gift)
      .flatMap((r) => r.actions.map((a) => `${ABILITY_LABEL.get(a.ability) ?? a.ability}${a.count > 1 ? ` x${a.count}` : ''}`));
  const names = [...new Set([...GIFT_CATALOG.map((g) => g.name),
    ...rules.filter((r) => r.trigger.type === 'gift').map((r) => r.trigger.value)])];
  const gifts = names.map((gift) => {
    const acts = actionsFor(gift);
    return { gift, ability: acts.length ? acts.join(', ') : 'no rule', implemented: acts.length > 0 };
  });
  gifts.sort((a, b) => Number(b.implemented) - Number(a.implemented)); // มีกฎขึ้นก่อน
  res.json({ gifts, abilities: ABILITIES.map((a) => a.id) });
});

// Mock: จำลองเหตุการณ์ผ่านกฎของผู้เช่า (gift / chat / like / follow / share / join)
// ผู้เช่าใช้กับตัวเอง / Admin หรือ x-bridge-key ต้องระบุ tenantId
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
  const type = typeof req.body?.type === 'string' ? req.body.type : 'gift';
  const username =
    (typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 64) : '') || 'MockViewer';
  const repeatCount = Number.isInteger(req.body?.repeatCount)
    ? Math.min(Math.max(req.body.repeatCount, 1), MAX_REPEAT)
    : 1;
  const before = rt.recent[0]?.id;
  let matched = 0;

  if (type === 'gift') {
    const giftName = typeof req.body?.giftName === 'string' ? req.body.giftName.trim().slice(0, 40) : '';
    if (!giftName) return res.status(400).json({ error: 'giftName is required.' });
    matched = fireTrigger(rt, 'gift', { value: giftName, times: repeatCount, username, source: 'mock', label: giftName });
    if (!matched) {
      addRecent(rt, { id: `${BOOT_ID}-n${nextId++}`, giftName, ability: '—', username, source: 'mock', at: Date.now(), delivery: 'no-rule' });
    }
  } else if (type === 'chat') {
    const text = String(req.body?.comment ?? '').slice(0, 200);
    matched = fireTrigger(rt, 'chat', { value: text, username, source: 'mock', label: `แชท: ${text.slice(0, 30)}` });
  } else if (type === 'like') {
    const likeCount = Math.min(Math.max(Number(req.body?.likeCount) || 1, 1), 100000);
    matched = handleLikes(rt, likeCount, username, 'mock');
  } else if (['follow', 'share', 'join'].includes(type)) {
    const labels = { follow: 'กดติดตาม', share: 'แชร์ไลฟ์', join: 'เข้าห้องไลฟ์' };
    matched = fireTrigger(rt, type, { username, source: 'mock', label: labels[type] });
  } else {
    return res.status(400).json({ error: 'Unknown type.' });
  }

  const idx = rt.recent.findIndex((r) => r.id === before);
  const created = (idx === -1 ? rt.recent : rt.recent.slice(0, idx)).filter((r) => r.delivery !== 'no-rule');
  res.json({ ok: true, matched, created });
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
    bound: !!t.robloxUserId,
    gameKey: t.gameKey,
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
  const needsRoblox = robloxName !== ''; // ไม่บังคับ: ผูกเองเมื่อผู้เล่นใส่คีย์ในเกม
  if (needsRoblox && !/^[A-Za-z0-9_]{3,20}$/.test(robloxName)) {
    return res.status(400).json({ error: 'Invalid Roblox username (3-20 chars: letters, numbers, _).' });
  }
  if (days === undefined) return res.status(400).json({ error: 'Days must be between 0 and 3650.' });
  if (plan === 'rental' && !days) return res.status(400).json({ error: 'Rental needs a number of days (1-3650).' });
  if (tenants.has(id.toLowerCase())) return res.status(409).json({ error: 'This ID already exists.' });
  if (needsRoblox && findTenantByRoblox(robloxName)) {
    return res.status(409).json({ error: 'This Roblox username is already assigned to another tenant.' });
  }

  const password = newPassword();
  const t = {
    id,
    robloxName: robloxName || null, // ว่างได้: ผูกอัตโนมัติเมื่อผู้เล่นใส่คีย์ในเกม
    robloxUserId: null,
    gameKey: newGameKey(),
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

  if (body.unbind === true || (body.robloxName !== undefined && String(body.robloxName).trim() === '')) {
    // ยกเลิกการผูก: ผู้เล่นต้องใส่คีย์ใหม่ในเกม (ใช้เมื่อลูกค้าเปลี่ยนบัญชี Roblox)
    t.robloxName = null;
    t.robloxUserId = null;
  } else if (body.robloxName !== undefined) {
    const name = String(body.robloxName).trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
      return res.status(400).json({ error: 'Invalid Roblox username.' });
    }
    const other = findTenantByRoblox(name);
    if (other && other !== current) {
      return res.status(409).json({ error: 'This Roblox username is already assigned to another tenant.' });
    }
    if (name.toLowerCase() !== String(current.robloxName ?? '').toLowerCase()) t.robloxUserId = null;
    t.robloxName = name;
  }
  if (body.newKey === true) t.gameKey = newGameKey(); // คีย์เก่าใช้ไม่ได้ทันที (การผูกเดิมยังอยู่)
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

// หา tenant ของผู้เล่น: ใช้ UserId ก่อน (เปลี่ยนชื่อ Roblox ไม่กระทบ) แล้วค่อยใช้ชื่อ
function tenantForPlayer(userId, name) {
  if (userId) {
    const byId = findTenantByUserId(userId);
    if (byId) return byId;
  }
  const byName = name ? findTenantByRoblox(name) : null;
  if (!byName) return null;
  if (byName.robloxUserId && userId && String(byName.robloxUserId) !== String(userId)) return null;
  return byName;
}

// จำกัดการเดาคีย์: ผิด 10 ครั้ง / 15 นาที ต่อบัญชี Roblox
const keyFails = new Map();
function keyBlocked(userId) {
  const rec = keyFails.get(userId);
  if (!rec) return false;
  if (rec.resetAt < Date.now()) {
    keyFails.delete(userId);
    return false;
  }
  return rec.count >= 10;
}
function recordKeyFail(userId) {
  const rec = keyFails.get(userId);
  if (!rec || rec.resetAt < Date.now()) keyFails.set(userId, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
  else rec.count++;
}

// POST /api/game/redeem  { userId, name, key? }  (ต้องมี x-bridge-key)
// ไม่มี key = เช็กว่าผู้เล่นคนนี้ผูกไว้แล้วหรือยัง / มี key = ผูกบัญชี Roblox กับคีย์
// ตอบ 200 เสมอพร้อม ok true/false ให้สคริปต์ในเกมอ่านง่าย
app.post('/api/game/redeem', requireBridgeKey, async (req, res) => {
  const userId = Number(req.body?.userId);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^[A-Za-z0-9_]{3,20}$/.test(name)) {
    return res.status(400).json({ error: 'userId and name are required.' });
  }
  const granted = (t) => ({ ok: true, tenantId: t.id, plan: planOf(t), expiresAt: t.expiresAt });
  const denied = (reason, message) => ({ ok: false, reason, message });

  // ผูกด้วยคีย์ไว้แล้วเท่านั้น (จับด้วย UserId) ชื่อ Roblox ที่ Admin กรอกเองไม่นับ
  const bound = findTenantByUserId(userId);
  const rawKey = req.body?.key;

  // 1) ไม่ได้ส่งคีย์มา: เข้าได้เฉพาะบัญชีที่เคยใส่คีย์ถูกแล้ว
  if (!rawKey) {
    if (!bound) return res.json(denied('need-key', 'Enter your game key to play.'));
    if (!isActive(bound)) return res.json(denied('expired', 'Your access has expired or was disabled.'));
    if (bound.robloxName !== name) {
      bound.robloxName = name; // ผู้เล่นเปลี่ยนชื่อ Roblox
      saveTenantInBackground(bound);
    }
    return res.json(granted(bound));
  }

  // 2) ส่งคีย์มา: ตรวจคีย์ทุกครั้ง แม้บัญชีจะผูกไว้แล้ว
  if (keyBlocked(userId)) return res.json(denied('too-many', 'Too many wrong keys. Try again in 15 minutes.'));

  const t = findTenantByKey(rawKey);
  if (!t) {
    recordKeyFail(userId);
    return res.json(denied('invalid', 'Invalid key. Check it and try again.'));
  }
  if (!isActive(t)) return res.json(denied('expired', 'This key has expired or was disabled.'));
  if (t.robloxUserId && String(t.robloxUserId) !== String(userId)) {
    recordKeyFail(userId);
    return res.json(denied('used', 'This key is already used by another Roblox account.'));
  }
  if (bound && bound !== t) {
    return res.json(denied('linked-other', 'This Roblox account is already linked to a different key.'));
  }
  if (bound === t) {
    keyFails.delete(userId);
    return res.json(granted(t)); // ใส่คีย์ของตัวเองซ้ำ
  }

  // 2) ผูกคีย์กับผู้เล่นคนนี้
  try {
    const stale = findTenantByRoblox(name); // ชื่อนี้ค้างอยู่ในบัญชีอื่น (ใส่มือไว้เก่า) ให้ย้ายออก
    if (stale && stale !== t) await saveTenant({ ...stale, robloxName: null, robloxUserId: null });
    await saveTenant({ ...t, robloxUserId: userId, robloxName: name, boundAt: Date.now() });
  } catch (err) {
    console.error('bind failed:', err.message);
    return res.json(denied('server', 'Server error. Please try again.'));
  }
  keyFails.delete(userId);
  console.log(`[${t.id}] key redeemed by Roblox ${name} (${userId})`);
  res.json({ ...granted(tenants.get(key(t))), newlyBound: true });
});

// กฎ Actions & Events ของผู้เล่น (แก้จากหน้าต่างในเกม)  (ต้องมี x-bridge-key)
// GET  /api/game/rules?userId=   -> { ok, rules, isDefault, catalog }
// PUT  /api/game/rules { userId, rules }  (reset: true = คืนค่าเริ่มต้น)
app.get('/api/game/rules', requireBridgeKey, (req, res) => {
  const t = findTenantByUserId(String(req.query.userId ?? ''));
  if (!t) return res.json({ ok: false, message: 'Enter your game key first.' });
  if (!isActive(t)) return res.json({ ok: false, message: 'Your access has expired or was disabled.' });
  res.json({ ok: true, tenantId: t.id, rules: rulesOf(t), isDefault: !Array.isArray(t.rules), catalog: CATALOG });
});

app.put('/api/game/rules', requireBridgeKey, async (req, res) => {
  const t = findTenantByUserId(String(req.body?.userId ?? ''));
  if (!t) return res.json({ ok: false, message: 'Enter your game key first.' });
  if (!isActive(t)) return res.json({ ok: false, message: 'Your access has expired or was disabled.' });
  let rules;
  try {
    // reset: true (หรือ rules: null) = คืนค่าเริ่มต้น
    rules = req.body?.reset === true || req.body?.rules === null ? undefined : normalizeRules(req.body?.rules);
  } catch (err) {
    return res.json({ ok: false, message: err.message });
  }
  const updated = { ...t };
  if (rules === undefined) delete updated.rules;
  else updated.rules = rules;
  try {
    await saveTenant(updated);
  } catch (err) {
    console.error('rules save failed:', err.message);
    return res.json({ ok: false, message: 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง' });
  }
  console.log(`[${t.id}] rules ${rules === undefined ? 'reset to default' : `saved (${rules.length})`}`);
  res.json({ ok: true, rules: rulesOf(updated), isDefault: rules === undefined });
});

// GET /api/events?player=<Roblox username>&userId=<Roblox UserId>  (ต้องมี x-bridge-key)
// ดึงแล้วลบออกจากคิวทันที ครั้งละ 20 ให้ตรงกับ MAX_EVENTS_PER_POLL ของ Poller
app.get('/api/events', requireBridgeKey, (req, res) => {
  const player = typeof req.query.player === 'string' ? req.query.player.trim().slice(0, 40) : '';
  const userId = typeof req.query.userId === 'string' ? req.query.userId.trim().slice(0, 20) : '';
  if (!player && !userId) return res.status(400).json({ error: 'player or userId query parameter is required.' });
  const t = tenantForPlayer(userId, player);
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
