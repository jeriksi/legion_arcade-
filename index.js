const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ============================================================
// КОНСТАНТЫ
// ============================================================
const MATCHMAKING_TIMEOUT = 30 * 1000;
const DISCONNECT_TIMEOUT = 60 * 1000;
const FINISHED_MATCH_TTL = 10 * 60 * 1000;
const ABANDONED_MATCH_TTL = 5 * 60 * 1000;
const DRAW_HM_LIMIT = 30;
const REPEAT_LIMIT = 3;

// Pong — 1:1 с офлайн-версией в userscript
const PONG_W = 400, PONG_H = 300, PONG_PW = 8, PONG_PH = 60, PONG_BS = 10, PONG_WIN = 7;

// ============================================================
// ХРАНИЛИЩА
// ============================================================
const matches = {};
const chessMatches = {};
const matchmakingQueue = [];
const chessQueue = [];
const pongRooms = {};
const pongQueue = [];
const leaderboards = {
    mines: [], tetris: [], match3: [], snake: [], pong: [], chess: [], checkers: [], 'checkers-mp': [], 'chess-mp': []
};

// ============================================================
// УТИЛИТЫ
// ============================================================
const nowMs = () => Date.now();
const posKey = (pos) => pos.b.join('') + '|' + pos.turn;

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
    const dirX = Math.random() > 0.5 ? 1 : -1;
    const dirY = Math.random() > 0.5 ? 1 : -1;
    room.ball = {
        x: PONG_W / 2 - PONG_BS / 2,
        y: PONG_H / 2 - PONG_BS / 2,
        vx: 4 * dirX,
        vy: 4 * dirY * (Math.random() * 0.5 + 0.5)
    };
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
            if (r < 3) b[i] = 'b';
            else if (r > 4) b[i] = 'w';
        }
        return { b, turn: 'w', hm: 0 };
    }

    function genCaps(b, sq, piece, captured, path) {
        const r = sq >> 3, c = sq & 7;
        const myColor = colorOf(piece);
        const myKing = isKing(piece);
        const results = [];
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
                if ((myColor === 'w' && lr === 0) || (myColor === 'b' && lr === 7))
                    newPiece = myColor === 'w' ? 'W' : 'B';
                results.push(...genCaps(b, lSq, newPiece, nc2, [...path, lSq]));
            }
        }

        if (!extended && captured.size > 0) {
            return [{ from: path[0], to: sq, captures: [...captured], path, piece }];
        }
        return results;
    }

    function genSimple(b, turn) {
        const moves = [];
        for (let i = 0; i < 64; i++) {
            const p = b[i];
            if (!p || colorOf(p) !== turn) continue;
            const r = i >> 3, c = i & 7;
            if (isKing(p)) {
                for (const [dr, dc] of DIRS) {
                    for (let d = 1; ; d++) {
                        const nr = r + dr * d, nc = c + dc * d;
                        if (nr < 0 || nr > 7 || nc < 0 || nc > 7) break;
                        const nSq = nr * 8 + nc;
                        if (b[nSq]) break;
                        moves.push({ from: i, to: nSq, captures: [], path: [i, nSq], piece: p });
                    }
                }
            } else {
                const fwd = turn === 'w' ? -1 : 1;
                for (const dc of [-1, 1]) {
                    const nr = r + fwd, nc = c + dc;
                    if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
                    const nSq = nr * 8 + nc;
                    if (b[nSq]) continue;
                    let newPiece = p;
                    if ((turn === 'w' && nr === 0) || (turn === 'b' && nr === 7))
                        newPiece = turn === 'w' ? 'W' : 'B';
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
        if (caps.length > 0) return caps;
        return genSimple(pos.b, pos.turn);
    }

    function make(pos, m) {
        const b = [...pos.b];
        for (const sq of m.captures) b[sq] = '';
        b[m.from] = '';
        b[m.to] = m.piece;
        let hm = pos.hm;
        if (m.captures.length > 0 || !isKing(pos.b[m.from])) hm = 0;
        else hm++;
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
// API ПИНГ-ПОНГ ОНЛАЙН (HTTP Polling, физика = офлайн-версия)
// ============================================================
app.post('/api/pong/find-match', (req, res) => {
    const { playerId, nickname } = req.body;
    if (!playerId) return res.status(400).json({ success: false, error: 'Нет playerId' });

    const activeRoom = Object.values(pongRooms).find(r =>
        r.state !== 'finished' && r.players.some(p => p.id === playerId));
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
                { id: playerId, nickname: nickname || 'Игрок', paddleY: PONG_H / 2, index: 1 }
            ],
            ball: { x: PONG_W / 2 - PONG_BS / 2, y: PONG_H / 2 - PONG_BS / 2, vx: 4, vy: 2 },
            score: { p1: 0, p2: 0 },
            state: 'playing',
            lastTick: ts,
            lastSeen: { [opponent.id]: ts, [playerId]: ts },
            finishedAt: null
        };
        return res.json({ success: true, roomId, playerIndex: 1 });
    }

    pongQueue.push({ id: playerId, nickname: nickname || 'Игрок', timestamp: nowMs() });
    return res.json({ success: true, status: 'waiting' });
});

app.get('/api/pong/status/:playerId', (req, res) => {
    const playerId = req.params.playerId;
    const room = Object.values(pongRooms).find(r => r.state === 'playing' && r.players.some(p => p.id === playerId));
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

    const me = playerId ? room.players.find(p => p.id === playerId) : null;
    const playerIndex = me ? room.players.indexOf(me) : -1;

    if (room.state === 'playing') {
        const now = nowMs();
        const dtFrames = Math.min((now - room.lastTick) / 16.66, 20);
        room.lastTick = now;

        room.ball.x += room.ball.vx * dtFrames;
        room.ball.y += room.ball.vy * dtFrames;

        if (room.ball.y <= 0) { room.ball.y = 0; room.ball.vy *= -1; }
        else if (room.ball.y + PONG_BS >= PONG_H) { room.ball.y = PONG_H - PONG_BS; room.ball.vy *= -1; }

        const p1 = room.players[0], p2 = room.players[1];
        const p1Top = p1.paddleY - PONG_PH / 2;
        const p2Top = p2.paddleY - PONG_PH / 2;

        if (room.ball.vx < 0 && room.ball.x <= PONG_PW && room.ball.x + PONG_BS >= 0) {
            if (room.ball.y + PONG_BS >= p1Top && room.ball.y <= p1Top + PONG_PH) {
                room.ball.x = PONG_PW;
                room.ball.vx *= -1.1;
                room.ball.vy = ((room.ball.y + PONG_BS / 2 - p1.paddleY) / PONG_PH) * 10;
            }
        }
        if (room.ball.vx > 0 && room.ball.x + PONG_BS >= PONG_W - PONG_PW) {
            if (room.ball.y + PONG_BS >= p2Top && room.ball.y <= p2Top + PONG_PH) {
                room.ball.x = PONG_W - PONG_PW - PONG_BS;
                room.ball.vx *= -1.1;
                room.ball.vy = ((room.ball.y + PONG_BS / 2 - p2.paddleY) / PONG_PH) * 10;
            }
        }

        room.ball.vx = Math.max(-15, Math.min(15, room.ball.vx));
        room.ball.vy = Math.max(-12, Math.min(12, room.ball.vy));

        if (room.ball.x < 0) { room.score.p2++; resetBall(room); room.lastTick = nowMs(); }
        else if (room.ball.x > PONG_W) { room.score.p1++; resetBall(room); room.lastTick = nowMs(); }

        if (room.score.p1 >= PONG_WIN || room.score.p2 >= PONG_WIN) {
            room.state = 'finished';
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
            timestamp: nowMs()
        }
    });
});

app.post('/api/pong/room/:roomId/move', (req, res) => {
    const { playerId, y } = req.body;
    const room = pongRooms[req.params.roomId];
    if (!room) return res.status(404).json({ success: false, error: 'Комната не найдена' });
    const player = room.players.find(p => p.id === playerId);
    if (!player) return res.status(400).json({ success: false, error: 'Вы не участник' });

    if (room.lastSeen) room.lastSeen[playerId] = nowMs();
    player.paddleY = Math.max(PONG_PH / 2, Math.min(PONG_H - PONG_PH / 2, y));
    res.json({ success: true });
});

app.post('/api/pong/room/:roomId/leave', (req, res) => {
    const room = pongRooms[req.params.roomId];
    if (room && room.state === 'playing') {
        room.state = 'finished';
        room.finishedAt = nowMs();
    }
    res.json({ success: true });
});

// ============================================================
// ФОНОВАЯ ОЧИСТКА
// ============================================================
setInterval(() => {
    const now = nowMs();

    // ШАШКИ
    for (const id of Object.keys(matches)) {
        const m = matches[id];
        if (m.status === 'finished' && m.finishedAt && now - m.finishedAt > FINISHED_MATCH_TTL) {
            delete matches[id]; continue;
        }
        if (m.status === 'playing') {
            const seenA = m.lastSeen[m.players[0].id] || 0;
            const seenB = m.lastSeen[m.players[1].id] || 0;
            if (Math.max(now - seenA, now - seenB) > ABANDONED_MATCH_TTL) delete matches[id];
        }
    }
    for (let i = matchmakingQueue.length - 1; i >= 0; i--) {
        if (now - matchmakingQueue[i].timestamp > MATCHMAKING_TIMEOUT) matchmakingQueue.splice(i, 1);
    }

    // ШАХМАТЫ
    for (const id of Object.keys(chessMatches)) {
        const m = chessMatches[id];
        if (m.status === 'finished' && m.finishedAt && now - m.finishedAt > FINISHED_MATCH_TTL) {
            delete chessMatches[id]; continue;
        }
        if (m.status === 'playing') {
            const seenA = m.lastSeen[m.players[0].id] || 0;
            const seenB = m.lastSeen[m.players[1].id] || 0;
            if (Math.max(now - seenA, now - seenB) > ABANDONED_MATCH_TTL) delete chessMatches[id];
        }
    }
    for (let i = chessQueue.length - 1; i >= 0; i--) {
        if (now - chessQueue[i].timestamp > MATCHMAKING_TIMEOUT) chessQueue.splice(i, 1);
    }

    // ПИНГ-ПОНГ
    for (const id of Object.keys(pongRooms)) {
        const r = pongRooms[id];
        if (r.state === 'finished') {
            if (r.finishedAt && now - r.finishedAt > FINISHED_MATCH_TTL) delete pongRooms[id];
            continue;
        }
        if (r.state === 'playing' && r.players.length === 2) {
            const seenA = (r.lastSeen && r.lastSeen[r.players[0].id]) || 0;
            const seenB = (r.lastSeen && r.lastSeen[r.players[1].id]) || 0;
            const bothStale = (now - seenA > DISCONNECT_TIMEOUT) && (now - seenB > DISCONNECT_TIMEOUT);
            if (bothStale) delete pongRooms[id];
        }
    }
    for (let i = pongQueue.length - 1; i >= 0; i--) {
        if (now - pongQueue[i].timestamp > MATCHMAKING_TIMEOUT) pongQueue.splice(i, 1);
    }
}, 30 * 1000);

// ============================================================
// API ШАШКИ ОНЛАЙН
// ============================================================
app.post('/api/checkers/find-match', (req, res) => {
    const { playerId, nickname } = req.body;
    if (!playerId) return res.status(400).json({ success: false, error: 'Нет playerId' });
    if (matchmakingQueue.find(p => p.id === playerId)) return res.json({ success: true, status: 'waiting' });

    const activeMatch = Object.values(matches).find(m => m.status === 'playing' && m.players.some(p => p.id === playerId));
    if (activeMatch) {
        activeMatch.lastSeen[playerId] = nowMs();
        return res.json({ success: true, matchId: activeMatch.id });
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
                { id: playerId, nickname: nickname || 'Игрок', color: 'b' }
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

    matchmakingQueue.push({ id: playerId, nickname: nickname || 'Игрок', timestamp: nowMs() });
    return res.json({ success: true, status: 'waiting' });
});

app.get('/api/checkers/status/:playerId', (req, res) => {
    const playerId = req.params.playerId;
    const match = Object.values(matches).find(m => m.status === 'playing' && m.players.some(p => p.id === playerId));
    if (match) { match.lastSeen[playerId] = nowMs(); return res.json({ success: true, matchId: match.id }); }

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
    res.json({ success: true, match });
});

app.post('/api/checkers/match/:id/move', (req, res) => {
    const { playerId, move } = req.body;
    const match = matches[req.params.id];
    if (!match) return res.status(404).json({ success: false, error: 'Матч не найден' });
    if (match.status !== 'playing') return res.status(400).json({ success: false, error: 'Игра завершена' });

    const player = match.players.find(p => p.id === playerId);
    if (!player) return res.status(400).json({ success: false, error: 'Вы не участник' });
    if (player.color !== match.gameState.turn) return res.status(400).json({ success: false, error: 'Сейчас не ваш ход' });
    if (!move || typeof move.from !== 'number' || typeof move.to !== 'number') return res.status(400).json({ success: false, error: 'Некорректный формат хода' });

    match.lastSeen[playerId] = nowMs();
    const validMoves = CK.legal(match.gameState);
    const realMove = validMoves.find(m => m.from === move.from && m.to === move.to);
    if (!realMove) return res.status(400).json({ success: false, error: 'Нелегальный ход' });

    match.gameState = CK.make(match.gameState, realMove);
    match.history.push(posKey(match.gameState));

    const nextMoves = CK.legal(match.gameState);
    if (nextMoves.length === 0) {
        finishMatch(match, playerId, 'no-moves');
    } else {
        const drawReason = checkDraw(match);
        if (drawReason) finishMatch(match, null, drawReason);
    }
    res.json({ success: true, match });
});

app.post('/api/checkers/match/:id/surrender', (req, res) => {
    const { playerId } = req.body;
    const match = matches[req.params.id];
    if (!match) return res.status(404).json({ success: false, error: 'Матч не найден' });
    if (match.status !== 'playing') return res.json({ success: true, match });

    const player = match.players.find(p => p.id === playerId);
    if (!player) return res.status(400).json({ success: false, error: 'Вы не участник' });

    const opponent = match.players.find(p => p.id !== playerId);
    finishMatch(match, opponent ? opponent.id : null, 'surrender');
    match.lastSeen[playerId] = nowMs();
    res.json({ success: true, match });
});

// ============================================================
// API ШАХМАТЫ ОНЛАЙН
// ============================================================
app.post('/api/chess/find-match', (req, res) => {
    const { playerId, nickname } = req.body;
    if (!playerId) return res.status(400).json({ success: false, error: 'Нет playerId' });
    if (chessQueue.find(p => p.id === playerId)) return res.json({ success: true, status: 'waiting' });

    const activeMatch = Object.values(chessMatches).find(m => m.status === 'playing' && m.players.some(p => p.id === playerId));
    if (activeMatch) {
        activeMatch.lastSeen[playerId] = nowMs();
        return res.json({ success: true, matchId: activeMatch.id });
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
                { id: playerId, nickname: nickname || 'Игрок', color: 'b' }
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

    chessQueue.push({ id: playerId, nickname: nickname || 'Игрок', timestamp: nowMs() });
    return res.json({ success: true, status: 'waiting' });
});

app.get('/api/chess/status/:playerId', (req, res) => {
    const playerId = req.params.playerId;
    const match = Object.values(chessMatches).find(m => m.status === 'playing' && m.players.some(p => p.id === playerId));
    if (match) { match.lastSeen[playerId] = nowMs(); return res.json({ success: true, matchId: match.id }); }

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
    res.json({ success: true, match });
});

app.post('/api/chess/match/:id/move', (req, res) => {
    const { playerId, move } = req.body;
    const match = chessMatches[req.params.id];
    if (!match) return res.status(404).json({ success: false, error: 'Матч не найден' });
    if (match.status !== 'playing') return res.status(400).json({ success: false, error: 'Игра завершена' });

    const player = match.players.find(p => p.id === playerId);
    if (!player) return res.status(400).json({ success: false, error: 'Вы не участник' });
    if (player.color !== match.gameState.turn) return res.status(400).json({ success: false, error: 'Сейчас не ваш ход' });
    if (!move || typeof move.from !== 'number' || typeof move.to !== 'number') return res.status(400).json({ success: false, error: 'Некорректный формат хода' });

    match.lastSeen[playerId] = nowMs();
    const validMoves = CH.legal(match.gameState);
    const realMove = validMoves.find(m => m.from === move.from && m.to === move.to && (!m.promo || m.promo === move.promo));
    if (!realMove) return res.status(400).json({ success: false, error: 'Нелегальный ход' });

    match.gameState = CH.make(match.gameState, realMove);
    match.history.push(CH.key(match.gameState));

    const nextMoves = CH.legal(match.gameState);
    if (nextMoves.length === 0) {
        const isCheck = CH.inCheck(match.gameState, match.gameState.turn);
        finishMatch(match, isCheck ? playerId : null, isCheck ? 'checkmate' : 'stalemate');
    } else {
        const drawReason = checkChessDraw(match);
        if (drawReason) finishMatch(match, null, drawReason);
    }
    res.json({ success: true, match });
});

app.post('/api/chess/match/:id/surrender', (req, res) => {
    const { playerId } = req.body;
    const match = chessMatches[req.params.id];
    if (!match) return res.status(404).json({ success: false, error: 'Матч не найден' });
    if (match.status !== 'playing') return res.json({ success: true, match });

    const player = match.players.find(p => p.id === playerId);
    if (!player) return res.status(400).json({ success: false, error: 'Вы не участник' });

    const opponent = match.players.find(p => p.id !== playerId);
    finishMatch(match, opponent ? opponent.id : null, 'surrender');
    match.lastSeen[playerId] = nowMs();
    res.json({ success: true, match });
});

// ============================================================
// ЛИДЕРБОРД
// ============================================================
app.post('/api/scores', (req, res) => {
    const { gameId, nickname, score, lowerIsBetter, losses = 0 } = req.body;
    if (!gameId || score == null) return res.status(400).json({ success: false, error: 'Нет данных' });
    if (typeof score !== 'number' || score < 0 || score > 999999) return res.status(400).json({ success: false, error: 'Неверный счет' });

    if (!leaderboards[gameId]) leaderboards[gameId] = [];
    let existing = leaderboards[gameId].find(x => x.nickname === nickname);

    if (existing) {
        if (lowerIsBetter) {
            if (score < existing.score) existing.score = score;
        } else {
            if (score > existing.score) existing.score = score;
        }
        existing.losses = Math.max(existing.losses || 0, losses);
        existing.date = Date.now();
    } else {
        leaderboards[gameId].push({ nickname: nickname || 'Игрок', score, losses, date: Date.now(), id: crypto.randomUUID() });
    }

    leaderboards[gameId].sort((a, b) => lowerIsBetter ? a.score - b.score : b.score - a.score);
    leaderboards[gameId] = leaderboards[gameId].slice(0, 10);
    res.json({ success: true });
});

app.get('/api/scores/:gameId', (req, res) => {
    const scores = leaderboards[req.params.gameId] || [];
    res.json({ success: true, scores });
});

app.get('/', (req, res) => res.send('Legion Arcade Server 🐾'));

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================
app.listen(PORT, () => console.log(`Слушаем порт ${PORT}`));
