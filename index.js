const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// КОНСТАНТЫ
// ============================================================
const MATCHMAKING_TIMEOUT = 30 * 1000;
const DISCONNECT_TIMEOUT = 60 * 1000;
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

// Неактивные аккаунты удаляются только когда размер карты перевалил
// за половину лимита — чтобы не терять редких игроков без причины.
const PLAYER_INACTIVE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 дней

// ============================================================
// БЕЛЫЙ СПИСОК ИГР
// ============================================================
// ВАЖНО: сервер валидирует только time-based sanity checks для соло-игр.
// Мультиплеерные рекорды (checkers-mp, chess-mp) считаются ТОЛЬКО на сервере
// в updateMultiplayerLeaderboard и через /api/scores от клиента НЕ принимаются.
// Pong-мультиплеер полностью удалён с сервера. Сингл-плеерные pong_* оставлены
// для тех клиентов, кто их ещё присылает в /api/scores.
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
};

// ============================================================
// УТИЛИТЫ
// ============================================================
const nowMs = () => Date.now();

// Ключ позиции для истории/повторов. Пустые клетки нормализуем в '.',
// иначе разные расстановки дают одинаковую строку ('' + join).
// Работает и для шашек (''), и для шахмат (null).
const posKey = (pos) => pos.b.map(p => p || '.').join('') + '|' + pos.turn;

function sanitizeNickname(n) {
    return String(n || '')
        .replace(/[<>&"'\x00-\x1f\x7f]/g, '')
        .substring(0, 20)
        .trim() || 'Аноним';
}

// IP: по умолчанию XFF игнорируется. Включается переменной окружения
// TRUST_PROXY=1 — только если сервер стоит за известным прокси (Render).
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function getClientIp(req) {
    if (TRUST_PROXY) {
        const xff = req.headers['x-forwarded-for'];
        if (xff) {
            const first = String(xff).split(',')[0].trim();
            if (first) return first;
        }
    }
    return req.socket.remoteAddress || 'unknown';
}

// ============================================================
// ХРАНИЛИЩА
// ============================================================
const players = new Map();        // playerId -> { token, createdAt, lastActiveAt }
const tokensToPlayers = new Map(); // token -> playerId

const matches = {};
const chessMatches = {};
const matchmakingQueue = [];
const chessQueue = [];

const leaderboards = {};
const gameSessions = new Map();         // sessionId -> { gameId, playerId, startTime }
const playerGameSessions = new Map();   // `${playerId}:${gameId}` -> sessionId

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

// Удаляем только по-настоящему старые аккаунты. Вызывается редко и
// только когда размер карты близок к лимиту.
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
// Убираем ТОЛЬКО истёкшие записи. Раньше был rateLimits.clear(),
// который обнулял и часовые счётчики вместе с минутными.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimits.entries()) {
        if (now > entry.reset) rateLimits.delete(key);
    }
}, 60 * 1000).unref?.();

app.use((req, res, next) => {
    const ip = getClientIp(req);
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
// РЕГИСТРАЦИЯ ИГРОКА
// ============================================================
app.post('/api/player/register', (req, res) => {
    const ip = getClientIp(req);
    // Не более 60 регистраций в час с одного IP (общий потолок на случай
    // корпоративных NAT). Счётчик очищается корректно (см. выше).
    if (!checkRateLimit('reg:' + ip, 60, 60 * 60 * 1000)) {
        return res.status(429).json({ success: false, error: 'Слишком много регистраций. Подождите.' });
    }
    // Перед отказом пробуем освободить место.
    if (players.size >= MAX_PLAYERS) {
        cleanupInactivePlayers(nowMs() - PLAYER_INACTIVE_TTL);
    }
    if (players.size >= MAX_PLAYERS) {
        return res.status(503).json({ success: false, error: 'Сервер перегружен' });
    }
    const playerId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const now = nowMs();
    players.set(playerId, { token, createdAt: now, lastActiveAt: now });
    tokensToPlayers.set(token, playerId);
    res.json({ success: true, playerId, token });
});

// Периодическая уборка — только при приближении к лимиту.
setInterval(() => {
    if (players.size > MAX_PLAYERS * 0.5) {
        cleanupInactivePlayers(nowMs() - PLAYER_INACTIVE_TTL);
    }
}, 60 * 60 * 1000).unref?.();

// ============================================================
// ЛИДЕРБОРД
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
    } catch (e) {
        console.error('Redis error:', e.message);
        return null;
    }
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

// Формат хранения: HSET lb:gameId <playerId> JSON({nickname,score,losses,date})
async function loadLeaderboardsFromDB() {
    if (!UPSTASH_URL) return;
    console.log('Загрузка рекордов из Upstash...');
    for (const gameId of Object.keys(GAME_RULES)) {
        const key = `lb:${gameId}`;
        const all = await redis('HGETALL', key);
        if (Array.isArray(all) && all.length > 0) {
            const scores = [];
            for (let i = 0; i < all.length; i += 2) {
                try {
                    const v = JSON.parse(all[i + 1]);
                    scores.push({
                        playerId: all[i],
                        nickname: v.nickname,
                        score: v.score,
                        losses: v.losses || 0,
                        date: v.date || 0
                    });
                } catch (_) {}
            }
            const isLower = GAME_RULES[gameId].lower;
            scores.sort((a, b) => isLower ? a.score - b.score : b.score - a.score);
            leaderboards[gameId] = scores.slice(0, 10);
        }
    }
    console.log('Рекорды успешно загружены в память.');
}

async function flushLeaderboardsToDB() {
    if (!UPSTASH_URL || !isLeaderboardDirty) return;
    console.log('Синхронизация рекордов с базой...');
    isLeaderboardDirty = false;
    const commands = [];
    for (const gameId of Object.keys(leaderboards)) {
        const scores = leaderboards[gameId];
        if (!scores || scores.length === 0) continue;
        const key = `lb:${gameId}`;
        commands.push(['DEL', key]);
        const hsetArgs = ['HSET', key];
        for (const s of scores) {
            hsetArgs.push(s.playerId, JSON.stringify({
                nickname: s.nickname,
                score: s.score,
                losses: s.losses || 0,
                date: s.date
            }));
        }
        commands.push(hsetArgs);
    }
    if (commands.length > 0) await redisPipeline(commands);
    console.log('Синхронизация завершена.');
}

setInterval(flushLeaderboardsToDB, 60 * 1000).unref?.();
process.on('SIGTERM', async () => {
    console.log('Сервер выключается, сохраняем рекорды...');
    await flushLeaderboardsToDB();
    process.exit(0);
});

// ============================================================
// API СЕССИЙ (античит)
// ============================================================
app.post('/api/session/start', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });

    const { gameId } = req.body || {};
    if (!gameId) return res.status(400).json({ success: false, error: 'Не указан gameId' });
    if (!GAME_RULES[gameId]) return res.status(400).json({ success: false, error: 'Неизвестная игра' });

    if (gameSessions.size >= MAX_SESSIONS) {
        return res.status(503).json({ success: false, error: 'Сервер перегружен' });
    }
    if (!checkRateLimit('sess:' + playerId, SESSION_RATE_MAX, SESSION_RATE_WINDOW_MS)) {
        return res.status(429).json({ success: false, error: 'Слишком часто. Подождите.' });
    }

    // Одна активная сессия на пару (playerId, gameId) — старую инвалидируем.
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
// API ОЧКОВ
// ============================================================
app.post('/api/scores', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });

    let { gameId, nickname, score, losses = 0, sessionId } = req.body || {};
    if (!gameId || score == null) return res.status(400).json({ success: false, error: 'Нет данных' });

    const rules = GAME_RULES[gameId];
    if (!rules) return res.status(400).json({ success: false, error: 'Неизвестная игра' });

    // Мультиплеерные рекорды считаются сервером автоматически при завершении
    // матча. Клиент их присылать не должен — иначе это просто self-report.
    if (gameId === 'checkers-mp' || gameId === 'chess-mp') {
        return res.status(400).json({
            success: false,
            error: 'Рекорды этой игры учитываются сервером автоматически'
        });
    }

    nickname = sanitizeNickname(nickname);
    score = Math.floor(Number(score));
    if (isNaN(score) || score < 0 || score > rules.maxScore) {
        return res.status(400).json({ success: false, error: 'Неверный счёт' });
    }
    losses = Math.max(0, Math.floor(Number(losses)) || 0);

    // Сессия ОБЯЗАТЕЛЬНА и должна принадлежать этому игроку и этой игре
    if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ success: false, error: 'Нет sessionId' });
    }
    const session = gameSessions.get(sessionId);
    if (!session) {
        return res.status(400).json({ success: false, error: 'Сессия недействительна или уже использована' });
    }
    if (session.gameId !== gameId) {
        gameSessions.delete(sessionId);
        const pk = session.playerId + ':' + session.gameId;
        if (playerGameSessions.get(pk) === sessionId) playerGameSessions.delete(pk);
        return res.status(400).json({ success: false, error: 'Сессия от другой игры' });
    }
    if (session.playerId !== playerId) {
        gameSessions.delete(sessionId);
        const pk = session.playerId + ':' + session.gameId;
        if (playerGameSessions.get(pk) === sessionId) playerGameSessions.delete(pk);
        return res.status(403).json({ success: false, error: 'Сессия другого игрока' });
    }
    // Одноразовость
    gameSessions.delete(sessionId);
    const pk = playerId + ':' + gameId;
    if (playerGameSessions.get(pk) === sessionId) playerGameSessions.delete(pk);

    const elapsedSeconds = (Date.now() - session.startTime) / 1000;
    let minSeconds = rules.minSeconds || 0;
    if (gameId === 'tetris')            minSeconds = Math.max(minSeconds, score * 0.2);
    else if (gameId.startsWith('snake_')) minSeconds = Math.max(minSeconds, score * 0.1);
    else if (gameId === 'match3')       minSeconds = Math.max(minSeconds, score * 0.05);
    else if (gameId.startsWith('pong_')) minSeconds = Math.max(minSeconds, score * 15);

    if (elapsedSeconds < minSeconds) {
        return res.status(400).json({ success: false, error: 'Античит: слишком быстро' });
    }

    // Лидерборд по playerId — ник это лишь метка, подменить невозможно.
    if (!leaderboards[gameId]) leaderboards[gameId] = [];
    const lower = rules.lower;
    const existing = leaderboards[gameId].find(x => x.playerId === playerId);

    if (existing) {
        let updated = false;
        if (lower ? score < existing.score : score > existing.score) {
            existing.score = score; updated = true;
        }
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
    const scores = (leaderboards[gameId] || []).slice(0, 10).map(s => ({
        nickname: s.nickname,
        score: s.score,
        losses: s.losses || 0
    }));
    res.json({ success: true, scores });
});

// ============================================================
// УТИЛИТЫ МАТЧЕЙ
// ============================================================
function finishMatch(match, winner, reason) {
    if (match.status === 'finished') return;
    match.status = 'finished';
    match.winner = winner;
    match.endReason = reason;
    match.finishedAt = nowMs();
}

// Серверный учёт побед/поражений в мультиплеере.
// Клиент больше НЕ отправляет /api/scores для *-mp: всё считается здесь.
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

// ============================================================
// ЕДИНАЯ ОЧЕРЕДЬ: игрок ждёт матч ТОЛЬКО в одной игре одновременно
// ============================================================
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
// ШАШКИ ОНЛАЙН
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

// ============================================================
// ШАХМАТЫ ОНЛАЙН
// ============================================================
app.post('/api/chess/find-match', (req, res) => {
    const playerId = getAuthedPlayerId(req);
    if (!playerId) return res.status(401).json({ success: false, error: 'Не авторизован' });
    const nickname = sanitizeNickname(req.body && req.body.nickname);
    removeFromOtherQueues(playerId, 'chess');

    if (chessQueue.find(p => p.id === playerId)) return res.json({ success: true, status: 'waiting' });

    const activeMatch = Object.values(chessMatches).find(m => m.status === 'playing' && m.players.some(p => p.id === playerId));
    if (activeMatch) {
        activeMatch.lastSeen[playerId] = nowMs();
        return res.json({ success: true, matchId: activeMatch.id });
    }

    if (chessQueue.length >= MAX_QUEUE) {
        return res.status(503).json({ success: false, error: 'Очередь переполнена' });
    }

    if (chessQueue.length > 0) {
        const opponent = chessQueue.shift();
        const matchId = crypto.randomUUID();
        const now = nowMs();
        const startState = CH.startPos();

        chessMatches[matchId] = {
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
            history: [CH.key(startState)],
            lastSeen: { [opponent.id]: now, [playerId]: now }
        };
        return res.json({ success: true, matchId });
    }

    chessQueue.push({ id: playerId, nickname, timestamp: nowMs() });
    return res.json({ success: true, status: 'waiting' });
});

// ============================================================
// ФОНОВАЯ ОЧИСТКА
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

app.get('/', (req, res) => res.send('Legion Arcade Server 🐾'));

app.listen(PORT, () => {
    console.log(`Слушаем порт ${PORT}`);
    loadLeaderboardsFromDB();
});
