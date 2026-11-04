const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// БАЗА ДАННЫХ (REDIS / UPSTASH)
// ============================================================
const UPSTASH_URL = process.env.UPSTASH_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;
let isLeaderboardDirty = false;

async function redis(...args) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
    try {
        const res = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(args)
        });
        if (!res.ok) { console.error('Redis HTTP', res.status); return null; }
        const data = await res.json();
        return data.result;
    } catch (e) { console.error('Redis error:', e.message); return null; }
}

async function redisPipeline(commands) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
    try {
        const res = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(commands)
        });
        return res.ok;
    } catch (e) { return false; }
}

// ============================================================
// 🌟 МОЛОЧНАЯ ФЕРМА (КЛИКЕР) — КОНФИГУРАЦИЯ 🌟
// ============================================================
const COW_CONFIG = {
    clickUps: [
        { id: 'hand',    kind: 'add',  cost: 15,  effect: 1,  mult: 1.15 },
        { id: 'bicep',   kind: 'mult', cost: 100, effect: 2,  max: 1 },
        { id: 'steel',   kind: 'mult', cost: 1e3, effect: 2,  max: 1 },
        { id: 'diamond', kind: 'mult', cost: 1e5, effect: 2,  max: 1 },
        { id: 'plasma',  kind: 'mult', cost: 1e7, effect: 2,  max: 1 },
        { id: 'cosmic',  kind: 'mult', cost: 1e9, effect: 2,  max: 1 },
        { id: 'divine',  kind: 'mult', cost: 1e12, effect: 2, max: 1 },
    ],
    buildings: [
        { id: 'cat',      cost: 15,     prod: 0.1,   mult: 1.15, synergy: { target: 'maid',     factor: 0.01 } },
        { id: 'maid',     cost: 100,    prod: 1,     mult: 1.15, synergy: { target: 'auto',     factor: 0.01 } },
        { id: 'auto',     cost: 1.1e3,  prod: 8,     mult: 1.15, synergy: { target: 'plant',    factor: 0.01 } },
        { id: 'plant',    cost: 12e3,   prod: 47,    mult: 1.15, synergy: { target: 'cheese',   factor: 0.01 } },
        { id: 'cheese',   cost: 130e3,  prod: 260,   mult: 1.15, synergy: { target: 'bank',     factor: 0.01 } },
        { id: 'bank',     cost: 1.4e6,  prod: 1.4e3, mult: 1.15, synergy: { target: 'cosmo',    factor: 0.01 } },
        { id: 'cosmo',    cost: 20e6,   prod: 7.8e3, mult: 1.15, synergy: { target: 'quantum',  factor: 0.01 } },
        { id: 'quantum',  cost: 330e6,  prod: 44e3,  mult: 1.15, synergy: { target: 'portal',   factor: 0.01 } },
        { id: 'portal',   cost: 5.1e9,  prod: 260e3, mult: 1.15, synergy: { target: 'alchemy',  factor: 0.01 } },
        { id: 'alchemy',  cost: 75e9,   prod: 1.6e6, mult: 1.15, synergy: { target: 'time',     factor: 0.01 } },
        { id: 'time',     cost: 1e12,   prod: 10e6,  mult: 1.15, synergy: { target: 'infinity', factor: 0.01 } },
        { id: 'infinity', cost: 14e12,  prod: 65e6,  mult: 1.15, synergy: null },
    ],
    mults: [
        { id: 'hay',    cost: 1e4,  factor: 2 },
        { id: 'gmo',    cost: 1e6,  factor: 2 },
        { id: 'wonder', cost: 1e8,  factor: 2 },
        { id: 'nano',   cost: 1e10, factor: 2 },
        { id: 'legend', cost: 1e12, factor: 3 },
        { id: 'meta',   cost: 1e15, factor: 3 },
        { id: 'void',   cost: 1e18, factor: 3 },
    ],
    achievements: [
        { threshold: 1e3,  bonus: 0.01 }, { threshold: 1e5,  bonus: 0.01 },
        { threshold: 1e7,  bonus: 0.01 }, { threshold: 1e9,  bonus: 0.02 },
        { threshold: 1e11, bonus: 0.02 }, { threshold: 1e13, bonus: 0.02 },
        { threshold: 1e15, bonus: 0.03 }, { threshold: 1e17, bonus: 0.03 },
        { threshold: 1e19, bonus: 0.03 }, { threshold: 1e21, bonus: 0.05 },
        { threshold: 1e23, bonus: 0.05 }, { threshold: 1e25, bonus: 0.05 },
        { threshold: 1e28, bonus: 0.10 }, { threshold: 1e31, bonus: 0.10 },
        { threshold: 1e34, bonus: 0.10 },
    ],
    milestones: [25, 50, 100, 200, 300, 400, 500],
    prestigeBase: 1e9,
    prestigeStep: 10,
    prestigeMult: 5,
};

// ============================================================
// ЦЕПОЧКИ ДОСТИЖЕНИЙ
// ============================================================
const CHAIN_ACHIEVEMENTS = [
    {
        id: 'clicks', name: 'Кликер', icon: '💪',
        tiers: [
            { threshold: 100,     bonus: 0.01 },
            { threshold: 1000,    bonus: 0.01 },
            { threshold: 10000,   bonus: 0.02 },
            { threshold: 100000,  bonus: 0.02 },
            { threshold: 1000000, bonus: 0.03 },
        ]
    },
    {
        id: 'golden', name: 'Охотник на коров', icon: '🐮✨',
        tiers: [
            { threshold: 1,   bonus: 0.01 },
            { threshold: 5,   bonus: 0.01 },
            { threshold: 25,  bonus: 0.02 },
            { threshold: 50,  bonus: 0.02 },
            { threshold: 100, bonus: 0.03 },
        ]
    },
    {
        id: 'slimes', name: 'Ловец слизней', icon: '🪱',
        tiers: [
            { threshold: 1,   bonus: 0.01 },
            { threshold: 10,  bonus: 0.01 },
            { threshold: 50,  bonus: 0.01 },
            { threshold: 100, bonus: 0.02 },
            { threshold: 500, bonus: 0.02 },
        ]
    },
    {
        id: 'cases', name: 'Коллекционер', icon: '📦',
        tiers: [
            { threshold: 1,   bonus: 0.01 },
            { threshold: 10,  bonus: 0.01 },
            { threshold: 50,  bonus: 0.01 },
            { threshold: 100, bonus: 0.02 },
            { threshold: 500, bonus: 0.02 },
        ]
    },
    {
        id: 'prestige', name: 'Перерождение', icon: '⭐',
        tiers: [
            { threshold: 1,  bonus: 0.01 },
            { threshold: 3,  bonus: 0.02 },
            { threshold: 5,  bonus: 0.02 },
            { threshold: 10, bonus: 0.03 },
            { threshold: 20, bonus: 0.05 },
        ]
    },
    {
        id: 'buildings', name: 'Империя', icon: '🏠',
        tiers: [
            { threshold: 10,   bonus: 0.01 },
            { threshold: 100,  bonus: 0.01 },
            { threshold: 500,  bonus: 0.02 },
            { threshold: 1000, bonus: 0.02 },
            { threshold: 5000, bonus: 0.03 },
        ]
    },
];

// ============================================================
// ЗОЛОТАЯ КОРОВА
// ============================================================
const GOLDEN_BUFFS = [
    { id: 'lucky',       weight: 40, type: 'milk' },
    { id: 'frenzy',      weight: 30, type: 'mps',      mult: 7,   duration: 15000 },
    { id: 'clickFrenzy', weight: 15, type: 'cp',       mult: 777, duration: 10000 },
    { id: 'building',    weight: 10, type: 'building', mult: 2,   duration: 20000 },
    { id: 'milkRain',    weight: 5,  type: 'mps',      mult: 15,  duration: 10000 },
];

const GOLDEN_BUFF_DESC = {
    lucky:       '✨ Удача! Мгновенное молоко',
    frenzy:      '🔥 Бешенство ×7 (15с)',
    clickFrenzy: '💥 Бешеный клик ×777 (10с)',
    building:    '🏭 Сила зданий ×2 (20с)',
    milkRain:    '🌊 Молочный дождь ×15 (10с)',
};

function rollGoldenBuff() {
    const total = GOLDEN_BUFFS.reduce((s, b) => s + b.weight, 0);
    let r = Math.random() * total;
    for (const b of GOLDEN_BUFFS) {
        r -= b.weight;
        if (r <= 0) return b;
    }
    return GOLDEN_BUFFS[0];
}

// ============================================================
// СКИНЫ
// ============================================================
const COW_SKINS = [
    { id: 'normal',  name: 'Обычная',       icon: '🐄', rarity: 'common',    chance: 15,   price: 40 },
    { id: 'cool',    name: 'Ледяная',       icon: '🐄', rarity: 'common',    chance: 15,   price: 40 },
    { id: 'pink',    name: 'Розовая',       icon: '🐄', rarity: 'common',    chance: 15,   price: 40 },
    { id: 'green',   name: 'Луговая',       icon: '🐄', rarity: 'common',    chance: 15,   price: 40 },
    { id: 'golden',  name: 'Золотая',       icon: '🐄', rarity: 'rare',      chance: 12.5, price: 150 },
    { id: 'purple',  name: 'Аметистовая',   icon: '🐄', rarity: 'rare',      chance: 12.5, price: 150 },
    { id: 'ghost',   name: 'Призрачная',    icon: '🐄', rarity: 'epic',      chance: 6,    price: 400 },
    { id: 'cyber',   name: 'Кибер-корова',  icon: '🐄', rarity: 'epic',      chance: 6,    price: 400 },
    { id: 'diamond', name: 'Алмазная',      icon: '🐄', rarity: 'legendary', chance: 1.5,  price: 1500 },
    { id: 'divine',  name: 'Божественная',  icon: '🐮', rarity: 'legendary', chance: 1.5,  price: 1500 }
];

const SKIN_BONUSES = {
    normal:  { type: 'mps',      value: 0.02, desc: '+2% к производству' },
    cool:    { type: 'cp',       value: 0.03, desc: '+3% к силе клика' },
    pink:    { type: 'crystals', value: 0.10, desc: '+10% к кристаллам' },
    green:   { type: 'slime',    value: 0.10, desc: '+10% к награде слизня' },
    golden:  { type: 'mps',      value: 0.08, desc: '+8% к производству' },
    purple:  { type: 'cp',       value: 0.08, desc: '+8% к силе клика' },
    ghost:   { type: 'mps',      value: 0.15, desc: '+15% к производству' },
    cyber:   { type: 'cp',       value: 0.15, desc: '+15% к силе клика' },
    diamond: { type: 'mps',      value: 0.25, desc: '+25% к производству' },
    divine:  { type: 'cp',       value: 0.25, desc: '+25% к силе клика' }
};

function getSkinBonus(state, type) {
    const bonus = SKIN_BONUSES[state.currentSkin];
    if (!bonus || bonus.type !== type) return 1;
    return 1 + bonus.value;
}

const DUP_CRYSTALS = { common: 5, rare: 20, epic: 60, legendary: 250 };

function getNextMidnightMSK() {
    const now = new Date();
    now.setUTCHours(now.getUTCHours() + 3);
    now.setUTCHours(24, 0, 0, 0);
    return now.getTime() - (3 * 60 * 60 * 1000);
}

// ============================================================
// ХРАНИЛИЩЕ КЛИКЕРА
// ============================================================
const COW_VERSION = 2;
const cowStates = new Map();

// ============================================================
// ХЕЛПЕРЫ ЦЕПОЧЕК
// ============================================================
function getChainStat(s, chainId) {
    switch (chainId) {
        case 'clicks':    return s.clicksTotal || 0;
        case 'golden':    return s.goldenCowsCaught || 0;
        case 'slimes':    return s.slimesCaught || 0;
        case 'cases':     return s.casesOpened || 0;
        case 'prestige':  return s.prestigeLevel || 0;
        case 'buildings': return Object.values(s.buildings || {}).reduce((a, b) => a + (b || 0), 0);
        default: return 0;
    }
}

function calcChainBonus(s) {
    let total = 0;
    for (const chain of CHAIN_ACHIEVEMENTS) {
        const stat = getChainStat(s, chain.id);
        for (const tier of chain.tiers) {
            if (stat >= tier.threshold) total += tier.bonus;
        }
    }
    return total;
}

// ============================================================
// РАСЧЁТ МАТЕМАТИКИ
// ============================================================
function calcCowMath(s) {
    let achBonus = 0;
    for (const a of COW_CONFIG.achievements) if (s.totalMilk >= a.threshold) achBonus += a.bonus;
    achBonus += calcChainBonus(s);

    let gMult = 1;
    for (const m of COW_CONFIG.mults) if (s.multipliers[m.id]) gMult *= m.factor;
    gMult *= Math.pow(COW_CONFIG.prestigeMult, s.prestigeLevel);
    gMult *= (1 + achBonus);

    const now = Date.now();
    const buff = (s.activeBuff && s.activeBuff.endsAt > now) ? s.activeBuff : null;

    const mpsBonus = getSkinBonus(s, 'mps');
    const cpBonus = getSkinBonus(s, 'cp');

    let mps = 0;
    const ownedMap = s.buildings;
    for (const b of COW_CONFIG.buildings) {
        const owned = ownedMap[b.id] || 0;
        let mileMult = 1;
        for (const t of COW_CONFIG.milestones) if (owned >= t) mileMult *= 2;
        const buildingBuff = (buff && buff.type === 'building' && buff.buildingId === b.id) ? buff.mult : 1;

        let synergyMult = 1;
        for (const other of COW_CONFIG.buildings) {
            if (other.synergy && other.synergy.target === b.id) {
                synergyMult += (ownedMap[other.id] || 0) * other.synergy.factor;
            }
        }

        mps += owned * b.prod * mileMult * buildingBuff * synergyMult;
    }

    let cp = 1;
    for (const u of COW_CONFIG.clickUps) {
        const owned = s.clickUps[u.id] || 0;
        if (u.kind === 'mult') cp *= Math.pow(u.effect, owned);
        else cp += owned * u.effect;
    }
    const cpBuff = (buff && buff.type === 'cp') ? buff.mult : 1;
    cp *= gMult * cpBonus * cpBuff;

    return { mps, cp };
}

function tickCow(s) {
    const now = Date.now();
    const dt = Math.max(0, Math.min(24 * 3600, (now - (s.lastUpdate || now)) / 1000));
    const { mps } = calcCowMath(s);
    s.milk += mps * dt;
    s.totalMilk += mps * dt;
    s.lastUpdate = now;
}

async function getCowState(playerId) {
    let state = cowStates.get(playerId);

    if (state && state.version !== COW_VERSION) {
        cowStates.delete(playerId);
        state = null;
    }

    if (!state) {
        const raw = await redis('GET', 'cow:' + playerId);
        state = raw ? JSON.parse(raw) : null;
        if (state && state.version !== COW_VERSION) state = null;

        if (!state) {
            state = {
                version: COW_VERSION,
                milk: 0, totalMilk: 0, lastUpdate: Date.now(),
                clickUps: {}, buildings: {}, multipliers: {}, prestigeLevel: 0,
                nextCaseTime: 0, unlockedSkins: ['normal'], currentSkin: 'normal',
                crystals: 0, cases: 0, lastSlimeClick: 0,
                activeBuff: null, lastGoldenAt: 0, goldenCowsCaught: 0,
                clicksTotal: 0, slimesCaught: 0, casesOpened: 0,
            };
        }

        if (state.crystals == null) state.crystals = 0;
        if (state.cases == null) state.cases = 0;
        if (!state.unlockedSkins) state.unlockedSkins = ['normal'];
        if (!state.currentSkin) state.currentSkin = 'normal';
        if (state.lastSlimeClick == null) state.lastSlimeClick = 0;
        if (state.activeBuff === undefined) state.activeBuff = null;
        if (state.lastGoldenAt == null) state.lastGoldenAt = 0;
        if (state.goldenCowsCaught == null) state.goldenCowsCaught = 0;
        if (state.clicksTotal == null) state.clicksTotal = 0;
        if (state.slimesCaught == null) state.slimesCaught = 0;
        if (state.casesOpened == null) state.casesOpened = 0;

        cowStates.set(playerId, state);
    }

    if (state.activeBuff && state.activeBuff.endsAt <= Date.now()) state.activeBuff = null;

    tickCow(state);
    return state;
}

async function saveCowState(playerId) {
    const s = cowStates.get(playerId);
    if (!s) return;
    await redis('SET', 'cow:' + playerId, JSON.stringify(s));
}

setInterval(() => {
    for (const pid of cowStates.keys()) saveCowState(pid);
}, 60000).unref?.();

// ============================================================
// ОБЩИЕ НАСТРОЙКИ СЕРВЕРА
// ============================================================
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
app.set('trust proxy', TRUST_PROXY ? 1 : false);

const MATCHMAKING_TIMEOUT = 30 * 1000;
const DISCONNECT_TIMEOUT = 120 * 1000;
const FINISHED_MATCH_TTL = 10 * 60 * 1000;
const ABANDONED_MATCH_TTL = 5 * 60 * 1000;
const SESSION_TTL = 2 * 60 * 60 * 1000;
const SESSION_CLEANUP_MS = 10 * 60 * 1000;
const DRAW_HM_LIMIT = 30;
const REPEAT_LIMIT = 3;
const MAX_QUEUE = 500;
const MAX_PLAYERS = 100000;
const MAX_SESSIONS = 100000;
const SESSION_RATE_WINDOW_MS = 60 * 1000;
const SESSION_RATE_MAX = 20;
const PLAYER_INACTIVE_TTL = 30 * 24 * 60 * 60 * 1000;

const GAME_RULES = {
    'mines_easy':    { lower: true,  maxScore: 3600,    minSeconds: 2 },
    'mines_mid':     { lower: true,  maxScore: 3600,    minSeconds: 2 },
    'mines_hard':    { lower: true,  maxScore: 3600,    minSeconds: 2 },
    'tetris':        { lower: false, maxScore: 1000000, minSeconds: 10 },
    'match3':        { lower: false, maxScore: 100000,  minSeconds: 5 },
    'snake_classic': { lower: false, maxScore: 100000,  minSeconds: 5 },
    'snake_wrap':    { lower: false, maxScore: 100000,  minSeconds: 5 },
    'snake_maze':    { lower: false, maxScore: 100000,  minSeconds: 5 },
    'pong_easy':     { lower: false, maxScore: 10000,   minSeconds: 15 },
    'pong_mid':      { lower: false, maxScore: 10000,   minSeconds: 15 },
    'pong_hard':     { lower: false, maxScore: 10000,   minSeconds: 15 },
    'checkers':      { lower: false, maxScore: 99999,   minSeconds: 0 },
    'chess':         { lower: false, maxScore: 99999,   minSeconds: 0 },
    'checkers-mp':   { lower: false, maxScore: 99999,   minSeconds: 0 },
    'chess-mp':      { lower: false, maxScore: 99999,   minSeconds: 0 },
    'cowclicker':    { lower: false, maxScore: 1e18,    minSeconds: 60 },
};

const nowMs = () => Date.now();
const posKey = (pos) => pos.b.map(p => p || '.').join('') + '|' + pos.turn;

function sanitizeNickname(n) {
    return String(n || '').replace(/[<>&"'\x00-\x1f\x7f]/g, '').substring(0, 20).trim() || 'Аноним';
}

// ============================================================
// ХРАНИЛИЩА
// ============================================================
const players = new Map();
const tokensToPlayers = new Map();
const matches = {};
const chessMatches = {};
const matchmakingQueue = [];
const chessQueue = [];
const leaderboards = {};
const gameSessions = new Map();
const playerGameSessions = new Map();

// ============================================================
// АВТОРИЗАЦИЯ
// ============================================================
function getAuthedPlayerId(req) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7).trim();
    if (!token) return null;
    const playerId = tokensToPlayers.get(token);
    if (!playerId) return null;
    const p = players.get(playerId);
    if (p) p.lastActiveAt = nowMs();
    return playerId;
}

function cleanupInactivePlayers(thresholdMs) {
    let removed = 0;
    for (const [playerId, p] of players.entries()) {
        if ((p.lastActiveAt || p.createdAt) < thresholdMs) {
            players.delete(playerId);
            tokensToPlayers.delete(p.token);
            removed++;
        }
    }
    if (removed > 0) console.log(`Очищено неактивных игроков: ${removed}`);
    return removed;
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use((req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('Referrer-Policy', 'no-referrer');
    next();
});

const rateLimits = new Map();
function checkRateLimit(key, maxReq, windowMs) {
    const now = Date.now();
    let entry = rateLimits.get(key);
    if (!entry || now > entry.reset) {
        entry = { count: 0, reset: now + windowMs };
        rateLimits.set(key, entry);
    }
    entry.count++;
    return entry.count <= maxReq;
}
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimits.entries()) {
        if (now > entry.reset) rateLimits.delete(key);
    }
}, 60 * 1000).unref?.();

app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit('ip:' + ip, 150, 60 * 1000)) {
        return res.status(429).json({ success: false, error: 'Слишком много запросов. Подождите.' });
    }
    next();
});

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'https://play.multidonate.ru');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json({ limit: '32kb' }));

// ============================================================
// РЕГИСТРАЦИЯ ИГРОКОВ
// ============================================================
app.post('/api/player/register', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit('reg:' + ip, 60, 60 * 60 * 1000)) {
        return res.status(429).json({ success: false, error: 'Слишком много регистраций. Подождите.' });
    }
    if (players.size >= MAX_PLAYERS) cleanupInactivePlayers(nowMs() - PLAYER_INACTIVE_TTL);
    if (players.size >= MAX_PLAYERS) return res.status(503).json({ success: false, error: 'Сервер перегружен' });

    const playerId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const now = nowMs();
    players.set(playerId, { token, createdAt: now, lastActiveAt: now });
    tokensToPlayers.set(token, playerId);

    await redis('HSET', 'players_db', token, JSON.stringify({ playerId, createdAt: now, lastActiveAt: now }));
    res.json({ success: true, playerId, token });
});

setInterval(() => { cleanupInactivePlayers(nowMs() - PLAYER_INACTIVE_TTL); }, 60 * 60 * 1000).unref?.();

// ============================================================
// ЛИДЕРБОРД
// ============================================================
async function loadLeaderboardsFromDB() {
    if (!UPSTASH_URL) return;
    const allPlayers = await redis('HGETALL', 'players_db');
    if (Array.isArray(allPlayers)) {
        for (let i = 0; i < allPlayers.length; i += 2) {
            const token = allPlayers[i];
            try {
                const data = JSON.parse(allPlayers[i + 1]);
                players.set(data.playerId, { token, createdAt: data.createdAt, lastActiveAt: data.lastActiveAt, nickname: data.nickname });
                tokensToPlayers.set(token, data.playerId);
            } catch (e) {}
        }
    }
    for (const gameId of Object.keys(GAME_RULES)) {
        const key = `lb:${gameId}`;
        const all = await redis('HGETALL', key);
        if (Array.isArray(all) && all.length > 0) {
            const scores = [];
            for (let i = 0; i < all.length; i += 2) {
                try {
                    const v = JSON.parse(all[i + 1]);
                    scores.push({ playerId: all[i], nickname: v.nickname, score: v.score, losses: v.losses || 0, date: v.date || 0 });
                } catch (_) {}
            }
            const isLower = GAME_RULES[gameId].lower;
            scores.sort((a, b) => isLower ? a.score - b.score : b.score - a.score);
            leaderboards[gameId] = scores.slice(0, 10);
        }
    }
}

async function flushLeaderboardsToDB() {
    if (!UPSTASH_URL || !isLeaderboardDirty) return;
    isLeaderboardDirty = false;
    const commands = [];
    for (const gameId of Object.keys(leaderboards)) {
        const scores = leaderboards[gameId];
        if (!scores || scores.length === 0) continue;
        const key = `lb:${gameId}`;
        commands.push(['DEL', key]);
        const hsetArgs = ['HSET', key];
        for (const s of scores) hsetArgs.push(s.playerId, JSON.stringify({ nickname: s.nickname, score: s.score, losses: s.losses || 0, date: s.date }));
        commands.push(hsetArgs);
    }
    if (commands.length > 0) await redisPipeline(commands);
}

setInterval(flushLeaderboardsToDB, 60 * 1000).unref?.();
process.on('SIGTERM', async () => {
    await flushLeaderboardsToDB();
    for (const pid of cowStates.keys()) await saveCowState(pid);
    process.exit(0);
});

// ============================================================
// СЕССИИ (АНТИЧИТ)
// ============================================================
app.post('/api/session/start', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    const { gameId } = req.body || {};
    if (!gameId) return res.status(400).json({ success: false, error: 'Не указан gameId' });
    if (!GAME_RULES[gameId]) return res.status(400).json({ success: false, error: 'Неизвестная игра' });
    if (gameSessions.size >= MAX_SESSIONS) return res.status(503).json({ success: false, error: 'Сервер перегружен' });
    if (!checkRateLimit('sess:' + playerId, SESSION_RATE_MAX, SESSION_RATE_WINDOW_MS)) return res.status(429).json({ success: false, error: 'Слишком часто. Подождите.' });

    const pairKey = playerId + ':' + gameId;
    const oldSid = playerGameSessions.get(pairKey);
    if (oldSid) gameSessions.delete(oldSid);
    const sessionId = crypto.randomUUID();
    gameSessions.set(sessionId, { gameId, playerId, startTime: Date.now() });
    playerGameSessions.set(pairKey, sessionId);
    res.json({ success: true, sessionId });
});

setInterval(() => {
    const now = Date.now();
    for (const [id, s] of gameSessions.entries()) {
        if (now - s.startTime > SESSION_TTL) {
            gameSessions.delete(id);
            const pk = s.playerId + ':' + s.gameId;
            if (playerGameSessions.get(pk) === id) playerGameSessions.delete(pk);
        }
    }
}, SESSION_CLEANUP_MS).unref?.();

// ============================================================
// ОЧКИ (ЛИДЕРБОРД)
// ============================================================
app.post('/api/scores', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    let { gameId, nickname, score, losses = 0, sessionId } = req.body || {};
    if (!gameId || score == null) return res.status(400).json({ success: false, error: 'Нет данных' });
    const rules = GAME_RULES[gameId];
    if (!rules) return res.status(400).json({ success: false, error: 'Неизвестная игра' });
    if (gameId === 'checkers-mp' || gameId === 'chess-mp' || gameId === 'cowclicker') return res.status(400).json({ success: false });

    nickname = sanitizeNickname(nickname);
    score = Math.floor(Number(score));
    if (isNaN(score) || score < 0 || score > rules.maxScore) return res.status(400).json({ success: false, error: 'Неверный счёт' });
    losses = Math.max(0, Math.floor(Number(losses)) || 0);

    if (!sessionId || typeof sessionId !== 'string') return res.status(400).json({ success: false, error: 'Нет sessionId' });
    const session = gameSessions.get(sessionId);
    if (!session) return res.status(400).json({ success: false, error: 'Сессия недействительна' });
    if (session.gameId !== gameId || session.playerId !== playerId) {
        gameSessions.delete(sessionId);
        return res.status(400).json({ success: false, error: 'Сессия не совпадает' });
    }
    gameSessions.delete(sessionId);

    const elapsedSeconds = (Date.now() - session.startTime) / 1000;
    let minSeconds = rules.minSeconds || 0;
    if (gameId === 'tetris') minSeconds = Math.max(minSeconds, score * 0.2);
    else if (gameId.startsWith('snake_')) minSeconds = Math.max(minSeconds, score * 0.1);
    else if (gameId === 'match3') minSeconds = Math.max(minSeconds, score * 0.05);
    else if (gameId.startsWith('pong_')) minSeconds = Math.max(minSeconds, score * 15);
    if (elapsedSeconds < minSeconds) return res.status(400).json({ success: false, error: 'Античит: слишком быстро' });

    if (!leaderboards[gameId]) leaderboards[gameId] = [];
    const lower = rules.lower;
    const existing = leaderboards[gameId].find(x => x.playerId === playerId);
    if (existing) {
        let updated = false;
        if (lower ? score < existing.score : score > existing.score) { existing.score = score; updated = true; }
        if (losses > (existing.losses || 0)) { existing.losses = losses; updated = true; }
        if (existing.nickname !== nickname) { existing.nickname = nickname; updated = true; }
        if (updated) { existing.date = Date.now(); isLeaderboardDirty = true; }
    } else {
        leaderboards[gameId].push({ playerId, nickname, score, losses, date: Date.now() });
        isLeaderboardDirty = true;
    }
    leaderboards[gameId].sort((a, b) => lower ? a.score - b.score : b.score - a.score);
    leaderboards[gameId] = leaderboards[gameId].slice(0, 10);
    res.json({ success: true });
});

app.get('/api/scores/:gameId', (req, res) => {
    const gameId = req.params.gameId;
    if (!GAME_RULES[gameId]) return res.status(400).json({ success: false, error: 'Неизвестная игра' });
    const scores = (leaderboards[gameId] || []).slice(0, 10).map(s => ({ nickname: s.nickname, score: s.score, losses: s.losses || 0 }));
    res.json({ success: true, scores });
});

// ============================================================
// 🌟 API МОЛОЧНОЙ ФЕРМЫ 🌟
// ============================================================
function syncCowLeaderboard(playerId, s) {
    const score = Math.floor(s.totalMilk);
    if (!leaderboards['cowclicker']) leaderboards['cowclicker'] = [];
    const lb = leaderboards['cowclicker'];
    const existing = lb.find(x => x.playerId === playerId);
    const p = players.get(playerId);
    const currentNickname = (p && p.nickname) ? p.nickname : null;

    if (existing) {
        let updated = false;
        if (score > existing.score) { existing.score = score; updated = true; }
        if (currentNickname && existing.nickname !== currentNickname) { existing.nickname = currentNickname; updated = true; }
        if (updated) { existing.date = Date.now(); isLeaderboardDirty = true; }
    } else if (score > 0) {
        lb.push({ playerId, nickname: currentNickname || 'Загрузка...', score, losses: 0, date: Date.now() });
        isLeaderboardDirty = true;
    }
    lb.sort((a, b) => b.score - a.score);
    leaderboards['cowclicker'] = lb.slice(0, 10);
}

app.post('/api/cow/sync', async (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false });
    const rawNickname = req.body && req.body.nickname;
    if (rawNickname) {
        const p = players.get(playerId);
        if (p) {
            p.nickname = sanitizeNickname(rawNickname);
            await redis('HSET', 'players_db', p.token, JSON.stringify({ playerId, createdAt: p.createdAt, lastActiveAt: p.lastActiveAt, nickname: p.nickname }));
        }
    }
    const state = await getCowState(playerId);
    syncCowLeaderboard(playerId, state);
    res.json({ success: true, state });
});

app.post('/api/cow/click', async (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false });
    const { clicks, nickname } = req.body;
    if (typeof clicks !== 'number' || clicks <= 0) return res.status(400).json({ success: false });

    if (nickname) {
        const p = players.get(playerId);
        if (p) {
            p.nickname = sanitizeNickname(nickname);
            redis('HSET', 'players_db', p.token, JSON.stringify({ playerId, createdAt: p.createdAt, lastActiveAt: p.lastActiveAt, nickname: p.nickname })).catch(() => {});
        }
    }

    const state = await getCowState(playerId);
    const now = Date.now();
    const timeDiff = (now - (state.lastClickTime || now - 1000)) / 1000;

    if (clicks > timeDiff * 20 + 5) return res.status(400).json({ success: false, error: 'Античит: слишком быстро' });

    const { cp } = calcCowMath(state);
    state.milk += clicks * cp;
    state.totalMilk += clicks * cp;
    state.clicksTotal = (state.clicksTotal || 0) + clicks;
    state.lastClickTime = now;
    state.lastUpdate = now;
    syncCowLeaderboard(playerId, state);
    res.json({ success: true, milk: state.milk, totalMilk: state.totalMilk });
});

app.post('/api/cow/buy', async (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false });
    const { type, id } = req.body;
    let { qty } = req.body;
    if (!qty || typeof qty !== 'number' || qty <= 0) return res.status(400).json({ success: false });

    const state = await getCowState(playerId);
    tickCow(state);

    if (type === 'building') {
        const cfg = COW_CONFIG.buildings.find(b => b.id === id);
        if (!cfg) return res.status(400).json({ success: false });
        const owned = state.buildings[id] || 0;
        let price = 0;
        for (let i = 0; i < qty; i++) price += cfg.cost * Math.pow(cfg.mult, owned + i);
        price = Math.floor(price);
        if (state.milk < price) return res.status(400).json({ success: false, error: 'Не хватает молока' });
        state.milk -= price;
        state.buildings[id] = owned + qty;
    } else if (type === 'clickUp') {
        const cfg = COW_CONFIG.clickUps.find(u => u.id === id);
        if (!cfg) return res.status(400).json({ success: false });
        const owned = state.clickUps[id] || 0;
        if (cfg.max && owned >= cfg.max) return res.status(400).json({ success: false, error: 'Уже куплено' });

        let price, buyQty;
        if (cfg.max) {
            price = Math.floor(cfg.cost);
            buyQty = 1;
        } else {
            buyQty = qty;
            price = 0;
            for (let i = 0; i < buyQty; i++) price += cfg.cost * Math.pow(cfg.mult, owned + i);
            price = Math.floor(price);
        }
        if (state.milk < price) return res.status(400).json({ success: false, error: 'Не хватает молока' });
        state.milk -= price;
        state.clickUps[id] = owned + buyQty;
    } else if (type === 'mult') {
        qty = 1;
        const cfg = COW_CONFIG.mults.find(m => m.id === id);
        if (!cfg || state.multipliers[id]) return res.status(400).json({ success: false });
        if (state.milk < cfg.cost) return res.status(400).json({ success: false, error: 'Не хватает молока' });
        state.milk -= cfg.cost;
        state.multipliers[id] = true;
    }

    saveCowState(playerId);
    syncCowLeaderboard(playerId, state);
    res.json({ success: true, milk: state.milk });
});

app.post('/api/cow/prestige', async (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false });
    const state = await getCowState(playerId);
    const cost = Math.floor(COW_CONFIG.prestigeBase * Math.pow(COW_CONFIG.prestigeStep, state.prestigeLevel));
    if (state.milk < cost) return res.status(400).json({ success: false, error: 'Не хватает молока' });

    state.prestigeLevel += 1;
    state.milk = 0;
    state.clickUps = {};
    state.buildings = {};
    state.multipliers = {};
    const casesReward = state.prestigeLevel * 2;
    state.cases = (state.cases || 0) + casesReward;
    saveCowState(playerId);
    res.json({ success: true, state, casesReward });
});

app.post('/api/cow/claim-daily', async (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false });
    const state = await getCowState(playerId);
    if (Date.now() < (state.nextCaseTime || 0)) return res.status(400).json({ success: false, error: 'Кейс еще не готов' });
    state.cases += 1;
    state.nextCaseTime = getNextMidnightMSK();
    saveCowState(playerId);
    res.json({ success: true, state });
});

app.post('/api/cow/open-case', async (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false });
    const state = await getCowState(playerId);
    if (state.cases <= 0) return res.status(400).json({ success: false, error: 'Нет кейсов' });
    state.cases -= 1;
    state.casesOpened = (state.casesOpened || 0) + 1;

    let roll = Math.random() * 100;
    let selectedSkin = COW_SKINS[0];
    let currentChance = 0;
    for (const skin of COW_SKINS) {
        currentChance += skin.chance;
        if (roll <= currentChance) { selectedSkin = skin; break; }
    }

    let isDuplicate = false;
    let crystalsGained = 0;
    if (state.unlockedSkins.includes(selectedSkin.id)) {
        isDuplicate = true;
        let baseCrystals = DUP_CRYSTALS[selectedSkin.rarity] || 0;
        const crystalBonus = getSkinBonus(state, 'crystals');
        crystalsGained = Math.floor(baseCrystals * crystalBonus);
        state.crystals += crystalsGained;
    } else {
        state.unlockedSkins.push(selectedSkin.id);
    }
    saveCowState(playerId);
    res.json({ success: true, skin: selectedSkin, isDuplicate, crystalsGained, state });
});

app.post('/api/cow/shop', async (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false });
    const { action, itemId } = req.body;
    const state = await getCowState(playerId);

    if (action === 'buy_case') {
        if (state.crystals < 50) return res.status(400).json({ success: false, error: 'Не хватает 💎' });
        state.crystals -= 50;
        state.cases += 1;
    } else if (action === 'buy_skin') {
        const skin = COW_SKINS.find(s => s.id === itemId);
        if (!skin) return res.status(400).json({ success: false });
        if (state.unlockedSkins.includes(itemId)) return res.status(400).json({ success: false, error: 'Уже есть' });
        if (state.crystals < skin.price) return res.status(400).json({ success: false, error: 'Не хватает 💎' });
        state.crystals -= skin.price;
        state.unlockedSkins.push(itemId);
    } else if (action === 'equip') {
        if (!state.unlockedSkins.includes(itemId)) return res.status(400).json({ success: false });
        state.currentSkin = itemId;
    }
    saveCowState(playerId);
    res.json({ success: true, state });
});

app.post('/api/cow/slime', async (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false });
    const state = await getCowState(playerId);
    const now = Date.now();

    if (now - (state.lastSlimeClick || 0) < 60000) {
        return res.status(400).json({ success: false, error: 'Слизень еще не готов' });
    }

    state.lastSlimeClick = now;
    state.slimesCaught = (state.slimesCaught || 0) + 1;
    const { mps } = calcCowMath(state);
    let rewardMilk = 0;
    let rewardCrystals = 0;

    if (Math.random() > 0.5) {
        const slimeBonus = getSkinBonus(state, 'slime');
        rewardMilk = Math.floor(mps * 120 * slimeBonus);
        state.milk += rewardMilk;
        state.totalMilk += rewardMilk;
    } else {
        const crystalBonus = getSkinBonus(state, 'crystals');
        rewardCrystals = Math.floor(10 * crystalBonus);
        state.crystals += rewardCrystals;
    }

    saveCowState(playerId);
    syncCowLeaderboard(playerId, state);
    res.json({ success: true, rewardMilk, rewardCrystals, state });
});

app.post('/api/cow/slime/escape', async (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false });
    const state = await getCowState(playerId);
    state.milk = Math.floor(state.milk * 0.95);
    saveCowState(playerId);
    res.json({ success: true, state });
});

// ============================================================
// ЗОЛОТАЯ КОРОВА
// ============================================================
app.post('/api/cow/golden-cow', async (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false });
    const state = await getCowState(playerId);
    const now = Date.now();

    if (now - (state.lastGoldenAt || 0) < 60000) {
        return res.status(400).json({ success: false, error: 'Слишком часто' });
    }

    state.lastGoldenAt = now;
    state.goldenCowsCaught = (state.goldenCowsCaught || 0) + 1;

    const buff = rollGoldenBuff();
    const { mps, cp } = calcCowMath(state);

    let rewardMilk = 0;
    let buffDesc = GOLDEN_BUFF_DESC[buff.id] || buff.id;

    if (buff.type === 'milk') {
        rewardMilk = Math.floor(Math.max(mps * 300, cp * 13, 100));
        state.milk += rewardMilk;
        state.totalMilk += rewardMilk;
    } else {
        let buildingId = null;
        if (buff.type === 'building') {
            const ownedIds = COW_CONFIG.buildings
                .filter(b => (state.buildings[b.id] || 0) > 0)
                .map(b => b.id);
            if (ownedIds.length === 0) {
                rewardMilk = Math.floor(Math.max(cp * 13, 100));
                state.milk += rewardMilk;
                state.totalMilk += rewardMilk;
                buffDesc = GOLDEN_BUFF_DESC.lucky;
                saveCowState(playerId);
                syncCowLeaderboard(playerId, state);
                return res.json({ success: true, state, rewardMilk, buffDesc });
            }
            buildingId = ownedIds[Math.floor(Math.random() * ownedIds.length)];
        }

        state.activeBuff = {
            id: buff.id,
            type: buff.type,
            mult: buff.mult || 1,
            buildingId,
            startsAt: now,
            endsAt: now + buff.duration,
            desc: buffDesc,
        };
    }

    saveCowState(playerId);
    syncCowLeaderboard(playerId, state);
    res.json({ success: true, state, rewardMilk, buffDesc });
});

// ============================================================
// МУЛЬТИПЛЕЕР: ШАХМАТЫ И ШАШКИ
// ============================================================
function finishMatch(match, winner, reason) {
    if (match.status === 'finished') return;
    match.status = 'finished';
    match.winner = winner;
    match.endReason = reason;
    match.finishedAt = nowMs();
}

function updateMultiplayerLeaderboard(gameId, match) {
    if (!match || !match.players || match.players.length !== 2) return;
    const winnerId = match.winner;
    if (!winnerId) return;
    if (!leaderboards[gameId]) leaderboards[gameId] = [];
    const lb = leaderboards[gameId];

    for (const p of match.players) {
        let entry = lb.find(x => x.playerId === p.id);
        if (!entry) {
            entry = { playerId: p.id, nickname: p.nickname, score: 0, losses: 0, date: Date.now() };
            lb.push(entry);
        }
        entry.nickname = p.nickname;
        entry.date = Date.now();
        if (p.id === winnerId) entry.score += 1;
        else entry.losses += 1;
    }
    lb.sort((a, b) => (b.score - a.score) || (a.losses - b.losses));
    leaderboards[gameId] = lb.slice(0, 10);
    isLeaderboardDirty = true;
}

function finishCheckersMatch(match, winner, reason) {
    const wasPlaying = match.status === 'playing';
    finishMatch(match, winner, reason);
    if (wasPlaying && winner) updateMultiplayerLeaderboard('checkers-mp', match);
}

function finishChessMatch(match, winner, reason) {
    const wasPlaying = match.status === 'playing';
    finishMatch(match, winner, reason);
    if (wasPlaying && winner) updateMultiplayerLeaderboard('chess-mp', match);
}

function removeFromOtherQueues(playerId, keepQueue) {
    if (keepQueue !== 'checkers') {
        const i = matchmakingQueue.findIndex(p => p.id === playerId);
        if (i !== -1) matchmakingQueue.splice(i, 1);
    }
    if (keepQueue !== 'chess') {
        const i = chessQueue.findIndex(p => p.id === playerId);
        if (i !== -1) chessQueue.splice(i, 1);
    }
}

function checkDraw(match) {
    const pos = match.gameState;
    const pieces = pos.b.filter(p => p).length;
    if (pieces <= 6 && pos.hm >= DRAW_HM_LIMIT) return 'draw-15';
    const key = posKey(pos);
    if (match.history.filter(k => k === key).length >= REPEAT_LIMIT) return 'draw-repeat';
    return null;
}

function checkChessDraw(match) {
    const pos = match.gameState;
    if (pos.hm >= 100) return 'fifty';
    if (CH.insufficient(pos)) return 'material';
    const key = CH.key(pos);
    if (match.history.filter(k => k === key).length >= REPEAT_LIMIT) return 'repeat';
    return null;
}

// ============================================================
// ДВИЖОК ШАШЕК
// ============================================================
const CK = (() => {
    const DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    const colorOf = (p) => (!p ? null : (p === 'w' || p === 'W' ? 'w' : 'b'));
    const isKing = (p) => p === 'W' || p === 'B';

    function startPos() {
        const b = new Array(64).fill('');
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
            if (((r + c) & 1) === 0) continue;
            const i = r * 8 + c;
            if (r < 3) b[i] = 'b'; else if (r > 4) b[i] = 'w';
        }
        return { b, turn: 'w', hm: 0 };
    }

    function genCaps(b, sq, piece, captured, path) {
        const r = sq >> 3, c = sq & 7, myColor = colorOf(piece), myKing = isKing(piece), results = [];
        let extended = false;
        for (const [dr, dc] of DIRS) {
            if (myKing) {
                let jumpedSq = -1, jumpDist = 0;
                for (let d = 1; ; d++) {
                    const nr = r + dr * d, nc = c + dc * d;
                    if (nr < 0 || nr > 7 || nc < 0 || nc > 7) break;
                    const nSq = nr * 8 + nc;
                    if (b[nSq]) {
                        if (captured.has(nSq) || colorOf(b[nSq]) === myColor) break;
                        jumpedSq = nSq; jumpDist = d; break;
                    }
                }
                if (jumpedSq === -1) continue;
                for (let d = jumpDist + 1; ; d++) {
                    const nr = r + dr * d, nc = c + dc * d;
                    if (nr < 0 || nr > 7 || nc < 0 || nc > 7) break;
                    const lSq = nr * 8 + nc;
                    if (b[lSq]) break;
                    extended = true;
                    const nc2 = new Set(captured); nc2.add(jumpedSq);
                    results.push(...genCaps(b, lSq, piece, nc2, [...path, lSq]));
                }
            } else {
                const mr = r + dr, mc = c + dc;
                if (mr < 0 || mr > 7 || mc < 0 || mc > 7) continue;
                const mSq = mr * 8 + mc, mp = b[mSq];
                if (!mp || colorOf(mp) === myColor || captured.has(mSq)) continue;
                const lr = r + dr * 2, lc = c + dc * 2;
                if (lr < 0 || lr > 7 || lc < 0 || lc > 7) continue;
                const lSq = lr * 8 + lc;
                if (b[lSq]) continue;
                extended = true;
                const nc2 = new Set(captured); nc2.add(mSq);
                let newPiece = piece;
                if ((myColor === 'w' && lr === 0) || (myColor === 'b' && lr === 7)) newPiece = myColor === 'w' ? 'W' : 'B';
                results.push(...genCaps(b, lSq, newPiece, nc2, [...path, lSq]));
            }
        }
        if (!extended && captured.size > 0) return [{ from: path[0], to: sq, captures: [...captured], path, piece }];
        return results;
    }

    function genSimple(b, turn) {
        const moves = [];
        for (let i = 0; i < 64; i++) {
            const p = b[i]; if (!p || colorOf(p) !== turn) continue;
            const r = i >> 3, c = i & 7;
            if (isKing(p)) {
                for (const [dr, dc] of DIRS) for (let d = 1; ; d++) {
                    const nr = r + dr * d, nc = c + dc * d;
                    if (nr < 0 || nr > 7 || nc < 0 || nc > 7) break;
                    const nSq = nr * 8 + nc;
                    if (b[nSq]) break;
                    moves.push({ from: i, to: nSq, captures: [], path: [i, nSq], piece: p });
                }
            } else {
                const fwd = turn === 'w' ? -1 : 1;
                for (const dc of [-1, 1]) {
                    const nr = r + fwd, nc = c + dc;
                    if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
                    const nSq = nr * 8 + nc;
                    if (b[nSq]) continue;
                    let newPiece = p;
                    if ((turn === 'w' && nr === 0) || (turn === 'b' && nr === 7)) newPiece = turn === 'w' ? 'W' : 'B';
                    moves.push({ from: i, to: nSq, captures: [], path: [i, nSq], piece: newPiece });
                }
            }
        }
        return moves;
    }

    function legal(pos) {
        const caps = [];
        for (let i = 0; i < 64; i++) {
            const p = pos.b[i];
            if (!p || colorOf(p) !== pos.turn) continue;
            caps.push(...genCaps(pos.b, i, p, new Set(), [i]));
        }
        return caps.length > 0 ? caps : genSimple(pos.b, pos.turn);
    }

    function make(pos, m) {
        const b = [...pos.b];
        for (const sq of m.captures) b[sq] = '';
        b[m.from] = ''; b[m.to] = m.piece;
        let hm = pos.hm;
        if (m.captures.length > 0 || !isKing(pos.b[m.from])) hm = 0; else hm++;
        return { b, turn: pos.turn === 'w' ? 'b' : 'w', hm };
    }

    return { startPos, legal, make };
})();

// ============================================================
// ДВИЖОК ШАХМАТ
// ============================================================
const CH = (() => {
    const isW = (p) => p === p.toUpperCase();
    const colorOf = (p) => (isW(p) ? 'w' : 'b');
    const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
    const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    function fromFEN(fen) {
        const parts = fen.split(' '); const b = [];
        for (const ch of parts[0]) {
            if (ch === '/') continue;
            if (ch >= '1' && ch <= '8') for (let k = 0; k < Number(ch); k++) b.push(null);
            else b.push(ch);
        }
        const cast = parts[2] || '-', ep = parts[3] || '-';
        return { b, turn: parts[1] || 'w', c: { K: cast.includes('K'), Q: cast.includes('Q'), k: cast.includes('k'), q: cast.includes('q') }, ep: ep === '-' ? -1 : (8 - Number(ep[1])) * 8 + (ep.charCodeAt(0) - 97), hm: Number(parts[4]) || 0 };
    }
    const startPos = () => fromFEN('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

    function attacked(pos, sq, by) {
        const b = pos.b, r = sq >> 3, c = sq & 7, pr = by === 'w' ? r + 1 : r - 1;
        if (pr >= 0 && pr < 8) { const P = by === 'w' ? 'P' : 'p'; if (c > 0 && b[pr * 8 + c - 1] === P) return true; if (c < 7 && b[pr * 8 + c + 1] === P) return true; }
        const N = by === 'w' ? 'N' : 'n', K = by === 'w' ? 'K' : 'k';
        for (const [dr, dc] of KN) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === N) return true; }
        for (const [dr, dc] of KG) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === K) return true; }
        const B = by === 'w' ? 'B' : 'b', R = by === 'w' ? 'R' : 'r', Q = by === 'w' ? 'Q' : 'q';
        for (const [dr, dc] of DIAG) { let rr = r + dr, cc = c + dc; while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) { const p = b[rr * 8 + cc]; if (p) { if (p === B || p === Q) return true; break; } rr += dr; cc += dc; } }
        for (const [dr, dc] of ORTH) { let rr = r + dr, cc = c + dc; while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) { const p = b[rr * 8 + cc]; if (p) { if (p === R || p === Q) return true; break; } rr += dr; cc += dc; } }
        return false;
    }

    function inCheck(pos, color) { const k = pos.b.indexOf(color === 'w' ? 'K' : 'k'); return k >= 0 && attacked(pos, k, color === 'w' ? 'b' : 'w'); }

    function make(pos, m) {
        const b = pos.b.slice(), me = pos.turn, p = b[m.from], cap = b[m.to];
        b[m.to] = m.promo ? (me === 'w' ? m.promo.toUpperCase() : m.promo.toLowerCase()) : p; b[m.from] = null;
        if (m.flag === 'ep') b[m.to + (me === 'w' ? 8 : -8)] = null;
        if (m.flag === 'ck') { const [f, t] = me === 'w' ? [63, 61] : [7, 5]; b[t] = b[f]; b[f] = null; }
        if (m.flag === 'cq') { const [f, t] = me === 'w' ? [56, 59] : [0, 3]; b[t] = b[f]; b[f] = null; }
        const c = { K: pos.c.K, Q: pos.c.Q, k: pos.c.k, q: pos.c.q };
        if (p === 'K') { c.K = false; c.Q = false; } if (p === 'k') { c.k = false; c.q = false; }
        for (const sq of [m.from, m.to]) { if (sq === 63) c.K = false; if (sq === 56) c.Q = false; if (sq === 7) c.k = false; if (sq === 0) c.q = false; }
        const pawn = p === 'P' || p === 'p';
        return { b, turn: me === 'w' ? 'b' : 'w', c, ep: m.flag === 'dbl' ? (m.from + m.to) / 2 : -1, hm: (pawn || cap || m.flag === 'ep') ? 0 : pos.hm + 1 };
    }

    function legal(pos) {
        const me = pos.turn, opp = me === 'w' ? 'b' : 'w', b = pos.b, out = [];
        const add = (from, to, flag, promo) => out.push({ from, to, flag, promo });
        const addPawn = (from, to, promoRow) => { if ((to >> 3) === promoRow) for (const pr of ['q', 'r', 'b', 'n']) add(from, to, undefined, pr); else add(from, to); };
        for (let i = 0; i < 64; i++) {
            const p = b[i]; if (!p || colorOf(p) !== me) continue;
            const t = p.toLowerCase(), r = i >> 3, c = i & 7;
            if (t === 'p') {
                const dir = me === 'w' ? -1 : 1, startRow = me === 'w' ? 6 : 1, promoRow = me === 'w' ? 0 : 7;
                const nr = r + dir;
                if (nr >= 0 && nr < 8) {
                    if (!b[nr * 8 + c]) { addPawn(i, nr * 8 + c, promoRow); if (r === startRow && !b[(nr + dir) * 8 + c]) add(i, (nr + dir) * 8 + c, 'dbl'); }
                    for (const dc of [-1, 1]) {
                        const cc = c + dc; if (cc < 0 || cc > 7) continue;
                        const to = nr * 8 + cc, q = b[to];
                        if (q && colorOf(q) !== me) addPawn(i, to, promoRow);
                        else if (!q && to === pos.ep) add(i, to, 'ep');
                    }
                }
            } else if (t === 'n' || t === 'k') {
                for (const [dr, dc] of (t === 'n' ? KN : KG)) { const rr = r + dr, cc = c + dc; if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue; const q = b[rr * 8 + cc]; if (!q || colorOf(q) !== me) add(i, rr * 8 + cc); }
                if (t === 'k') {
                    if (me === 'w' && i === 60) {
                        if (pos.c.K && b[63] === 'R' && !b[61] && !b[62] && !attacked(pos, 60, opp) && !attacked(pos, 61, opp) && !attacked(pos, 62, opp)) add(60, 62, 'ck');
                        if (pos.c.Q && b[56] === 'R' && !b[57] && !b[58] && !b[59] && !attacked(pos, 60, opp) && !attacked(pos, 59, opp) && !attacked(pos, 58, opp)) add(60, 58, 'cq');
                    } else if (me === 'b' && i === 4) {
                        if (pos.c.k && b[7] === 'r' && !b[5] && !b[6] && !attacked(pos, 4, opp) && !attacked(pos, 5, opp) && !attacked(pos, 6, opp)) add(4, 6, 'ck');
                        if (pos.c.q && b[0] === 'r' && !b[1] && !b[2] && !b[3] && !attacked(pos, 4, opp) && !attacked(pos, 3, opp) && !attacked(pos, 2, opp)) add(4, 2, 'cq');
                    }
                }
            } else {
                const dirs = t === 'b' ? DIAG : t === 'r' ? ORTH : DIAG.concat(ORTH);
                for (const [dr, dc] of dirs) {
                    let rr = r + dr, cc = c + dc;
                    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) { const q = b[rr * 8 + cc]; if (!q) add(i, rr * 8 + cc); else { if (colorOf(q) !== me) add(i, rr * 8 + cc); break; } rr += dr; cc += dc; }
                }
            }
        }
        return out.filter((m) => !inCheck(make(pos, m), me));
    }

    const key = (pos) => pos.b.map((p) => p || '.').join('') + pos.turn + (pos.c.K ? 'K' : '') + (pos.c.Q ? 'Q' : '') + (pos.c.k ? 'k' : '') + (pos.c.q ? 'q' : '') + pos.ep;
    function insufficient(pos) { const rest = pos.b.filter((p) => p && p.toLowerCase() !== 'k'); if (rest.length === 0) return true; return rest.length === 1 && 'nb'.includes(rest[0].toLowerCase()); }

    return { startPos, legal, make, inCheck, key, insufficient };
})();

// ============================================================
// API ШАШКИ ОНЛАЙН
// ============================================================
app.post('/api/checkers/find-match', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    const nickname = sanitizeNickname(req.body && req.body.nickname);
    removeFromOtherQueues(playerId, 'checkers');

    if (matchmakingQueue.find(p => p.id === playerId)) return res.json({ success: true, status: 'waiting' });

    const activeMatch = Object.values(matches).find(m => m.status === 'playing' && m.players.some(p => p.id === playerId));
    if (activeMatch) {
        activeMatch.lastSeen[playerId] = nowMs();
        return res.json({ success: true, matchId: activeMatch.id });
    }

    if (matchmakingQueue.length >= MAX_QUEUE) {
        return res.status(503).json({ success: false, error: 'Очередь переполнена' });
    }

    if (matchmakingQueue.length > 0) {
        const opponent = matchmakingQueue.shift();
        const matchId = crypto.randomUUID();
        const now = nowMs();
        const startState = CK.startPos();

        matches[matchId] = {
            id: matchId,
            players: [
                { id: opponent.id, nickname: opponent.nickname, color: 'w' },
                { id: playerId, nickname, color: 'b' }
            ],
            status: 'playing',
            gameState: startState,
            winner: null,
            endReason: null,
            createdAt: now,
            finishedAt: null,
            history: [posKey(startState)],
            lastSeen: { [opponent.id]: now, [playerId]: now }
        };
        return res.json({ success: true, matchId });
    }

    matchmakingQueue.push({ id: playerId, nickname, timestamp: nowMs() });
    return res.json({ success: true, status: 'waiting' });
});

app.get('/api/checkers/status', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });

    const m = Object.values(matches).find(x => x.status === 'playing' && x.players.some(p => p.id === playerId));
    if (m) {
        m.lastSeen[playerId] = nowMs();
        return res.json({ success: true, matchId: m.id });
    }

    const idx = matchmakingQueue.findIndex(p => p.id === playerId);
    if (idx !== -1) {
        const wait = nowMs() - matchmakingQueue[idx].timestamp;
        if (wait > MATCHMAKING_TIMEOUT) {
            matchmakingQueue.splice(idx, 1);
            return res.json({ success: true, status: 'timeout' });
        }
        return res.json({ success: true, status: 'waiting', waitTime: Math.floor(wait / 1000) });
    }
    return res.json({ success: true, status: 'none' });
});

app.get('/api/checkers/match/:matchId', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    if (!Object.prototype.hasOwnProperty.call(matches, req.params.matchId)) return res.status(404).json({ success: false, error: 'Матч не найден' });
    const m = matches[req.params.matchId];
    if (!m.players.some(p => p.id === playerId)) return res.status(403).json({ success: false, error: 'Вы не участник' });

    m.lastSeen[playerId] = nowMs();
    if (m.status === 'playing') {
        const opp = m.players.find(p => p.id !== playerId);
        if (opp && m.lastSeen[opp.id] && nowMs() - m.lastSeen[opp.id] > DISCONNECT_TIMEOUT) finishCheckersMatch(m, playerId, 'disconnect');
    }
    res.json({ success: true, match: m });
});

app.post('/api/checkers/match/:matchId/move', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    if (!Object.prototype.hasOwnProperty.call(matches, req.params.matchId)) return res.status(404).json({ success: false, error: 'Матч не найден' });
    const m = matches[req.params.matchId];
    if (m.status !== 'playing') return res.status(400).json({ success: false, error: 'Матч не идёт' });

    const me = m.players.find(p => p.id === playerId);
    if (!me) return res.status(403).json({ success: false, error: 'Вы не участник' });
    if (m.gameState.turn !== me.color) return res.status(400).json({ success: false, error: 'Сейчас не ваш ход' });

    const { move } = req.body || {};
    if (!move || typeof move.from !== 'number' || typeof move.to !== 'number' || move.from < 0 || move.from > 63 || move.to < 0 || move.to > 63) return res.status(400).json({ success: false, error: 'Неверный формат хода' });

    const legal = CK.legal(m.gameState);
    const found = legal.find(x => x.from === move.from && x.to === move.to);
    if (!found) return res.status(400).json({ success: false, error: 'Нелегальный ход' });

    m.gameState = CK.make(m.gameState, found);
    m.history.push(posKey(m.gameState));
    m.lastSeen[playerId] = nowMs();

    const oppMoves = CK.legal(m.gameState);
    if (oppMoves.length === 0) finishCheckersMatch(m, playerId, 'no-moves');
    else { const draw = checkDraw(m); if (draw) finishCheckersMatch(m, null, draw); }
    res.json({ success: true, match: m });
});

app.post('/api/checkers/match/:matchId/surrender', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    if (!Object.prototype.hasOwnProperty.call(matches, req.params.matchId)) return res.json({ success: true });
    const m = matches[req.params.matchId];
    if (!m.players.some(p => p.id === playerId)) return res.status(403).json({ success: false, error: 'Вы не участник' });
    if (m.status !== 'playing') return res.json({ success: true });
    const opp = m.players.find(p => p.id !== playerId);
    finishCheckersMatch(m, opp ? opp.id : null, 'surrender');
    res.json({ success: true });
});

// ============================================================
// API ШАХМАТЫ ОНЛАЙН
// ============================================================
app.post('/api/chess/find-match', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    const nickname = sanitizeNickname(req.body && req.body.nickname);
    removeFromOtherQueues(playerId, 'chess');

    if (chessQueue.find(p => p.id === playerId)) return res.json({ success: true, status: 'waiting' });

    const activeMatch = Object.values(chessMatches).find(m => m.status === 'playing' && m.players.some(p => p.id === playerId));
    if (activeMatch) { activeMatch.lastSeen[playerId] = nowMs(); return res.json({ success: true, matchId: activeMatch.id }); }

    if (chessQueue.length >= MAX_QUEUE) return res.status(503).json({ success: false, error: 'Очередь переполнена' });

    if (chessQueue.length > 0) {
        const opponent = chessQueue.shift();
        const matchId = crypto.randomUUID();
        const now = nowMs();
        const startState = CH.startPos();
        chessMatches[matchId] = {
            id: matchId,
            players: [{ id: opponent.id, nickname: opponent.nickname, color: 'w' }, { id: playerId, nickname, color: 'b' }],
            status: 'playing', gameState: startState, winner: null, endReason: null, createdAt: now, finishedAt: null,
            history: [CH.key(startState)], lastSeen: { [opponent.id]: now, [playerId]: now }
        };
        return res.json({ success: true, matchId });
    }
    chessQueue.push({ id: playerId, nickname, timestamp: nowMs() });
    return res.json({ success: true, status: 'waiting' });
});

app.get('/api/chess/status', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    const m = Object.values(chessMatches).find(x => x.status === 'playing' && x.players.some(p => p.id === playerId));
    if (m) { m.lastSeen[playerId] = nowMs(); return res.json({ success: true, matchId: m.id }); }
    const idx = chessQueue.findIndex(p => p.id === playerId);
    if (idx !== -1) {
        const wait = nowMs() - chessQueue[idx].timestamp;
        if (wait > MATCHMAKING_TIMEOUT) { chessQueue.splice(idx, 1); return res.json({ success: true, status: 'timeout' }); }
        return res.json({ success: true, status: 'waiting', waitTime: Math.floor(wait / 1000) });
    }
    return res.json({ success: true, status: 'none' });
});

app.get('/api/chess/match/:matchId', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    if (!Object.prototype.hasOwnProperty.call(chessMatches, req.params.matchId)) return res.status(404).json({ success: false, error: 'Матч не найден' });
    const m = chessMatches[req.params.matchId];
    if (!m.players.some(p => p.id === playerId)) return res.status(403).json({ success: false, error: 'Вы не участник' });

    m.lastSeen[playerId] = nowMs();
    if (m.status === 'playing') {
        const opp = m.players.find(p => p.id !== playerId);
        if (opp && m.lastSeen[opp.id] && nowMs() - m.lastSeen[opp.id] > DISCONNECT_TIMEOUT) finishChessMatch(m, playerId, 'disconnect');
    }
    res.json({ success: true, match: m });
});

app.post('/api/chess/match/:matchId/move', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    if (!Object.prototype.hasOwnProperty.call(chessMatches, req.params.matchId)) return res.status(404).json({ success: false, error: 'Матч не найден' });
    const m = chessMatches[req.params.matchId];
    if (m.status !== 'playing') return res.status(400).json({ success: false, error: 'Матч не идёт' });

    const me = m.players.find(p => p.id === playerId);
    if (!me) return res.status(403).json({ success: false, error: 'Вы не участник' });
    if (m.gameState.turn !== me.color) return res.status(400).json({ success: false, error: 'Сейчас не ваш ход' });

    const { move } = req.body || {};
    if (!move || typeof move.from !== 'number' || typeof move.to !== 'number' || move.from < 0 || move.from > 63 || move.to < 0 || move.to > 63) return res.status(400).json({ success: false, error: 'Неверный формат хода' });

    const legal = CH.legal(m.gameState);
    const found = legal.find(x => x.from === move.from && x.to === move.to && (x.promo || null) === (move.promo || null));
    if (!found) return res.status(400).json({ success: false, error: 'Нелегальный ход' });

    m.gameState = CH.make(m.gameState, found);
    m.history.push(CH.key(m.gameState));
    m.lastSeen[playerId] = nowMs();

    const oppMoves = CH.legal(m.gameState);
    if (oppMoves.length === 0) {
        if (CH.inCheck(m.gameState, m.gameState.turn)) finishChessMatch(m, playerId, 'checkmate');
        else finishChessMatch(m, null, 'stalemate');
    } else {
        const draw = checkChessDraw(m);
        if (draw) finishChessMatch(m, null, draw);
    }
    res.json({ success: true, match: m });
});

app.post('/api/chess/match/:matchId/surrender', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    if (!Object.prototype.hasOwnProperty.call(chessMatches, req.params.matchId)) return res.json({ success: true });
    const m = chessMatches[req.params.matchId];
    if (!m.players.some(p => p.id === playerId)) return res.status(403).json({ success: false, error: 'Вы не участник' });
    if (m.status !== 'playing') return res.json({ success: true });
    const opp = m.players.find(p => p.id !== playerId);
    finishChessMatch(m, opp ? opp.id : null, 'surrender');
    res.json({ success: true });
});

// ============================================================
// ОЧИСТКА СТАРЫХ МАТЧЕЙ
// ============================================================
setInterval(() => {
    const now = nowMs();
    for (const id of Object.keys(matches)) {
        const m = matches[id];
        if (m.status === 'finished' && m.finishedAt && now - m.finishedAt > FINISHED_MATCH_TTL) { delete matches[id]; continue; }
        if (m.status === 'playing') {
            const seenA = m.lastSeen[m.players[0].id] || 0;
            const seenB = m.lastSeen[m.players[1].id] || 0;
            if (Math.max(now - seenA, now - seenB) > ABANDONED_MATCH_TTL) delete matches[id];
        }
    }
    for (let i = matchmakingQueue.length - 1; i >= 0; i--) {
        if (now - matchmakingQueue[i].timestamp > MATCHMAKING_TIMEOUT) matchmakingQueue.splice(i, 1);
    }
    for (const id of Object.keys(chessMatches)) {
        const m = chessMatches[id];
        if (m.status === 'finished' && m.finishedAt && now - m.finishedAt > FINISHED_MATCH_TTL) { delete chessMatches[id]; continue; }
        if (m.status === 'playing') {
            const seenA = m.lastSeen[m.players[0].id] || 0;
            const seenB = m.lastSeen[m.players[1].id] || 0;
            if (Math.max(now - seenA, now - seenB) > ABANDONED_MATCH_TTL) delete chessMatches[id];
        }
    }
    for (let i = chessQueue.length - 1; i >= 0; i--) {
        if (now - chessQueue[i].timestamp > MATCHMAKING_TIMEOUT) chessQueue.splice(i, 1);
    }
}, 30 * 1000).unref?.();

// ============================================================
// ОТМЕНА ПОИСКА
// ============================================================
function makeCancelHandler(queueName) {
    return (req, res) => {
        const playerId = getAuthedPlayerId(req);
        if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
        const queues = { checkers: matchmakingQueue, chess: chessQueue };
        const q = queues[queueName];
        const i = q.findIndex(p => p.id === playerId);
        if (i !== -1) q.splice(i, 1);
        res.json({ success: true });
    };
}
app.post('/api/checkers/cancel', makeCancelHandler('checkers'));
app.post('/api/chess/cancel',    makeCancelHandler('chess'));

// ============================================================
// СТАРТ
// ============================================================
app.get('/', (req, res) => res.send('Legion Arcade Server 🐾'));

async function startServer() {
    await loadLeaderboardsFromDB();
    app.listen(PORT, () => {
        console.log(`Слушаем порт ${PORT}`);
    });
}
startServer();
