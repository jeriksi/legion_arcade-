const express = require('express');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
    
    // (Убрал отсюда ошибочную ссылку на GitHub)
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ============================================================
// ДВИЖОК ШАШЕК
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
// ХРАНИЛИЩА
// ============================================================
const matches = {}; 
const matchmakingQueue = []; 

// 1. Поиск матча (Авто-подбор)
app.post('/api/checkers/find-match', (req, res) => {
    const { playerId, nickname } = req.body;
    
    const existing = matchmakingQueue.find(p => p.id === playerId);
    if (existing) {
        return res.json({ success: true, status: 'waiting' });
    }
    
    // Очистка старых заявок (если кто-то закрыл вкладку)
    const now = Date.now();
    for (let i = matchmakingQueue.length - 1; i >= 0; i--) {
        if (now - matchmakingQueue[i].timestamp > 30000) {
            matchmakingQueue.splice(i, 1);
        }
    }

    if (matchmakingQueue.length > 0) {
        const opponent = matchmakingQueue.shift(); 
        const matchId = crypto.randomUUID();
        
        matches[matchId] = {
            id: matchId,
            players: [
                { id: opponent.id, nickname: opponent.nickname, color: 'w' },
                { id: playerId, nickname, color: 'b' }
            ],
            status: 'playing',
            gameState: CK.startPos(),
            winner: null
        };
        return res.json({ success: true, matchId });
    } else {
        matchmakingQueue.push({ id: playerId, nickname, timestamp: Date.now() });
        return res.json({ success: true, status: 'waiting' });
    }
});

// 2. Проверка статуса поиска
app.get('/api/checkers/status/:playerId', (req, res) => {
    const playerId = req.params.playerId;
    
    const match = Object.values(matches).find(m => 
        m.status === 'playing' && m.players.some(p => p.id === playerId)
    );
    
    if (match) {
        return res.json({ success: true, matchId: match.id });
    }
    
    const inQueue = matchmakingQueue.find(p => p.id === playerId);
    if (inQueue) {
        const waitTime = Date.now() - inQueue.timestamp;
        
        if (waitTime > 30000) {
            const idx = matchmakingQueue.findIndex(p => p.id === playerId);
            if (idx !== -1) matchmakingQueue.splice(idx, 1);
            return res.json({ success: true, status: 'timeout' });
        }
        
        return res.json({ success: true, status: 'waiting', waitTime: Math.floor(waitTime / 1000) });
    }
    
    return res.json({ success: true, status: 'none' });
});

// 3. Получить состояние матча
app.get('/api/checkers/match/:id', (req, res) => {
    const match = matches[req.params.id];
    if (!match) return res.status(404).json({ error: 'Матч не найден' });
    res.json({ success: true, match });
});

// 4. СДЕЛАТЬ ХОД (Этот кусок был потерян!)
app.post('/api/checkers/match/:id/move', (req, res) => {
    const { playerId, move } = req.body; 
    const match = matches[req.params.id];
    
    if (!match || match.status !== 'playing') return res.status(400).json({ success: false, error: 'Игра недоступна' });
    
    const player = match.players.find(p => p.id === playerId);
    if (!player || player.color !== match.gameState.turn) return res.status(400).json({ success: false, error: 'Сейчас не ваш ход' });
    
    const validMoves = CK.legal(match.gameState);
    const realMove = validMoves.find(m => m.from === move.from && m.to === move.to);
    
    if (!realMove) return res.status(400).json({ success: false, error: 'Нелегальный ход' });
    
    match.gameState = CK.make(match.gameState, realMove);
    
    // Проверка: если у следующего игрока нет ходов, он проиграл
    const nextMoves = CK.legal(match.gameState);
    if (nextMoves.length === 0) {
        match.status = 'finished';
        match.winner = playerId;
    }
    
    res.json({ success: true, match });
});

// Тестовый роут
app.get('/', (req, res) => res.send('Сервер шашек с авто-подбором работает! 🐾'));

app.listen(PORT, () => console.log(`Слушаем порт ${PORT}`));
