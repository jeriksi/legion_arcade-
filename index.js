const express = require('express');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Разрешаем запросы с любых доменов (для UserScript)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// ============================================================
// ДВИЖОК ШАШЕК (взято из вашего кода)
// ============================================================
const CK = (() => {
    const DIRS = [[-1,-1],[-1,1],[1,-1],[1,1]];
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
// ХРАНИЛИЩЕ МАТЧЕЙ (В памяти сервера)
// ============================================================
const matches = {}; // { matchId: { id, players: [], status, gameState, winner } }

// 1. Создать матч (ожидание игрока)
app.post('/api/checkers/create', (req, res) => {
    const { playerId, nickname } = req.body;
    const matchId = crypto.randomUUID();
    
    matches[matchId] = {
        id: matchId,
        players: [{ id: playerId, nickname, color: 'w' }],
        status: 'waiting',
        gameState: CK.startPos(),
        winner: null
    };
    
    res.json({ success: true, matchId });
});

// 2. Подключиться к существующему матчу
app.post('/api/checkers/join', (req, res) => {
    const { playerId, nickname, matchId } = req.body;
    const match = matches[matchId];
    
    if (!match) return res.status(404).json({ error: 'Матч не найден' });
    if (match.status !== 'waiting') return res.status(400).json({ error: 'Матч уже начался' });
    if (match.players[0].id === playerId) return res.status(400).json({ error: 'Нельзя играть с самим собой' });
    
    match.players.push({ id: playerId, nickname, color: 'b' });
    match.status = 'playing';
    
    res.json({ success: true, match });
});

// 3. Получить состояние матча (для опроса)
app.get('/api/checkers/:id', (req, res) => {
    const match = matches[req.params.id];
    if (!match) return res.status(404).json({ error: 'Матч не найден' });
    res.json({ success: true, match });
});

// 4. Сделать ход
app.post('/api/checkers/:id/move', (req, res) => {
    const { playerId, move } = req.body; // move: { from, to, captures, path, piece }
    const match = matches[req.params.id];
    
    if (!match || match.status !== 'playing') return res.status(400).json({ error: 'Игра недоступна' });
    
    const player = match.players.find(p => p.id === playerId);
    if (!player || player.color !== match.gameState.turn) return res.status(400).json({ error: 'Не ваш ход' });
    
    // Проверяем, легален ли ход на сервере (защита от читов)
    const validMoves = CK.legal(match.gameState);
    const isValid = validMoves.some(m => m.from === move.from && m.to === move.to);
    
    if (!isValid) return res.status(400).json({ error: 'Нелегальный ход' });
    
    // Применяем ход
    const realMove = validMoves.find(m => m.from === move.from && m.to === move.to);
    match.gameState = CK.make(match.gameState, realMove);
    
    // Проверка на конец игры (нет ходов)
    const nextMoves = CK.legal(match.gameState);
    if (nextMoves.length === 0) {
        match.status = 'finished';
        match.winner = playerId; // Победа тому, кто сделал ход
    }
    
    res.json({ success: true, match });
});

// Тестовый роут
app.get('/', (req, res) => res.send('Сервер шашек работает! 🐾'));

app.listen(PORT, () => console.log(`Слушаем порт ${PORT}`));
