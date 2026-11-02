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
// ДВИЖОК ШАШЕК (русские шашки)
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
// КОНСТАНТЫ
// ============================================================
const MATCHMAKING_TIMEOUT = 30 * 1000;       // 30 сек ожидания соперника
const DISCONNECT_TIMEOUT = 60 * 1000;        // 60 сек без поллинга = отключился
const FINISHED_MATCH_TTL = 10 * 60 * 1000;   // 10 минут хранения завершённых
const ABANDONED_MATCH_TTL = 5 * 60 * 1000;   // 5 минут неактивности обоих = удалить
const DRAW_HM_LIMIT = 30;                    // 15 полных ходов без боя/простых
const REPEAT_LIMIT = 3;                      // троекратное повторение

// ============================================================
// ХРАНИЛИЩА
// ============================================================
const matches = {};
const leaderboards = {
    mines: [], tetris: [], match3: [], snake: [], pong: [], chess: [], checkers: []
};
const matchmakingQueue = [];

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

    // Правило 15 ходов применяется только при ≤6 фигурах на доске
    if (pieces <= 6 && pos.hm >= DRAW_HM_LIMIT) return 'draw-15';

    // Троекратное повторение позиции
    const key = posKey(pos);
    if (match.history.filter(k => k === key).length >= REPEAT_LIMIT) return 'draw-repeat';

    return null;
}

// ============================================================
// ФОНОВАЯ ОЧИСТКА
// ============================================================
setInterval(() => {
    const now = nowMs();

    for (const id of Object.keys(matches)) {
        const m = matches[id];

        if (m.status === 'finished' && m.finishedAt && now - m.finishedAt > FINISHED_MATCH_TTL) {
            delete matches[id];
            continue;
        }

        if (m.status === 'playing') {
            const seenA = m.lastSeen[m.players[0].id] || 0;
            const seenB = m.lastSeen[m.players[1].id] || 0;
            const maxIdle = Math.max(now - seenA, now - seenB);
            if (maxIdle > ABANDONED_MATCH_TTL) {
                delete matches[id];
            }
        }
    }

    for (let i = matchmakingQueue.length - 1; i >= 0; i--) {
        if (now - matchmakingQueue[i].timestamp > MATCHMAKING_TIMEOUT) {
            matchmakingQueue.splice(i, 1);
        }
    }
}, 30 * 1000);

// ============================================================
// РОУТЫ
// ============================================================

app.post('/api/checkers/find-match', (req, res) => {
    const { playerId, nickname } = req.body;
    if (!playerId) return res.status(400).json({ success: false, error: 'Нет playerId' });

    // Уже в очереди?
    if (matchmakingQueue.find(p => p.id === playerId)) {
        return res.json({ success: true, status: 'waiting' });
    }

    // Уже в активном матче? — вернём его
    const activeMatch = Object.values(matches).find(m =>
        m.status === 'playing' && m.players.some(p => p.id === playerId)
    );
    if (activeMatch) {
        activeMatch.lastSeen[playerId] = nowMs();
        return res.json({ success: true, matchId: activeMatch.id });
    }

    // Есть ожидающий? — создаём матч
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
            lastSeen: {
                [opponent.id]: now,
                [playerId]: now
            }
        };
        return res.json({ success: true, matchId });
    }

    // Никого нет — в очередь
    matchmakingQueue.push({ id: playerId, nickname: nickname || 'Игрок', timestamp: nowMs() });
    return res.json({ success: true, status: 'waiting' });
});

app.get('/api/checkers/status/:playerId', (req, res) => {
    const playerId = req.params.playerId;

    const match = Object.values(matches).find(m =>
        m.status === 'playing' && m.players.some(p => p.id === playerId)
    );
    if (match) {
        match.lastSeen[playerId] = nowMs();
        return res.json({ success: true, matchId: match.id });
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

        // Проверка на отключение соперника
        if (match.status === 'playing') {
            const opponent = match.players.find(p => p.id !== playerId);
            if (opponent) {
                const oppLastSeen = match.lastSeen[opponent.id] || 0;
                if (nowMs() - oppLastSeen > DISCONNECT_TIMEOUT) {
                    finishMatch(match, playerId, 'disconnect');
                }
            }
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
    if (!move || typeof move.from !== 'number' || typeof move.to !== 'number') {
        return res.status(400).json({ success: false, error: 'Некорректный формат хода' });
    }

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
    if (match.status !== 'playing') return res.json({ success: true, match }); // уже завершён

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

    // Ищем, есть ли уже этот игрок в таблице (чтобы обновлять его рекорд, а не спамить)
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
        leaderboards[gameId].push({ 
            nickname: nickname || 'Игрок', 
            score, 
            losses, 
            date: Date.now(), 
            id: crypto.randomUUID() 
        });
    }

    leaderboards[gameId].sort((a, b) => lowerIsBetter ? a.score - b.score : b.score - a.score);
    leaderboards[gameId] = leaderboards[gameId].slice(0, 10);

    res.json({ success: true });
});
app.get('/api/scores/:gameId', (req, res) => {
    const scores = leaderboards[req.params.gameId] || [];
    res.json({ success: true, scores });
});

app.get('/', (req, res) => res.send('Legion Arcade Checkers Server 🐾'));

app.listen(PORT, () => console.log(`Слушаем порт ${PORT}`));
