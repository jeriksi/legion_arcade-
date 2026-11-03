// ==UserScript==
// @name         Legion: Arcade (мини-игры + Мультиплеер)
// @namespace    https://github.com/
// @version      0.5.0
// @description  Мини-игры в стиле Легиона: от сапёра до онлайн-шашек.
// @match        https://play.multidonate.ru/c/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      legion-arcade.onrender.com
// @updateURL    https://raw.githubusercontent.com/jeriksi/legion_arcade-/main/legion-arcade.meta.js
// @downloadURL  https://raw.githubusercontent.com/jeriksi/legion_arcade-/main/legion-arcade.user.js
// ==/UserScript==

(function () {
    'use strict';

    if (window.__LG_ARCADE__) return;

    // ============================================================
    // !!! ВАЖНО: ВСТАВЬТЕ СЮДА СВОЮ ССЫЛКУ С RENDER !!!
    // ============================================================
    const SERVER_URL = 'https://legion-arcade.onrender.com';

    // ============================================================
    // Хранилище и утилиты
    // ============================================================
    const LS = 'lgArcade.';
    const store = {
        get(k, d) {
            try {
                const v = localStorage.getItem(LS + k);
                return v === null ? d : JSON.parse(v);
            } catch (e) { return d; }
        },
        set(k, v) {
            try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) {}
        }
    };

    function getPlayerName() {
        const el = document.querySelector('span.who');
        return el ? el.textContent.trim() : null; // Возвращаем null, если ник еще не прогрузился
    }

    function getToken() {
        if (typeof GM_getValue === 'function') {
            try {
                const name = getPlayerName();
                if (!name) return null; // Ждем прогрузки
                const v = GM_getValue('lgArcade.playerToken_' + name, undefined);
                if (v !== undefined && v !== null && v !== '') return v;

                // Миграция для старых токенов
                const legacy = store.get('playerToken', null);
                if (legacy && name === 'Игрок') return legacy;
            } catch (e) {}
        }
        return null;
    }

    function setToken(v) {
        if (typeof GM_setValue !== 'function') return false;
        try {
            const name = getPlayerName() || 'Игрок';
            GM_setValue('lgArcade.playerToken_' + name, v);
            return true;
        } catch (e) { return false; }
    }

    let playerId = store.get('playerId', null);
    let playerToken = getToken();
    // МЫ УБРАЛИ ОЧИСТКУ playerId ОТСЮДА, чтобы не терять данные при загрузке

    function rawRequest(path, options = {}) {
        return new Promise((resolve) => {
            const headers = { 'Content-Type': 'application/json' };
            if (playerToken) headers['Authorization'] = 'Bearer ' + playerToken;

            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url: SERVER_URL + path,
                headers,
                data: options.body,
                timeout: 20000,
                onload: (res) => {
                    try { resolve(JSON.parse(res.responseText)); }
                    catch (e) { resolve({ success: false, error: 'Ошибка парсинга ответа' }); }
                },
                onerror: () => resolve({ success: false, error: 'Сетевая ошибка (сервер выключен)' }),
                ontimeout: () => resolve({ success: false, error: 'Сервер не отвечает.' })
            });
        });
    }

    let registeringPromise = null;
    async function ensureRegistered() {
        if (playerToken && playerId) return true;
        if (registeringPromise) return registeringPromise;

        registeringPromise = (async () => {
            try {
                // Ждем до 10 секунд, пока сайт прогрузит ваш ник
                let name = getPlayerName();
                let attempts = 0;
                while (!name && attempts < 20) {
                    await new Promise(r => setTimeout(r, 500));
                    name = getPlayerName();
                    attempts++;
                }
                if (!name) name = 'Игрок';

                // Пробуем получить токен еще раз (вдруг ник только что прогрузился)
                playerToken = getToken();
                if (playerToken && playerId) return true;

                // Если токена нет — регистрируемся
                const res = await rawRequest('/api/player/register', { method: 'POST', body: '{}' });
                if (res && res.success && res.playerId && res.token) {
                    playerId = res.playerId;
                    playerToken = res.token;
                    store.set('playerId', playerId);
                    setToken(playerToken);
                    return true;
                }
            } catch (e) {}
            return false;
        })();

        try { return await registeringPromise; }
        finally { registeringPromise = null; }
    }

    async function serverRequest(path, options = {}) {
        if (path !== '/api/player/register') {
            const ok = await ensureRegistered();
            if (!ok) return { success: false, error: 'Не удалось авторизоваться' };
        }

        let res = await rawRequest(path, options);

        // Если сервер ответил "Не авторизован" (например, он только что перезагрузился)
        if (path !== '/api/player/register' && res && !res.success &&
            (res.error === 'Не авторизован' || res.error === 'Неверный токен')) {

            // Ждем 2 секунды и пробуем еще раз, НЕ удаляя токен
            await new Promise(r => setTimeout(r, 2000));
            res = await rawRequest(path, options);

            // Если снова ошибка — значит токен реально устарел
            if (!res.success && (res.error === 'Не авторизован' || res.error === 'Неверный токен')) {
                playerId = null; playerToken = null;
                store.set('playerId', null); setToken(null);
                const ok = await ensureRegistered();
                if (ok) res = await rawRequest(path, options);
            }
        }
        return res;
    }

    // Регистрируемся сразу при загрузке (функция сама подождет нужный ник).
    ensureRegistered();

    async function startSession(gameId) {
        try {
            const r = await serverRequest('/api/session/start', {
                method: 'POST',
                body: JSON.stringify({ gameId })
            });
            if (r && r.success && r.sessionId) {
                if (!window.lgSessions) window.lgSessions = {};
                window.lgSessions[gameId] = r.sessionId;
            }
        } catch (e) {}
    }

    const fmtTime = (s) => {
        s = Math.max(0, Math.floor(s));
        return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    };

    function h(tag, props, ...kids) {
        const el = document.createElement(tag);
        if (props) {
            for (const k of Object.keys(props)) {
                const v = props[k];
                if (k === 'class') el.className = v;
                else if (k === 'text') el.textContent = v;
                else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
                else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
            }
        }
        for (const kid of kids) if (kid != null) el.append(kid);
        return el;
    }

    // ============================================================
    // Стили
    // ============================================================
    const CSS = `
    :host {
        all: initial;
        --bg: #1b1c23; --bg2: #242530; --bg3: #121319; --line: #3a3c4a;
        --gold: #f3c969; --gold-d: #8a6a2f; --gold-bg: #3a2d18;
        --text: #e9eaf0; --muted: #9a9db0; --green: #59d98e; --red: #ff6b6b;
        --font: "Nunito", "Segoe UI", system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; font-family: var(--font); }
    button { font: inherit; cursor: pointer; }

    .fab { position: fixed; z-index: 2147483000; width: 50px; height: 50px; border-radius: 50%; border: 2px solid var(--gold-d); background: var(--bg2); color: var(--gold); box-shadow: 0 6px 18px rgba(0,0,0,.55); font-size: 24px; line-height: 1; display: grid; place-items: center; touch-action: none; user-select: none; padding: 0; }
    .fab:hover { border-color: var(--gold); }
    .fab:active { transform: scale(.95); }

    .win { position: fixed; z-index: 2147483001; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(560px, 96vw); max-height: 94vh; display: none; color: var(--text); }
    .win.open { display: block; }
    .win.wide { width: min(1000px, 98vw); }
    .dm-screen { position: relative; border-radius: 10px; overflow: hidden; background: #000; border: 1px solid var(--line); width: 100%; max-width: 960px; margin: 0 auto; }
    .dm-screen canvas { display: block; width: 100%; aspect-ratio: 16 / 10; image-rendering: pixelated; outline: none; cursor: crosshair; }

    .frame { position: relative; border-radius: 16px; padding: 16px 18px 14px; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 24px 70px rgba(0,0,0,.65); max-height: 94vh; overflow: auto; }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 0 0 12px; cursor: grab; user-select: none; touch-action: none; }
    .head:active { cursor: grabbing; }
    .title { font-weight: 800; font-size: 20px; color: var(--gold); }
    .x { width: 28px; height: 28px; border-radius: 50%; border: 0; background: #f1f1f5; color: #20212a; font-weight: 800; font-size: 14px; padding: 0; line-height: 1; display: grid; place-items: center; }
    .x:hover { background: #fff; }
    .board { background: transparent; padding: 0; }

    .cards { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; padding: 6px; border-radius: 12px; background: var(--bg3); max-height: 280px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
    .cards::-webkit-scrollbar { width: 6px; }
    .cards::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }

    .category-title { width: 100%; font-size: 11px; font-weight: 800; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin: 10px 4px 2px 4px; display: flex; align-items: center; gap: 8px; }
    .category-title:first-child { margin-top: 2px; }
    .category-title::after { content: ''; flex: 1; height: 1px; background: var(--line); }

    .card { position: relative; display: flex; align-items: center; gap: 9px; flex: 1 1 180px; padding: 8px 12px; text-align: left; color: var(--text); background: transparent; border: 1px solid transparent; border-radius: 10px; }
    .card:hover:not(:disabled):not(.on) { background: var(--bg2); }
    .card.on { background: var(--gold-bg); border-color: var(--gold-d); color: var(--gold); }
    .ico { flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-size: 17px; background: var(--bg2); border: 2px solid var(--ring, #888); }
    .meta { min-width: 0; }
    .name { font-weight: 800; font-size: 15px; }
    .sub { font-size: 12px; font-weight: 600; color: var(--muted); }
    .card.on .sub { color: #c9a95e; }

    .btn { padding: 6px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg2); color: var(--text); font-weight: 700; font-size: 13px; }
    .btn:hover { border-color: var(--gold-d); }
    .btn:active { transform: translateY(1px); }
    .btn.on { background: var(--gold-bg); color: var(--gold); border-color: var(--gold-d); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .lb-modal { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(18, 19, 25, 0.9); z-index: 10; display: none; flex-direction: column; align-items: center; justify-content: center; border-radius: 16px; backdrop-filter: blur(4px); }
    .lb-content { background: var(--bg2); padding: 20px; border-radius: 12px; border: 1px solid var(--line); width: 90%; max-width: 360px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .lb-table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .lb-table th { color: var(--muted); text-align: left; padding: 8px 4px; border-bottom: 1px solid var(--line); font-size: 12px; text-transform: uppercase; }
    .lb-table td { padding: 8px 4px; border-bottom: 1px solid rgba(255,255,255,0.05); font-weight: 600; }
    .lb-table tr:last-child td { border-bottom: none; }
    .lb-table td:first-child { color: var(--gold); font-weight: 800; width: 30px; }
    .lb-select {
        width: 100%; padding: 8px 12px; margin-bottom: 8px;
        background: var(--bg3); color: var(--text); border: 1px solid var(--line);
        border-radius: 8px; font-weight: 600; outline: none; font-family: var(--font);
        -webkit-appearance: none; -moz-appearance: none; appearance: none;
        background-image: url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23f3c969%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E");
        background-repeat: no-repeat; background-position: right 12px top 50%; background-size: 10px auto;
    }
    .lb-select:focus { border-color: var(--gold); }

    .ms-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .ms-diffs { display: flex; gap: 6px; flex-wrap: wrap; }
    .lcd { min-width: 62px; padding: 4px 8px; text-align: center; border-radius: 8px; background: var(--bg3); color: var(--green); border: 1px solid var(--line); font: 800 17px/1.2 "Consolas", monospace; letter-spacing: 1px; }
    .ms-mid { display: flex; align-items: center; gap: 8px; }
    .face { font-size: 20px; padding: 2px 8px; }
    .ms-hint { margin-top: 10px; font-size: 12px; font-weight: 600; color: var(--muted); text-align: center; min-height: 16px; }
    .ms-wrap { display: flex; justify-content: center; overflow: auto; padding: 10px; border-radius: 12px; background: var(--bg2); }
    .grid { display: grid; gap: 2px; padding: 4px; border-radius: 10px; background: var(--bg3); user-select: none; touch-action: manipulation; }
    .cell { width: var(--cs); height: var(--cs); padding: 0; border-radius: 5px; display: grid; place-items: center; font-weight: 800; font-size: calc(var(--cs) * .56); line-height: 1; background: #3c3f50; border: 1px solid #50536a; color: var(--text); }
    .cell:hover:not(.o) { background: #474b5f; }
    .cell.o { background: #16171d; border-color: #20222b; cursor: default; }
    .cell.boom { background: #7a2b2b; border-color: #a64444; }
    .cell.n1 { color: #5aa9ff; } .cell.n2 { color: #59d98e; } .cell.n3 { color: #ff6b6b; }
    .cell.n4 { color: #b08cff; } .cell.n5 { color: #ffb04a; } .cell.n6 { color: #4fd1c5; }
    .cell.n7 { color: #e9eaf0; } .cell.n8 { color: #9a9db0; }

    .ch-bar { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-bottom: 8px; align-items: center; justify-content: center; }
    .ch-group { display: flex; gap: 4px; flex-wrap: wrap; }
    .ch-status { margin: 6px 0 8px; text-align: center; font-weight: 800; font-size: 15px; color: var(--gold); min-height: 22px; }
    .ch-wrap { display: flex; justify-content: center; padding: 10px; border-radius: 12px; background: var(--bg2); }
    .ch-board { display: grid; grid-template-columns: repeat(8, var(--sq)); border-radius: 6px; overflow: hidden; border: 2px solid var(--bg3); }
    .sq { width: var(--sq); height: var(--sq); padding: 0; border: 0; border-radius: 0; position: relative; display: grid; place-items: center; font-size: calc(var(--sq) * .74); line-height: 1; background: #7a7e98; }
    .sq.d { background: #4a4d63; }
    .sq.last { background-image: linear-gradient(rgba(243,201,105,.32), rgba(243,201,105,.32)); }
    .sq.sel { box-shadow: inset 0 0 0 3px var(--gold); }
    .sq.tgt::after { content: ""; position: absolute; width: 28%; height: 28%; border-radius: 50%; background: rgba(243,201,105,.9); }
    .sq.tgt.cap::after { width: 86%; height: 86%; background: transparent; border: 3px solid rgba(243,201,105,.95); }
    .mp-lobby { display: flex; flex-direction: column; align-items: center; gap: 15px; padding: 20px; background: var(--bg2); border-radius: 12px; }

    /* ===== Фулскрин ===== */
    .win.fullscreen {
        left: 0 !important; top: 0 !important;
        transform: none !important;
        width: 100vw !important; height: 100vh !important;
        max-height: 100vh !important;
        border-radius: 0;
    }
    .win.fullscreen > .frame {
        max-height: 100vh !important; height: 100vh !important;
        border-radius: 0;
    }
    .win.fullscreen .resize-handle { display: none; }

    /* ===== Ручки ресайза (как у окон ОС) ===== */
    .resize-handle { position: absolute; z-index: 5; background: transparent; touch-action: none; }
    .resize-handle.n  { top: -5px;    left: 16px;  right: 16px;  height: 10px; cursor: ns-resize; }
    .resize-handle.s  { bottom: -5px; left: 16px;  right: 16px;  height: 10px; cursor: ns-resize; }
    .resize-handle.e  { right: -5px;  top: 16px;   bottom: 16px; width: 10px;  cursor: ew-resize; }
    .resize-handle.w  { left: -5px;   top: 16px;   bottom: 16px; width: 10px;  cursor: ew-resize; }
    .resize-handle.ne { top: -5px;    right: -5px; width: 16px;  height: 16px; cursor: nesw-resize; }
    .resize-handle.nw { top: -5px;    left: -5px;  width: 16px;  height: 16px; cursor: nwse-resize; }
    .resize-handle.se { bottom: -5px; right: -5px; width: 16px;  height: 16px; cursor: nwse-resize; }
    .resize-handle.sw { bottom: -5px; left: -5px;  width: 16px;  height: 16px; cursor: nwse-resize; }
    `;

    // ============================================================
    // ДВИЖКИ
    // ============================================================
    const MS = {
        neighbors(b, i) {
            const x = i % b.w, y = (i - x) / b.w, out = [];
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && ny >= 0 && nx < b.w && ny < b.h) out.push(ny * b.w + nx);
            }
            return out;
        },
        create(w, hgt, m) { return { w, h: hgt, m, state: 'ready', placed: false, opened: 0, cells: Array.from({ length: w * hgt }, () => ({ mine: false, open: false, flag: false, n: 0, boom: false })) }; },
        place(b, safe) {
            let excl = new Set([safe, ...MS.neighbors(b, safe)]);
            if (b.w * b.h - excl.size < b.m) excl = new Set([safe]);
            const pool = [];
            for (let i = 0; i < b.cells.length; i++) if (!excl.has(i)) pool.push(i);
            for (let k = 0; k < b.m; k++) {
                const j = k + Math.floor(Math.random() * (pool.length - k));
                [pool[k], pool[j]] = [pool[j], pool[k]];
                b.cells[pool[k]].mine = true;
            }
            for (let i = 0; i < b.cells.length; i++) b.cells[i].n = MS.neighbors(b, i).filter((j) => b.cells[j].mine).length;
            b.placed = true;
        },
        open(b, i) {
            if (b.state === 'won' || b.state === 'lost') return false;
            const c = b.cells[i];
            if (c.open || c.flag) return false;
            let started = false;
            if (!b.placed) { MS.place(b, i); b.state = 'playing'; started = true; }
            if (c.mine) { c.boom = true; b.state = 'lost'; b.cells.forEach((x) => { if (x.mine && !x.flag) x.open = true; }); return started; }
            const stack = [i];
            while (stack.length) {
                const k = stack.pop(), ck = b.cells[k];
                if (ck.open || ck.flag) continue;
                ck.open = true; b.opened++;
                if (ck.n === 0) for (const j of MS.neighbors(b, k)) if (!b.cells[j].open) stack.push(j);
            }
            if (b.opened === b.w * b.h - b.m) { b.state = 'won'; b.cells.forEach((x) => { if (x.mine) x.flag = true; }); }
            return started;
        },
        flag(b, i) { if (b.state === 'won' || b.state === 'lost') return; const c = b.cells[i]; if (c.open) return; c.flag = !c.flag; },
        flagsLeft(b) { return b.m - b.cells.filter((c) => c.flag).length; },
        chord(b, i) {
            const c = b.cells[i];
            if (!c.open || c.n === 0 || b.state !== 'playing') return;
            const ns = MS.neighbors(b, i);
            if (ns.filter((j) => b.cells[j].flag).length !== c.n) return;
            for (const j of ns) if (!b.cells[j].flag) MS.open(b, j);
        }
    };

    const CH = (() => {
        const isW = (p) => p === p.toUpperCase();
        const colorOf = (p) => (isW(p) ? 'w' : 'b');
        const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
        const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
        const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
        const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
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
        function evalPos(pos) {
            let s = 0;
            for (let i = 0; i < 64; i++) {
                const p = pos.b[i]; if (!p) continue;
                const t = p.toLowerCase(), r = i >> 3, c = i & 7, w = isW(p);
                const dist = Math.max(Math.abs(r - 3.5), Math.abs(c - 3.5));
                let v = VAL[t];
                if (t === 'n' || t === 'b') v += (3.5 - dist) * 8;
                else if (t === 'q') v += (3.5 - dist) * 2;
                else if (t === 'p') v += (w ? 6 - r : r - 1) * 6 + ((c === 3 || c === 4) ? 6 : 0);
                s += w ? v : -v;
            }
            return s;
        }
        const orderScore = (pos, m) => {
            const v = pos.b[m.to];
            let s = v ? VAL[v.toLowerCase()] * 10 - VAL[pos.b[m.from].toLowerCase()] : 0;
            if (m.promo) s += 800; if (m.flag === 'ep') s += 1000; return s;
        };
        function search(pos, depth, alpha, beta, ply) {
            const ms = legal(pos);
            if (!ms.length) return inCheck(pos, pos.turn) ? -(100000 - ply) : 0;
            if (depth === 0) { const e = evalPos(pos); return pos.turn === 'w' ? e : -e; }
            ms.sort((x, y) => orderScore(pos, y) - orderScore(pos, x));
            let best = -Infinity;
            for (const m of ms) { const sc = -search(make(pos, m), depth - 1, -beta, -alpha, ply + 1); if (sc > best) best = sc; if (best > alpha) alpha = best; if (alpha >= beta) break; }
            return best;
        }
        function bestMove(pos, depth, noise) {
            const ms = legal(pos); if (!ms.length) return null;
            ms.sort((x, y) => orderScore(pos, y) - orderScore(pos, x));
            let best = null, bs = -Infinity;
            for (const m of ms) { const sc = -search(make(pos, m), depth - 1, -Infinity, Infinity, 1) + Math.random() * noise; if (sc > bs) { bs = sc; best = m; } }
            return best;
        }
        return { fromFEN, startPos, legal, make, inCheck, key, insufficient, bestMove, colorOf };
    })();

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
            const r = sq >> 3, c = sq & 7, myColor = colorOf(piece), myKing = isKing(piece), results = [];
            let extended = false;
            for (const [dr, dc] of DIRS) {
                if (myKing) {
                    let jumpedSq = -1, jumpDist = 0;
                    for (let d = 1; ; d++) { const nr = r + dr * d, nc = c + dc * d; if (nr < 0 || nr > 7 || nc < 0 || nc > 7) break; const nSq = nr * 8 + nc; if (b[nSq]) { if (captured.has(nSq) || colorOf(b[nSq]) === myColor) break; jumpedSq = nSq; jumpDist = d; break; } }
                    if (jumpedSq === -1) continue;
                    for (let d = jumpDist + 1; ; d++) {
                        const nr = r + dr * d, nc = c + dc * d; if (nr < 0 || nr > 7 || nc < 0 || nc > 7) break;
                        const lSq = nr * 8 + nc; if (b[lSq]) break;
                        extended = true; const nc2 = new Set(captured); nc2.add(jumpedSq);
                        results.push(...genCaps(b, lSq, piece, nc2, [...path, lSq]));
                    }
                } else {
                    const mr = r + dr, mc = c + dc; if (mr < 0 || mr > 7 || mc < 0 || mc > 7) continue;
                    const mSq = mr * 8 + mc, mp = b[mSq]; if (!mp || colorOf(mp) === myColor || captured.has(mSq)) continue;
                    const lr = r + dr * 2, lc = c + dc * 2; if (lr < 0 || lr > 7 || lc < 0 || lc > 7) continue;
                    const lSq = lr * 8 + lc; if (b[lSq]) continue;
                    extended = true; const nc2 = new Set(captured); nc2.add(mSq);
                    let newPiece = piece; if ((myColor === 'w' && lr === 0) || (myColor === 'b' && lr === 7)) newPiece = myColor === 'w' ? 'W' : 'B';
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
                        const nr = r + dr * d, nc = c + dc * d; if (nr < 0 || nr > 7 || nc < 0 || nc > 7) break;
                        const nSq = nr * 8 + nc; if (b[nSq]) break; moves.push({ from: i, to: nSq, captures: [], path: [i, nSq], piece: p });
                    }
                } else {
                    const fwd = turn === 'w' ? -1 : 1;
                    for (const dc of [-1, 1]) {
                        const nr = r + fwd, nc = c + dc; if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
                        const nSq = nr * 8 + nc; if (b[nSq]) continue;
                        let newPiece = p; if ((turn === 'w' && nr === 0) || (turn === 'b' && nr === 7)) newPiece = turn === 'w' ? 'W' : 'B';
                        moves.push({ from: i, to: nSq, captures: [], path: [i, nSq], piece: newPiece });
                    }
                }
            }
            return moves;
        }
        function legal(pos) {
            const caps = [];
            for (let i = 0; i < 64; i++) { const p = pos.b[i]; if (!p || colorOf(p) !== pos.turn) continue; caps.push(...genCaps(pos.b, i, p, new Set(), [i])); }
            return caps.length > 0 ? caps : genSimple(pos.b, pos.turn);
        }
        function make(pos, m) {
            const b = [...pos.b]; for (const sq of m.captures) b[sq] = ''; b[m.from] = ''; b[m.to] = m.piece;
            let hm = pos.hm; if (m.captures.length > 0 || !isKing(pos.b[m.from])) hm = 0; else hm++;
            return { b, turn: pos.turn === 'w' ? 'b' : 'w', hm };
        }
        const key = (pos) => pos.b.join('') + pos.turn;
        function evaluate(pos) {
            let s = 0;
            for (let i = 0; i < 64; i++) {
                const p = pos.b[i]; if (!p) continue;
                const sign = colorOf(p) === 'w' ? 1 : -1;
                if (isKing(p)) s += sign * 300;
                else { s += sign * 100; s += sign * (colorOf(p) === 'w' ? (7 - (i >> 3)) : (i >> 3)) * 8; }
            }
            return s;
        }
        function bestMove(pos, depth, noise) {
            const moves = legal(pos); if (!moves.length) return null;
            const maximizing = pos.turn === 'w';
            function search(p, d, alpha, beta) {
                if (d === 0) return evaluate(p);
                const ms = legal(p); if (!ms.length) return p.turn === 'w' ? -100000 : 100000;
                if (p.turn === 'w') {
                    let best = -Infinity;
                    for (const m of ms) { const v = search(make(p, m), d - 1, alpha, beta); if (v > best) best = v; if (best > alpha) alpha = best; if (alpha >= beta) break; }
                    return best;
                } else {
                    let best = Infinity;
                    for (const m of ms) { const v = search(make(p, m), d - 1, alpha, beta); if (v < best) best = v; if (best < beta) beta = best; if (alpha >= beta) break; }
                    return best;
                }
            }
            moves.sort((a, b) => b.captures.length - a.captures.length);
            let best = null, bestV = maximizing ? -Infinity : Infinity;
            for (const m of moves) {
                let v = search(make(pos, m), depth - 1, -Infinity, Infinity);
                if (noise > 0) v += (Math.random() - 0.5) * noise;
                if (maximizing ? v > bestV : v < bestV) { bestV = v; best = m; }
            }
            return best;
        }
        return { startPos, legal, make, key, colorOf, isKing, bestMove };
    })();

    // ============================================================
    // ИГРА: САПЁР
    // ============================================================
    const DIFFS = {
        easy: { label: 'Лёгкая',  w: 9,  h: 9,  m: 10 },
        mid:  { label: 'Средняя', w: 12, h: 12, m: 24 },
        hard: { label: 'Сложная', w: 16, h: 16, m: 40 }
    };

    const Minesweeper = {
    id: 'mines', name: 'Сапёр', icon: '💣', ring: '#e05a4f', category: 'solo',
    subtitle() { const best = store.get('ms.best', {}); const parts = Object.keys(DIFFS).filter((k) => best[k] != null).map((k) => DIFFS[k].label[0] + ' ' + fmtTime(best[k])); return parts.length ? 'рекорд: ' + parts.join(' · ') : 'рекордов пока нет'; },
    mount(root, api) {
        let diff = store.get('ms.diff', 'easy'); if (!DIFFS[diff]) diff = 'easy';
        let board, cellEls = [], flagMode = false, timerId = null, startedAt = 0, accMs = 0, running = false, lpTimer = null, lpFired = false;
        const diffBtns = h('div', { class: 'ms-diffs' }); const mineLcd = h('div', { class: 'lcd', text: '000' }); const timeLcd = h('div', { class: 'lcd', text: '00:00' });
        const face = h('button', { class: 'btn face', text: '🐱', title: 'Новая игра', onclick: () => newGame() });
        const flagBtn = h('button', { class: 'btn', text: '🚩 Флажок', onclick: () => { flagMode = !flagMode; flagBtn.classList.toggle('on', flagMode); } });
        const bar = h('div', { class: 'ms-bar' }, diffBtns, h('div', { class: 'ms-mid' }, mineLcd, face, timeLcd), flagBtn);
        const gridEl = h('div', { class: 'grid' }); const hint = h('div', { class: 'ms-hint' });
        root.append(bar, h('div', { class: 'ms-wrap' }, gridEl), hint);
        const elapsed = () => (accMs + (running ? Date.now() - startedAt : 0)) / 1000;
        const tick = () => { timeLcd.textContent = fmtTime(elapsed()); };
        const startTimer = () => { if (!running) { running = true; startedAt = Date.now(); timerId = setInterval(tick, 250); } };
        const stopTimer = () => { if (running) { accMs += Date.now() - startedAt; running = false; } clearInterval(timerId); timerId = null; };
        function renderDiffs() {
            diffBtns.textContent = '';
            for (const k of Object.keys(DIFFS)) diffBtns.append(h('button', { class: 'btn' + (k === diff ? ' on' : ''), text: DIFFS[k].label, onclick: () => { diff = k; store.set('ms.diff', k); renderDiffs(); newGame(); } }));
        }
        function newGame() {
            stopTimer(); accMs = 0; lpFired = false; const d = DIFFS[diff]; board = MS.create(d.w, d.h, d.m);
            const avail = Math.min(root.clientWidth || 560, 560) - 40; const cs = Math.max(22, Math.min(34, Math.floor(avail / d.w) - 3));
            gridEl.style.setProperty('--cs', cs + 'px'); gridEl.style.gridTemplateColumns = `repeat(${d.w}, var(--cs))`; gridEl.textContent = ''; cellEls = [];
            for (let i = 0; i < d.w * d.h; i++) { const el = h('button', { class: 'cell', 'data-i': i, type: 'button' }); cellEls.push(el); gridEl.append(el); }
            face.textContent = '🐱'; hint.textContent = 'ЛКМ - открыть · ПКМ / долгое нажатие - флажок'; tick(); paint();
            startSession('mines_' + diff);
        }
        function paint() {
            for (let i = 0; i < cellEls.length; i++) {
                const c = board.cells[i], el = cellEls[i]; let cls = 'cell', txt = '';
                if (c.open) { cls += ' o'; if (c.mine) { txt = '💣'; if (c.boom) cls += ' boom'; } else if (c.n > 0) { txt = String(c.n); cls += ' n' + c.n; } }
                else if (c.flag) { txt = (board.state === 'lost' && !c.mine) ? '❌' : '🚩'; }
                el.className = cls; if (el.textContent !== txt) el.textContent = txt;
            }
            mineLcd.textContent = String(Math.max(0, MS.flagsLeft(board))).padStart(3, '0');
            if (board.state === 'lost') face.textContent = '😿'; if (board.state === 'won') face.textContent = '😸';
        }
        function afterMove(started) {
            if (started) startTimer();
            if (board.state === 'lost') {
                stopTimer(); hint.textContent = 'Бум! Попробуй ещё раз.';
            } else if (board.state === 'won') {
                stopTimer(); tick();
                const t = Math.floor(elapsed());
                const best = store.get('ms.best', {});
                const isNew = best[diff] == null || t < best[diff];
                if (isNew) {
                    best[diff] = t;
                    store.set('ms.best', best);
                    api.refreshCards();
                    hint.textContent = `Победа! Новый рекорд: ${fmtTime(t)}`;
                } else {
                    hint.textContent = `Победа! Время: ${fmtTime(t)} (рекорд ${fmtTime(best[diff])})`;
                }
                // Всегда отправляем на сервер — сервер сам решит, обновлять ли.
                api.submitScore(t, 'mines_' + diff);
            }
            paint();
        }
        const idxOf = (e) => { const t = e.target.closest && e.target.closest('.cell'); return t ? Number(t.dataset.i) : -1; };
        function primary(i) {
            const c = board.cells[i];
            if (flagMode && !c.open) { MS.flag(board, i); paint(); return; }
            if (c.open) { MS.chord(board, i); afterMove(false); } else { afterMove(MS.open(board, i)); }
        }
        gridEl.addEventListener('click', (e) => { const i = idxOf(e); if (i < 0) return; if (lpFired) { lpFired = false; return; } primary(i); });
        gridEl.addEventListener('contextmenu', (e) => { e.preventDefault(); if (lpFired) return; const i = idxOf(e); if (i >= 0) { MS.flag(board, i); paint(); } });
        gridEl.addEventListener('pointerdown', (e) => {
            lpFired = false; if (e.pointerType !== 'touch') return;
            const i = idxOf(e); if (i < 0) return;
            clearTimeout(lpTimer); lpTimer = setTimeout(() => { lpFired = true; MS.flag(board, i); paint(); if (navigator.vibrate) { try { navigator.vibrate(20); } catch (err) {} } }, 450);
        });
        const cancelLp = () => clearTimeout(lpTimer);
        gridEl.addEventListener('pointerup', cancelLp); gridEl.addEventListener('pointercancel', cancelLp);
        gridEl.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch' && (Math.abs(e.movementX) > 3 || Math.abs(e.movementY) > 3)) cancelLp(); });
        renderDiffs(); newGame();
        return { onHide() { if (board.state === 'playing') stopTimer(); }, onShow() { if (board.state === 'playing') { startTimer(); tick(); } }, destroy() { stopTimer(); clearTimeout(lpTimer); } };
    }
};

    // ============================================================
    // ОБЩИЕ КОНСТАНТЫ ДЛЯ ШАХМАТ / ШАШЕК
    // ============================================================
    const GLYPH = { k: '♚︎', q: '♛︎', r: '♜︎', b: '♝︎', n: '♞︎', p: '♟︎' };
    const LEVELS = { 1: { label: 'Лёгкий', depth: 1, noise: 140 }, 2: { label: 'Средний', depth: 2, noise: 20 }, 3: { label: 'Сложный', depth: 3, noise: 4 } };
    const sqName = (i) => 'abcdefgh'[i & 7] + (8 - (i >> 3));

    // ============================================================
    // ИГРА: ШАХМАТЫ
    // ============================================================
    const Chess = {
        id: 'chess', name: 'Шахматы', icon: '♞', ring: '#b9a6e0', category: 'solo',
        subtitle() { const w = store.get('ch.wins', 0); return w ? 'побед над ботом: ' + w : 'против бота'; },
        mount(root, api) {
            const saved = store.get('ch.opts', {}); const opts = { side: saved.side === 'b' ? 'b' : 'w', level: LEVELS[saved.level] ? saved.level : 2 };
            let pos, hist, keys, last, moves, sel, targets, outcome, thinking = false, gen = 0, botTimer = null, promo = null;
            const optsBar = h('div', { class: 'ch-bar' }); const status = h('div', { class: 'ch-status' }); const boardEl = h('div', { class: 'ch-board' }); const promoEl = h('div', { class: 'ch-promo' }); const hint = h('div', { class: 'ms-hint' });
            root.append(optsBar, status, h('div', { class: 'ch-wrap' }, boardEl), promoEl, hint);
            const cs = Math.max(34, Math.min(58, Math.floor((Math.min(root.clientWidth || 520, 520) - 24) / 8)));
            boardEl.style.setProperty('--sq', cs + 'px'); const sqEls = [];
            for (let v = 0; v < 64; v++) { const el = h('button', { class: 'sq', type: 'button', 'data-v': v }); sqEls.push(el); boardEl.append(el); }
            const flipped = () => opts.side === 'b'; const toIdx = (v) => (flipped() ? 63 - v : v);
            boardEl.addEventListener('click', (e) => { const t = e.target.closest('.sq'); if (t) onSquare(toIdx(Number(t.dataset.v))); });
            function renderOpts() {
                optsBar.textContent = ''; const grp = (...kids) => h('div', { class: 'ch-group' }, ...kids); const opt = (label, on, fn) => h('button', { class: 'btn' + (on ? ' on' : ''), type: 'button', text: label, onclick: fn });
                optsBar.append(grp(opt('Белые', opts.side === 'w', () => setOpts({ side: 'w' })), opt('Чёрные', opts.side === 'b', () => setOpts({ side: 'b' }))));
                optsBar.append(grp(...Object.keys(LEVELS).map((k) => opt(LEVELS[k].label, opts.level === Number(k), () => setOpts({ level: Number(k) })))));
                optsBar.append(grp(opt('Новая игра', false, () => newGame()), opt('↶ Отмена хода', false, () => undo())));
            }
            function setOpts(patch) { Object.assign(opts, patch); store.set('ch.opts', opts); renderOpts(); newGame(); }
            function computeOutcome() {
                if (!moves.length) return CH.inCheck(pos, pos.turn) ? 'mate' : 'stalemate';
                if (CH.insufficient(pos)) return 'material'; if (pos.hm >= 100) return 'fifty';
                const k = keys[keys.length - 1]; if (keys.filter((x) => x === k).length >= 3) return 'repeat'; return 'ok';
            }
            function statusText() {
                switch (outcome) {
                    case 'mate': { const winner = pos.turn === 'w' ? 'b' : 'w'; return winner === opts.side ? 'Мат! Ты победил 🎉' : 'Мат. Победил бот'; }
                    case 'stalemate': return 'Пат - ничья'; case 'material': return 'Ничья: не хватает материала';
                    case 'fifty': return 'Ничья по правилу 50 ходов'; case 'repeat': return 'Ничья: троекратное повторение';
                }
                if (thinking) return 'Бот думает…';
                const chk = CH.inCheck(pos, pos.turn) ? ' · Шах!' : ''; return (pos.turn === opts.side ? 'Твой ход' : 'Ход бота') + chk;
            }
            function paint() {
                const chkSq = (outcome === 'ok' || outcome === 'mate') && CH.inCheck(pos, pos.turn) ? pos.b.indexOf(pos.turn === 'w' ? 'K' : 'k') : -1;
                for (let v = 0; v < 64; v++) {
                    const i = toIdx(v), p = pos.b[i], r = i >> 3, c = i & 7, el = sqEls[v];
                    let cls = 'sq'; if ((r + c) & 1) cls += ' d'; if (last && (last.from === i || last.to === i)) cls += ' last'; if (i === sel) cls += ' sel'; if (targets.includes(i)) cls += ' tgt' + (p ? ' cap' : '');
                    if (i === chkSq) cls += ' chk'; if (p) cls += CH.colorOf(p) === 'w' ? ' pw' : ' pb'; el.className = cls;
                    const txt = p ? GLYPH[p.toLowerCase()] : ''; if (el.textContent !== txt) el.textContent = txt;
                }
                status.textContent = statusText();
                hint.textContent = last ? 'Последний ход: ' + sqName(last.from) + '–' + sqName(last.to) : 'Нажми на свою фигуру, чтобы увидеть доступные ходы';
            }
            function refresh() {
                moves = CH.legal(pos);
                const oldOutcome = outcome;
                outcome = computeOutcome();
                paint();
                if (outcome === 'ok' && pos.turn !== opts.side) botMove();
                if (outcome === 'mate' && oldOutcome !== 'mate') {
                    const winner = pos.turn === 'w' ? 'b' : 'w';
                    if (winner === opts.side) {
                        const wins = store.get('ch.wins', 0) + 1;
                        store.set('ch.wins', wins); api.refreshCards();
                        api.submitScore(wins, 'chess');
                    }
                }
            }
            function botMove() {
                thinking = true; status.textContent = statusText(); const my = gen;
                botTimer = setTimeout(() => { if (my !== gen) return; const L = LEVELS[opts.level]; const m = CH.bestMove(pos, L.depth, L.noise); thinking = false; if (m) play(m); }, 80);
            }
            function play(m) {
                hist.push({ pos, last }); pos = CH.make(pos, m); last = m; keys.push(CH.key(pos)); sel = -1; targets = []; clearPromo(); refresh();
            }
            function clearPromo() { promo = null; promoEl.textContent = ''; }
            function showPromo(ms) {
                promo = ms; promoEl.textContent = ''; promoEl.append(h('span', { class: 'sub', text: 'Превратить в:' }));
                for (const t of ['q', 'r', 'b', 'n']) promoEl.append(h('button', { class: 'btn promo-btn', type: 'button', text: GLYPH[t], onclick: () => { const m = ms.find((x) => x.promo === t); if (m) play(m); } }));
            }
            function onSquare(i) {
                if (outcome !== 'ok' || thinking) return; if (pos.turn !== opts.side) return; if (promo) clearPromo();
                if (sel >= 0) { const ms = moves.filter((m) => m.from === sel && m.to === i); if (ms.length > 1) { showPromo(ms); return; } if (ms.length === 1) { play(ms[0]); return; } }
                const p = pos.b[i]; if (p && CH.colorOf(p) === pos.turn) { sel = i; targets = moves.filter((m) => m.from === i).map((m) => m.to); } else { sel = -1; targets = []; } paint();
            }
            function undo() {
                if (!hist.length) return; gen++; clearTimeout(botTimer); thinking = false; let e = hist.pop(); pos = e.pos; last = e.last; keys.pop();
                if (pos.turn !== opts.side && hist.length) { e = hist.pop(); pos = e.pos; last = e.last; keys.pop(); }
                sel = -1; targets = []; clearPromo(); refresh();
            }
            function newGame() { gen++; clearTimeout(botTimer); thinking = false; pos = CH.startPos(); hist = []; keys = [CH.key(pos)]; last = null; sel = -1; targets = []; clearPromo(); startSession('chess'); refresh(); }
            renderOpts(); newGame();
            return { destroy() { gen++; clearTimeout(botTimer); } };
        }
    };

    // ============================================================
    // ИГРА: ШАШКИ
    // ============================================================
    const Checkers = {
        id: 'checkers', name: 'Шашки', icon: '⚫', ring: '#e8b05c', category: 'solo',
        subtitle() { const w = store.get('chk.wins', 0); return w ? 'побед над ботом: ' + w : 'русские шашки'; },
        mount(root, api) {
            const LEVELS = { 1: { label: 'Лёгкий', depth: 2, noise: 80 }, 2: { label: 'Средний', depth: 3, noise: 15 }, 3: { label: 'Сложный', depth: 4, noise: 3 } };
            const saved = store.get('chk.opts', {}); const opts = { side: saved.side === 'b' ? 'b' : 'w', level: LEVELS[saved.level] ? saved.level : 2 };
            let pos, hist, keys, last, moves, sel, targets, outcome, thinking = false, gen = 0, botTimer = null;
            const CHK_GLYPH = { w: '●', W: '♛', b: '●', B: '♛' };
            const optsBar = h('div', { class: 'ch-bar' }); const status = h('div', { class: 'ch-status' }); const boardEl = h('div', { class: 'ch-board' }); const hint = h('div', { class: 'ms-hint' });
            root.append(optsBar, status, h('div', { class: 'ch-wrap' }, boardEl), hint);
            const cs = Math.max(34, Math.min(58, Math.floor((Math.min(root.clientWidth || 520, 520) - 24) / 8)));
            boardEl.style.setProperty('--sq', cs + 'px'); const sqEls = [];
            for (let v = 0; v < 64; v++) { const el = h('button', { class: 'sq', type: 'button', 'data-v': v }); sqEls.push(el); boardEl.append(el); }
            const flipped = () => opts.side === 'b'; const toIdx = (v) => (flipped() ? 63 - v : v);
            boardEl.addEventListener('click', (e) => { const t = e.target.closest('.sq'); if (t) onSquare(toIdx(Number(t.dataset.v))); });
            function renderOpts() {
                optsBar.textContent = ''; const grp = (...k) => h('div', { class: 'ch-group' }, ...k); const opt = (label, on, fn) => h('button', { class: 'btn' + (on ? ' on' : ''), type: 'button', text: label, onclick: fn });
                optsBar.append(grp(opt('Белые', opts.side === 'w', () => setOpts({ side: 'w' })), opt('Чёрные', opts.side === 'b', () => setOpts({ side: 'b' }))));
                optsBar.append(grp(...Object.keys(LEVELS).map(k => opt(LEVELS[k].label, opts.level === Number(k), () => setOpts({ level: Number(k) })))));
                optsBar.append(grp(opt('Новая игра', false, () => newGame()), opt('↶ Отмена хода', false, () => undo())));
            }
            function setOpts(patch) { Object.assign(opts, patch); store.set('chk.opts', opts); renderOpts(); newGame(); }
            function computeOutcome() {
                if (!moves.length) return 'lose';
                if (pos.hm >= 30) { const totalPieces = pos.b.filter(p => p).length; if (totalPieces <= 6) return 'fifteen'; }
                const k = keys[keys.length - 1]; if (keys.filter(x => x === k).length >= 3) return 'repeat'; return 'ok';
            }
            function statusText() {
                switch (outcome) {
                    case 'lose': return pos.turn === opts.side ? 'Нет ходов. Поражение' : 'Победа! У бота нет ходов 🎉';
                    case 'fifteen': return 'Ничья: 15 ходов без боя'; case 'repeat': return 'Ничья: троекратное повторение';
                }
                if (thinking) return 'Бот думает…'; return pos.turn === opts.side ? 'Твой ход' : 'Ход бота';
            }
            function paint() {
                for (let v = 0; v < 64; v++) {
                    const i = toIdx(v), p = pos.b[i], r = i >> 3, c = i & 7, el = sqEls[v];
                    let cls = 'sq'; if ((r + c) & 1) cls += ' d'; if (last && (last.from === i || last.to === i || (last.path && last.path.includes(i)))) cls += ' last';
                    if (i === sel) cls += ' sel'; if (targets.includes(i)) cls += ' tgt' + (p ? ' cap' : ''); el.className = cls;
                    if (p) {
                        const isW = CK.colorOf(p) === 'w'; el.style.color = isW ? '#f0e6d2' : '#1a1a1a';
                        el.style.textShadow = isW ? '0 0 1px #000, 0 0 2px rgba(0,0,0,0.8)' : '0 0 1px #fff, 0 0 2px rgba(255,255,255,0.6)';
                        if (el.textContent !== CHK_GLYPH[p]) el.textContent = CHK_GLYPH[p];
                    } else { el.style.color = ''; el.style.textShadow = ''; if (el.textContent !== '') el.textContent = ''; }
                }
                status.textContent = statusText();
                hint.textContent = last ? 'Последний ход: ' + sqName(last.from) + '–' + sqName(last.to) + (last.captures.length ? ` (${last.captures.length} взято)` : '') : 'Нажми на свою шашку, чтобы увидеть доступные ходы';
            }
            function refresh() {
                moves = CK.legal(pos);
                const oldOutcome = outcome;
                outcome = computeOutcome();
                paint();
                if (outcome === 'ok' && pos.turn !== opts.side) botMove();
                if (outcome === 'lose' && oldOutcome !== 'lose') {
                    if (pos.turn !== opts.side) {
                        const wins = store.get('chk.wins', 0) + 1;
                        store.set('chk.wins', wins); api.refreshCards();
                        api.submitScore(wins, 'checkers');
                    }
                }
            }
            function botMove() {
                thinking = true; status.textContent = statusText(); const my = gen;
                botTimer = setTimeout(() => { if (my !== gen) return; const L = LEVELS[opts.level]; const m = CK.bestMove(pos, L.depth, L.noise); thinking = false; if (m) play(m); }, 80);
            }
            function play(m) {
                hist.push({ pos, last }); pos = CK.make(pos, m); last = m; keys.push(CK.key(pos)); sel = -1; targets = []; refresh();
            }
            function onSquare(i) {
                if (outcome !== 'ok' || thinking) return; if (pos.turn !== opts.side) return;
                if (sel >= 0) { const ms = moves.filter(m => m.from === sel && m.to === i); if (ms.length >= 1) { play(ms[0]); return; } }
                const p = pos.b[i]; if (p && CK.colorOf(p) === pos.turn) { sel = i; targets = moves.filter(m => m.from === i).map(m => m.to); } else { sel = -1; targets = []; } paint();
            }
            function undo() {
                if (!hist.length) return; gen++; clearTimeout(botTimer); thinking = false; let e = hist.pop(); pos = e.pos; last = e.last; keys.pop();
                if (pos.turn !== opts.side && hist.length) { e = hist.pop(); pos = e.pos; last = e.last; keys.pop(); }
                sel = -1; targets = []; refresh();
            }
            function newGame() { gen++; clearTimeout(botTimer); thinking = false; pos = CK.startPos(); hist = []; keys = [CK.key(pos)]; last = null; sel = -1; targets = []; startSession('checkers'); refresh(); }
            renderOpts(); newGame();
            return { destroy() { gen++; clearTimeout(botTimer); } };
        }
    };

    // ============================================================
    // ИГРА: ТЕТРИС (+ клик-рестарт)
    // ============================================================
    const Tetris = {
        id: 'tetris', name: 'Тетрис', icon: '🧱', ring: '#5aa9ff', category: 'solo',
        subtitle() { const hi = store.get('tetris.hi', 0); return hi ? 'рекорд: ' + hi : 'tetris'; },
        mount(root, api) {
            const COLS = 10, ROWS = 20, BLOCK = 20;
            const canvas = h('canvas', { width: COLS * BLOCK, height: ROWS * BLOCK, style: 'background: #121319; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.5);' });
            const nextCanvas = h('canvas', { width: 4 * BLOCK, height: 4 * BLOCK, style: 'background: #1b1c23; border-radius: 6px;' });
            const ctx = canvas.getContext('2d'); const nCtx = nextCanvas.getContext('2d');
            const scoreEl = h('div', { class: 'lcd', style: 'font-size: 14px; width: 100px; text-align: center;', text: '000000' });
            const linesEl = h('div', { class: 'lcd', style: 'font-size: 14px; width: 100px; text-align: center;', text: '0' });
            const levelEl = h('div', { class: 'lcd', style: 'font-size: 14px; width: 100px; text-align: center;', text: '1' });
            const btnPause = h('button', { class: 'btn', text: '⏸ Пауза', onclick: togglePause });
            const btnRestart = h('button', { class: 'btn', text: '🔄 Рестарт', onclick: () => newGame() });
            const ctrlRow = h('div', { class: 'tetris-controls', style: 'display: none; gap: 6px; margin-top: 10px; justify-content: center; width: 100%;' },
                h('button', { class: 'btn', text: '◀', style: 'flex:1;', onpointerdown: (e) => { e.preventDefault(); move(-1); } }),
                h('button', { class: 'btn', text: '▼', style: 'flex:1;', onpointerdown: (e) => { e.preventDefault(); drop(); } }),
                h('button', { class: 'btn', text: '▶', style: 'flex:1;', onpointerdown: (e) => { e.preventDefault(); move(1); } }),
                h('button', { class: 'btn', text: '🔄', style: 'flex:1;', onpointerdown: (e) => { e.preventDefault(); rotate(); } })
            );
            if ('ontouchstart' in window || navigator.maxTouchPoints > 0) ctrlRow.style.display = 'flex';
            const side = h('div', { style: 'display: flex; flex-direction: column; gap: 10px; align-items: center;' },
                h('div', { style: 'color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase;' }, 'Очки'), scoreEl,
                h('div', { style: 'color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase;' }, 'Линии'), linesEl,
                h('div', { style: 'color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase;' }, 'Уровень'), levelEl,
                h('div', { style: 'color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; margin-top: 10px;' }, 'Следующая'), nextCanvas,
                h('div', { style: 'display: flex; flex-direction: column; gap: 6px; margin-top: auto; width: 100%;' }, btnPause, btnRestart)
            );
            const wrap = h('div', { style: 'display: flex; gap: 16px; justify-content: center; padding: 10px;' }, canvas, side);
            const hint = h('div', { class: 'ms-hint', text: '← → - движение · ↑ - поворот · ↓ - ускорить · Пробел - быстрое падение' });
            root.append(wrap, ctrlRow, hint);
            let board, piece, nextPiece, score, lines, level, gameOver, paused, dropCounter, dropInterval, lastTime, animId = null, isFastDropping = false;
            const COLORS = ['#00f0f0', '#0000f0', '#f0a000', '#f0f000', '#00f000', '#a000f0', '#f00000'];
            const SHAPES = [[[1, 1, 1, 1]], [[1, 0, 0], [1, 1, 1]], [[0, 0, 1], [1, 1, 1]], [[1, 1], [1, 1]], [[0, 1, 1], [1, 1, 0]], [[1, 1, 1], [0, 1, 0]], [[1, 1, 0], [0, 1, 1]]];
            function createPiece() { const typeId = Math.floor(Math.random() * SHAPES.length); const shape = SHAPES[typeId]; return { shape, color: COLORS[typeId], x: Math.floor(COLS / 2) - Math.ceil(shape[0].length / 2), y: 0 }; }
            function newGame() {
                if (animId) cancelAnimationFrame(animId);
                board = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
                score = 0; lines = 0; level = 1; gameOver = false; paused = false; dropCounter = 0; dropInterval = 1000; lastTime = performance.now(); isFastDropping = false;
                piece = createPiece(); nextPiece = createPiece(); btnPause.textContent = '⏸ Пауза'; updateUI(); startSession('tetris'); loop(performance.now());
            }
            function togglePause() {
                if (gameOver) return; paused = !paused; btnPause.textContent = paused ? '▶ Продолжить' : '⏸ Пауза';
                if (!paused) { lastTime = performance.now(); if (!animId) loop(lastTime); } else { cancelAnimationFrame(animId); animId = null; }
            }
            function updateUI() { scoreEl.textContent = String(score).padStart(6, '0'); linesEl.textContent = String(lines); levelEl.textContent = String(level); }
            function collide(b, p) {
                for (let y = 0; y < p.shape.length; y++) for (let x = 0; x < p.shape[y].length; x++) if (p.shape[y][x]) {
                    const bx = p.x + x, by = p.y + y; if (bx < 0 || bx >= COLS || by >= ROWS || (by >= 0 && b[by][bx])) return true;
                } return false;
            }
            function merge() {
                piece.shape.forEach((row, y) => row.forEach((val, x) => { if (val && piece.y + y >= 0) board[piece.y + y][piece.x + x] = piece.color; }));
                clearLines(); piece = nextPiece; nextPiece = createPiece();
                if (collide(board, piece)) {
                    gameOver = true; const hi = store.get('tetris.hi', 0); if (score > hi) { store.set('tetris.hi', score); api.refreshCards(); }
                    api.submitScore(score, 'tetris');
                }
            }
            function clearLines() {
                let cleared = 0;
                for (let y = ROWS - 1; y >= 0; y--) if (board[y].every(val => val !== 0)) { board.splice(y, 1); board.unshift(Array(COLS).fill(0)); cleared++; y++; }
                if (cleared > 0) { const pts = [0, 100, 300, 500, 800][cleared]; score += pts * level; lines += cleared; level = Math.floor(lines / 10) + 1; dropInterval = Math.max(100, 1000 - (level - 1) * 100); updateUI(); }
            }
            function rotate() {
                if (paused || gameOver) return; const s = piece.shape; const rotated = s[0].map((_, i) => s.map(row => row[i]).reverse());
                const oldX = piece.x; piece.shape = rotated; let offset = 1;
                while (collide(board, piece)) { piece.x += offset; offset = -(offset + (offset > 0 ? 1 : -1)); if (Math.abs(offset) > s[0].length) { piece.shape = s; piece.x = oldX; return; } }
            }
            function move(dir) { if (paused || gameOver) return; piece.x += dir; if (collide(board, piece)) piece.x -= dir; }
            function drop() { if (paused || gameOver) return; piece.y++; if (collide(board, piece)) { piece.y--; merge(); } dropCounter = 0; }
            function drawBlock(c, x, y, color) { c.fillStyle = color; c.fillRect(x * BLOCK, y * BLOCK, BLOCK, BLOCK); c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 2; c.strokeRect(x * BLOCK, y * BLOCK, BLOCK, BLOCK); c.fillStyle = 'rgba(255,255,255,0.2)'; c.fillRect(x * BLOCK + 2, y * BLOCK + 2, BLOCK - 4, 4); }
            function drawGhost() {
                if (gameOver || paused) return; let ghostY = piece.y; const temp = { ...piece, y: ghostY };
                while (!collide(board, temp)) { ghostY++; temp.y = ghostY; } ghostY--;
                if (ghostY > piece.y) {
                    ctx.save(); ctx.globalAlpha = 0.15; piece.shape.forEach((row, y) => row.forEach((val, x) => {
                        if (val) { ctx.fillStyle = piece.color; ctx.fillRect((piece.x + x) * BLOCK, (ghostY + y) * BLOCK, BLOCK, BLOCK); ctx.strokeStyle = piece.color; ctx.lineWidth = 1; ctx.strokeRect((piece.x + x) * BLOCK, (ghostY + y) * BLOCK, BLOCK, BLOCK); }
                    })); ctx.restore();
                }
            }
            function draw() {
                ctx.fillStyle = '#121319'; ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 1;
                for (let i = 0; i <= COLS; i++) { ctx.beginPath(); ctx.moveTo(i * BLOCK, 0); ctx.lineTo(i * BLOCK, canvas.height); ctx.stroke(); }
                for (let i = 0; i <= ROWS; i++) { ctx.beginPath(); ctx.moveTo(0, i * BLOCK); ctx.lineTo(canvas.width, i * BLOCK); ctx.stroke(); }
                for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (board[y][x]) drawBlock(ctx, x, y, board[y][x]);
                drawGhost();
                if (!gameOver && !paused) piece.shape.forEach((row, y) => row.forEach((val, x) => { if (val) drawBlock(ctx, piece.x + x, piece.y + y, piece.color); }));
                nCtx.fillStyle = '#1b1c23'; nCtx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
                if (nextPiece) {
                    const offsetX = (4 - nextPiece.shape[0].length) / 2; const offsetY = (4 - nextPiece.shape.length) / 2;
                    nextPiece.shape.forEach((row, y) => row.forEach((val, x) => {
                        if (val) { nCtx.fillStyle = nextPiece.color; nCtx.fillRect((x + offsetX) * BLOCK, (y + offsetY) * BLOCK, BLOCK, BLOCK); nCtx.strokeStyle = 'rgba(0,0,0,0.3)'; nCtx.strokeRect((x + offsetX) * BLOCK, (y + offsetY) * BLOCK, BLOCK, BLOCK); }
                    }));
                }
                if (gameOver || paused) {
                    ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.fillStyle = '#f3c969'; ctx.font = 'bold 18px "Nunito", sans-serif'; ctx.textAlign = 'center'; ctx.fillText(gameOver ? 'ИГРА ОКОНЧЕНА' : 'ПАУЗА', canvas.width / 2, canvas.height / 2 - 10);
                    if (gameOver) { ctx.fillStyle = '#e9eaf0'; ctx.font = '12px "Nunito", sans-serif'; ctx.fillText('R или клик — заново', canvas.width / 2, canvas.height / 2 + 20); }
                }
            }
            function loop(time) {
                if (!canvas.isConnected) return; const dt = time - lastTime; lastTime = time;
                if (!paused && !gameOver) { dropCounter += dt; const currentInterval = isFastDropping ? 30 : dropInterval; if (dropCounter > currentInterval) drop(); }
                draw(); animId = requestAnimationFrame(loop);
            }
            const keydownListener = (e) => {
                if (win.style.display === 'none') return; if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Space'].includes(e.code)) e.preventDefault();
                if (e.code === 'KeyR') { newGame(); return; }
                if (e.code === 'ArrowLeft') move(-1); if (e.code === 'ArrowRight') move(1); if (e.code === 'ArrowDown') drop(); if (e.code === 'ArrowUp') rotate(); if (e.code === 'Space') isFastDropping = true; if (e.code === 'KeyP') togglePause();
            };
            const keyupListener = (e) => { if (e.code === 'Space') isFastDropping = false; };
            window.addEventListener('keydown', keydownListener); window.addEventListener('keyup', keyupListener);
            canvas.addEventListener('click', () => { if (gameOver) newGame(); });
            newGame();
            return { onHide() { cancelAnimationFrame(animId); animId = null; isFastDropping = false; }, onShow() { if (!paused && !gameOver && !animId) { lastTime = performance.now(); loop(lastTime); } }, destroy() { cancelAnimationFrame(animId); window.removeEventListener('keydown', keydownListener); window.removeEventListener('keyup', keyupListener); } };
        }
    };

    // ============================================================
    // ИГРА: ТРИ В РЯД
    // ============================================================
    const Match3 = {
        id: 'match3', name: 'Три в ряд', icon: '💎', ring: '#59d98e', category: 'solo',
        subtitle() { const hi = store.get('m3.hi', 0); return hi ? 'рекорд: ' + hi : 'анимированная головоломка'; },
        mount(root, api) {
            const SIZE = 8; const CELL = 44; const GAP = 4; const BOARD_SIZE = SIZE * (CELL + GAP);
            let board = []; let elements = []; let score = 0; let moves = 30; let selected = null; let isProcessing = false;
            const styleEl = h('style', { text: `
                .m3-container { position: relative; width: 100%; max-width: ${BOARD_SIZE}px; aspect-ratio: 1; margin: 0 auto; background: #121319; border-radius: 12px; overflow: hidden; box-shadow: inset 0 0 20px rgba(0,0,0,0.8); touch-action: none; }
                .m3-gem { position: absolute; width: ${CELL}px; height: ${CELL}px; display: flex; align-items: center; justify-content: center; transition: top 0.25s ease, left 0.25s ease, transform 0.2s, opacity 0.2s; cursor: pointer; will-change: top, left, transform; }
                .m3-gem.sel { transform: scale(1.15); z-index: 10; filter: drop-shadow(0 0 8px #fff); }
                .m3-gem.pop { transform: scale(0); opacity: 0; }
                .m3-shape { width: 80%; height: 80%; box-shadow: inset -3px -3px 8px rgba(0,0,0,0.4), inset 3px 3px 8px rgba(255,255,255,0.4); transition: transform 0.3s; pointer-events: none; }
                .gem-0 .m3-shape { background: linear-gradient(135deg, #ff6b6b, #c0392b); border-radius: 50%; }
                .gem-1 .m3-shape { background: linear-gradient(135deg, #59d98e, #27ae60); border-radius: 15%; transform: rotate(45deg); }
                .gem-2 .m3-shape { background: linear-gradient(135deg, #5aa9ff, #2980b9); border-radius: 6px; }
                .gem-3 .m3-shape { background: linear-gradient(135deg, #f3c969, #d4ac0d); clip-path: polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%); }
                .gem-4 .m3-shape { background: linear-gradient(135deg, #b08cff, #8e44ad); clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%); }
                .gem-5 .m3-shape { background: linear-gradient(135deg, #4fd1c5, #16a085); border-radius: 50% 0 50% 50%; transform: rotate(-45deg); }
            ` });
            root.append(styleEl);
            const scoreEl = h('div', { class: 'lcd', style: 'font-size: 16px; width: 80px; text-align: center;', text: '0000' });
            const movesEl = h('div', { class: 'lcd', style: 'font-size: 16px; width: 80px; text-align: center;', text: '30' });
            const btnRestart = h('button', { class: 'btn', text: '🔄 Рестарт', onclick: () => newGame(), style: 'margin-top: 10px;' });
            const topBar = h('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding: 0 10px;' },
                h('div', { style: 'display: flex; flex-direction: column; align-items: center;' }, h('div', { style: 'color: var(--muted); font-size: 11px; font-weight: 800; margin-bottom: 4px;' }, 'ОЧКИ'), scoreEl),
                h('div', { style: 'display: flex; flex-direction: column; align-items: center;' }, h('div', { style: 'color: var(--muted); font-size: 11px; font-weight: 800; margin-bottom: 4px;' }, 'ХОДЫ'), movesEl)
            );
            const gridEl = h('div', { class: 'm3-container' });
            const hint = h('div', { class: 'ms-hint', text: 'Нажмите на два соседних камня, чтобы поменять их местами' });
            root.append(topBar, gridEl, hint, h('div', { style: 'text-align: center;' }, btnRestart));
            gridEl.addEventListener('click', (e) => { const el = e.target.closest('.m3-gem'); if (!el) return; handleCellClick(Number(el.dataset.r), Number(el.dataset.c)); });
            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
            const getPos = (r, c) => ({ top: r * (CELL + GAP) + GAP, left: c * (CELL + GAP) + GAP });
            function updateUI() { scoreEl.textContent = String(score).padStart(4, '0'); movesEl.textContent = String(moves); }
            function initBoardData() {
                board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
                for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
                    do { board[r][c] = Math.floor(Math.random() * 6); } while ((c >= 2 && board[r][c] === board[r][c-1] && board[r][c] === board[r][c-2]) || (r >= 2 && board[r][c] === board[r-1][c] && board[r][c] === board[r-2][c]));
                }
            }
            function createGemEl(val, r, c) {
                const pos = getPos(r, c); const el = h('div', { class: `m3-gem gem-${val}`, style: `top: ${pos.top}px; left: ${pos.left}px;`, 'data-r': r, 'data-c': c }, h('div', { class: 'm3-shape' }));
                gridEl.append(el); return el;
            }
            function newGame() {
                gridEl.innerHTML = ''; initBoardData(); elements = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
                for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) elements[r][c] = createGemEl(board[r][c], r, c);
                score = 0; moves = 30; selected = null; isProcessing = false; updateUI(); hint.textContent = 'Нажмите на два соседних камня, чтобы поменять их местами';
                startSession('match3');
            }
            function handleCellClick(r, c) {
                if (isProcessing || moves <= 0) return;
                if (selected && selected.r === r && selected.c === c) { if (elements[r][c]) elements[r][c].classList.remove('sel'); selected = null; return; }
                if (!selected) { selected = { r, c }; if (elements[r][c]) elements[r][c].classList.add('sel'); return; }
                const prev = elements[selected.r][selected.c]; if (prev) prev.classList.remove('sel');
                const dist = Math.abs(selected.r - r) + Math.abs(selected.c - c); const oldSelected = { ...selected }; selected = null;
                if (dist === 1) trySwap(oldSelected.r, oldSelected.c, r, c);
                else { selected = { r, c }; if (elements[r][c]) elements[r][c].classList.add('sel'); }
            }
            async function trySwap(r1, c1, r2, c2) {
                isProcessing = true; await swapVisual(r1, c1, r2, c2); const matches = findMatches();
                if (matches.length === 0) { await swapVisual(r1, c1, r2, c2); isProcessing = false; return; }
                moves--; updateUI(); await processMatches(matches);
            }
            async function swapVisual(r1, c1, r2, c2) {
                const tempData = board[r1][c1]; board[r1][c1] = board[r2][c2]; board[r2][c2] = tempData;
                const tempEl = elements[r1][c1]; elements[r1][c1] = elements[r2][c2]; elements[r2][c2] = tempEl;
                const el1 = elements[r1][c1]; const el2 = elements[r2][c2];
                el1.style.transition = 'top 0.25s ease, left 0.25s ease'; el2.style.transition = 'top 0.25s ease, left 0.25s ease';
                const p1 = getPos(r1, c1); const p2 = getPos(r2, c2);
                el1.style.top = p1.top + 'px'; el1.style.left = p1.left + 'px'; el1.dataset.r = r1; el1.dataset.c = c1;
                el2.style.top = p2.top + 'px'; el2.style.left = p2.left + 'px'; el2.dataset.r = r2; el2.dataset.c = c2;
                await sleep(250);
            }
            function findMatches() {
                const toRemove = new Set();
                for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE - 2; c++) { const val = board[r][c]; if (val !== null && val === board[r][c+1] && val === board[r][c+2]) { toRemove.add(`${r},${c}`); toRemove.add(`${r},${c+1}`); toRemove.add(`${r},${c+2}`); } }
                for (let c = 0; c < SIZE; c++) for (let r = 0; r < SIZE - 2; r++) { const val = board[r][c]; if (val !== null && val === board[r+1][c] && val === board[r+2][c]) { toRemove.add(`${r},${c}`); toRemove.add(`${r+1},${c}`); toRemove.add(`${r+2},${c}`); } }
                return Array.from(toRemove).map(str => { const [r, c] = str.split(',').map(Number); return { r, c }; });
            }
            async function processMatches(matches) {
                score += matches.length * 10 * (matches.length > 3 ? 2 : 1); updateUI();
                for (let m of matches) { if (elements[m.r][m.c]) elements[m.r][m.c].classList.add('pop'); board[m.r][m.c] = null; } await sleep(200);
                for (let m of matches) { if (elements[m.r][m.c]) { elements[m.r][m.c].remove(); elements[m.r][m.c] = null; } }
                let maxFallDuration = 0;
                for (let c = 0; c < SIZE; c++) {
                    let emptyRow = SIZE - 1;
                    for (let r = SIZE - 1; r >= 0; r--) {
                        if (board[r][c] !== null) {
                            if (r !== emptyRow) {
                                board[emptyRow][c] = board[r][c]; board[r][c] = null; elements[emptyRow][c] = elements[r][c]; elements[r][c] = null;
                                const el = elements[emptyRow][c]; const pos = getPos(emptyRow, c);
                                const distCells = emptyRow - r; const duration = distCells * 0.1; maxFallDuration = Math.max(maxFallDuration, duration);
                                el.getBoundingClientRect(); el.style.transition = `top ${duration}s cubic-bezier(0.25, 0.46, 0.45, 0.94)`; el.style.top = pos.top + 'px'; el.dataset.r = emptyRow; el.dataset.c = c;
                            }
                            emptyRow--;
                        }
                    }
                    if (emptyRow >= 0) {
                        const maxDist = (emptyRow + 2) * (CELL + GAP); const duration = (maxDist / (CELL + GAP)) * 0.1; maxFallDuration = Math.max(maxFallDuration, duration);
                        for (let r = emptyRow; r >= 0; r--) {
                            const newVal = Math.floor(Math.random() * 6); board[r][c] = newVal; const pos = getPos(r, c); const startTop = pos.top - maxDist;
                            const el = h('div', { class: `m3-gem gem-${newVal}`, style: `top: ${startTop}px; left: ${pos.left}px;`, 'data-r': r, 'data-c': c }, h('div', { class: 'm3-shape' }));
                            gridEl.append(el); elements[r][c] = el; el.getBoundingClientRect(); el.style.transition = `top ${duration}s cubic-bezier(0.25, 0.46, 0.45, 0.94)`; el.style.top = pos.top + 'px';
                        }
                    }
                }
                await sleep(maxFallDuration * 1000 + 50);
                const newMatches = findMatches();
                if (newMatches.length > 0) await processMatches(newMatches);
                else {
                    isProcessing = false;
                    if (moves <= 0) {
                        const hi = store.get('m3.hi', 0);
                        if (score > hi) { store.set('m3.hi', score); api.refreshCards(); hint.textContent = `Игра окончена! Новый рекорд: ${score}`; }
                        else hint.textContent = `Игра окончена! Счет: ${score}. Рекорд: ${hi}`;
                        api.submitScore(score, 'match3');
                    }
                }
            }
            newGame(); return { destroy() {} };
        }
    };

    // ============================================================
    // ИГРА: ЗМЕЙКА (+ клик-рестарт)
    // ============================================================
    const Snake = {
        id: 'snake', name: 'Змейка', icon: '🐍', ring: '#59d98e', category: 'solo',
        subtitle() { const hi = Math.max(store.get('snake.hi_classic', 0), store.get('snake.hi_wrap', 0), store.get('snake.hi_maze', 0)); return hi ? 'рекорд: ' + hi : '3 режима игры'; },
        mount(root, api) {
            const GRID = 20; const TILE = 20; const SIZE = GRID * TILE;
            const canvas = h('canvas', { width: SIZE, height: SIZE, style: 'background: #16171d; border-radius: 12px; border: 1px solid #3a3c4a; width: 100%; max-width: 400px; aspect-ratio: 1; margin: 0 auto; display: block;' });
            const ctx = canvas.getContext('2d');
            const scoreEl = h('div', { class: 'lcd', style: 'font-size: 14px; padding: 2px 6px; width: 70px; text-align: center;', text: '0000' });
            const hiEl = h('div', { class: 'lcd', style: 'font-size: 14px; padding: 2px 6px; width: 70px; text-align: center;', text: '0000' });
            const topBar = h('div', { style: 'display: flex; justify-content: center; gap: 15px; margin-bottom: 12px;' }, h('div', { style: 'display: flex; flex-direction: column; align-items: center;' }, h('div', { style: 'color: var(--muted); font-size: 10px; font-weight: 800; margin-bottom: 4px;' }, 'ОЧКИ'), scoreEl), h('div', { style: 'display: flex; flex-direction: column; align-items: center;' }, h('div', { style: 'color: var(--muted); font-size: 10px; font-weight: 800; margin-bottom: 4px;' }, 'РЕКОРД'), hiEl));
            const modeBtns = h('div', { style: 'display: flex; gap: 6px; justify-content: center; margin-bottom: 10px; flex-wrap: wrap;' });
            const modes = [{ id: 'classic', label: 'Классика' }, { id: 'wrap', label: 'Без границ' }, { id: 'maze', label: 'Лабиринт' }];
            let currentMode = store.get('snake.mode', 'classic');
            modes.forEach(m => {
                const rec = store.get('snake.hi_' + m.id, 0);
                const label = rec ? `${m.label} · ${rec}` : m.label;
                const btn = h('button', {
                    class: 'btn' + (currentMode === m.id ? ' on' : ''),
                    text: label,
                    onclick: () => {
                        currentMode = m.id;
                        store.set('snake.mode', currentMode);
                        modeBtns.querySelectorAll('.btn').forEach(b => b.classList.remove('on'));
                        btn.classList.add('on');
                        initGame();
                    }
                });
                modeBtns.append(btn);
            });
            const dpad = h('div', { class: 'snake-dpad', style: 'display: none; grid-template-columns: repeat(3, 1fr); gap: 6px; width: 180px; margin: 15px auto 0;' },
                h('div'), h('button', { class: 'btn', style: 'aspect-ratio: 1; font-size: 20px;', onpointerdown: (e) => { e.preventDefault(); changeDir(0, -1); } }, '▲'), h('div'),
                h('button', { class: 'btn', style: 'aspect-ratio: 1; font-size: 20px;', onpointerdown: (e) => { e.preventDefault(); changeDir(-1, 0); } }, '◀'),
                h('button', { class: 'btn', style: 'aspect-ratio: 1; font-size: 20px;', onpointerdown: (e) => { e.preventDefault(); changeDir(0, 1); } }, '▼'),
                h('button', { class: 'btn', style: 'aspect-ratio: 1; font-size: 20px;', onpointerdown: (e) => { e.preventDefault(); changeDir(1, 0); } }, '▶'));
            if ('ontouchstart' in window || navigator.maxTouchPoints > 0) dpad.style.display = 'grid';
            const hint = h('div', { class: 'ms-hint', text: 'Стрелки или WASD · Пробел / R - Рестарт' });
            root.append(topBar, modeBtns, canvas, dpad, hint);
            let snake, prevSnake, dir, nextDir, food, score, hiScore, gameOver, speed, lastMove, animId; let obstacles = [];
            function generateRandomMaze() {
                obstacles = []; const safeMin = 7, safeMax = 12; let attempts = 0;
                while (obstacles.length < 45 && attempts < 200) {
                    attempts++; const x = Math.floor(Math.random() * GRID); const y = Math.floor(Math.random() * GRID);
                    if (x >= safeMin && x <= safeMax && y >= safeMin && y <= safeMax) continue;
                    if (x === 0 || x === GRID-1 || y === 0 || y === GRID-1) continue;
                    if (obstacles.some(o => o.x === x && o.y === y)) continue;
                    obstacles.push({x, y});
                    if (Math.random() < 0.6) {
                        const length = Math.floor(Math.random() * 2) + 1; const isHorizontal = Math.random() > 0.5;
                        for (let i = 1; i <= length; i++) {
                            const nx = isHorizontal ? x + i : x; const ny = isHorizontal ? y : y + i;
                            if (nx >= safeMin && nx <= safeMax && ny >= safeMin && ny <= safeMax) break;
                            if (nx >= GRID-1 || ny >= GRID-1) break;
                            if (obstacles.some(o => o.x === nx && o.y === ny)) break;
                            obstacles.push({x: nx, y: ny});
                        }
                    }
                }
            }
            function initGame() {
                speed = 160; snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }]; prevSnake = snake.map(s => ({...s})); dir = { x: 1, y: 0 }; nextDir = { x: 1, y: 0 }; score = 0;
                const legacyHi = store.get('snake.hi', 0); if (legacyHi && !store.get('snake.hi_classic', 0)) store.set('snake.hi_classic', legacyHi);
                hiScore = store.get('snake.hi_' + currentMode, 0); gameOver = false; lastMove = performance.now();
                if (currentMode === 'maze') generateRandomMaze(); else obstacles = [];
                startSession('snake_' + currentMode);
                spawnFood(); updateUI(); if (animId) cancelAnimationFrame(animId); loop(performance.now());
            }
            function spawnFood() {
                let newFood, valid = false, attempts = 0;
                while (!valid && attempts < 500) { attempts++; newFood = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) }; valid = !snake.some(seg => seg.x === newFood.x && seg.y === newFood.y) && !obstacles.some(obs => obs.x === newFood.x && obs.y === newFood.y); }
                if (valid) food = newFood;
            }
            function updateUI() { scoreEl.textContent = String(score).padStart(4, '0'); hiEl.textContent = String(hiScore).padStart(4, '0'); }
            function changeDir(dx, dy) { if (gameOver) return; if (dir.x !== -dx || dir.y !== -dy) nextDir = { x: dx, y: dy }; }
            function update(time) {
                if (gameOver) return; if (time - lastMove < speed) return;
                lastMove = time; dir = nextDir; let head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
                if (currentMode === 'wrap') { if (head.x < 0) head.x = GRID - 1; if (head.x >= GRID) head.x = 0; if (head.y < 0) head.y = GRID - 1; if (head.y >= GRID) head.y = 0; }
                else { if (head.x < 0 || head.x >= GRID || head.y < 0 || head.y >= GRID) return die(); }
                if (obstacles.some(obs => obs.x === head.x && obs.y === head.y)) return die();
                const isEating = (head.x === food.x && head.y === food.y); const checkLen = isEating ? snake.length : snake.length - 1;
                for (let i = 0; i < checkLen; i++) if (snake[i].x === head.x && snake[i].y === head.y) return die();
                prevSnake = snake.map(s => ({...s})); snake.unshift(head);
                if (isEating) {
                    score += 10; if (score > hiScore) { hiScore = score; store.set('snake.hi_' + currentMode, hiScore); api.refreshCards(); }
                    if (speed > 70 && score % 50 === 0) speed -= 10; spawnFood(); updateUI();
                } else snake.pop();
            }
            function die() {
                gameOver = true;
                api.submitScore(score, 'snake_' + currentMode);
                if (navigator.vibrate) { try { navigator.vibrate([100, 50, 100]); } catch(e){} }
            }
            function draw(time) {
                ctx.fillStyle = '#16171d'; ctx.fillRect(0, 0, SIZE, SIZE);
                ctx.strokeStyle = 'rgba(255,255,255,0.015)'; ctx.lineWidth = 1; ctx.beginPath();
                for (let i = 0; i <= GRID; i++) { ctx.moveTo(i * TILE, 0); ctx.lineTo(i * TILE, SIZE); ctx.moveTo(0, i * TILE); ctx.lineTo(SIZE, i * TILE); } ctx.stroke();
                obstacles.forEach(obs => { ctx.fillStyle = '#2a2d37'; ctx.fillRect(obs.x * TILE + 1, obs.y * TILE + 1, TILE - 2, TILE - 2); ctx.strokeStyle = '#3a3c4a'; ctx.strokeRect(obs.x * TILE + 1, obs.y * TILE + 1, TILE - 2, TILE - 2); });
                if (food) { ctx.fillStyle = '#e06c75'; ctx.beginPath(); ctx.arc(food.x * TILE + TILE/2, food.y * TILE + TILE/2, TILE/2 - 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.beginPath(); ctx.arc(food.x * TILE + TILE/2 - 2, food.y * TILE + TILE/2 - 2, 2, 0, Math.PI * 2); ctx.fill(); }
                if (!gameOver) {
                    let t = Math.min(1, (time - lastMove) / speed); let pts = [];
                    for (let i = 0; i < snake.length; i++) {
                        let curr = snake[i]; let prev = prevSnake[i] || prevSnake[prevSnake.length - 1] || curr;
                        let dx = curr.x - prev.x; let dy = curr.y - prev.y; let x, y;
                        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) { x = curr.x; y = curr.y; } else { x = prev.x + dx * t; y = prev.y + dy * t; }
                        pts.push({ x: x * TILE + TILE/2, y: y * TILE + TILE/2 });
                    }
                    const drawPath = () => {
                        ctx.beginPath();
                        if (pts.length === 1) { ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[0].x, pts[0].y); }
                        else if (pts.length === 2) { ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); }
                        else {
                            ctx.moveTo(pts[0].x, pts[0].y); let lastMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }; ctx.lineTo(lastMid.x, lastMid.y);
                            for (let i = 1; i < pts.length - 1; i++) {
                                let p1 = pts[i]; let p2 = pts[i+1]; let nextMid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
                                if (Math.hypot(p1.x - pts[i-1].x, p1.y - pts[i-1].y) > TILE * 2) ctx.moveTo(nextMid.x, nextMid.y);
                                else ctx.quadraticCurveTo(p1.x, p1.y, nextMid.x, nextMid.y);
                            }
                            let lastP = pts[pts.length - 1];
                            if (Math.hypot(lastP.x - pts[pts.length-2].x, lastP.y - pts[pts.length-2].y) > TILE * 2) ctx.moveTo(lastP.x, lastP.y);
                            else ctx.lineTo(lastP.x, lastP.y);
                        }
                    };
                    drawPath(); ctx.lineWidth = TILE - 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#4ade80'; ctx.stroke();
                    drawPath(); ctx.lineWidth = TILE - 10; ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.stroke();
                    if (pts.length > 0) {
                        let head = pts[0]; let angle = Math.atan2(dir.y, dir.x);
                        ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(angle);
                        ctx.fillStyle = '#4ade80'; ctx.beginPath(); ctx.ellipse(0, 0, TILE/2 + 1, TILE/2 - 1, 0, 0, Math.PI * 2); ctx.fill();
                        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(4, -4.5, 3.5, 0, Math.PI * 2); ctx.arc(4, 4.5, 3.5, 0, Math.PI * 2); ctx.fill();
                        ctx.fillStyle = '#16171d'; ctx.beginPath(); ctx.arc(5.5, -4.5, 1.5, 0, Math.PI * 2); ctx.arc(5.5, 4.5, 1.5, 0, Math.PI * 2); ctx.fill();
                        if (Math.floor(time / 150) % 2 === 0) { ctx.strokeStyle = '#ff4d4d'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(13, 0); ctx.lineTo(15, -2); ctx.moveTo(13, 0); ctx.lineTo(15, 2); ctx.stroke(); }
                        ctx.restore();
                    }
                }
                if (gameOver) {
                    ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(0, 0, SIZE, SIZE);
                    ctx.fillStyle = '#f3c969'; ctx.font = 'bold 26px "Nunito", sans-serif'; ctx.textAlign = 'center'; ctx.fillText('GAME OVER', SIZE / 2, SIZE / 2 - 10);
                    ctx.fillStyle = '#e9eaf0'; ctx.font = '14px "Nunito", sans-serif'; ctx.fillText('Пробел, R или клик — заново', SIZE / 2, SIZE / 2 + 25);
                }
            }
            function loop(time) { if (!canvas.isConnected) return; update(time); draw(time); animId = requestAnimationFrame(loop); }
            const onKeyDown = (e) => {
                if (win.style.display === 'none') return; if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault();
                if (e.code === 'Space' || e.code === 'KeyR') { initGame(); return; }
                if (e.code === 'ArrowUp' || e.code === 'KeyW') changeDir(0, -1); if (e.code === 'ArrowDown' || e.code === 'KeyS') changeDir(0, 1);
                if (e.code === 'ArrowLeft' || e.code === 'KeyA') changeDir(-1, 0); if (e.code === 'ArrowRight' || e.code === 'KeyD') changeDir(1, 0);
            };
            window.addEventListener('keydown', onKeyDown);
            canvas.addEventListener('click', () => { if (gameOver) initGame(); });
            initGame();
            return { onHide() { cancelAnimationFrame(animId); animId = null; }, onShow() { if (!gameOver && !animId) { lastMove = performance.now(); loop(performance.now()); } }, destroy() { cancelAnimationFrame(animId); window.removeEventListener('keydown', onKeyDown); } };
        }
    };

    // ============================================================
    // ИГРА: ПИНГ-ПОНГ (+ клик-рестарт)
    // ============================================================
    const Pong = {
        id: 'pong', name: 'Пинг-понг', icon: '🏓', ring: '#f3c969', category: 'solo',
        subtitle() { const diff = store.get('pong.diff', 'mid'); const diffName = diff === 'easy' ? 'Легко' : diff === 'mid' ? 'Средне' : 'Сложно'; const hi = store.get('pong.hi_' + diff, 0); return hi ? `рекорд (${diffName}): ${hi}` : 'понг-пинг'; },
        mount(root, api) {
            const W = 400, H = 300, PW = 8, PH = 60, BS = 10, WIN_SCORE = 7, FLASH_INSET = -10;
            const canvas = h('canvas', { width: W, height: H, style: 'background: #121319; border-radius: 12px; border: 2px solid #2a2d37; width: 100%; max-width: 400px; aspect-ratio: 4/3; margin: 0 auto; display: block; cursor: crosshair; touch-action: none;' });
            const ctx = canvas.getContext('2d');
            const playerScoreEl = h('div', { class: 'lcd', style: 'font-size: 20px; width: 50px; text-align: center; color: #f3c969;', text: '0' });
            const botScoreEl = h('div', { class: 'lcd', style: 'font-size: 20px; width: 50px; text-align: center; color: #ff6b6b;', text: '0' });
            const currentStreakEl = h('div', { class: 'lcd', style: 'font-size: 16px; width: 50px; text-align: center; color: #f3c969;', text: '0' });
            const bestStreakEl = h('div', { class: 'lcd', style: 'font-size: 16px; width: 50px; text-align: center; color: #59d98e;', text: '0' });
            const diffBtns = h('div', { style: 'display: flex; gap: 4px;' });
            const levels = [{ id: 'easy', label: 'Легко', speed: 3.0, err: 40 }, { id: 'mid', label: 'Средне', speed: 4.5, err: 15 }, { id: 'hard', label: 'Сложно', speed: 6.5, err: 0 }];
            let currentLevel = store.get('pong.diff', 'mid');
            levels.forEach(l => {
                const btn = h('button', { class: 'btn' + (currentLevel === l.id ? ' on' : ''), text: l.label, onclick: () => { currentLevel = l.id; store.set('pong.diff', currentLevel); diffBtns.querySelectorAll('.btn').forEach(b => b.classList.remove('on')); btn.classList.add('on'); initGame(); } });
                diffBtns.append(btn);
            });
            const btnPause = h('button', { class: 'btn', text: '⏸ Пауза', onclick: togglePause });
            const topBar = h('div', { style: 'display: flex; justify-content: center; align-items: center; gap: 15px; margin-bottom: 10px; flex-wrap: wrap;' },
                h('div', { style: 'display: flex; flex-direction: column; align-items: center;' }, h('div', { style: 'color: var(--muted); font-size: 11px; font-weight: 800; margin-bottom: 4px;' }, 'ВЫ'), playerScoreEl),
                h('div', { style: 'color: var(--muted); font-size: 20px; font-weight: 800;' }, ':'),
                h('div', { style: 'display: flex; flex-direction: column; align-items: center;' }, h('div', { style: 'color: var(--muted); font-size: 11px; font-weight: 800; margin-bottom: 4px;' }, 'БОТ'), botScoreEl),
                h('div', { style: 'display: flex; flex-direction: column; align-items: center; margin-left: 15px; border-left: 1px solid #3a3c4a; padding-left: 15px;' }, h('div', { style: 'color: var(--muted); font-size: 11px; font-weight: 800; margin-bottom: 4px;' }, 'СЕРИЯ'), currentStreakEl),
                h('div', { style: 'display: flex; flex-direction: column; align-items: center;' }, h('div', { style: 'color: var(--muted); font-size: 11px; font-weight: 800; margin-bottom: 4px;' }, 'РЕКОРД'), bestStreakEl)
            );
            const bottomBar = h('div', { style: 'display: flex; justify-content: center; gap: 10px; margin-top: 10px; align-items: center; flex-wrap: wrap;' }, h('span', { style: 'color: var(--muted); font-size: 12px; font-weight: 800;' }, 'СЛОЖНОСТЬ:'), diffBtns, btnPause);
            const hint = h('div', { class: 'ms-hint', text: 'Мышь по экрану · Стрелки ↑↓ / W S · P - Пауза · Пробел / R - Рестарт' });
            root.append(topBar, canvas, hint, bottomBar);
            let playerY, botY, ballX, ballY, ballVX, ballVY, playerScore, botScore; let gameOver, paused, animId; let lastTime; let currentStreak = 0; let bestStreak = 0; let useKeyboard = false; let particles = []; let countdown = 0; let isWaiting = false; let isStartCountdown = false; let flashX = 0; let flashY = 0; let flashLife = 0;
            function initGame() {
                playerY = H / 2 - PH / 2; botY = H / 2 - PH / 2; playerScore = 0; botScore = 0; gameOver = false; paused = false; particles = []; flashLife = 0; btnPause.textContent = '⏸ Пауза';
                currentStreak = 0; bestStreak = store.get('pong.hi_' + currentLevel, 0); updateUI(); startSession('pong_' + currentLevel); startRound(true); if (animId) cancelAnimationFrame(animId); lastTime = performance.now(); loop(performance.now());
            }
            function startRound(isStart) { isWaiting = true; isStartCountdown = isStart; countdown = isStart ? 3000 : 800; ballX = W / 2 - BS / 2; ballY = H / 2 - BS / 2; ballVX = 0; ballVY = 0; }
            function togglePause() {
                if (gameOver) return; paused = !paused; btnPause.textContent = paused ? '▶ Продолжить' : '⏸ Пауза';
                if (!paused) { lastTime = performance.now(); if (!animId) loop(lastTime); } else { cancelAnimationFrame(animId); animId = null; draw(); }
            }
            function updateUI() { playerScoreEl.textContent = playerScore; botScoreEl.textContent = botScore; currentStreakEl.textContent = currentStreak; bestStreakEl.textContent = bestStreak; }
            function spawnParticles(x, y, color, dir) { for (let i = 0; i < 12; i++) { particles.push({ x: x, y: y, vx: (Math.random() * 4 + 2) * dir, vy: (Math.random() - 0.5) * 8, life: 1, color: color, size: Math.random() * 3 + 1 }); } }
            function update(dt, time) {
                if (gameOver || paused) return;
                for (let i = particles.length - 1; i >= 0; i--) { let p = particles[i]; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= 0.05 * dt; if (p.life <= 0) particles.splice(i, 1); }
                if (flashLife > 0) flashLife -= 0.05 * dt;
                if (isWaiting) { countdown -= dt * 16.66; if (countdown <= 0) { isWaiting = false; const dirX = Math.random() > 0.5 ? 1 : -1; const dirY = Math.random() > 0.5 ? 1 : -1; ballVX = 4 * dirX; ballVY = 4 * dirY * (Math.random() * 0.5 + 0.5); } return; }
                ballX += ballVX * dt; ballY += ballVY * dt;
                if (ballY <= 0) { ballY = 0; ballVY *= -1; } else if (ballY + BS >= H) { ballY = H - BS; ballVY *= -1; }
                playerY = Math.max(0, Math.min(H - PH, playerY));
                const levelData = levels.find(l => l.id === currentLevel); const botSpeed = levelData.speed; let botTarget = ballY - PH / 2 + (Math.random() - 0.5) * levelData.err;
                if (botY < botTarget) botY = Math.min(botTarget, botY + botSpeed * dt); if (botY > botTarget) botY = Math.max(botTarget, botY - botSpeed * dt); botY = Math.max(0, Math.min(H - PH, botY));
                if (ballVX < 0 && ballX <= PW && ballX + BS >= 0) {
                    if (ballY + BS >= playerY && ballY <= playerY + PH) { ballX = PW; ballVX *= -1.1; const hitPos = (ballY + BS / 2 - playerY) / PH; ballVY = (hitPos - 0.5) * 10; spawnParticles(PW, ballY + BS/2, '#f3c969', 1); if (navigator.vibrate) { try { navigator.vibrate(20); } catch(e){} } }
                }
                if (ballVX > 0 && ballX + BS >= W - PW) {
                    if (ballY + BS >= botY && ballY <= botY + PH) { ballX = W - PW - BS; ballVX *= -1.1; const hitPos = (ballY + BS / 2 - botY) / PH; ballVY = (hitPos - 0.5) * 10; spawnParticles(W - PW, ballY + BS/2, '#ff6b6b', -1); }
                }
                ballVX = Math.max(-15, Math.min(15, ballVX)); ballVY = Math.max(-12, Math.min(12, ballVY));
                if (ballX < 0) { botScore++; flashX = FLASH_INSET; flashY = ballY + BS/2; flashLife = 1; updateUI(); checkWin(); if (!gameOver) startRound(false); }
                else if (ballX > W) { playerScore++; flashX = W - FLASH_INSET; flashY = ballY + BS/2; flashLife = 1; updateUI(); checkWin(); if (!gameOver) startRound(false); }
            }
            function checkWin() {
                if (playerScore >= WIN_SCORE) {
                    gameOver = true; currentStreak++; if (currentStreak > bestStreak) { bestStreak = currentStreak; store.set('pong.hi_' + currentLevel, bestStreak); api.refreshCards(); }
                    api.submitScore(currentStreak, 'pong_' + currentLevel);
                    updateUI();
                } else if (botScore >= WIN_SCORE) { gameOver = true; currentStreak = 0; updateUI(); }
            }
            function draw() {
                ctx.fillStyle = '#121319'; ctx.fillRect(0, 0, W, H);
                if (flashLife > 0) {
                    let gradient = ctx.createRadialGradient(flashX, flashY, 0, flashX, flashY, 120);
                    gradient.addColorStop(0, `rgba(255, 50, 50, ${flashLife})`); gradient.addColorStop(0.4, `rgba(255, 50, 50, ${flashLife * 0.4})`); gradient.addColorStop(1, 'rgba(255, 50, 50, 0)');
                    ctx.fillStyle = gradient; ctx.fillRect(0, 0, W, H); ctx.fillStyle = `rgba(255, 255, 255, ${flashLife})`; ctx.beginPath(); ctx.arc(flashX, flashY, 4, 0, Math.PI * 2); ctx.fill();
                }
                ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 2; ctx.setLineDash([10, 10]); ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.setLineDash([]);
                ctx.fillStyle = '#f3c969'; ctx.shadowColor = '#f3c969'; ctx.shadowBlur = 10; ctx.fillRect(0, playerY, PW, PH);
                ctx.fillStyle = '#ff6b6b'; ctx.shadowColor = '#ff6b6b'; ctx.shadowBlur = 10; ctx.fillRect(W - PW, botY, PW, PH);
                if (!isWaiting) { ctx.fillStyle = '#ffffff'; ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 15; ctx.beginPath(); ctx.arc(ballX + BS / 2, ballY + BS / 2, BS / 2, 0, Math.PI * 2); ctx.fill(); }
                ctx.shadowBlur = 0; for (let p of particles) { ctx.fillStyle = p.color; ctx.globalAlpha = p.life; ctx.fillRect(p.x, p.y, p.size, p.size); } ctx.globalAlpha = 1;
                if (isWaiting && !paused && !gameOver) {
                    if (isStartCountdown) { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#ffffff'; ctx.font = 'bold 50px "Nunito", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; let num = Math.ceil(countdown / 1000); ctx.fillText(num > 0 ? num : 'GO!', W / 2, H / 2); }
                }
                if (gameOver || paused) {
                    ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = gameOver ? (playerScore >= WIN_SCORE ? '#f3c969' : '#ff6b6b') : '#e9eaf0'; ctx.font = 'bold 28px "Nunito", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
                    if (gameOver) { ctx.fillText(playerScore >= WIN_SCORE ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ', W / 2, H / 2 - 20); ctx.fillStyle = '#e9eaf0'; ctx.font = '14px "Nunito", sans-serif'; ctx.fillText(playerScore >= WIN_SCORE ? `Серия: ${currentStreak}` : 'Серия сброшена', W / 2, H / 2 + 5); ctx.fillText('Пробел, R или клик — заново', W / 2, H / 2 + 30); }
                    else { ctx.fillText('ПАУЗА', W / 2, H / 2 - 10); ctx.fillStyle = '#e9eaf0'; ctx.font = '14px "Nunito", sans-serif'; ctx.fillText('Нажмите P для продолжения', W / 2, H / 2 + 25); }
                }
            }
            function loop(time) { if (!canvas.isConnected) return; const dt = Math.min(2, (time - lastTime) / 16.66); lastTime = time; update(dt, time); draw(); animId = requestAnimationFrame(loop); }
            const handleGlobalMouse = (e) => { if (gameOver || paused || win.style.display === 'none') return; useKeyboard = false; const rect = canvas.getBoundingClientRect(); const relativeY = (e.clientY - rect.top) / rect.height; playerY = (relativeY * H) - (PH / 2); };
            const handleTouch = (e) => { if (gameOver || paused) return; useKeyboard = false; const rect = canvas.getBoundingClientRect(); let clientY = e.touches[0].clientY; const y = (clientY - rect.top) * (H / rect.height); playerY = y - PH / 2; if (e.cancelable) e.preventDefault(); };
            window.addEventListener('mousemove', handleGlobalMouse); canvas.addEventListener('touchmove', handleTouch, { passive: false });
            const onKeyDown = (e) => {
                if (win.style.display === 'none') return;
                const isUp = e.code === 'ArrowUp' || e.code === 'KeyW'; const isDown = e.code === 'ArrowDown' || e.code === 'KeyS'; const isPause = e.code === 'KeyP'; const isRestart = e.code === 'Space' || e.code === 'KeyR';
                if (isUp || isDown || isRestart || isPause) e.preventDefault();
                if (isRestart) { initGame(); return; } if (isPause) { togglePause(); return; }
                if (isUp) { useKeyboard = true; playerY -= 30; } if (isDown) { useKeyboard = true; playerY += 30; }
            };
            window.addEventListener('keydown', onKeyDown);
            canvas.addEventListener('click', () => { if (gameOver) initGame(); });
            initGame();
            return { onHide() { cancelAnimationFrame(animId); animId = null; window.removeEventListener('mousemove', handleGlobalMouse); }, onShow() { window.addEventListener('mousemove', handleGlobalMouse); if (!gameOver && !paused && !animId) { lastTime = performance.now(); loop(performance.now()); } }, destroy() { cancelAnimationFrame(animId); window.removeEventListener('keydown', onKeyDown); window.removeEventListener('mousemove', handleGlobalMouse); canvas.removeEventListener('touchmove', handleTouch); } };
        }
    };

    // ============================================================
    // ИГРА: ШАШКИ ОНЛАЙН
    // ============================================================
    const OnlineCheckers = {
        id: 'checkers-mp', name: 'Шашки Онлайн', icon: '🌐', ring: '#59d98e', category: 'multi',
        subtitle() { return 'поиск соперника'; },
        mount(root, api) {
            let matchId = null, myColor = null, currentMatch = null;
            let selectedSquare = null, validMoves = [], isProcessing = false;
            let statusPollTimer = null, matchPollTimer = null, waitInterval = null;
            let searchGen = 0;

            const lobbyEl = h('div', { class: 'mp-lobby', style: 'text-align: center; min-height: 200px; justify-content: center;' });
            const gameEl  = h('div', { style: 'display: none; flex-direction: column; align-items: center;' });
            root.append(lobbyEl, gameEl);
            const statusEl = h('div', { class: 'ch-status', text: 'Синхронизация…' });
            const boardEl  = h('div', { class: 'ch-board' });
            const hintEl   = h('div', { class: 'ms-hint' });
            const exitBtn  = h('button', { class: 'btn', text: 'Выйти (Сдаться)', style: 'margin-top: 15px; color: #ff6b6b; border-color: #ff6b6b;' });
            gameEl.append(statusEl, h('div', { class: 'ch-wrap' }, boardEl), hintEl, exitBtn);
            const cs = Math.max(34, Math.min(58, Math.floor((Math.min(root.clientWidth || 520, 520) - 24) / 8)));
            boardEl.style.setProperty('--sq', cs + 'px');
            const sqEls = [];
            for (let v = 0; v < 64; v++) { const el = h('button', { class: 'sq', type: 'button', 'data-v': v }); sqEls.push(el); boardEl.append(el); }

            function stopAllTimers() { clearInterval(statusPollTimer); statusPollTimer = null; clearInterval(matchPollTimer); matchPollTimer = null; clearInterval(waitInterval); waitInterval = null; }

            function showLobby() {
                searchGen++;
                matchId = null; myColor = null; currentMatch = null; selectedSquare = null; validMoves = []; isProcessing = false; stopAllTimers();
                exitBtn.textContent = 'Выйти (Сдаться)'; exitBtn.style.color = '#ff6b6b'; exitBtn.style.borderColor = '#ff6b6b'; exitBtn.disabled = false;
                lobbyEl.style.display = 'flex'; gameEl.style.display = 'none'; lobbyEl.innerHTML = '';
                lobbyEl.append(
                    h('h3', { text: 'Онлайн Шашки', style: 'margin: 0 0 10px 0; color: var(--gold); font-size: 20px;' }),
                    h('button', { class: 'btn on', text: '🔍 Найти соперника', onclick: findMatch, style: 'font-size: 16px; padding: 12px 24px;' }),
                    h('div', { style: 'margin-top: 15px; color: var(--muted); font-size: 12px;' }, 'Если соперник не найдётся за 30 секунд, поиск отменится.')
                );
            }

            async function findMatch() {
                const myGen = ++searchGen;
                const timerEl = h('div', { style: 'font-size: 32px; font-weight: 800; color: #59d98e; margin: 20px 0;', text: '0' });
                lobbyEl.innerHTML = '';
                lobbyEl.append(
                    h('h3', { style: 'color: var(--gold); margin: 0 0 10px 0;', text: 'Поиск соперника…' }),
                    timerEl, h('div', { style: 'color: var(--muted);', text: 'секунд' }),
                    h('button', { class: 'btn', text: 'Отменить', style: 'margin-top: 15px;', onclick: () => showLobby() })
                );
                let sec = 0; waitInterval = setInterval(() => { sec++; timerEl.textContent = sec; }, 1000);

                const res = await serverRequest('/api/checkers/find-match', {
                    method: 'POST', body: JSON.stringify({ nickname: getPlayerName() })
                });
                if (myGen !== searchGen) return;
                if (!res.success) { clearInterval(waitInterval); waitInterval = null; alert('Ошибка сервера: ' + (res.error || 'неизвестная')); showLobby(); return; }
                if (res.matchId) { clearInterval(waitInterval); waitInterval = null; startGame(res.matchId); }
                else { if (!statusPollTimer) statusPollTimer = setInterval(checkStatus, 1500); }
            }

            async function checkStatus() {
                const myGen = searchGen;
                const res = await serverRequest('/api/checkers/status');
                if (myGen !== searchGen) return;
                if (!res.success) return;
                if (res.matchId) { clearInterval(statusPollTimer); statusPollTimer = null; clearInterval(waitInterval); waitInterval = null; startGame(res.matchId); }
                else if (res.status === 'timeout') { clearInterval(statusPollTimer); statusPollTimer = null; clearInterval(waitInterval); waitInterval = null; alert('Соперник не найден за 30 секунд.'); showLobby(); }
            }

            function startGame(id) {
                matchId = id; myColor = null; currentMatch = null; selectedSquare = null; validMoves = []; isProcessing = false;
                lobbyEl.style.display = 'none'; gameEl.style.display = 'flex'; stopAllTimers(); matchPollTimer = setInterval(pollMatch, 1500); pollMatch();
            }

            async function pollMatch() {
                if (!matchId) return;
                const res = await serverRequest(`/api/checkers/match/${matchId}`);
                if (!res || !res.success || !res.match) { showLobby(); return; }
                currentMatch = res.match;
                if (!myColor) { const me = currentMatch.players.find(p => p.id === playerId); if (me) myColor = me.color; }
                if (currentMatch.status === 'playing' && currentMatch.gameState.turn !== myColor) { selectedSquare = null; validMoves = []; }
                renderBoard();
            }

            function renderBoard() {
                if (!currentMatch) return;
                const pos = currentMatch.gameState; const flipped = myColor === 'b'; const toIdx = (v) => (flipped ? 63 - v : v);
                for (let v = 0; v < 64; v++) {
                    const i = toIdx(v), p = pos.b[i], r = i >> 3, c = i & 7, el = sqEls[v];
                    let cls = 'sq'; if ((r + c) & 1) cls += ' d'; if (selectedSquare === i) cls += ' sel';
                    const targetMove = validMoves.find(m => m.to === i); if (targetMove) cls += ' tgt' + (targetMove.captures.length > 0 ? ' cap' : '');
                    el.className = cls;
                    if (p) {
                        const isW = (p === 'w' || p === 'W'); el.textContent = (p === 'W' || p === 'B') ? '♛' : '●';
                        el.style.color = isW ? '#f0e6d2' : '#1a1a1a'; el.style.textShadow = isW ? '0 0 1px #000, 0 0 2px rgba(0,0,0,0.8)' : '0 0 1px #fff, 0 0 2px rgba(255,255,255,0.6)';
                    } else { el.textContent = ''; el.style.color = ''; el.style.textShadow = ''; }
                }
                if (currentMatch.status === 'finished') {
                    const isWin = currentMatch.winner === playerId; const isDraw = !currentMatch.winner;
                    const reasonText = { 'surrender': ' (соперник сдался)', 'disconnect': ' (соперник отключился)', 'no-moves': ' (у соперника нет ходов)', 'draw-15': ' (ничья по правилу 15 ходов)', 'draw-repeat': ' (ничья: троекратное повторение)' }[currentMatch.endReason] || '';
                    if (isDraw) { statusEl.textContent = '🤝 Ничья' + reasonText; statusEl.style.color = 'var(--muted)'; }
                    else { statusEl.textContent = (isWin ? '🏆 Вы победили!' : '😿 Вы проиграли') + reasonText; statusEl.style.color = isWin ? '#59d98e' : '#ff6b6b'; }
                    hintEl.textContent = 'Игра окончена.';
                    exitBtn.textContent = '← В лобби'; exitBtn.style.color = 'var(--text)'; exitBtn.style.borderColor = 'var(--line)';
                    clearInterval(matchPollTimer); matchPollTimer = null; return;
                }
                const turnColor = currentMatch.gameState.turn;
                if (turnColor === myColor) { statusEl.textContent = '🟢 Ваш ход!'; hintEl.textContent = selectedSquare === null ? 'Нажмите на свою шашку' : (validMoves.length ? 'Выберите куда пойти' : 'У этой шашки нет ходов'); }
                else { statusEl.textContent = '⏳ Ход соперника…'; hintEl.textContent = 'Ожидание…'; }
                statusEl.style.color = 'var(--gold)';
            }

            async function handleSquareClick(v) {
                if (!currentMatch || currentMatch.status !== 'playing' || isProcessing) return;
                if (currentMatch.gameState.turn !== myColor) return;
                const idx = (myColor === 'b') ? 63 - v : v;
                const pos = currentMatch.gameState; const p = pos.b[idx];
                const isMyPiece = (myColor === 'w' && (p === 'w' || p === 'W')) || (myColor === 'b' && (p === 'b' || p === 'B'));
                if (isMyPiece) { selectedSquare = idx; validMoves = CK.legal(pos).filter(m => m.from === idx); renderBoard(); return; }
                if (selectedSquare !== null) {
                    const from = selectedSquare; const move = validMoves.find(m => m.to === idx);
                    if (!move) { selectedSquare = null; validMoves = []; renderBoard(); return; }
                    isProcessing = true;
                    const res = await serverRequest(`/api/checkers/match/${matchId}/move`, {
                        method: 'POST', body: JSON.stringify({ move: { from, to: idx } })
                    });
                    selectedSquare = null; validMoves = [];
                    if (!res.success) { alert(res.error || 'Нелегальный ход'); isProcessing = false; renderBoard(); return; }
                    currentMatch = res.match; renderBoard(); isProcessing = false;
                }
            }

            boardEl.addEventListener('click', (e) => { const t = e.target.closest('.sq'); if (t) handleSquareClick(Number(t.dataset.v)); });
            exitBtn.addEventListener('click', async () => {
                if (currentMatch && currentMatch.status === 'finished') { showLobby(); return; }
                if (!matchId) { showLobby(); return; }
                if (!confirm('Сдаться? Это засчитается как поражение.')) return;
                exitBtn.disabled = true; exitBtn.textContent = 'Отправка…';
                try { await serverRequest(`/api/checkers/match/${matchId}/surrender`, { method: 'POST', body: '{}' }); } catch (_) {}
                showLobby();
            });

            showLobby();
            return {
                destroy() { stopAllTimers(); },
                onHide() {
                    if (!matchId && (statusPollTimer || waitInterval)) {
                        serverRequest('/api/checkers/cancel', { method: 'POST', body: '{}' });
                        showLobby();
                    }
                }
            };
        }
    };

    // ============================================================
    // ИГРА: ШАХМАТЫ ОНЛАЙН
    // ============================================================
        const OnlineChess = {
        id: 'chess-mp', name: 'Шахматы Онлайн', icon: '🌐', ring: '#b9a6e0', category: 'multi',
        subtitle() { return 'поиск соперника'; },
        mount(root, api) {
            let matchId = null, myColor = null, currentMatch = null;
            let selectedSquare = null, validMoves = [], isProcessing = false;
            let statusPollTimer = null, matchPollTimer = null, waitInterval = null;
            let promoMoves = [];

            const lobbyEl = h('div', { class: 'mp-lobby', style: 'text-align: center; min-height: 200px; justify-content: center;' });
            const gameEl  = h('div', { style: 'display: none; flex-direction: column; align-items: center;' });
            root.append(lobbyEl, gameEl);
            const statusEl = h('div', { class: 'ch-status', text: 'Синхронизация…' });
            const boardEl  = h('div', { class: 'ch-board' });
            const promoEl  = h('div', { class: 'ch-promo' });
            const hintEl   = h('div', { class: 'ms-hint' });
            const exitBtn  = h('button', { class: 'btn', text: 'Выйти (Сдаться)', style: 'margin-top: 15px; color: #ff6b6b; border-color: #ff6b6b;' });
            gameEl.append(statusEl, h('div', { class: 'ch-wrap' }, boardEl), promoEl, hintEl, exitBtn);
            const cs = Math.max(34, Math.min(58, Math.floor((Math.min(root.clientWidth || 520, 520) - 24) / 8)));
            boardEl.style.setProperty('--sq', cs + 'px');
            const sqEls = [];
            for (let v = 0; v < 64; v++) { const el = h('button', { class: 'sq', type: 'button', 'data-v': v }); sqEls.push(el); boardEl.append(el); }

            function stopAllTimers() { clearInterval(statusPollTimer); statusPollTimer = null; clearInterval(matchPollTimer); matchPollTimer = null; clearInterval(waitInterval); waitInterval = null; }

            function showLobby() {
                matchId = null; myColor = null; currentMatch = null; selectedSquare = null; validMoves = []; isProcessing = false; promoMoves = []; promoEl.textContent = ''; stopAllTimers();
                exitBtn.textContent = 'Выйти (Сдаться)'; exitBtn.style.color = '#ff6b6b'; exitBtn.style.borderColor = '#ff6b6b'; exitBtn.disabled = false;
                lobbyEl.style.display = 'flex'; gameEl.style.display = 'none'; lobbyEl.innerHTML = '';
                lobbyEl.append(
                    h('h3', { text: 'Онлайн Шахматы', style: 'margin: 0 0 10px 0; color: var(--gold); font-size: 20px;' }),
                    h('button', { class: 'btn on', text: '🔍 Найти соперника', onclick: findMatch, style: 'font-size: 16px; padding: 12px 24px;' }),
                    h('div', { style: 'margin-top: 15px; color: var(--muted); font-size: 12px;' }, 'Если соперник не найдётся за 30 секунд, поиск отменится.')
                );
            }

            async function findMatch() {
                const timerEl = h('div', { style: 'font-size: 32px; font-weight: 800; color: #59d98e; margin: 20px 0;', text: '0' });
                lobbyEl.innerHTML = '';
                lobbyEl.append(
                    h('h3', { style: 'color: var(--gold); margin: 0 0 10px 0;', text: 'Поиск соперника…' }),
                    timerEl, h('div', { style: 'color: var(--muted);', text: 'секунд' }),
                    h('button', { class: 'btn', text: 'Отменить', style: 'margin-top: 15px;', onclick: () => showLobby() })
                );
                let sec = 0; waitInterval = setInterval(() => { sec++; timerEl.textContent = sec; }, 1000);

                const res = await serverRequest('/api/chess/find-match', {
                    method: 'POST', body: JSON.stringify({ nickname: getPlayerName() })
                });
                if (!res.success) { clearInterval(waitInterval); waitInterval = null; alert('Ошибка сервера: ' + (res.error || 'неизвестная')); showLobby(); return; }
                if (res.matchId) { clearInterval(waitInterval); waitInterval = null; startGame(res.matchId); }
                else { if (!statusPollTimer) statusPollTimer = setInterval(checkStatus, 1500); }
            }

            async function checkStatus() {
                const res = await serverRequest('/api/chess/status');
                if (!res.success) return;
                if (res.matchId) { clearInterval(statusPollTimer); statusPollTimer = null; clearInterval(waitInterval); waitInterval = null; startGame(res.matchId); }
                else if (res.status === 'timeout') { clearInterval(statusPollTimer); statusPollTimer = null; clearInterval(waitInterval); waitInterval = null; alert('Соперник не найден за 30 секунд.'); showLobby(); }
            }

            function startGame(id) {
                matchId = id; myColor = null; currentMatch = null; selectedSquare = null; validMoves = []; isProcessing = false; promoMoves = []; promoEl.textContent = '';
                lobbyEl.style.display = 'none'; gameEl.style.display = 'flex'; stopAllTimers(); matchPollTimer = setInterval(pollMatch, 1500); pollMatch();
            }

            async function pollMatch() {
                if (!matchId) return;
                const res = await serverRequest(`/api/chess/match/${matchId}`);
                if (!res || !res.success || !res.match) { showLobby(); return; }
                currentMatch = res.match;
                if (!myColor) { const me = currentMatch.players.find(p => p.id === playerId); if (me) myColor = me.color; }
                if (currentMatch.status === 'playing' && currentMatch.gameState.turn !== myColor) { selectedSquare = null; validMoves = []; promoMoves = []; promoEl.textContent = ''; }
                // Рекорд пишет сервер при завершении матча.
                renderBoard();
            }

            function renderBoard() {
                if (!currentMatch) return;
                const pos = currentMatch.gameState;
                const flipped = myColor === 'b';
                const toIdx = (v) => (flipped ? 63 - v : v);
                const inChk = CH.inCheck(pos, pos.turn);
                const chkSq = inChk ? pos.b.indexOf(pos.turn === 'w' ? 'K' : 'k') : -1;
                for (let v = 0; v < 64; v++) {
                    const i = toIdx(v), p = pos.b[i], r = i >> 3, c = i & 7, el = sqEls[v];
                    let cls = 'sq'; if ((r + c) & 1) cls += ' d'; if (selectedSquare === i) cls += ' sel';
                    if (i === chkSq) cls += ' chk';
                    const targetMove = validMoves.find(m => m.to === i);
                    if (targetMove) cls += ' tgt' + (p ? ' cap' : '');
                    el.className = cls;
                    if (p) {
                        el.textContent = GLYPH[p.toLowerCase()];
                        const isW = p === p.toUpperCase();
                        el.style.color = isW ? '#f0e6d2' : '#1a1a1a';
                        el.style.textShadow = isW ? '0 0 1px #000, 0 0 2px rgba(0,0,0,0.8)' : '0 0 1px #fff, 0 0 2px rgba(255,255,255,0.6)';
                    } else { el.textContent = ''; el.style.color = ''; el.style.textShadow = ''; }
                }
                if (currentMatch.status === 'finished') {
                    const isWin = currentMatch.winner === playerId;
                    const isDraw = !currentMatch.winner;
                    const reasonText = { 'checkmate': ' (мат)', 'surrender': ' (соперник сдался)', 'disconnect': ' (соперник отключился)', 'stalemate': ' (пат)', 'material': ' (недостаточно материала)', 'fifty': ' (правило 50 ходов)', 'repeat': ' (троекратное повторение)' }[currentMatch.endReason] || '';
                    if (isDraw) { statusEl.textContent = '🤝 Ничья' + reasonText; statusEl.style.color = 'var(--muted)'; }
                    else { statusEl.textContent = (isWin ? '🏆 Вы победили!' : '😿 Вы проиграли') + reasonText; statusEl.style.color = isWin ? '#59d98e' : '#ff6b6b'; }
                    hintEl.textContent = 'Игра окончена.';
                    exitBtn.textContent = '← В лобби'; exitBtn.style.color = 'var(--text)'; exitBtn.style.borderColor = 'var(--line)';
                    clearInterval(matchPollTimer); matchPollTimer = null;
                    return;
                }
                const turnColor = currentMatch.gameState.turn;
                if (turnColor === myColor) {
                    statusEl.textContent = '🟢 Ваш ход' + (inChk ? ' · Шах!' : '');
                    hintEl.textContent = selectedSquare === null ? 'Нажмите на свою фигуру' : (validMoves.length ? 'Выберите куда пойти' : 'У этой фигуры нет ходов');
                }
                else {
                    statusEl.textContent = '⏳ Ход соперника…' + (inChk ? ' Шах!' : '');
                    hintEl.textContent = 'Ожидание…';
                }
                statusEl.style.color = 'var(--gold)';
            }

            async function handleSquareClick(v) {
                if (promoMoves.length > 0) return;
                if (!currentMatch || currentMatch.status !== 'playing' || isProcessing) return;
                if (currentMatch.gameState.turn !== myColor) return;
                const idx = (myColor === 'b') ? 63 - v : v;
                const pos = currentMatch.gameState;
                const p = pos.b[idx];
                const isMyPiece = p && ((myColor === 'w' && p === p.toUpperCase()) || (myColor === 'b' && p === p.toLowerCase()));
                if (isMyPiece) { selectedSquare = idx; validMoves = CH.legal(pos).filter(m => m.from === idx); renderBoard(); return; }
                if (selectedSquare !== null) {
                    const from = selectedSquare;
                    const movesToTarget = validMoves.filter(m => m.to === idx);
                    if (movesToTarget.length === 0) { selectedSquare = null; validMoves = []; renderBoard(); return; }
                    if (movesToTarget.length === 1) { makeMove(movesToTarget[0]); }
                    else { promoMoves = movesToTarget; showPromo(); }
                }
            }

            async function makeMove(move) {
                isProcessing = true;
                selectedSquare = null; validMoves = []; promoMoves = []; promoEl.textContent = '';
                const res = await serverRequest(`/api/chess/match/${matchId}/move`, {
                    method: 'POST', body: JSON.stringify({ move: { from: move.from, to: move.to, promo: move.promo } })
                });
                if (!res.success) { alert(res.error || 'Нелегальный ход'); isProcessing = false; renderBoard(); return; }
                currentMatch = res.match; renderBoard(); isProcessing = false;
            }

            function showPromo() {
                promoEl.innerHTML = '';
                promoEl.append(h('span', { class: 'sub', text: 'Выберите фигуру:' }));
                for (const t of ['q', 'r', 'b', 'n']) {
                    const move = promoMoves.find(m => m.promo === t);
                    if (!move) continue;
                    promoEl.append(h('button', { class: 'btn promo-btn', type: 'button', text: GLYPH[t], onclick: () => makeMove(move) }));
                }
                promoEl.append(h('button', { class: 'btn', text: 'Отмена', onclick: () => { promoMoves = []; promoEl.textContent = ''; renderBoard(); } }));
            }

            boardEl.addEventListener('click', (e) => { const t = e.target.closest('.sq'); if (t) handleSquareClick(Number(t.dataset.v)); });
            exitBtn.addEventListener('click', async () => {
                if (currentMatch && currentMatch.status === 'finished') { showLobby(); return; }
                if (!matchId) { showLobby(); return; }
                if (!confirm('Сдаться? Это засчитается как поражение.')) return;
                exitBtn.disabled = true; exitBtn.textContent = 'Отправка…';
                try { await serverRequest(`/api/chess/match/${matchId}/surrender`, { method: 'POST', body: '{}' }); } catch (_) {}
                showLobby();
            });

            showLobby(); return { destroy() { stopAllTimers(); } };
        }
    };

    // ============================================================
    // Утилита форматирования чисел для кликера
    // ============================================================
    function cowFmtNum(n) {
        if (!n || n < 1000) return Math.floor(n || 0).toString();
        const suffixes = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
        let tier = Math.floor(Math.log10(n) / 3);
        if (tier >= suffixes.length) tier = suffixes.length - 1;
        const scaled = n / Math.pow(10, tier * 3);
        return scaled.toFixed(scaled < 100 ? 2 : 1) + suffixes[tier];
    }

// ============================================================
// ИГРА: МОЛОЧНАЯ ФЕРМА (кликер)
// ============================================================
const CowClicker = {
    id: 'cowclicker',
    name: 'Молочная ферма',
    icon: '🐄',
    ring: '#e8b05c',
    category: 'solo',
    subtitle() {
        const s = store.get('cow.state', null);
        if (!s) return 'кликер · коровы ждут';
        const p = s.prestigeLevel || 0;
        return cowFmtNum(s.totalMilk || 0) + ' 🥛' + (p > 0 ? ' · ⭐' + p : '');
    },
    mount(root, api) {
        let state = {
            milk: 0, totalMilk: 0, clickUps: {}, buildings: {}, multipliers: {},
            prestigeLevel: 0
        };

        let pendingClicks = 0;
        let clickTimeout = null;
        let isSyncing = false;
        let buyMode = store.get('cow.buyMode', 1); // 1, 10, 100, 'max'

        const CSS = `
        .cow-game { display: flex; flex-direction: column; gap: 10px; padding: 10px; color: #f0e6d2; font-family: var(--font); max-width: 100%; position: relative; }
        .cow-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: rgba(0,0,0,0.35); border-radius: 12px; border: 1px solid rgba(243,201,105,0.25); }
        .cow-milk-count { font-size: 24px; font-weight: 800; color: #f3c969; line-height: 1.1; }
        .cow-mps { font-size: 12px; color: #b8a082; font-weight: 700; margin-top: 2px; }
        .cow-stage { position: relative; display: flex; justify-content: center; align-items: center; min-height: 220px; padding: 10px; background: radial-gradient(ellipse at center, rgba(243,201,105,0.12) 0%, transparent 65%); border-radius: 12px; overflow: hidden; }
        .cow-btn { background: none; border: none; font-size: 110px; line-height: 1; cursor: pointer; user-select: none; padding: 8px 16px; transition: transform 0.08s; filter: drop-shadow(0 6px 14px rgba(0,0,0,0.55)); }
        .cow-btn:active { transform: scale(0.94); }
        .cow-btn.clicked { animation: cow-pop 0.18s ease-out; }
        @keyframes cow-pop { 0%{transform:scale(1)} 40%{transform:scale(1.12)} 100%{transform:scale(1)} }
        .cow-float { position: absolute; pointer-events: none; font-weight: 900; font-size: 20px; color: #f3c969; text-shadow: 0 2px 6px rgba(0,0,0,0.9); animation: cow-float-up 1s ease-out forwards; z-index: 5; }
        @keyframes cow-float-up { 0%{opacity:1;transform:translate(-50%,-50%)} 100%{opacity:0;transform:translate(-50%,-150%)} }
        .cow-tabs { display: flex; gap: 4px; padding: 4px; background: rgba(0,0,0,0.35); border-radius: 10px; flex-wrap: wrap; }
        .cow-tab { flex: 1; min-width: 60px; padding: 8px 6px; background: transparent; border: 1px solid transparent; border-radius: 8px; color: #b8a082; font-weight: 700; font-size: 12px; cursor: pointer; font-family: inherit; }
        .cow-tab:hover { color: #f3c969; }
        .cow-tab.on { background: rgba(243,201,105,0.18); color: #f3c969; border-color: rgba(243,201,105,0.45); }
        .cow-content { max-height: 300px; overflow-y: auto; padding-right: 2px; scrollbar-width: thin; scrollbar-color: #5a4a2f transparent; }
        .cow-content::-webkit-scrollbar { width: 6px; }
        .cow-content::-webkit-scrollbar-thumb { background: #5a4a2f; border-radius: 4px; }
        .cow-buy-mode { display: flex; gap: 4px; margin-bottom: 8px; position: sticky; top: 0; background: #1b1c23; padding: 4px 0; z-index: 2; }
        .cow-buy-mode .cow-tab { padding: 4px 10px; font-size: 11px; flex: 0 0 auto; }
        .cow-up { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 6px; background: rgba(255,255,255,0.03); border: 1px solid rgba(243,201,105,0.16); border-radius: 10px; cursor: pointer; transition: background 0.12s, border-color 0.12s, opacity 0.2s; width: 100%; text-align: left; font-family: inherit; color: inherit; }
        .cow-up:hover:not(.locked):not(.owned) { background: rgba(243,201,105,0.1); border-color: rgba(243,201,105,0.45); }
        .cow-up.locked { opacity: 0.42; }
        .cow-up.owned { opacity: 0.6; cursor: default; }
        .cow-up-icon { font-size: 26px; width: 38px; text-align: center; flex: none; }
        .cow-up-info { flex: 1; min-width: 0; }
        .cow-up-name { font-weight: 800; font-size: 14px; color: #f0e6d2; }
        .cow-up-desc { font-size: 11px; color: #a89070; margin-top: 2px; }
        .cow-up-right { text-align: right; flex: none; }
        .cow-up-price { font-weight: 800; color: #f3c969; font-size: 14px; white-space: nowrap; }
        .cow-up.locked .cow-up-price { color: #8a7a5a; }
        .cow-up-count { font-size: 11px; color: #a89070; margin-top: 2px; }
        .cow-toast-container { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; pointer-events: none; z-index: 100; }
        .cow-toast { background: rgba(89,217,142,0.9); color: #0f1a13; padding: 8px 16px; border-radius: 20px; font-weight: 800; font-size: 12px; box-shadow: 0 6px 20px rgba(0,0,0,0.5); animation: cow-toast-in 0.3s ease-out; white-space: nowrap; }
        @keyframes cow-toast-in { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
        .cow-prestige-box { padding: 18px 16px; text-align: center; background: rgba(243,201,105,0.08); border: 1px solid rgba(243,201,105,0.3); border-radius: 12px; }
        .cow-ach { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin-bottom: 6px; background: rgba(255,255,255,0.03); border: 1px solid rgba(243,201,105,0.16); border-radius: 10px; }
        .cow-ach.locked { opacity: 0.4; }
        .cow-ach.unlocked { border-color: rgba(89,217,142,0.5); background: rgba(89,217,142,0.08); }
        .cow-ach-icon { font-size: 22px; }
        .cow-ach-info { flex: 1; }
        .cow-ach-name { font-weight: 800; font-size: 13px; }
        .cow-ach-thr { font-size: 11px; color: #a89070; }
        .cow-ach-bonus { color: #59d98e; font-weight: 800; font-size: 13px; }
        `;
        root.append(h('style', { text: CSS }));

        const wrap = h('div', { class: 'cow-game' });
        root.append(wrap);
        const toastContainer = h('div', { class: 'cow-toast-container' });
        wrap.append(toastContainer);

        // ============================ HEADER ============================
        const milkCountEl = h('div', { class: 'cow-milk-count', text: '0' });
        const mpsEl = h('div', { class: 'cow-mps', text: '0 / сек' });
        const clickPowerEl = h('div', { class: 'cow-mps', text: '+0 / клик' });
        wrap.append(h('div', { class: 'cow-header' },
            h('div', {}, milkCountEl, h('div', { style: 'font-size: 10px; color: #7a6a4a; font-weight: 800; text-transform: uppercase; margin-top: 3px;' }, 'молоко')),
            h('div', { style: 'text-align: right;' }, mpsEl, clickPowerEl)
        ));

        // ============================ STAGE ============================
        const stageEl = h('div', { class: 'cow-stage' });
        const cowBtn = h('button', { class: 'cow-btn', text: '🐄', onclick: onCowClick });
        stageEl.append(cowBtn);
        wrap.append(stageEl);

        // ============================ TABS ============================
        const tabs = [
            { id: 'clickups',     label: '💪 Клик' },
            { id: 'buildings',    label: '🏠 Здания' },
            { id: 'mults',        label: '🌟 Бонусы' },
            { id: 'achievements', label: '🏆 Достижения' },
            { id: 'prestige',     label: '⭐ Престиж' },
        ];
        let currentTab = 'clickups';
        const tabsEl = h('div', { class: 'cow-tabs' });
        const tabBtns = {};
        for (const t of tabs) {
            const btn = h('button', { class: 'cow-tab' + (t.id === currentTab ? ' on' : ''), text: t.label, onclick: () => { currentTab = t.id; renderTabs(); } });
            tabBtns[t.id] = btn;
            tabsEl.append(btn);
        }
        wrap.append(tabsEl);
        const contentEl = h('div', { class: 'cow-content' });
        wrap.append(contentEl);

        let currentCards = [];

        // ============================ КЛИКИ ============================
        function onCowClick(e) {
            const p = getLocalClickPower();
            state.milk += p;
            state.totalMilk += p;

            cowBtn.classList.remove('clicked');
            void cowBtn.offsetWidth;
            cowBtn.classList.add('clicked');
            spawnFloat('+' + cowFmtNum(p), e, '#f3c969', 20);
            updateHeader();

            pendingClicks++;
            if (!clickTimeout) {
                clickTimeout = setTimeout(sendClicks, 1000);
            }
        }

        async function sendClicks() {
            clickTimeout = null;
            if (pendingClicks === 0 || isSyncing) return;
            const toSend = pendingClicks;
            pendingClicks = 0;

            isSyncing = true;
            const res = await serverRequest('/api/cow/click', {
                method: 'POST', body: JSON.stringify({ clicks: toSend })
            });
            isSyncing = false;

            if (res && res.success) {
                state.milk = res.milk;
                state.totalMilk = res.totalMilk;
                updateHeader();
                refreshVisibleCards();
            } else {
                syncState();
            }
        }

        // ============================ ПОКУПКИ ============================
        async function buyUpgrade(type, id, qty) {
            const res = await serverRequest('/api/cow/buy', {
                method: 'POST', body: JSON.stringify({ type, id, qty })
            });
            if (res && res.success) {
                state.milk = res.milk;
                syncState();
            } else {
                showToast(res.error || 'Ошибка покупки');
            }
        }

        async function doPrestige() {
            if (!confirm('Вы уверены? Весь прогресс (кроме общего молока и достижений) сбросится.')) return;
            const res = await serverRequest('/api/cow/prestige', { method: 'POST', body: '{}' });
            if (res && res.success) {
                state = res.state;
                renderAll();
                showToast('⭐ Престиж успешно применён!');
            }
        }

        async function syncState() {
            const res = await serverRequest('/api/cow/sync', {
                method: 'POST',
                body: JSON.stringify({ nickname: getPlayerName() })
            });
            if (res && res.success) {
                state = res.state;
                updateHeader();
                refreshVisibleCards();
                store.set('cow.state', { totalMilk: state.totalMilk, prestigeLevel: state.prestigeLevel });
                api.refreshCards();
            }
        }

        // ============================ КОНФИГИ ============================
        const CLICK_UPS_CFG = [
            { id: 'hands',   icon: '💪', name: 'Мозолистые руки',   cost: 15,     effect: 1,      mult: 1.15, desc: '+1 молока за клик' },
            { id: 'bicep',   icon: '🦾', name: 'Молочный бицепс',    cost: 500,    effect: 10,     mult: 1.20, desc: '+10 молока за клик' },
            { id: 'steel',   icon: '✋', name: 'Стальные ладони',    cost: 5e4,    effect: 100,    mult: 1.25, desc: '+100 молока за клик' },
            { id: 'diamond', icon: '💎', name: 'Алмазный хват',      cost: 5e6,    effect: 1000,   mult: 1.30, desc: '+1 000 молока за клик' },
            { id: 'plasma',  icon: '⚡', name: 'Плазменные пальцы',  cost: 5e8,    effect: 1e4,    mult: 1.35, desc: '+10 000 молока за клик' },
            { id: 'cosmic',  icon: '🌌', name: 'Космическая хватка', cost: 5e10,   effect: 1e5,    mult: 1.40, desc: '+100 000 молока за клик' },
            { id: 'divine',  icon: '🙏', name: 'Божественное доение',cost: 5e12,   effect: 1e6,    mult: 1.50, desc: '+1 000 000 молока за клик' },
        ];
        const BUILDINGS_CFG = [
            { id: 'cat',      icon: '🐱', name: 'Кот-помощник',         cost: 15,     prod: 0.15,  mult: 1.15 },
            { id: 'maid',     icon: '👩‍🌾', name: 'Доярка-стажёрка',      cost: 100,    prod: 1,     mult: 1.15 },
            { id: 'auto',     icon: '🤖', name: 'Автодойка',             cost: 1100,   prod: 8,     mult: 1.15 },
            { id: 'plant',    icon: '🏭', name: 'Молочный цех',          cost: 12000,  prod: 47,    mult: 1.15 },
            { id: 'cheese',   icon: '🧀', name: 'Сыроварня',             cost: 130000, prod: 260,   mult: 1.15 },
            { id: 'bank',     icon: '🏦', name: 'Молочный банк',         cost: 1.4e6,  prod: 1400,  mult: 1.15 },
            { id: 'cosmo',    icon: '🚀', name: 'Космо-корова',          cost: 2e7,    prod: 7800,  mult: 1.15 },
            { id: 'quantum',  icon: '⚛️', name: 'Квантовая ферма',       cost: 3.3e8,  prod: 4.4e4, mult: 1.15 },
            { id: 'portal',   icon: '🌀', name: 'Молочный портал',       cost: 5.1e9,  prod: 2.6e5, mult: 1.15 },
            { id: 'alchemy',  icon: '⚗️', name: 'Алхимическая лаборатория', cost: 7.5e10, prod: 1.6e6, mult: 1.15 },
            { id: 'time',     icon: '⏳', name: 'Машина времени',        cost: 1e12,   prod: 1e7,   mult: 1.15 },
            { id: 'infinity', icon: '♾️', name: 'Бесконечная корова',    cost: 1.4e13, prod: 6.5e7, mult: 1.15 },
        ];
        const MULTS_CFG = [
            { id: 'hay',    icon: '🌾', name: 'Премиум-сено',     cost: 1e4,  factor: 2 },
            { id: 'gmo',    icon: '🧬', name: 'ГМО-кукуруза',     cost: 1e5,  factor: 2 },
            { id: 'wonder', icon: '🌟', name: 'Чудо-корм',        cost: 1e6,  factor: 3 },
            { id: 'nano',   icon: '🔬', name: 'Нано-удобрение',   cost: 1e7,  factor: 3 },
            { id: 'legend', icon: '✨', name: 'Легендарное сено', cost: 1e8,  factor: 5 },
            { id: 'meta',   icon: '💫', name: 'Мета-корм',        cost: 1e10, factor: 5 },
            { id: 'void',   icon: '🌑', name: 'Корм из пустоты',  cost: 1e12, factor: 10 },
        ];
        const ACH_CFG = [
            { threshold: 1e3,  bonus: 0.01, name: 'Первая тысяча',    icon: '🐄' }, { threshold: 1e4,  bonus: 0.01, name: 'Уже неплохо',      icon: '🐄' },
            { threshold: 1e5,  bonus: 0.01, name: 'Молочный магнат',  icon: '🐄' }, { threshold: 1e6,  bonus: 0.02, name: 'Миллионер',        icon: '💧' },
            { threshold: 1e7,  bonus: 0.02, name: 'Большой бизнес',   icon: '💧' }, { threshold: 1e8,  bonus: 0.02, name: 'Молочный лорд',    icon: '💧' },
            { threshold: 1e9,  bonus: 0.03, name: 'Миллиардер',       icon: '🌊' }, { threshold: 1e10, bonus: 0.03, name: 'Империя',          icon: '🌊' },
            { threshold: 1e11, bonus: 0.03, name: 'Молочный хан',     icon: '🌊' }, { threshold: 1e12, bonus: 0.05, name: 'Триллионер',       icon: '🌌' },
            { threshold: 1e13, bonus: 0.05, name: 'Молочный бог',     icon: '🌌' }, { threshold: 1e14, bonus: 0.05, name: 'Абсолют',          icon: '🌌' },
            { threshold: 1e15, bonus: 0.10, name: 'Молочный титан',   icon: '👑' }, { threshold: 1e16, bonus: 0.10, name: 'За гранью',        icon: '👑' },
        ];

        // ============================ РАСЧЁТЫ (UI) ============================
        function getLocalClickPower() {
            let ach = 0; for (const a of ACH_CFG) if (state.totalMilk >= a.threshold) ach += a.bonus;
            let g = 1; for (const m of MULTS_CFG) if (state.multipliers[m.id]) g *= m.factor;
            g *= Math.pow(1.5, state.prestigeLevel); g *= (1 + ach);
            let cp = 1; for (const u of CLICK_UPS_CFG) cp += (state.clickUps[u.id] || 0) * u.effect;
            return cp * g;
        }
        function getLocalMps() {
            let ach = 0; for (const a of ACH_CFG) if (state.totalMilk >= a.threshold) ach += a.bonus;
            let g = 1; for (const m of MULTS_CFG) if (state.multipliers[m.id]) g *= m.factor;
            g *= Math.pow(1.5, state.prestigeLevel); g *= (1 + ach);
            let mps = 0; for (const b of BUILDINGS_CFG) {
                const o = state.buildings[b.id] || 0;
                let mm = 1; for (const t of [25, 50, 100, 200, 300, 400, 500]) if (o >= t) mm *= 2;
                mps += o * b.prod * mm;
            }
            return mps * g;
        }

        function getBuyInfo(type, id, mode) {
            if (type === 'mult') return { qty: 1, price: MULTS_CFG.find(m=>m.id===id).cost };
            const cfg = type === 'building' ? BUILDINGS_CFG.find(b=>b.id===id) : CLICK_UPS_CFG.find(u=>u.id===id);
            const owned = type === 'building' ? (state.buildings[id] || 0) : (state.clickUps[id] || 0);

            if (mode === 'max') {
                let total = 0, count = 0;
                let p = Math.floor(cfg.cost * Math.pow(cfg.mult, owned));
                while (total + p <= state.milk && count < 10000) {
                    total += p; count++;
                    p = Math.floor(cfg.cost * Math.pow(cfg.mult, owned + count));
                }
                if (count === 0) {
                    return { qty: 1, price: Math.floor(cfg.cost * Math.pow(cfg.mult, owned)) };
                }
                return { qty: count, price: total };
            } else {
                let total = 0;
                for (let i = 0; i < mode; i++) total += Math.floor(cfg.cost * Math.pow(cfg.mult, owned + i));
                return { qty: mode, price: total };
            }
        }

        // ============================ UI ============================
        let lastHeaderUpdate = 0;
        function updateHeader() {
            const now = Date.now();
            if (now - lastHeaderUpdate < 100) return;
            lastHeaderUpdate = now;
            milkCountEl.textContent = cowFmtNum(state.milk);
            mpsEl.textContent = cowFmtNum(getLocalMps()) + ' / сек';
            clickPowerEl.textContent = '+' + cowFmtNum(getLocalClickPower()) + ' / клик';
        }

        function makeBuyCard(cfg, type) {
            const card = h('button', { class: 'cow-up' });
            const priceEl = h('div', { class: 'cow-up-price' });
            const descEl = h('div', { class: 'cow-up-desc' });
            const countEl = h('div', { class: 'cow-up-count' });
            card.append(
                h('div', { class: 'cow-up-icon', text: cfg.icon }),
                h('div', { class: 'cow-up-info' }, h('div', { class: 'cow-up-name', text: cfg.name }), descEl),
                h('div', { class: 'cow-up-right' }, priceEl, countEl)
            );

            card.refresh = () => {
                const owned = type === 'building' ? (state.buildings[cfg.id] || 0) : (type === 'clickUp' ? (state.clickUps[cfg.id] || 0) : !!state.multipliers[cfg.id]);
                let desc = cfg.desc || '';
                let price = cfg.cost;

                if (type !== 'mult') {
                    const info = getBuyInfo(type, cfg.id, buyMode);
                    price = info.price;

                    if (type === 'building') {
                        let mm = 1; for (const t of [25, 50, 100, 200, 300, 400, 500]) if (owned >= t) mm *= 2;
                        desc = '+' + cowFmtNum(cfg.prod * mm) + ' / сек' + (mm > 1 ? ' · вехи ×' + mm : '');
                    } else if (type === 'clickUp') {
                        desc = cfg.desc;
                    }
                }

                descEl.textContent = desc;
                if (owned === true) {
                    priceEl.textContent = '✓ куплено'; countEl.textContent = '';
                    card.classList.add('owned'); card.classList.remove('locked');
                } else {
                    priceEl.textContent = cowFmtNum(price) + ' 🥛';
                    let countText = '×' + owned;
                    if (buyMode === 'max' && type !== 'mult') countText += ' (+' + getBuyInfo(type, cfg.id, buyMode).qty + ')';
                    else if (buyMode > 1 && type !== 'mult') countText += ' (+' + buyMode + ')';
                    countEl.textContent = countText;

                    card.classList.remove('owned');
                    card.classList.toggle('locked', state.milk < price);
                }
            };

            card.onclick = () => {
                const owned = type === 'building' ? (state.buildings[cfg.id] || 0) : (type === 'clickUp' ? (state.clickUps[cfg.id] || 0) : !!state.multipliers[cfg.id]);
                if (owned === true) return;
                const info = getBuyInfo(type, cfg.id, buyMode);
                if (state.milk < info.price) return;
                buyUpgrade(type, cfg.id, info.qty);
            };
            card.refresh();
            return card;
        }

        function refreshVisibleCards() { for (const c of currentCards) if (c.refresh) c.refresh(); }

        function makeBuyModeRow() {
            const row = h('div', { class: 'cow-buy-mode' });
            const modes = [1, 10, 100, 'max'];
            for (const n of modes) {
                const label = n === 'max' ? 'MAX' : '×' + n;
                row.append(h('button', {
                    class: 'cow-tab' + (buyMode === n ? ' on' : ''),
                    text: label,
                    onclick: () => { buyMode = n; store.set('cow.buyMode', n); renderTabs(); }
                }));
            }
            return row;
        }

        function renderTabs() {
            for (const t of tabs) tabBtns[t.id].classList.toggle('on', t.id === currentTab);
            contentEl.innerHTML = ''; currentCards = [];

            if (currentTab === 'clickups') {
                contentEl.append(makeBuyModeRow());
                for (const u of CLICK_UPS_CFG) {
                    currentCards.push(makeBuyCard({ ...u, desc: '+'+u.effect+' за клик' }, 'clickUp'));
                }
            }
            else if (currentTab === 'buildings') {
                contentEl.append(makeBuyModeRow());
                for (const b of BUILDINGS_CFG) {
                    currentCards.push(makeBuyCard(b, 'building'));
                }
            }
            else if (currentTab === 'mults') {
                for (const m of MULTS_CFG) {
                    const card = makeBuyCard({ ...m, desc: '×' + m.factor + ' ко всему производству' }, 'mult');
                    currentCards.push(card);
                }
            }
            else if (currentTab === 'achievements') {
                let bns = 0; for (const a of ACH_CFG) if (state.totalMilk >= a.threshold) bns += a.bonus;
                contentEl.append(h('div', { style: 'padding: 10px; margin-bottom: 8px; text-align: center; color: #59d98e; font-weight: 800; background: rgba(89,217,142,0.08); border-radius: 8px;', text: 'Бонус к производству: +' + Math.round(bns * 100) + '%' }));
                for (const a of ACH_CFG) {
                    const isUnlocked = state.totalMilk >= a.threshold;
                    contentEl.append(h('div', { class: 'cow-ach ' + (isUnlocked ? 'unlocked' : 'locked') },
                        h('div', { class: 'cow-ach-icon', text: a.icon }),
                        h('div', { class: 'cow-ach-info' }, h('div', { class: 'cow-ach-name', text: a.name }), h('div', { class: 'cow-ach-thr', text: 'Накопить ' + cowFmtNum(a.threshold) + ' 🥛' })),
                        h('div', { class: 'cow-ach-bonus', text: '+' + Math.round(a.bonus * 100) + '%' })
                    ));
                }
            }
            else if (currentTab === 'prestige') {
                const cost = Math.floor(5e7 * Math.pow(5, state.prestigeLevel));
                const can = state.milk >= cost;
                contentEl.append(h('div', { class: 'cow-prestige-box' },
                    h('div', { style: 'font-size: 44px; margin-bottom: 6px;', text: '⭐' }),
                    h('div', { style: 'font-size: 16px; font-weight: 800; color: #f3c969; margin-bottom: 8px;' }, 'Престиж ' + state.prestigeLevel),
                    h('div', { style: 'font-size: 12px; color: #b8a082; line-height: 1.7; margin-bottom: 14px;' },
                        'Сброс прогресса. Останется только totalMilk и достижения.', h('br'),
                        'Сейчас: ×' + Math.pow(1.5, state.prestigeLevel).toFixed(2) + ' → станет: ×' + Math.pow(1.5, state.prestigeLevel + 1).toFixed(2), h('br'),
                        'Стоимость: ' + cowFmtNum(cost) + ' 🥛'
                    ),
                    h('button', {
                        class: 'cow-tab' + (can ? ' on' : ''), style: 'padding: 12px; width: 100%;' + (can ? '' : ' opacity: 0.5; cursor: not-allowed;'),
                        text: can ? '⭐ Сделать престиж' : 'Недостаточно молока', onclick: can ? doPrestige : null
                    })
                ));
            }
            contentEl.append(...currentCards);
        }

        function spawnFloat(text, e, color, fontSize) {
            const rect = stageEl.getBoundingClientRect();
            let cx = rect.width / 2, cy = rect.height / 2;
            if (e && e.clientX) { cx = e.clientX - rect.left; cy = e.clientY - rect.top; }
            const el = h('div', { class: 'cow-float', text, style: `left:${cx}px; top:${cy}px;${color ? 'color:' + color + ';' : ''}${fontSize ? 'font-size:' + fontSize + 'px;' : ''}` });
            stageEl.append(el); setTimeout(() => el.remove(), 1000);
        }

        function showToast(text) {
            const el = h('div', { class: 'cow-toast', text });
            toastContainer.append(el);
            setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 500); }, 3000);
        }

        // ============================ ТИКЕР ============================
        let mounted = true, lastTick = Date.now(), rafId = null;
        let lastSync = 0;

        function tick() {
            if (!mounted) return;

            if (document.hidden) {
                if (rafId) cancelAnimationFrame(rafId);
                rafId = null;
                return;
            }

            const now = Date.now();
            const dt = Math.max(0, Math.min(60, (now - lastTick) / 1000));
            lastTick = now;

            const mps = getLocalMps();
            if (mps > 0) { state.milk += mps * dt; state.totalMilk += mps * dt; }
            updateHeader();

            if (now - lastSync > 10000) {
                lastSync = now;
                syncState();
            }
            if (now % 1000 < 20) refreshVisibleCards();

            rafId = requestAnimationFrame(tick);
        }

        // ============================ СТАРТ ============================
        const onVisibilityChange = () => {
            if (!document.hidden && mounted && !rafId) {
                lastTick = Date.now();
                rafId = requestAnimationFrame(tick);
            }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        syncState();
        lastTick = Date.now();
        rafId = requestAnimationFrame(tick);

        return {
            onShow() {
                mounted = true; lastTick = Date.now();
                if (!rafId) rafId = requestAnimationFrame(tick);
                syncState();
            },
            onHide() {
                mounted = false; if (rafId) cancelAnimationFrame(rafId); rafId = null;
                if (pendingClicks > 0) sendClicks();
            },
            destroy() {
                mounted = false;
                if (rafId) cancelAnimationFrame(rafId);
                document.removeEventListener('visibilitychange', onVisibilityChange);
            }
        };
    }
};



    // ============================================================
    // ИГРА: DOOM (одиночная, шареварный эпизод 1)
    // Движок: исходники id Software (GPL-2.0), переведены в JavaScript без изменений
    // игровой логики; сеть и музыка отключены. Файл doom1.wad пользователь выбирает
    // один раз, он хранится только в его браузере (IndexedDB).
    // ============================================================
    const Doom = {
        id: 'doom',
        name: 'Doom',
        icon: '👹',
        ring: '#e05a4f',
        wide: true,
        category: 'solo',
        subtitle() { return 'эпизод 1 · 1 игрок'; },
        mount(root) {
            const W = 320, H = 200;
            const KEYS = {
                ArrowUp: 0xad, KeyW: 0xad, ArrowDown: 0xaf, KeyS: 0xaf, ArrowLeft: 0xac, ArrowRight: 0xae,
                KeyA: 44, KeyD: 46, KeyF: 0x80 + 0x1d, Space: 32, KeyE: 32,
                ShiftLeft: 0x80 + 0x36, ShiftRight: 0x80 + 0x36, Escape: 27, Enter: 13, NumpadEnter: 13,
                Tab: 9, Backspace: 127, Minus: 45, Equal: 61, Pause: 0xff, KeyP: 0xff
            };
            const keyCode = (e) => {
                if (e.ctrlKey || e.metaKey || e.altKey) return null;
                if (KEYS[e.code] != null) return KEYS[e.code];
                if (/^Digit[0-9]$/.test(e.code)) return e.code.charCodeAt(5);
                if (/^Key[A-Z]$/.test(e.code)) return e.code.charCodeAt(3) + 32;
                return null;
            };
            const idb = {
                open() {
                    return new Promise((res, rej) => {
                        try {
                            const r = indexedDB.open('lgArcade', 1);
                            r.onupgradeneeded = () => r.result.createObjectStore('files');
                            r.onsuccess = () => res(r.result);
                            r.onerror = () => rej(r.error);
                        } catch (e) { rej(e); }
                    });
                },
                async run(mode, fn) {
                    const db = await this.open();
                    return new Promise((res, rej) => {
                        const req = fn(db.transaction('files', mode).objectStore('files'));
                        req.onsuccess = () => res(req.result);
                        req.onerror = () => rej(req.error);
                    });
                },
                get(k) { return this.run('readonly', (s) => s.get(k)).then((v) => v || null); },
                set(k, v) { return this.run('readwrite', (s) => s.put(v, k)); },
                del(k) { return this.run('readwrite', (s) => s.delete(k)); }
            };
            function checkWad(buf) {
                if (buf.byteLength < 12) return 'Файл слишком маленький.';
                const dv = new DataView(buf), u8 = new Uint8Array(buf);
                if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'IWAD') return 'Это не IWAD-файл. Нужен doom1.wad.';
                const n = dv.getInt32(4, true), off = dv.getInt32(8, true);
                if (n < 1 || off < 12 || off + n * 16 > buf.byteLength) return 'Файл повреждён.';
                for (let i = 0; i < n; i++) {
                    let name = '';
                    for (let k = 0; k < 8; k++) { const c = u8[off + i * 16 + 8 + k]; if (!c) break; name += String.fromCharCode(c); }
                    if (name === 'E1M1') return '';
                }
                return 'В файле нет первого эпизода (E1M1). Нужен doom1.wad.';
            }
            const panel = h('div', { class: 'dm-panel' });
            const canvas = h('canvas', { width: W, height: H, tabindex: '0' });
            const over = h('div', { class: 'dm-over', text: 'Нажми на экран, чтобы играть' });
            const screen = h('div', { class: 'dm-screen' }, canvas, over);
            const bar = h('div', { class: 'dm-bar' });
            const help = h('div', { class: 'dm-help' });
            screen.style.display = 'none'; bar.style.display = 'none'; help.style.display = 'none';
            root.append(panel, screen, bar, help);
            const ctx = canvas.getContext('2d');
            let ex = null, mem = null, raf = 0, running = false, focused = false, alive = false, exited = null;
            let muted = store.get('dm.mute', false), mouseOn = store.get('dm.mouse', true);
            let clock = { acc: 0, last: 0, on: false };
            let logs = [];
            const held = new Set();
            let mouseBtn = 0, mouseDx = 0, mouseSent = 0;
            const nowMs = () => clock.acc + (clock.on ? performance.now() - clock.last : 0);
            let actx = null, voices = 0;
            let sfxCache = new Map();
            function ensureAudio() {
                if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; } }
                if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
            }
            function playSfx(id, p, n, rate, vol, sep) {
                if (muted || !actx || actx.state !== 'running' || voices >= 24) return;
                let buf = sfxCache.get(id);
                if (!buf) {
                    const u8 = new Uint8Array(mem.buffer, p, n);
                    buf = actx.createBuffer(1, n, rate);
                    const ch = buf.getChannelData(0);
                    for (let i = 0; i < n; i++) ch[i] = (u8[i] - 128) / 128;
                    sfxCache.set(id, buf);
                }
                const src = actx.createBufferSource(), g = actx.createGain();
                src.buffer = buf; g.gain.value = Math.min(1, vol / 127) * 0.6;
                src.connect(g);
                let out = g;
                if (actx.createStereoPanner) {
                    const pn = actx.createStereoPanner();
                    pn.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128));
                    g.connect(pn); out = pn;
                }
                out.connect(actx.destination);
                voices++; src.onended = () => { voices--; };
                src.start();
            }
            const readStr = (p, n) => new TextDecoder().decode(new Uint8Array(mem.buffer, p, n));
            function showPanel(...kids) {
                panel.textContent = ''; panel.append(...kids.filter(Boolean)); panel.style.display = '';
                screen.style.display = 'none'; bar.style.display = 'none'; help.style.display = 'none';
            }
            function pickFileUI(note) {
                const input = h('input', { type: 'file', accept: '.wad,.WAD', class: 'dm-file',
                    onchange: async () => {
                        const f = input.files && input.files[0];
                        if (!f) return;
                        const buf = await f.arrayBuffer();
                        const bad = checkWad(buf);
                        if (bad) { showPanel(...pickFileUI(bad)); return; }
                        try { await idb.set('doom1.wad', buf); } catch (e) { sessionWad = buf; }
                        sessionWad = buf;
                        welcome();
                    } });
                return [
                    note ? h('div', { class: 'dm-err', text: note }) : null,
                    h('div', {}, h('b', { text: 'Нужен файл doom1.wad' }), ' (бесплатная шареварная версия Doom 1993 года).'),
                    h('div', { text: 'Выбери его один раз: он сохранится в этом браузере и никуда не отправляется.' }),
                    input
                ];
            }
            let sessionWad = null;
            async function getWad() {
                if (sessionWad) return sessionWad;
                try { sessionWad = await idb.get('doom1.wad'); } catch (e) { sessionWad = null; }
                return sessionWad;
            }
            async function welcome() {
                const wad = await getWad();
                if (!wad) { showPanel(...pickFileUI('')); return; }
                showPanel(
                    h('div', {}, h('b', { text: 'Doom · эпизод 1' }), ' · одиночная игра'),
                    h('div', { text: 'Игра работает прямо в браузере. Пока окно закрыто или скрыто, время в игре стоит.' }),
                    h('div', { class: 'dm-row' },
                        h('button', { class: 'btn on', type: 'button', text: '▶ Играть', onclick: () => start() }),
                        h('button', { class: 'btn', type: 'button', text: 'Выбрать другой WAD',
                            onclick: async () => { sessionWad = null; try { await idb.del('doom1.wad'); } catch (e) {} showPanel(...pickFileUI('')); } })));
            }
            function endScreen(title, extra) {
                stopLoop(); alive = false; releaseAll(); exitLock();
                showPanel(
                    h('div', {}, h('b', { text: title })),
                    extra ? h('pre', { class: 'dm-log', text: extra }) : null,
                    h('div', { class: 'dm-row' },
                        h('button', { class: 'btn on', type: 'button', text: '↻ Запустить заново', onclick: () => start() })));
            }
            async function start() {
                stopLoop(); alive = false; exited = null; logs = []; sfxCache = new Map(); held.clear();
                showPanel(h('div', { text: 'Загрузка…' }));
                try {
                    const wad = await getWad();
                    if (!wad) { showPanel(...pickFileUI('')); return; }
                    ex = createDoomEngine({
                        js_now: () => nowMs(),
                        js_print: (p, n) => { logs.push(readStr(p, n)); if (logs.length > 60) logs.shift(); },
                        js_exit: (c) => { exited = c; },
                        js_sfx: (id, p, n, rate, vol, sep) => { try { playSfx(id, p, n, rate, vol, sep); } catch (e) {} }
                    });
                    mem = ex.memory;
                    const p = ex.doom_alloc_wad(wad.byteLength);
                    new Uint8Array(mem.buffer, p, wad.byteLength).set(new Uint8Array(wad));
                    clock = { acc: 0, last: performance.now(), on: true };
                    ex.doom_start();
                    alive = true;
                    panel.style.display = 'none'; screen.style.display = ''; bar.style.display = ''; help.style.display = '';
                    renderBar(); renderHelp();
                    ensureAudio();
                    canvas.focus();
                    startLoop();
                } catch (e) { crash(e); }
            }
            function crash(e) {
                const text = logs.join('').split('\n').filter(Boolean).slice(-6).join('\n');
                if (exited !== null && exited === 0) { endScreen('Ты вышел из игры.', ''); return; }
                endScreen('Игра остановилась с ошибкой.', (e && e.message ? e.message + '\n' : '') + text);
            }
            function frame() {
                raf = 0;
                if (!running) return;
                try {
                    if (mouseDx || mouseBtn !== mouseSent) {
                        ex.doom_mouse(mouseBtn, mouseDx * 4, 0);
                        mouseDx = 0; mouseSent = mouseBtn;
                    }
                    ex.doom_tick();
                    if (ex.doom_frame_ready()) {
                        const fb = new Uint8ClampedArray(mem.buffer, ex.doom_fb(), W * H * 4);
                        ctx.putImageData(new ImageData(fb, W, H), 0, 0);
                    }
                } catch (e) { running = false; crash(e); return; }
                raf = requestAnimationFrame(frame);
            }
            function startLoop() {
                if (running || !alive) return;
                running = true;
                if (!clock.on) { clock.last = performance.now(); clock.on = true; }
                raf = requestAnimationFrame(frame);
            }
            function stopLoop() {
                if (clock.on) { clock.acc += performance.now() - clock.last; clock.on = false; }
                running = false;
                if (raf) { cancelAnimationFrame(raf); raf = 0; }
            }
            function releaseAll() {
                if (ex && alive) { for (const c of held) { try { ex.doom_key(0, c); } catch (e) {} } }
                held.clear(); mouseBtn = 0; mouseDx = 0;
            }
            function onKey(e) {
                if (!running || !focused) return;
                const c = keyCode(e);
                if (c == null) return;
                e.preventDefault(); e.stopImmediatePropagation();
                if (e.type === 'keydown') {
                    if (e.repeat || held.has(c)) return;
                    held.add(c); ex.doom_key(1, c);
                } else if (held.has(c)) {
                    held.delete(c); ex.doom_key(0, c);
                }
            }
            window.addEventListener('keydown', onKey, true);
            window.addEventListener('keyup', onKey, true);
            const locked = () => (shadow.pointerLockElement || document.pointerLockElement) === canvas;
            function exitLock() { try { if (locked()) document.exitPointerLock(); } catch (e) {} }
            canvas.addEventListener('focus', () => { focused = true; over.classList.add('hide'); ensureAudio(); });
            canvas.addEventListener('blur', () => { focused = false; over.classList.remove('hide'); releaseAll(); });
            canvas.addEventListener('mousedown', (e) => {
                e.preventDefault(); canvas.focus();
                if (mouseOn && !locked()) { try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (err) {} }
                if (locked() || mouseOn) mouseBtn |= (e.button === 0 ? 1 : e.button === 1 ? 2 : 4);
            });
            window.addEventListener('mouseup', (e) => { mouseBtn &= ~(e.button === 0 ? 1 : e.button === 1 ? 2 : 4); });
            canvas.addEventListener('contextmenu', (e) => e.preventDefault());
            window.addEventListener('mousemove', (e) => { if (running && locked()) mouseDx += e.movementX || 0; });
            function renderBar() {
                bar.textContent = '';
                const tap = (fn) => (e) => { fn(e); canvas.focus(); };
                bar.append(
                    h('button', { class: 'btn', type: 'button', text: '☰ Меню (Esc)', onclick: tap(() => { ex.doom_key(1, 27); ex.doom_key(0, 27); }) }),
                    h('button', { class: 'btn', type: 'button', text: muted ? '🔇 Звук: выкл' : '🔊 Звук: вкл',
                        onclick: tap(() => { muted = !muted; store.set('dm.mute', muted); renderBar(); }) }),
                    h('button', { class: 'btn', type: 'button', text: mouseOn ? '🖱 Мышь: вкл' : '🖱 Мышь: выкл',
                        onclick: tap(() => { mouseOn = !mouseOn; store.set('dm.mouse', mouseOn); if (!mouseOn) exitLock(); renderBar(); }) }),
                    h('button', { class: 'btn', type: 'button', text: '↻ Заново', onclick: () => start() }));
            }
            function renderHelp() {
                help.textContent = '';
                help.append('W A S D - ходить · стрелки - поворот · F или левая кнопка мыши - стрелять · Пробел или E - открыть/использовать · Shift - бег · цифры 1-7 - оружие · P - пауза');
                help.append(h('br'));
                help.append('Клик по экрану захватывает мышь (поворот мышью), Esc отпускает её.');
            }
            showPanel(h('div', { text: 'Загрузка…' }));
            welcome();
            return {
                onShow() { if (alive) { startLoop(); } },
                onHide() { stopLoop(); releaseAll(); exitLock(); },
                destroy() { stopLoop(); window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKey, true); }
            };
        }
    };

    // ============================================================
    // ЯДРО: кнопка, окно, реестр игр
    // ============================================================
    const games = [];
    let active = null, isOpen = false;
    const instances = new Map();

    const host = h('div', { id: 'lg-arcade-host' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(h('style', { text: CSS }));

    const fab = h('button', { class: 'fab', text: '🎮', title: 'Мини-игры', 'aria-label': 'Мини-игры' });
    const cardsEl = h('div', { class: 'cards' });
    const stage = h('div');

    const closeBtn = h('button', { class: 'x', text: '✕', title: 'Закрыть', 'aria-label': 'Закрыть' });
    const trophyBtn = h('button', { class: 'btn trophy-btn', text: '🏆', title: 'Таблица лидеров', style: 'font-size: 16px; padding: 2px 8px;' });
    const resetBtn      = h('button', { class: 'btn reset-btn',      text: '⟲', title: 'Сбросить размер', 'aria-label': 'Сбросить размер', style: 'font-size: 16px; padding: 2px 8px;' });
    const fullscreenBtn = h('button', { class: 'btn fs-btn',         text: '⛶', title: 'На весь экран',   'aria-label': 'На весь экран',   style: 'font-size: 16px; padding: 2px 8px;' });
    const head = h('div', { class: 'head' }, h('div', { class: 'title', text: 'Мини-игры' }), h('div', { style: 'display: flex; gap: 8px;' }, resetBtn, fullscreenBtn, trophyBtn, closeBtn));

    const lbModal = h('div', { class: 'lb-modal' });

    const win = h('div', { class: 'win', role: 'dialog', 'aria-label': 'Мини-игры' },
        h('div', { class: 'frame' }, head,
            h('div', { class: 'board' }, cardsEl, stage,
                h('div', { class: 'foot', text: 'Legion Arcade v0.4 · Мультиплеер и Рекорды' }))
        ),
        lbModal
    );
    shadow.append(fab, win);

    // ============================================================
    // ФУЛСКРИН + РЕСАЙЗ ОКНА
    // ============================================================
    function toggleFullscreen() {
        const isFs = win.classList.toggle('fullscreen');
        fullscreenBtn.textContent = isFs ? '⤡' : '⛶';
        fullscreenBtn.title = isFs ? 'Свернуть' : 'На весь экран';
    }
    fullscreenBtn.addEventListener('click', toggleFullscreen);

    // ============================================================
    // СБРОС РАЗМЕРА ОКНА
    // ============================================================
    function resetWindowSize() {
        if (win.classList.contains('fullscreen')) {
            win.classList.remove('fullscreen');
            fullscreenBtn.textContent = '⛶';
            fullscreenBtn.title = 'На весь экран';
        }

        for (const prop of ['left', 'top', 'right', 'bottom', 'width', 'height', 'max-height', 'transform']) {
            win.style.removeProperty(prop);
        }

        const frame = win.querySelector('.frame');
        if (frame) {
            frame.style.removeProperty('height');
            frame.style.removeProperty('max-height');
        }
    }
    resetBtn.addEventListener('click', resetWindowSize);

    function ensureFreePosition() {
        if (win.classList.contains('fullscreen')) return false;

        const cs = getComputedStyle(win);
        const hasTransform = cs.transform && cs.transform !== 'none';
        const needsPin = hasTransform || !win.style.width;

        if (needsPin) {
            const r = win.getBoundingClientRect();
            win.style.transform = 'none';
            win.style.left   = r.left + 'px';
            win.style.top    = r.top + 'px';
            win.style.right  = 'auto';
            win.style.bottom = 'auto';
            win.style.width  = r.width + 'px';
        }

        win.style.maxHeight = 'none';
        return true;
    }
    function applyFrameSize(hgt) {
        const frame = win.querySelector('.frame');
        if (frame) { frame.style.maxHeight = hgt + 'px'; frame.style.height = hgt + 'px'; }
    }
    function makeResizable(handle, dir) {
        let sx, sy, ow, oh, ol, ot, down = false;
        const MIN_W = 340, MIN_H = 260;
        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (win.classList.contains('fullscreen')) return;
            if (!ensureFreePosition()) return;
            down = true;
            sx = e.clientX; sy = e.clientY;
            const r = win.getBoundingClientRect();
            ow = r.width; oh = r.height; ol = r.left; ot = r.top;
            win.style.width = ow + 'px';
            win.style.height = oh + 'px';
            win.style.maxHeight = 'none';
            applyFrameSize(oh);
            try { handle.setPointerCapture(e.pointerId); } catch (err) {}
            e.preventDefault();
            e.stopPropagation();
        });
        handle.addEventListener('pointermove', (e) => {
            if (!down) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            let nw = ow, nh = oh, nl = ol, nt = ot;
            if (dir.includes('e')) nw = Math.max(MIN_W, ow + dx);
            if (dir.includes('s')) nh = Math.max(MIN_H, oh + dy);
            if (dir.includes('w')) { nw = Math.max(MIN_W, ow - dx); nl = ol + (ow - nw); }
            if (dir.includes('n')) { nh = Math.max(MIN_H, oh - dy); nt = ot + (oh - nh); }
            if (nl < 0) { nw += nl; nl = 0; }
            if (nt < 0) { nh += nt; nt = 0; }
            if (nl + nw > window.innerWidth)  nw = window.innerWidth  - nl;
            if (nt + nh > window.innerHeight) nh = window.innerHeight - nt;
            win.style.width = nw + 'px';
            win.style.height = nh + 'px';
            win.style.left = nl + 'px';
            win.style.top = nt + 'px';
            applyFrameSize(nh);
        });
        const end = () => { down = false; };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }
    for (const dir of ['n','s','e','w','ne','nw','se','sw']) {
        const handle = h('div', { class: 'resize-handle ' + dir });
        win.append(handle);
        makeResizable(handle, dir);
    }

    const LB_GAMES = [
        { id: 'checkers-mp', name: '🌐 Шашки Онлайн', category: 'multi', modes: [] },
        { id: 'chess-mp', name: '🌐 Шахматы Онлайн', category: 'multi', modes: [] },
        { id: 'mines', name: '💣 Сапёр', category: 'solo', modes: [{ id: 'easy', name: 'Лёгкий' }, { id: 'mid', name: 'Средний' }, { id: 'hard', name: 'Сложный' }] },
        { id: 'chess', name: '♞ Шахматы', category: 'solo', modes: [] },
        { id: 'checkers', name: '⚫ Шашки', category: 'solo', modes: [] },
        { id: 'tetris', name: '🧱 Тетрис', category: 'solo', modes: [] },
        { id: 'match3', name: '💎 Три в ряд', category: 'solo', modes: [] },
        { id: 'snake', name: '🐍 Змейка', category: 'solo', modes: [{ id: 'classic', name: 'Классика' }, { id: 'wrap', name: 'Без границ' }, { id: 'maze', name: 'Лабиринт' }] },
        { id: 'pong', name: '🏓 Пинг-понг', category: 'solo', modes: [{ id: 'easy', name: 'Легко' }, { id: 'mid', name: 'Средне' }, { id: 'hard', name: 'Сложно' }] },
        { id: 'cowclicker', name: '🐄 Молочная ферма', category: 'solo', modes: [] },
    ];

    async function showLeaderboard() {
        lbModal.style.display = 'flex';
        lbModal.innerHTML = '';
        const content = h('div', { class: 'lb-content' });
        content.append(h('h3', { text: '🏆 Таблица Лидеров', style: 'text-align: center; margin-top: 0; color: var(--gold); font-size: 16px;' }));
        const catSelect = h('select', { class: 'lb-select' },
            h('option', { value: 'multi', text: '🌐 Мультиплеер' }),
            h('option', { value: 'solo', text: '🎮 Одиночные игры' })
        );
        content.append(catSelect);
        const gameSelect = h('select', { class: 'lb-select' });
        content.append(gameSelect);
        const modeSelect = h('select', { class: 'lb-select', style: 'display: none;' });
        content.append(modeSelect);
        const tableContainer = h('div', { style: 'min-height: 150px; display: flex; flex-direction: column; justify-content: center;' });
        content.append(tableContainer);
        content.append(h('div', {
            style: 'font-size: 11px; color: var(--muted); text-align: center; margin-top: 12px; margin-bottom: 12px; line-height: 1.4;',
            text: 'ℹ️ Рекорды синхронизируются с базой раз в минуту. Если вы не видите свой новый результат — подождите 60 секунд и откройте таблицу снова.'
        }));
        const refreshBtn = h('button', { class: 'btn', text: '🔄 Обновить', style: 'margin-bottom: 8px; width: 100%;', onclick: () => loadScores() });
        content.append(refreshBtn);
        content.append(h('button', { class: 'btn on', text: 'Закрыть', style: 'width: 100%;', onclick: () => { lbModal.style.display = 'none'; } }));
        lbModal.append(content);
        function updateModeList() {
            const game = LB_GAMES.find(g => g.id === gameSelect.value);
            modeSelect.innerHTML = '';
            if (game && game.modes && game.modes.length > 0) {
                modeSelect.style.display = 'block';
                game.modes.forEach(m => { modeSelect.append(h('option', { value: `${game.id}_${m.id}`, text: m.name })); });
            } else { modeSelect.style.display = 'none'; }
            loadScores();
        }
        function updateGameList() {
            const cat = catSelect.value;
            const filtered = LB_GAMES.filter(g => g.category === cat);
            gameSelect.innerHTML = '';
            if (filtered.length === 0) {
                updateModeList();
                return;
            }
            filtered.forEach(g => gameSelect.append(h('option', { value: g.id, text: g.name })));
            updateModeList();
        }
        async function loadScores() {
            let finalGameId = gameSelect.value;
            if (modeSelect.style.display === 'block') finalGameId = modeSelect.value;
            tableContainer.innerHTML = '<div style="color: var(--muted); text-align: center;">Загрузка...</div>';
            try {
                const res = await serverRequest('/api/scores/' + finalGameId);
                tableContainer.innerHTML = '';
                if (!res.success || !res.scores || res.scores.length === 0) {
                    tableContainer.append(h('div', { text: 'Пока нет рекордов. Стань первым!', style: 'text-align: center; color: var(--muted); margin: 20px 0; font-size: 13px;' }));
                } else {
                    const showLosses = finalGameId === 'checkers-mp';
                    const table = h('table', { class: 'lb-table' },
                        h('thead', {}, h('tr', {},
                            h('th', { text: '#' }),
                            h('th', { text: 'Игрок' }),
                            h('th', { text: 'Победы' }),
                            showLosses ? h('th', { text: 'Пораж.' }) : null
                        ))
                    );
                    const tbody = h('tbody');
                    res.scores.forEach((s, i) => {
                        let displayScore = s.score;
                        if (finalGameId.startsWith('mines')) displayScore = fmtTime(s.score);
                        if (finalGameId === 'cowclicker') displayScore = cowFmtNum(s.score);
                        tbody.append(h('tr', {},
                            h('td', { text: (i + 1) + '.' }),
                            h('td', { text: s.nickname, style: 'max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }),
                            h('td', { text: displayScore }),
                            showLosses ? h('td', { text: s.losses || 0, style: 'color: #ff6b6b;' }) : null
                        ));
                    });
                    table.append(tbody);
                    tableContainer.append(table);
                }
            } catch (e) { tableContainer.innerHTML = '<div style="color: var(--red); text-align: center;">Ошибка загрузки</div>'; }
        }
        catSelect.addEventListener('change', updateGameList);
        gameSelect.addEventListener('change', updateModeList);
        modeSelect.addEventListener('change', loadScores);
        if (active) {
            catSelect.value = active.category;
            updateGameList();
            const foundGame = LB_GAMES.find(g => g.id === active.id);
            if (foundGame) {
                gameSelect.value = foundGame.id;
                if (foundGame.modes && foundGame.modes.length > 0) {
                    let currentModeId = '';
                    if (active.id === 'mines') currentModeId = store.get('ms.diff', 'easy');
                    else if (active.id === 'snake') currentModeId = store.get('snake.mode', 'classic');
                    else if (active.id === 'pong') currentModeId = store.get('pong.diff', 'mid');
                    const modeVal = `${foundGame.id}_${currentModeId}`;
                    if ([...modeSelect.options].some(o => o.value === modeVal)) modeSelect.value = modeVal;
                }
                updateModeList();
            }
        } else {
            catSelect.value = 'solo';
            updateGameList();
        }
    }
    trophyBtn.addEventListener('click', () => showLeaderboard());

    function renderCards() {
        cardsEl.textContent = '';
        const renderGroup = (title, filterFn) => {
            const groupGames = games.filter(filterFn);
            if (!groupGames.length) return;
            cardsEl.append(h('div', { class: 'category-title', text: title }));
            for (const g of groupGames) {
                const card = h('button', {
                    class: 'card' + (active === g ? ' on' : ''), type: 'button', disabled: !!g.soon,
                    title: g.soon ? 'Скоро' : g.name,
                    onclick: () => select(g)
                },
                    h('div', { class: 'ico', text: g.icon, style: `--ring:${g.ring}` }),
                    h('div', { class: 'meta' },
                        h('div', { class: 'name', text: g.name }),
                        h('div', { class: 'sub', text: g.subtitle() })),
                    g.soon ? h('div', { class: 'tag', text: 'скоро' }) : null);
                cardsEl.append(card);
            }
        };
        renderGroup('🌐 Мультиплеер', g => g.category === 'multi');
        renderGroup('🎮 Одиночные игры', g => g.category === 'solo');
    }

    function select(g) {
        if (!g || active === g) return;
        lbModal.style.display = 'none';
        resetWindowSize();
        win.classList.remove('wide');
        if (active) {
            const cur = instances.get(active);
            cur.root.style.display = 'none';
            if (isOpen && cur.inst.onHide) cur.inst.onHide();
        }
        active = g;
        let entry = instances.get(g);
        if (!entry) {
            const r = h('div');
            stage.append(r);
            entry = { root: r, inst: {} };
            instances.set(g, entry);
            entry.inst = g.mount(r, {
                refreshCards: renderCards,
                submitScore: (score, customGameId = g.id, losses = 0) => {
                    // Мультиплеерные рекорды сервер считает сам при завершении матча.
                    if (customGameId === 'checkers-mp' || customGameId === 'chess-mp') return;
                    const sessions = window.lgSessions || {};
                    const sid = sessions[customGameId] || null;
                    serverRequest('/api/scores', {
                        method: 'POST',
                        body: JSON.stringify({
                            gameId: customGameId,
                            nickname: getPlayerName(),
                            score,
                            losses,
                            sessionId: sid
                        })
                    });
                }
            }) || {};
        }
        entry.root.style.display = '';
        renderCards();
        if (isOpen && entry.inst.onShow) entry.inst.onShow();
    }

    function open() {
        if (isOpen) return;
        isOpen = true; win.classList.add('open');
        if (!active) select(games.find((g) => !g.soon));
        else { const e = instances.get(active); if (e && e.inst.onShow) e.inst.onShow(); }
    }
    function close() {
        if (!isOpen) return;
        isOpen = false; win.classList.remove('open'); lbModal.style.display = 'none';
        const e = active && instances.get(active);
        if (e && e.inst.onHide) e.inst.onHide();
    }
    const toggle = () => (isOpen ? close() : open());

    function makeDraggable(handle, target, opts) {
        let sx, sy, ox, oy, moved = false, down = false;
        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || (opts.ignore && e.target.closest(opts.ignore))) return;
            down = true; moved = false; sx = e.clientX; sy = e.clientY;
            const r = target.getBoundingClientRect(); ox = r.left; oy = r.top;
            try { handle.setPointerCapture(e.pointerId); } catch (err) {}
        });
        handle.addEventListener('pointermove', (e) => {
            if (!down) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < 5) return;
            moved = true;
            const r = target.getBoundingClientRect();
            const nx = Math.min(Math.max(0, ox + dx), window.innerWidth - Math.min(r.width, 80));
            const ny = Math.min(Math.max(0, oy + dy), window.innerHeight - 40);
            target.style.transform = 'none'; target.style.left = nx + 'px'; target.style.top = ny + 'px'; target.style.right = 'auto'; target.style.bottom = 'auto';
        });
        const end = () => {
            if (!down) return;
            down = false;
            if (moved && opts.save) { const r = target.getBoundingClientRect(); store.set(opts.save, { left: Math.round(r.left), top: Math.round(r.top) }); }
        };
        handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
        return () => moved;
    }

    (function placeFab() {
        const p = store.get('fabPos', null);
        if (p && p.left >= 0 && p.top >= 0 && p.left < window.innerWidth - 40 && p.top < window.innerHeight - 40) { fab.style.left = p.left + 'px'; fab.style.top = p.top + 'px'; }
        else { fab.style.left = '16px'; fab.style.bottom = '90px'; }
    })();
    const fabMoved = makeDraggable(fab, fab, { save: 'fabPos' });
    fab.addEventListener('click', (e) => { if (fabMoved()) { e.preventDefault(); return; } toggle(); });
    makeDraggable(head, win, { ignore: '.x, .trophy-btn, .fs-btn, .reset-btn' });
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !isOpen) return;
        if (win.classList.contains('fullscreen')) { toggleFullscreen(); return; }
        close();
    });

    function register(g) { games.push(g); renderCards(); }
    register(Minesweeper);
    register(Chess);
    register(Checkers);
    register(OnlineCheckers);
    register(Tetris);
    register(Match3);
    register(Snake);
    register(Pong);
    register(OnlineChess);
    register(Doom);
    register(CowClicker);

    function mount() {
        if (!document.body) return false;
        document.body.appendChild(host);
        return true;
    }
    if (!mount()) document.addEventListener('DOMContentLoaded', mount);
    window.__LG_ARCADE__ = { register, open, close, toggle, MS, store };
})();
