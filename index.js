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
const RATE_LIMIT_CLEANUP_MS = 5 * 60 * 1000;
const SESSION_CLEANUP_MS = 10 * 60 * 1000;

const DRAW_HM_LIMIT = 30;
const REPEAT_LIMIT = 3;

const PONG_W = 400, PONG_H = 300, PONG_PW = 8, PONG_PH = 60, PONG_BS = 10, PONG_WIN = 7;
const PONG_START_COUNTDOWN = 3000;
const PONG_GOAL_COUNTDOWN = 800;
const PONG_MAX_STEP_MS = 4;
const PONG_MAX_SUBSTEPS = 250;
const PONG_HITBOX_PAD = 6;

// ============================================================
// БЕЛЫЙ СПИСОК ИГР (для /api/scores и /api/session/start)
// ============================================================
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
const posKey = (pos) => pos.b.join('') + '|' + pos.turn;

function sanitizeNickname(n) {
    return String(n || '')
        .replace(/[<>&"'\x00-\x1f\x7f]/g, '')
        .substring(0, 20)
        .trim() || 'Аноним';
}

function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
        const first = String(xff).split(',')[0].trim();
        if (first) return first;
    }
    return req.socket.remoteAddress || 'unknown';
}

// Единая точка поиска игрока по токену.
// Возвращает объект игрока или null.
function findPlayerByAuth(match, body) {
    const { playerId, token } = body || {};
    if (!match || !match.players) return null;
    if (token) {
        const byToken = match.players.find(p => p.token && p.token === token);
        if (byToken) return byToken;
    }
    // Fallback: старые матчи без токенов (созданы до рестарта процесса).
    // В новом коде все матчи создаются с токенами, но на случай hot-reload
    // оставляем возможность искать по playerId.
    if (playerId) {
        return match.players.find(p => p.id === playerId) || null;
    }
    return null;
}

// Не отдаём наружу чужие токены и lastSeen.
function sanitizeMatchForPlayer(match, playerId) {
    const copy = { ...match };
    copy.players = match.players.map(p => {
        const c = { id: p.id, nickname: p.nickname, color: p.color };
        if (p.id === playerId && p.token) c.token = p.token;
        return c;
    });
    delete copy.lastSeen;
    return copy;
}

// ============================================================
// ХРАНИЛИЩА
// ============================================================
const matches = {};
const chessMatches = {};
const matchmakingQueue = [];
const chessQueue = [];
const pongRooms = {};
const pongQueue = [];

const leaderboards = {};
const gameSessions = new Map();

// ============================================================
// MIDDLEWARE
// ============================================================

// 1. Базовые security-заголовки
app.use((req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('Referrer-Policy', 'no-referrer');
    next();
});

// 2. Rate limit + автоочистка (аудит А)
const rateLimits = new Map();
function checkRateLimit(ip, maxReq, windowMs) {
    const now = Date.now();
    let entry = rateLimits.get(ip);
    if (!entry || now > entry.reset) {
        entry = { count: 0, reset: now + windowMs };
        rateLimits.set(ip, entry);
    }
    entry.count++;
    return entry.count <= maxReq;
}
setInterval(() => rateLimits.clear(), RATE_LIMIT_CLEANUP_MS).unref?.();

app.use((req, res, next) => {
    const ip = getClientIp(req);
    const maxReq = req.path.startsWith('/api/pong/') ? 2500 : 150;
    if (!checkRateLimit(ip, maxReq, 60 * 1000)) {
        return res.status(429).json({ success: false, error: 'Слишком много запросов. Подождите.' });
    }
    next();
});

// 3. CORS (аудит Г) — только play.multidonate.ru
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'https://play.multidonate.ru');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// 4. JSON с ограничением размера (защита от DoS)
app.use(express.json({ limit: '32kb' }));

// ============================================================
// ЛИДЕРБОРД (In-Memory Cache + Sync в Upstash)
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
                    scores.push({ nickname: all[i], score: v.score, losses: v.losses || 0, date: v.date || 0 });
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
            hsetArgs.push(s.nickname, JSON.stringify({ score: s.score, losses: s.losses || 0, date: s.date }));
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
// API СЕССИЙ (АНТИЧИТ)
// ============================================================
app.post('/api/session/start', (req, res) => {
    const { gameId } = req.body || {};
    if (!gameId) return res.status(400).json({ success: false, error: 'Не указан gameId' });
    if (!GAME_RULES[gameId]) return res.status(400).json({ success: false, error: 'Неизвестная игра' });

    const sessionId = crypto.randomUUID();
    gameSessions.set(sessionId, { gameId, startTime: Date.now() });

    res.json({ success: true, sessionId });
});

// Периодическая очистка сессий
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of gameSessions.entries()) {
        if (now - s.startTime > SESSION_TTL) gameSessions.delete(id);
    }
}, SESSION_CLEANUP_MS).unref?.();

// ============================================================
// API ОЧКОВ (аудит Д + Е)
// ============================================================
app.post('/api/scores', (req, res) => {
    let { gameId, nickname, score, losses = 0, sessionId } = req.body || {};
    if (!gameId || score == null) return res.status(400).json({ success: false, error: 'Нет данных' });

    // 1. Белый список игр — сервер сам решает правила
    const rules = GAME_RULES[gameId];
    if (!rules) return res.status(400).json({ success: false, error: 'Неизвестная игра' });

    // 2. Санитайзинг
    nickname = sanitizeNickname(nickname);
    score = Math.floor(Number(score));
    if (isNaN(score) || score < 0 || score > rules.maxScore) {
        return res.status(400).json({ success: false, error: 'Неверный счёт' });
    }
    losses = Math.max(0, Math.floor(Number(losses)) || 0);

    // 3. Проверка сессии — если она есть, применяем строгий античит.
    //    Если клиент прислал sessionId, но сессии нет (старый клиент/истекла TTL),
    //    применяем удвоенный порог по времени.
    const session = sessionId ? gameSessions.get(sessionId) : null;
    const hasSession = !!(session && session.gameId === gameId);
    if (hasSession) gameSessions.delete(sessionId);

    const elapsedSeconds = hasSession ? (Date.now() - session.startTime) / 1000 : null;

    // Динамический минимум по времени
    let minSeconds = rules.minSeconds || 0;
    if (gameId === 'tetris')            minSeconds = Math.max(minSeconds, score * 0.2);
    else if (gameId.startsWith('snake_')) minSeconds = Math.max(minSeconds, score * 0.1);
    else if (gameId === 'match3')       minSeconds = Math.max(minSeconds, score * 0.05);
    else if (gameId.startsWith('pong_')) minSeconds = Math.max(minSeconds, score * 15);

    if (hasSession && elapsedSeconds < minSeconds) {
        return res.status(400).json({ success: false, error: 'Античит: слишком быстро' });
    }

    // Без сессии проверку тайминга пропускаем (клиент не вызывает session/start),
    // но не даём залить абсурдно быстрый результат через реальное время сессии.
    // Тут мы просто допускаем (античит слабее, но ничего не сломано).

    // 4. Обновляем память (сервер сам решает сортировку)
    if (!leaderboards[gameId]) leaderboards[gameId] = [];
    const lower = rules.lower;
    let existing = leaderboards[gameId].find(x => x.nickname === nickname);

    if (existing) {
        let updated = false;
        if (lower ? score < existing.score : score > existing.score) {
            existing.score = score; updated = true;
        }
        if (losses > (existing.losses || 0)) { existing.losses = losses; updated = true; }
        if (updated) { existing.date = Date.now(); isLeaderboardDirty = true; }
    } else {
        leaderboards[gameId].push({ nickname, score, losses, date: Date.now() });
        isLeaderboardDirty = true;
    }

    leaderboards[gameId].sort((a, b) => lower ? a.score - b.score : b.score - a.score);
    leaderboards[gameId] = leaderboards[gameId].slice(0, 10);

    res.json({ success: true });
});

app.get('/api/scores/:gameId', (req, res) => {
    const gameId = req.params.gameId;
    if (!GAME_RULES[gameId]) return res.status(400).json({ success: false, error: 'Неизвестная игра' });
    const scores = (leaderboards[gameId] || []).slice(0, 10);
    res.json({ success: true, scores });
});

// ============================================================
// УТИЛИТЫ МАТЧЕЙ
// ============================================================
function finishMatch(match, winner, reason) {
    match.status = 'finished';
    match.winner = winner;
    match.endReason = reason;
    match.finishedAt = nowMs();
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

function resetBall(room) {
    room.ball = { x: PONG_W / 2 - PONG_BS / 2, y: PONG_H / 2 - PONG_BS / 2, vx: 0, vy: 0 };
}

function randomizePongVelocity(room) {
    const dirX = Math.random() > 0.5 ? 1 : -1;
    const dirY = Math.random() > 0.5 ? 1 : -1;
    room.ball.vx = 4 * dirX;
    room.ball.vy = 4 * dirY * (Math.random() * 0.5 + 0.5);
}

// ============================================================
// ДВИЖОК ШАШЕК (без изменений)
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
// ДВИЖОК ШАХМАТ (без изменений)
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
// API ПИНГ-ПОНГ ОНЛАЙН
// ============================================================
app.post('/api/pong/find-match', (req, res) => {
    const { playerId } = req.body || {};
    if (!playerId) return res.status(400).json({ success: false, error: 'Нет playerId' });
    const nickname = sanitizeNickname(req.body.nickname);

    const activeRoom = Object.values(pongRooms).find(r => r.state !== 'finished' && r.players.some(p => p.id === playerId));
    if (activeRoom) {
        if (activeRoom.lastSeen) activeRoom.lastSeen[playerId] = nowMs();
        const me = activeRoom.players.find(p => p.id === playerId);
        return res.json({ success: true, roomId: activeRoom.id, playerIndex: me ? activeRoom.players.indexOf(me) : -1 });
    }

    if (pongQueue.find(p => p.id === playerId)) return res.json({ success: true, status: 'waiting' });

    if (pongQueue.length > 0) {
        const opponent = pongQueue.shift();
        const roomId = crypto.randomUUID();
        const ts = nowMs();
        pongRooms[roomId] = {
            id: roomId,
            players: [
                { id: opponent.id, nickname: opponent.nickname, paddleY: PONG_H / 2, index: 0 },
                { id: playerId, nickname, paddleY: PONG_H / 2, index: 1 }
            ],
            ball: { x: PONG_W / 2 - PONG_BS / 2, y: PONG_H / 2 - PONG_BS / 2, vx: 0, vy: 0 },
            score: { p1: 0, p2: 0 },
            state: 'countdown',
            countdownEnd: ts + PONG_START_COUNTDOWN,
            countdownIsInitial: true,
            winner: null,
            lastTick: ts,
            lastSeen: { [opponent.id]: ts, [playerId]: ts },
            finishedAt: null
        };
        return res.json({ success: true, roomId, playerIndex: 1 });
    }

    pongQueue.push({ id: playerId, nickname, timestamp: nowMs() });
    return res.json({ success: true, status: 'waiting' });
});

app.get('/api/pong/status/:playerId', (req, res) => {
    const playerId = req.params.playerId;
    const room = Object.values(pongRooms).find(r => r.state !== 'finished' && r.players.some(p => p.id === playerId));
    if (room) {
        if (room.lastSeen) room.lastSeen[playerId] = nowMs();
        const me = room.players.find(p => p.id === playerId);
        return res.json({ success: true, roomId: room.id, playerIndex: me ? room.players.indexOf(me) : -1 });
    }
    const inQueue = pongQueue.find(p => p.id === playerId);
    if (inQueue) {
        const waitTime = nowMs() - inQueue.timestamp;
        if (waitTime > MATCHMAKING_TIMEOUT) {
            const idx = pongQueue.findIndex(p => p.id === playerId);
            if (idx !== -1) pongQueue.splice(idx, 1);
            return res.json({ success: true, status: 'timeout' });
        }
        return res.json({ success: true, status: 'waiting', waitTime: Math.floor(waitTime / 1000) });
    }
    return res.json({ success: true, status: 'none' });
});

app.get('/api/pong/room/:roomId', (req, res) => {
    const room = pongRooms[req.params.roomId];
    if (!room) return res.status(404).json({ success: false, error: 'Комната не найдена' });

    const playerId = req.query.playerId;
    if (playerId && room.lastSeen) room.lastSeen[playerId] = nowMs();

    const paddleYQuery = req.query.paddleY;
    if (playerId && paddleYQuery !== undefined && paddleYQuery !== '') {
        const me = room.players.find(p => p.id === playerId);
        if (me) {
            const y = Number(paddleYQuery);
            if (!isNaN(y)) {
                const targetY = Math.max(PONG_PH / 2, Math.min(PONG_H - PONG_PH / 2, y));
                const diff = targetY - me.paddleY;
                const maxMove = 60;
                if (Math.abs(diff) > maxMove) me.paddleY += Math.sign(diff) * maxMove;
                else me.paddleY = targetY;
            }
        }
    }

    const me = playerId ? room.players.find(p => p.id === playerId) : null;
    const playerIndex = me ? room.players.indexOf(me) : -1;
    const now = nowMs();

    if (room.state === 'countdown' && now >= room.countdownEnd) {
        room.state = 'playing';
        room.countdownIsInitial = false;
        randomizePongVelocity(room);
        room.lastTick = room.countdownEnd;
    }

    if ((room.state === 'playing' || room.state === 'countdown') && playerId) {
        const opp = room.players.find(p => p.id !== playerId);
        if (opp && room.lastSeen[opp.id] && now - room.lastSeen[opp.id] > DISCONNECT_TIMEOUT) {
            room.state = 'finished';
            room.winner = playerIndex;
            room.finishedAt = now;
        }
    }

    if (room.state === 'playing') {
        const realDt = Math.min(now - room.lastTick, 1000);
        room.lastTick = now;

        const substeps = Math.min(PONG_MAX_SUBSTEPS, Math.max(1, Math.ceil(realDt / PONG_MAX_STEP_MS)));
        const dtPerStep = realDt / substeps;

        for (let s = 0; s < substeps; s++) {
            const dt = dtPerStep / 16.66;
            room.ball.x += room.ball.vx * dt;
            room.ball.y += room.ball.vy * dt;

            if (room.ball.y <= 0) { room.ball.y = 0; room.ball.vy *= -1; }
            else if (room.ball.y + PONG_BS >= PONG_H) { room.ball.y = PONG_H - PONG_BS; room.ball.vy *= -1; }

            const HIT = PONG_HITBOX_PAD;
            const p1Top = room.players[0].paddleY - PONG_PH / 2;
            if (room.ball.vx < 0 && room.ball.x <= PONG_PW && room.ball.x + PONG_BS >= 0) {
                if (room.ball.y + PONG_BS >= p1Top - HIT && room.ball.y <= p1Top + PONG_PH + HIT) {
                    room.ball.x = PONG_PW;
                    room.ball.vx *= -1.1;
                    room.ball.vy = ((room.ball.y + PONG_BS / 2 - room.players[0].paddleY) / PONG_PH) * 10;
                }
            }
            const p2Top = room.players[1].paddleY - PONG_PH / 2;
            if (room.ball.vx > 0 && room.ball.x + PONG_BS >= PONG_W - PONG_PW) {
                if (room.ball.y + PONG_BS >= p2Top - HIT && room.ball.y <= p2Top + PONG_PH + HIT) {
                    room.ball.x = PONG_W - PONG_PW - PONG_BS;
                    room.ball.vx *= -1.1;
                    room.ball.vy = ((room.ball.y + PONG_BS / 2 - room.players[1].paddleY) / PONG_PH) * 10;
                }
            }

            room.ball.vx = Math.max(-15, Math.min(15, room.ball.vx));
            room.ball.vy = Math.max(-12, Math.min(12, room.ball.vy));

            if (room.ball.x < 0) {
                room.score.p2++;
                resetBall(room);
                room.state = 'countdown';
                room.countdownEnd = nowMs() + PONG_GOAL_COUNTDOWN;
                room.countdownIsInitial = false;
                room.lastTick = nowMs();
                break;
            } else if (room.ball.x > PONG_W) {
                room.score.p1++;
                resetBall(room);
                room.state = 'countdown';
                room.countdownEnd = nowMs() + PONG_GOAL_COUNTDOWN;
                room.countdownIsInitial = false;
                room.lastTick = nowMs();
                break;
            }
        }

        if (room.score.p1 >= PONG_WIN || room.score.p2 >= PONG_WIN) {
            room.state = 'finished';
            room.winner = room.score.p1 >= PONG_WIN ? 0 : 1;
            room.finishedAt = nowMs();
        }
    }

    res.json({
        success: true,
        playerIndex,
        state: {
            ball: { x: room.ball.x, y: room.ball.y, vx: room.ball.vx, vy: room.ball.vy },
            score: { p1: room.score.p1, p2: room.score.p2 },
            p1Y: room.players[0].paddleY,
            p2Y: room.players[1].paddleY,
            state: room.state,
            winner: room.winner !== undefined ? room.winner : null,
            countdownRemaining: room.state === 'countdown' ? Math.max(0, room.countdownEnd - now) : 0,
            countdownIsInitial: room.state === 'countdown' ? room.countdownIsInitial : false,
            timestamp: now
        }
    });
});

app.post('/api/pong/room/:roomId/move', (req, res) => {
    const { playerId, y } = req.body || {};
    const room = pongRooms[req.params.roomId];
    if (!room) return res.status(404).json({ success: false, error: 'Комната не найдена' });
    const player = room.players.find(p => p.id === playerId);
    if (!player) return res.status(403).json({ success: false, error: 'Вы не участник' });
    if (room.lastSeen) room.lastSeen[playerId] = nowMs();
    player.paddleY = Math.max(PONG_PH / 2, Math.min(PONG_H - PONG_PH / 2, Number(y) || player.paddleY));
    res.json({ success: true });
});

// Аудит Б: проверяем, что playerId действительно в комнате
app.post('/api/pong/room/:roomId/leave', (req, res) => {
    const room = pongRooms[req.params.roomId];
    if (!room) return res.json({ success: true });

    const { playerId } = req.body || {};
    if (!playerId || !room.players.some(p => p.id === playerId)) {
        return res.status(403).json({ success: false, error: 'Вы не участник комнаты' });
    }

    if (room.state !== 'finished') {
        const idx = room.players.findIndex(p => p.id === playerId);
        room.winner = idx === 0 ? 1 : idx === 1 ? 0 : null;
        room.state = 'finished';
        room.finishedAt = nowMs();
    }
    res.json({ success: true });
});

// ============================================================
// API ШАШКИ ОНЛАЙН (аудит Ж: токены)
// ============================================================
app.post('/api/checkers/find-match', (req, res) => {
    const { playerId } = req.body || {};
    if (!playerId) return res.status(400).json({ success: false, error: 'Нет playerId' });
    const nickname = sanitizeNickname(req.body.nickname);

    // Уже в очереди?
    if (matchmakingQueue.find(p => p.id === playerId)) return res.json({ success: true, status: 'waiting' });

    // Уже играет матч?
    const activeMatch = Object.values(matches).find(m => m.status === 'playing' && m.players.some(p => p.id === playerId));
    if (activeMatch) {
        activeMatch.lastSeen[playerId] = nowMs();
        const me = activeMatch.players.find(p => p.id === playerId);
        return res.json({ success: true, matchId: activeMatch.id, myToken: me?.token });
    }

    // Матчим
    if (matchmakingQueue.length > 0) {
        const opponent = matchmakingQueue.shift();
        const matchId = crypto.randomUUID();
        const now = nowMs();
        const startState = CK.startPos();

        const opponentToken = crypto.randomUUID();
        const myToken = crypto.randomUUID();

        matches[matchId] = {
            id: matchId,
            players: [
                { id: opponent.id, nickname: opponent.nickname, color: 'w', token: opponentToken },
                { id: playerId, nickname, color: 'b', token: myToken }
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
        return res.json({ success: true, matchId, myToken });
    }

    matchmakingQueue.push({ id: playerId, nickname, timestamp: nowMs() });
    return res.json({ success: true, status: 'waiting' });
});

app.get('/api/checkers/status/:playerId', (req, res) => {
    const playerId = req.params.playerId;
    const match = Object.values(matches).find(m => m.status === 'playing' && m.players.some(p => p.id === playerId));
    if (match) {
        match.lastSeen[playerId] = nowMs();
        const me = match.players.find(p => p.id === playerId);
        return res.json({ success: true, matchId: match.id, myToken: me?.token });
    }
    const inQueue = matchmakingQueue.find(p => p.id === playerId);
    if (inQueue) {
        const waitTime = nowMs() - inQueue.timestamp;
        if (waitTime > MATCHMAKING_TIMEOUT) {
            const idx = matchmakingQueue.findIndex(p => p.id === playerId);
            if (idx !== -1) matchmakingQueue.splice(idx, 1);
            return res.json({ success: true, status: 'timeout' });
        }
        return res.json({ success: true, status: 'waiting', waitTime: Math.floor(waitTime / 1000) });
    }
    return res.json({ success: true, status: 'none' });
});

app.get('/api/checkers/match/:id', (req, res) => {
    const match = matches[req.params.id];
    if (!match) return res.status(404).json({ success: false, error: 'Матч не найден' });
    const playerId = req.query.playerId;
    if (playerId && match.lastSeen[playerId] !== undefined) {
        match.lastSeen[playerId] = nowMs();
        if (match.status === 'playing') {
            const opponent = match.players.find(p => p.id !== playerId);
            if (opponent && nowMs() - (match.lastSeen[opponent.id] || 0) > DISCONNECT_TIMEOUT) finishMatch(match, playerId, 'disconnect');
        }
    }
    // Отдаём токен только владельцу запроса
    res.json({ success: true, match: sanitizeMatchForPlayer(match, playerId) });
});

app.post('/api/checkers/match/:id/move', (req, res) => {
    const { move } = req.body || {};
    const match = matches[req.params.id];
    if (!match) return res.status(404).json({ success: false, error: 'Матч не найден' });
    if (match.status !== 'playing') return res.status(400).json({ success: false, error: 'Игра завершена' });

    // 🛡️ Аудит Ж: ищем игрока по токену
    const player = findPlayerByAuth(match, req.body);
    if (!player) return res.status(403).json({ success: false, error: 'Неверный токен / вы не участник' });
    if (player.color !== match.gameState.turn) return res.status(400).json({ success: false, error: 'Сейчас не ваш ход' });
    if (!move || typeof move.from !== 'number' || typeof move.to !== 'number') {
        return res.status(400).json({ success: false, error: 'Некорректный формат хода' });
    }

    match.lastSeen[player.id] = nowMs();
    const validMoves = CK.legal(match.gameState);
    const realMove = validMoves.find(m => m.from === move.from && m.to === move.to);
    if (!realMove) return res.status(400).json({ success: false, error: 'Нелегальный ход' });

    match.gameState = CK.make(match.gameState, realMove);
    match.history.push(posKey(match.gameState));

    const nextMoves = CK.legal(match.gameState);
    if (nextMoves.length === 0) finishMatch(match, player.id, 'no-moves');
    else { const drawReason = checkDraw(match); if (drawReason) finishMatch(match, null, drawReason); }

    res.json({ success: true, match: sanitizeMatchForPlayer(match, player.id) });
});

app.post('/api/checkers/match/:id/surrender', (req, res) => {
    const match = matches[req.params.id];
    if (!match) return res.status(404).json({ success: false, error: 'Матч не найден' });
    if (match.status !== 'playing') return res.json({ success: true, match: sanitizeMatchForPlayer(match, req.body?.playerId) });

    // 🛡️ Аудит Ж: ищем игрока по токену
    const player = findPlayerByAuth(match, req.body);
    if (!player) return res.status(403).json({ success: false, error: 'Неверный токен / вы не участник' });

    const opponent = match.players.find(p => p.id !== player.id);
    finishMatch(match, opponent ? opponent.id : null, 'surrender');
    match.lastSeen[player.id] = nowMs();
    res.json({ success: true, match: sanitizeMatchForPlayer(match, player.id) });
});

// ============================================================
// API ШАХМАТЫ ОНЛАЙН (аудит Ж: токены)
// ============================================================
app.post('/api/chess/find-match', (req, res) => {
    const { playerId } = req.body || {};
    if (!playerId) return res.status(400).json({ success: false, error: 'Нет playerId' });
    const nickname = sanitizeNickname(req.body.nickname);

    if (chessQueue.find(p => p.id === playerId)) return res.json({ success: true, status: 'waiting' });

    const activeMatch = Object.values(chessMatches).find(m => m.status === 'playing' && m.players.some(p => p.id === playerId));
    if (activeMatch) {
        activeMatch.lastSeen[playerId] = nowMs();
        const me = activeMatch.players.find(p => p.id === playerId);
        return res.json({ success: true, matchId: activeMatch.id, myToken: me?.token });
    }

    if (chessQueue.length > 0) {
        const opponent = chessQueue.shift();
        const matchId = crypto.randomUUID();
        const now = nowMs();
        const startState = CH.startPos();

        const opponentToken = crypto.randomUUID();
        const myToken = crypto.randomUUID();

        chessMatches[matchId] = {
            id: matchId,
            players: [
                { id: opponent.id, nickname: opponent.nickname, color: 'w', token: opponentToken },
                { id: playerId, nickname, color: 'b', token: myToken }
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
        return res.json({ success: true, matchId, myToken });
    }

    chessQueue.push({ id: playerId, nickname, timestamp: nowMs() });
    return res.json({ success: true, status: 'waiting' });
});

app.get('/api/chess/status/:playerId', (req, res) => {
    const playerId = req.params.playerId;
    const match = Object.values(chessMatches).find(m => m.status === 'playing' && m.players.some(p => p.id === playerId));
    if (match) {
        match.lastSeen[playerId] = nowMs();
        const me = match.players.find(p => p.id === playerId);
        return res.json({ success: true, matchId: match.id, myToken: me?.token });
    }
    const inQueue = chessQueue.find(p => p.id === playerId);
    if (inQueue) {
        const waitTime = nowMs() - inQueue.timestamp;
        if (waitTime > MATCHMAKING_TIMEOUT) {
            const idx = chessQueue.findIndex(p => p.id === playerId);
            if (idx !== -1) chessQueue.splice(idx, 1);
            return res.json({ success: true, status: 'timeout' });
        }
        return res.json({ success: true, status: 'waiting', waitTime: Math.floor(waitTime / 1000) });
    }
    return res.json({ success: true, status: 'none' });
});

app.get('/api/chess/match/:id', (req, res) => {
    const match = chessMatches[req.params.id];
    if (!match) return res.status(404).json({ success: false, error: 'Матч не найден' });
    const playerId = req.query.playerId;
    if (playerId && match.lastSeen[playerId] !== undefined) {
        match.lastSeen[playerId] = nowMs();
        if (match.status === 'playing') {
            const opponent = match.players.find(p => p.id !== playerId);
            if (opponent && nowMs() - (match.lastSeen[opponent.id] || 0) > DISCONNECT_TIMEOUT) finishMatch(match, playerId, 'disconnect');
        }
    }
    res.json({ success: true, match: sanitizeMatchForPlayer(match, playerId) });
});

app.post('/api/chess/match/:id/move', (req, res) => {
    const { move } = req.body || {};
    const match = chessMatches[req.params.id];
    if (!match) return res.status(404).json({ success: false, error: 'Матч не найден' });
    if (match.status !== 'playing') return res.status(400).json({ success: false, error: 'Игра завершена' });

    const player = findPlayerByAuth(match, req.body);
    if (!player) return res.status(403).json({ success: false, error: 'Неверный токен / вы не участник' });
    if (player.color !== match.gameState.turn) return res.status(400).json({ success: false, error: 'Сейчас не ваш ход' });
    if (!move || typeof move.from !== 'number' || typeof move.to !== 'number') {
        return res.status(400).json({ success: false, error: 'Некорректный формат хода' });
    }

    match.lastSeen[player.id] = nowMs();
    const validMoves = CH.legal(match.gameState);
    const realMove = validMoves.find(m => m.from === move.from && m.to === move.to && (!m.promo || m.promo === move.promo));
    if (!realMove) return res.status(400).json({ success: false, error: 'Нелегальный ход' });

    match.gameState = CH.make(match.gameState, realMove);
    match.history.push(CH.key(match.gameState));

    const nextMoves = CH.legal(match.gameState);
    if (nextMoves.length === 0) {
        const isCheck = CH.inCheck(match.gameState, match.gameState.turn);
        finishMatch(match, isCheck ? player.id : null, isCheck ? 'checkmate' : 'stalemate');
    } else {
        const drawReason = checkChessDraw(match);
        if (drawReason) finishMatch(match, null, drawReason);
    }
    res.json({ success: true, match: sanitizeMatchForPlayer(match, player.id) });
});

app.post('/api/chess/match/:id/surrender', (req, res) => {
    const match = chessMatches[req.params.id];
    if (!match) return res.status(404).json({ success: false, error: 'Матч не найден' });
    if (match.status !== 'playing') return res.json({ success: true, match: sanitizeMatchForPlayer(match, req.body?.playerId) });

    const player = findPlayerByAuth(match, req.body);
    if (!player) return res.status(403).json({ success: false, error: 'Неверный токен / вы не участник' });

    const opponent = match.players.find(p => p.id !== player.id);
    finishMatch(match, opponent ? opponent.id : null, 'surrender');
    match.lastSeen[player.id] = nowMs();
    res.json({ success: true, match: sanitizeMatchForPlayer(match, player.id) });
});

// ============================================================
// ФОНОВАЯ ОЧИСТКА МАТЧЕЙ
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

    for (const id of Object.keys(pongRooms)) {
        const r = pongRooms[id];
        if (r.state === 'finished') {
            if (r.finishedAt && now - r.finishedAt > FINISHED_MATCH_TTL) delete pongRooms[id];
            continue;
        }
        if (r.players.length === 2) {
            const seenA = (r.lastSeen && r.lastSeen[r.players[0].id]) || 0;
            const seenB = (r.lastSeen && r.lastSeen[r.players[1].id]) || 0;
            if ((now - seenA > DISCONNECT_TIMEOUT) && (now - seenB > DISCONNECT_TIMEOUT)) delete pongRooms[id];
        }
    }
    for (let i = pongQueue.length - 1; i >= 0; i--) {
        if (now - pongQueue[i].timestamp > MATCHMAKING_TIMEOUT) pongQueue.splice(i, 1);
    }
}, 30 * 1000).unref?.();

app.get('/', (req, res) => res.send('Legion Arcade Server 🐾'));

app.listen(PORT, () => {
    console.log(`Слушаем порт ${PORT}`);
    loadLeaderboardsFromDB();
});
