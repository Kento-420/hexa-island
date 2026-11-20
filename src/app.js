// HEXA ISLAND 画面と部屋（同期）
(function () {
  'use strict';
  const E = window.Shima, G = E.G, RES = E.RES, JA = E.RES_JA;
  const ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '🪨' };
  const HEXCOL = { wood: '#2e7d4f', brick: '#c8643b', sheep: '#9fd06a', wheat: '#f0c64a', ore: '#8a94a6', desert: '#e6d3a3' };
  const PCOL = ['#e5383b', '#2b7fd4', '#ffd21f', '#9b51e0']; // 赤・青・黄・紫（白は見えにくく、黒は盗賊と紛らわしかった）
  const PEDGE = ['#17303d', '#17303d', '#17303d', '#17303d']; // コマの縁取り
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* なくても動く */ } } };
  const isLocalhost = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  // ---------- 保存先 ----------
  // テスト用：同じブラウザのタブどうしで共有するだけの保存先
  function makeMemStore() {
    const docs = new Map(), dsubs = new Map(), csubs = new Map();
    const parent = (p) => p.split('/').slice(0, -1).join('/');
    const list = (par) => { const out = []; docs.forEach((v, k) => { if (parent(k) === par) out.push(Object.assign({ id: k.split('/').pop() }, clone(v))); }); return out.sort((a, b) => (a.id < b.id ? -1 : 1)); };
    let bc = null;
    function put(path, data, remote) {
      if (data === null) docs.delete(path); else docs.set(path, clone(data));
      (dsubs.get(path) || []).slice().forEach((cb) => cb(data === null ? null : clone(data)));
      const par = parent(path); (csubs.get(par) || []).slice().forEach((cb) => cb(list(par)));
      if (bc && !remote) bc.postMessage({ path, data });
    }
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel('shima-test');
      bc.onmessage = (ev) => { const m = ev.data; if (m.hello) bc.postMessage({ dump: Array.from(docs.entries()) }); else if (m.dump) m.dump.forEach((kv) => { if (!docs.has(kv[0])) put(kv[0], kv[1], true); }); else put(m.path, m.data, true); };
      bc.postMessage({ hello: 1 });
    }
    const sub = (map, p, cb, cur) => { if (!map.has(p)) map.set(p, []); map.get(p).push(cb); setTimeout(() => cb(cur()), 0); return () => map.set(p, map.get(p).filter((x) => x !== cb)); };
    let id = null; try { id = sessionStorage.getItem('shima.uid'); if (!id) { id = 't' + Math.random().toString(36).slice(2, 8); sessionStorage.setItem('shima.uid', id); } } catch (e) { id = 't' + Math.random().toString(36).slice(2, 8); }
    return {
      uid: id, canWrite: true,
      set: async (p, d) => put(p, d), get: async (p) => (docs.has(p) ? clone(docs.get(p)) : null), del: async (p) => put(p, null),
      subDoc: (p, cb) => sub(dsubs, p, cb, () => (docs.has(p) ? clone(docs.get(p)) : null)),
      subCol: (p, cb) => sub(csubs, p, cb, () => list(p)),
    };
  }
  // 本番：このページの共有データ
  async function makeDbStore() {
    if (!window.claude || typeof window.claude.use !== 'function') return null;
    const both = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
    const db = both[0], user = both[1];
    if (!db || !user) return null;
    let id = null; try { id = await user.id(); } catch (e) { /* 下で扱う */ }
    if (!id) return null;
    let cw = null; try { cw = await user.can('data.write'); } catch (e) { /* 不明のまま */ }
    const wrap = (s) => (s.exists ? clone(s.data()) : null);
    return {
      uid: id, canWrite: cw !== false,
      set: (p, d) => db.doc(p).set(d), get: async (p) => wrap(await db.doc(p).get()), del: (p) => db.doc(p).delete(),
      subDoc: (p, cb, err) => db.doc(p).onSnapshot((s) => cb(wrap(s)), err),
      subCol: (p, cb, err) => db.collection(p).onSnapshot((q) => cb(q.docs.map((d) => Object.assign({ id: d.id }, clone(d.data())))), err),
    };
  }


  // ログイン不要の通信：部屋を作った人の端末が「親」になり、全員が親と直接つながる（PeerJS）
  const hasPeer = typeof window.Peer === 'function';
  const PEER_PREFIX = 'hirakejima-v1-';
  let peerUid = ls.get('shima.puid'); if (!peerUid) { peerUid = 'p' + Math.random().toString(36).slice(2, 10); ls.set('shima.puid', peerUid); }
  function makePeerStore() {
    const docs = new Map(), dsubs = new Map(), csubs = new Map();
    const parent = (p) => p.split('/').slice(0, -1).join('/');
    const list = (par) => { const out = []; docs.forEach((v, k) => { if (parent(k) === par) out.push(Object.assign({ id: k.split('/').pop() }, clone(v))); }); return out.sort((a, b) => (a.id < b.id ? -1 : 1)); };
    let peer = null, role = null, code = null, conns = [], hc = null, closed = false, lastSeen = 0, pingT = null, retryT = null, saveT = null, connecting = false;
    const opts = () => (isLocalhost && window.__peerOpts) || {};
    const api = { uid: peerUid, canWrite: true, onStatus: null, onReconnect: null };
    const status = (kind, msg) => { if (api.onStatus) api.onStatus(kind, msg); };
    function applyLocal(path, data) {
      if (data === null || data === undefined) docs.delete(path); else docs.set(path, clone(data));
      (dsubs.get(path) || []).slice().forEach((cb) => cb(docs.has(path) ? clone(docs.get(path)) : null));
      const par = parent(path); (csubs.get(par) || []).slice().forEach((cb) => cb(list(par)));
      if (role === 'host') { clearTimeout(saveT); saveT = setTimeout(() => ls.set('shima.hostdump', JSON.stringify({ code, docs: Array.from(docs.entries()) })), 300); }
    }
    const broadcast = (m) => conns.forEach((c) => { if (c.open) { try { c.send(m); } catch (e) { /* 切れた相手は無視 */ } } });
    function put(path, data) {
      applyLocal(path, data);
      if (role === 'host') broadcast({ k: 'set', p: path, d: data });
      else if (hc && hc.open) { try { hc.send({ k: 'set', p: path, d: data }); } catch (e) { /* つなぎ直しで回復 */ } }
    }
    api.host = (c, restore) => {
      role = 'host'; code = c; if (restore) restore.forEach((kv) => docs.set(kv[0], kv[1]));
      return new Promise((res, rej) => {
        let done = false;
        peer = new window.Peer(PEER_PREFIX + c, opts());
        peer.on('open', () => { if (!done) { done = true; res(); } status('ok', ''); });
        peer.on('connection', (conn) => {
          conns.push(conn);
          conn.on('open', () => { try { conn.send({ k: 'dump', docs: Array.from(docs.entries()) }); } catch (e) { /* 次のつなぎ直しで送る */ } });
          conn.on('data', (m) => { if (!m) return; if (m.k === 'set' && typeof m.p === 'string') { applyLocal(m.p, m.d); broadcast({ k: 'set', p: m.p, d: m.d }); } else if (m.k === 'ping') { try { conn.send({ k: 'pong' }); } catch (e) { /* 無視 */ } } });
          const drop = () => { conns = conns.filter((x) => x !== conn); };
          conn.on('close', drop); conn.on('error', drop);
        });
        peer.on('disconnected', () => { if (closed) return; status('warn', '仲介サーバーとの接続が切れました。つなぎ直しています…'); setTimeout(() => { if (!closed && peer && peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch (e) { /* 次の機会に */ } } }, 1500); });
        peer.on('error', (e) => { if (!done) { done = true; rej(e); } });
      });
    };
    function connect(first) {
      connecting = true;
      return new Promise((res, rej) => {
        let done = false;
        const fin = (ok, e) => { if (done) return; done = true; connecting = false; clearTimeout(to); if (ok) res(); else rej(e); };
        const to = setTimeout(() => fin(false, { type: 'timeout' }), 15000);
        try { if (peer && !peer.destroyed) peer.destroy(); } catch (e) { /* 無視 */ }
        const pr = peer = new window.Peer(undefined, opts());
        pr.on('open', () => {
          const conn = hc = pr.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
          conn.on('open', () => { lastSeen = Date.now(); });
          conn.on('data', (m) => {
            lastSeen = Date.now(); if (!m) return;
            if (m.k === 'dump') {
              const nw = new Map(m.docs), keys = new Set(Array.from(docs.keys()).concat(Array.from(nw.keys())));
              keys.forEach((k) => { const a = docs.has(k) ? JSON.stringify(docs.get(k)) : null, b = nw.has(k) ? JSON.stringify(nw.get(k)) : null; if (a !== b) applyLocal(k, nw.has(k) ? nw.get(k) : null); });
              fin(true); status('ok', ''); if (!first && api.onReconnect) api.onReconnect();
            } else if (m.k === 'set' && typeof m.p === 'string') applyLocal(m.p, m.d);
          });
          conn.on('close', () => lost(pr)); conn.on('error', () => lost(pr));
        });
        pr.on('error', (e) => { if (!done) fin(false, e); else lost(pr); });
      });
    }
    function lost(pr) {
      if (closed || pr !== peer || retryT || connecting) return;
      status('warn', '親の端末との接続が切れました。つなぎ直しています…');
      const again = () => { retryT = null; if (closed) return; connect(false).catch(() => { if (!closed) retryT = setTimeout(again, 3000); }); };
      retryT = setTimeout(again, 1200);
    }
    api.join = (c) => { role = 'guest'; code = c; return connect(true).then(() => { pingT = setInterval(() => { if (closed) return; if (hc && hc.open) { try { hc.send({ k: 'ping' }); } catch (e) { /* 下で拾う */ } } if (Date.now() - lastSeen > 16000) lost(peer); }, 5000); }); };
    const onVis = () => {
      if (closed || document.visibilityState !== 'visible' || !peer) return;
      if (role === 'host') { if (peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch (e) { /* 無視 */ } } }
      else if (!(hc && hc.open)) lost(peer);
    };
    document.addEventListener('visibilitychange', onVis);
    api.close = () => { closed = true; clearInterval(pingT); clearTimeout(retryT); clearTimeout(saveT); document.removeEventListener('visibilitychange', onVis); try { if (peer) peer.destroy(); } catch (e) { /* 無視 */ } };
    const sub = (map, p, cb, cur) => { if (!map.has(p)) map.set(p, []); map.get(p).push(cb); setTimeout(() => cb(cur()), 0); return () => map.set(p, map.get(p).filter((x) => x !== cb)); };
    api.set = async (p, d) => put(p, d); api.get = async (p) => (docs.has(p) ? clone(docs.get(p)) : null); api.del = async (p) => put(p, null);
    api.subDoc = (p, cb) => sub(dsubs, p, cb, () => (docs.has(p) ? clone(docs.get(p)) : null));
    api.subCol = (p, cb) => sub(csubs, p, cb, () => list(p));
    return api;
  }
  const peerErr = (e) => { const t = e && e.type; return t === 'peer-unavailable' ? 'その部屋は見つかりません。コードと、親の端末が部屋を開いたままかを確認してください' : t === 'timeout' ? 'つながりませんでした。どちらかがWi-Fiとモバイル回線を切り替えると、つながることがあります' : '仲介サーバーにつながりません。少し待ってやり直してください'; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 状態 ----------
  let store = null, net = 'checking'; // checking | on（共有データ） | peer（端末どうし） | off
  let screen = 'home';
  let myName = ls.get('shima.name') || '';
  let codeInput = '';
  let cpuLevel = +(ls.get('shima.lv') || 2); if (!(cpuLevel >= 1 && cpuLevel <= 3)) cpuLevel = 2;
  let room = null;   // {code, local, host, seats, inputs, unsub, slow}
  let S = null, me = -1;
  let busy = false;
  const blankUi = () => ({ confirm: null, pv: 0, sel: null, counter: false, mode: null, sheet: null, tab: 'bank', give: E.zero(), want: E.zero(), disc: E.zero(), bankGive: null, bankPick: [], pick: [], view: 0, sentDiscard: false, sentTrade: 0 });
  let ui = blankUi();
  let lastTurnKey = '', lastStealRev = 0, lastMonoKey = '';
  let robFx = null, robTimer = null, prevRob = null, chipFx = {}, chipTimer = null, prevNeed = null;
  // 開始時にタイルを伏せておき、外側から順にめくる
  let reveal = null, revealTimer = null, seenGame = '';
  const REVEAL_GAP = 90, REVEAL_ORDER = (function () { const idx = G.hexes.map((_, i) => i).sort((a, b) => { const A = G.hexes[a], B = G.hexes[b], da = Math.round(Math.hypot(A.x, A.y)), db = Math.round(Math.hypot(B.x, B.y)); return db - da || Math.atan2(A.y, A.x) - Math.atan2(B.y, B.x); }); const o = []; idx.forEach((h, k) => { o[h] = k; }); return o; })();
  // 振動（対応している端末だけ。設定は端末に残る）
  const canVib = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  // 振動の強さ 0=オフ 1=弱 2=ふつう 3=強（端末に残る）
  let vibLv = (function () { const v = ls.get('shima.vib2'); if (v !== null && /^[0-3]$/.test(v)) return +v; return ls.get('shima.vib') === '0' ? 0 : 2; })();
  const VIBJA = ['オフ', '弱', 'ふつう', '強'];
  // 短すぎる振動は多くのAndroid端末で感じ取れないので、長さを底上げして送る
  const buzz = (p) => {
    if (!canVib || !vibLv) return;
    const k = [0, 0.8, 1.3, 2.2][vibLv], lo = [0, 22, 32, 45][vibLv];
    const arr = (Array.isArray(p) ? p : [p]).map((x, i) => (i % 2 ? Math.max(70, x) : Math.max(lo, Math.round(x * k))));
    try { navigator.vibrate(arr); } catch (e) { /* 対応していなければ何もしない */ }
  };
  function vibTest() {
    if (!canVib) { toast('このブラウザは振動に対応していません。Chromeで開いてください'); return; }
    let ok = false; try { ok = navigator.vibrate([120, 80, 120]); } catch (e) { ok = false; }
    toast(ok ? '振動を送りました。震えなければ、本体のマナーモード・おやすみモード・省電力と「バイブと触覚」の設定を見てください' : 'ブラウザに振動を止められました。Chromeで直接このページを開いてください');
  }
  let lastTradeId = 0, lastCounterN = 0, lastOver = '';
  let fx = null, fxTimer = null, lastGainKey = '', handFx = null, handTimer = null, prevHand = null, cpuTimer = null;
  const dl = (t) => 'style="animation-delay:-' + Math.max(0, Date.now() - t) + 'ms"';
  const demo = E.newGame([{ uid: 'a', name: '' }, { uid: 'b', name: '' }, { uid: 'c', name: '' }]); // タイトル画面用（伏せたまま見せる）

  const meSeat = () => (room && room.local ? (room.cpu ? room.human : ui.view) : me);
  const sid = () => String(store.uid).replace(/[^A-Za-z0-9_~:@+-]/g, '_');

  let toastTimer = null;
  function toast(t, ms) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), Math.max(ms || 2600, t.length * 110)); }
  // 札が動く様子：画面上のある場所から別の場所へ、札を1枚飛ばす
  function fly(fromSel, toSel, html) {
    const a = document.querySelector(fromSel), b = document.querySelector(toSel);
    if (!a || !b || !document.body.animate || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const x0 = ra.left + ra.width / 2, y0 = ra.top + ra.height / 2, dx = rb.left + rb.width / 2 - x0, dy = rb.top + rb.height / 2 - y0;
    const el = document.createElement('div'); el.className = 'flyc'; el.innerHTML = html; el.style.left = x0 + 'px'; el.style.top = y0 + 'px'; document.body.appendChild(el);
    const c = 'translate(-50%,-50%) ', end = 'translate(calc(-50% + ' + dx + 'px),calc(-50% + ' + dy + 'px)) ';
    const an = el.animate([{ transform: c + 'scale(.5)', opacity: 0 }, { transform: c + 'scale(1.6)', opacity: 1, offset: 0.14 }, { transform: c + 'scale(1.6)', opacity: 1, offset: 0.42 }, { transform: end + 'scale(1)', opacity: 1, offset: 0.86 }, { transform: end + 'scale(.8)', opacity: 0 }], { duration: 2100, easing: 'ease-in-out' });
    an.onfinish = () => el.remove(); setTimeout(() => el.remove(), 2600);
  }

  // ---------- 部屋 ----------
  const makeCode = () => { let s = ''; for (let i = 0; i < 4; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)]; return s; };
  const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  function needName() { myName = myName.trim().slice(0, 8); if (!myName) { toast('先に名前を入れてください'); return true; } ls.set('shima.name', myName); return false; }

  async function createRoom() {
    if (busy || needName()) return; busy = true; render();
    try {
      let code = makeCode();
      if (net === 'peer') {
        leaveRoom(); let ps = null;
        for (let i = 0; i < 4 && !ps; i++) { const x = makePeerStore(); try { await x.host(code); ps = x; } catch (e) { x.close(); if (!e || e.type !== 'unavailable-id') throw e; code = makeCode(); } }
        if (!ps) throw new Error('code');
        store = ps;
      } else for (let i = 0; i < 5; i++) { if (!(await store.get('games/' + code))) break; code = makeCode(); }
      await store.set('games/' + code, { host: store.uid, t: Date.now() });
      await enterRoom(code);
    } catch (e) { if (net === 'peer') toast(peerErr(e)); else fail(e); }
    busy = false; render();
  }
  // 親の端末がページを開き直したとき：同じコードで部屋を開き直し、保存してあった盤面を戻す
  async function rehost(code, docs) {
    if (busy) return; busy = true; render();
    leaveRoom(); let ps = null, err = null;
    for (let i = 0; i < 4 && !ps; i++) { const x = makePeerStore(); try { await x.host(code, docs); ps = x; } catch (e) { x.close(); err = e; if (!e || e.type !== 'unavailable-id') break; await wait(2500); } }
    if (ps) { store = ps; try { await enterRoom(code); } catch (e) { toast(peerErr(e)); } } else toast(peerErr(err));
    busy = false; render();
  }
  async function joinRoom(code) {
    code = normCode(code);
    if (busy || needName()) return;
    if (code.length !== 4) { toast('部屋コードは4文字です'); return; }
    busy = true; render();
    try {
      if (net === 'peer') { leaveRoom(); const x = makePeerStore(); try { await x.join(code); } catch (e) { x.close(); throw e; } store = x; }
      if (!(await store.get('games/' + code))) toast('その部屋は見つかりません。コードを確認してください');
      else await enterRoom(code);
    } catch (e) { if (net === 'peer') toast(peerErr(e)); else fail(e); }
    busy = false; render();
  }
  function fail(e) {
    if (e && e.code === 'invalid_argument') { store.canWrite = false; toast('書き込めません。持ち主に「編集者」として招待してもらってください'); }
    else toast('通信に失敗しました。少し待ってやり直してください');
  }
  async function enterRoom(code) {
    leaveRoom();
    room = { code, local: false, host: null, seats: [], inputs: [], unsub: [], slow: false, loaded: false };
    S = null; me = -1; ui = blankUi(); screen = 'lobby'; ls.set('shima.room', code);
    if (net === 'peer') {
      const r0 = room, ps = store; r0.pstore = ps;
      ps.onStatus = (k, msg) => { if (room !== r0) return; r0.netMsg = k === 'ok' ? '' : msg; render(); };
      ps.onReconnect = () => { if (room !== r0) return; ui.sentDiscard = false; ui.sentTrade = 0; if (iDrive()) pushState(); render(); };
    }
    const base = 'games/' + code;
    const mine = await store.get(base + '/seats/' + sid());
    if (!mine || mine.name !== myName) await store.set(base + '/seats/' + sid(), { uid: store.uid, name: myName, t: mine ? mine.t : Date.now() });
    const r = room, onErr = () => { if (room === r) toast('接続が切れました。ページを開き直してください'); };
    const timer = setTimeout(() => { if (room === r && !r.loaded) { r.slow = true; render(); } }, 10000);
    r.unsub.push(() => clearTimeout(timer));
    r.unsub.push(store.subDoc(base, (d) => { if (room !== r) return; r.host = d ? d.host : null; render(); }, onErr));
    r.unsub.push(store.subCol(base + '/seats', (l) => { if (room !== r) return; r.loaded = true; r.slow = false; clearTimeout(timer); r.seats = l.sort((a, b) => (a.t || 0) - (b.t || 0)); render(); }, onErr));
    r.unsub.push(store.subDoc(base + '/live/state', (d) => {
      if (room !== r) return;
      if (!d) { // 親が「待合にもどる」を選んだ：全員を待合へ戻す
        if (S && screen === 'game') { if (cpuTimer) { clearTimeout(cpuTimer); cpuTimer = null; } S = null; me = -1; screen = 'lobby'; ui = blankUi(); toast('待合にもどりました'); render(); }
        return;
      }
      onState(d);
    }, onErr));
    r.unsub.push(store.subCol(base + '/inputs', (l) => { if (room !== r) return; r.inputs = l; setTimeout(processInputs, 0); }, onErr));
  }
  function leaveRoom() { if (cpuTimer) { clearTimeout(cpuTimer); cpuTimer = null; } clearTimeout(revealTimer); reveal = null; fx = null; handFx = null; prevHand = null; if (room && room.pstore) { try { room.pstore.close(); } catch (e) { /* 無視 */ } if (store === room.pstore) store = null; } if (room && room.unsub) room.unsub.forEach((u) => { try { u(); } catch (e) { /* 無視 */ } }); room = null; S = null; me = -1; }

  function onState(d) {
    if (S && !(d.rev > S.rev)) return;
    let n; try { n = JSON.parse(d.s); } catch (e) { return; }
    S = n; me = S.players.findIndex((p) => p.uid === store.uid); screen = 'game';
    afterChange(); setTimeout(processInputs, 0);
  }
  function startGame() {
    const seats = room.seats.slice(0, 4);
    if (seats.length < 2) { toast('2人以上そろってから始めてください'); return; }
    const order = seats.map((s) => ({ uid: s.uid, name: s.name, cpu: s.cpu ? (s.level || 2) : 0 }));
    cpuSent = {};
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
    const n = E.newGame(order); n.rev = (S ? S.rev : 0) + 1;
    S = n; me = S.players.findIndex((p) => p.uid === store.uid); screen = 'game'; ui = blankUi();
    afterChange(); pushState();
  }
  function startLocal(count) {
    leaveRoom();
    room = { code: null, local: true, unsub: [] };
    const names = ['あか', 'あお', 'きいろ', 'むらさき'].slice(0, count);
    S = E.newGame(names.map((nm, i) => ({ uid: 'local' + i, name: nm }))); ui = blankUi(); screen = 'game';
    afterChange();
  }

  function startCpu(count) {
    leaveRoom();
    const ps = [{ uid: 'human', name: myName.trim().slice(0, 8) || 'あなた' }];
    for (let i = 1; i < count; i++) ps.push({ uid: 'cpu' + i, name: 'CPU' + i });
    for (let i = ps.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = ps[i]; ps[i] = ps[j]; ps[j] = t; }
    room = { code: null, local: true, cpu: true, human: 0, level: cpuLevel, unsub: [] };
    S = E.newGame(ps); room.human = S.players.findIndex((q) => q.uid === 'human'); ui = blankUi(); screen = 'game';
    afterChange();
  }
  // CPUの手番・捨て札・交渉の返事を、少し間をあけて1手ずつ進める
  function cpuPending() {
    if (!S || !room || S.phase === 'over') return null;
    let cs = [];
    if (room.local) { if (room.cpu) cs = S.players.map((_, i) => i).filter((i) => i !== room.human); }
    else if (store && room.host === store.uid) cs = S.players.map((p, i) => (p.cpu ? i : -1)).filter((i) => i >= 0);
    if (!cs.length) return null;
    const fresh = (i, kind) => !cpuSent[cpuKey(i, kind)];
    if (S.phase === 'discard') { const s = cs.find((i) => S.discardNeed[i] && fresh(i, 'discard')); return s === undefined ? null : { seat: s, kind: 'discard' }; }
    if (S.trade && cs.indexOf(S.turn) < 0) { const s = cs.find((i) => S.trade.resp[i] === undefined && fresh(i, 'resp')); return s === undefined ? null : { seat: s, kind: 'resp' }; }
    return cs.indexOf(S.turn) >= 0 ? { seat: S.turn, kind: 'turn' } : null;
  }
  let cpuSent = {};
  const cpuKey = (seat, kind) => S.gameId + ':' + S.rev + ':' + seat + ':' + kind;
  const cpuLv = (seat) => (room.local ? room.level : S.players[seat].cpu) || 2;
  function scheduleCpu() {
    if (cpuTimer || reveal) return; const pd = cpuPending(); if (!pd) return;
    const delay = pd.kind !== 'turn' ? 450 : S.phase === 'roll' ? 900 : (fx && Date.now() - fx.t < 1500 ? 2100 : robFx && Date.now() - robFx.t < 1500 ? 2300 : 700);
    cpuTimer = setTimeout(cpuStep, delay);
  }
  function cpuStep() {
    cpuTimer = null; const pd = cpuPending(); if (!pd) return;
    let a = null;
    try {
      if (pd.kind === 'resp') { const ans = window.ShimaAI.respond(S, pd.seat, cpuLv(pd.seat)); a = ans && typeof ans === 'object' ? { t: 'counterTrade', id: S.trade.id, give: ans.give, want: ans.want } : { t: 'respondTrade', id: S.trade.id, ok: !!ans }; }
      else a = window.ShimaAI.decide(S, pd.seat, cpuLv(pd.seat));
    } catch (e) { a = null; }
    if (!room.local && !iDrive()) { // ほかの人の番：親から「操作のお願い」として送る
      if (!a) return;
      cpuSent[cpuKey(pd.seat, pd.kind)] = 1;
      store.set('games/' + room.code + '/inputs/s' + pd.seat, { n: Date.now(), g: S.gameId, a: JSON.stringify(a) }).catch(fail);
      scheduleCpu(); return;
    }
    let n = clone(S), r = a ? E.apply(n, pd.seat, a) : { err: 1 };
    if (r.err) { // 念のための保険：止まらないように進める
      const fb = pd.kind === 'resp' ? { t: 'respondTrade', id: S.trade.id, ok: false } : S.phase === 'roll' ? { t: 'roll' } : S.phase === 'main' ? { t: 'endTurn' } : null;
      if (!fb) return; n = clone(S); if (E.apply(n, pd.seat, fb).err) return;
    }
    S = n; afterChange(); pushState();
  }

  // ルールを進める端末：手番の人の端末。手番がCPUのときは親の端末
  const iDrive = () => !!(S && room && !room.local && store && S.phase !== 'over' && ((me >= 0 && me === S.turn) || (S.players[S.turn].cpu && room.host === store.uid)));
  let writing = false, dirty = false;
  async function pushState() {
    if (!room || room.local) return;
    if (writing) { dirty = true; return; }
    writing = true;
    const r = room;
    do {
      dirty = false; const snap = S;
      try { await store.set('games/' + r.code + '/live/state', { rev: snap.rev, s: JSON.stringify(snap) }); }
      catch (e) { fail(e); break; }
    } while (dirty && room === r);
    writing = false;
  }
  // 手番の人の端末が、ほかの人の操作（捨て札・交渉の返事）を取りこむ
  function processInputs() {
    if (!iDrive()) return;
    let changed = false;
    room.inputs.forEach((d) => {
      const seat = parseInt(String(d.id).slice(1), 10);
      if (!(seat >= 0) || seat === me || seat >= S.players.length || d.g !== S.gameId || !(d.n > (S.seen[seat] || 0))) return;
      let a; try { a = JSON.parse(d.a); } catch (e) { return; }
      const n = clone(S), res = E.apply(n, seat, a);
      if (res.err) { S.seen[seat] = d.n; S.rev++; } else { n.seen[seat] = d.n; S = n; }
      changed = true;
    });
    if (changed) { afterChange(); pushState(); }
  }
  function act(a, seat) {
    if (seat === undefined) seat = meSeat();
    if (!S || seat < 0) return false;
    const n = clone(S), r = E.apply(n, seat, a);
    if (r.err) { toast(r.err); return false; }
    if (room.local || iDrive()) { if (a.t === 'placeSettlement' || a.t === 'placeRoad' || a.t === 'buildCity' || a.t === 'moveRobber') buzz(12); S = n; afterChange(); pushState(); }
    else {
      store.set('games/' + room.code + '/inputs/s' + seat, { n: Date.now(), g: S.gameId, a: JSON.stringify(a) }).catch(fail);
      if (a.t === 'discard') ui.sentDiscard = true;
      if (a.t === 'respondTrade' || a.t === 'counterTrade') { ui.sentTrade = a.id; ui.counter = false; }
      render();
    }
    return true;
  }

  function afterChange() {
    if (room.local && !room.cpu) ui.view = S.phase === 'discard' ? +Object.keys(S.discardNeed)[0] : S.turn;
    const m = meSeat();
    if (S.phase !== 'main' || m !== S.turn) ui.mode = null;
    else if (ui.mode && whyNot(ui.mode, m)) ui.mode = null;
    if (ui.sel && !inTargets(targets(), ui.sel)) ui.sel = null;
    if (S.phase !== 'discard') { ui.sentDiscard = false; ui.disc = E.zero(); }
    if (!S.trade) { ui.sentTrade = 0; ui.counter = false; }
    if (['trade', 'plenty', 'mono'].indexOf(ui.sheet) >= 0 && (m !== S.turn || (S.phase !== 'main' && S.phase !== 'roll'))) ui.sheet = null;
    if (ui.sheet === 'trade' && S.phase !== 'main') ui.sheet = null;
    const key = S.gameId + ':' + S.turn + ':' + (S.phase === 'setup' ? S.setup.i : S.phase === 'roll' ? 'r' : '');
    if ((!room.local || room.cpu) && m === S.turn && key !== lastTurnKey && (S.phase === 'roll' || S.phase === 'setup')) { toast('あなたの番です'); buzz([30, 60, 30]); }
    lastTurnKey = key;
    const st = S.lastSteal;
    let hit = false; // この変化で、自分の札がほかの人にとられたか
    const flies = [], chip = (i) => '.pl[data-i="' + i + '"]', cell = (r) => '.rc[data-r="' + r + '"]', nm = (i) => S.players[i].name;
    const solo = !room.local || room.cpu; // 自分の席が決まっている（1台まわしでは手札の中身を出さない）
    if (st && st.rev > lastStealRev) {
      lastStealRev = st.rev;
      if (solo && st.from === m) { hit = true; toast(ICON[st.res] + JA[st.res] + ' を ' + nm(st.by) + ' にうばわれた', 4200); buzz([60, 50, 90]); flies.push([cell(st.res), chip(st.by), ICON[st.res]]); }
      else if (solo && st.by === m) { toast(nm(st.from) + ' から ' + ICON[st.res] + JA[st.res] + ' をうばった', 3600); flies.push([chip(st.from), cell(st.res), ICON[st.res]]); }
      else flies.push([chip(st.from), chip(st.by), '?']);
    }
    const mo = S.lastMono, mk = S.gameId + ':' + (mo ? mo.n : 0);
    if (mo && mk !== lastMonoKey && lastMonoKey !== '') {
      if (solo && mo.from[m]) { hit = true; toast('独占：' + ICON[mo.res] + JA[mo.res] + ' ' + mo.from[m] + '枚を ' + nm(mo.by) + ' にとられた', 4200); buzz([60, 50, 90]); flies.push([cell(mo.res), chip(mo.by), ICON[mo.res] + mo.from[m]]); }
      else Object.keys(mo.from).forEach((k) => { if (+k !== m) flies.push([chip(k), solo && mo.by === m ? cell(mo.res) : chip(mo.by), ICON[mo.res] + mo.from[k]]); });
    }
    lastMonoKey = mk;
    // 新しいゲームの始まり：タイルを伏せた状態から順にめくる
    if (S.gameId !== seenGame) {
      seenGame = S.gameId; lastTradeId = 0; lastCounterN = 0; prevRob = S.robber; prevNeed = {}; chipFx = {}; robFx = null;
      if (S.phase === 'setup' && S.setup.i === 0 && S.setup.need === 's') {
        reveal = { t: Date.now() }; clearTimeout(revealTimer);
        revealTimer = setTimeout(() => { reveal = null; buzz(25); if (screen === 'game' && S) { render(); scheduleCpu(); } }, REVEAL_GAP * G.hexes.length + 700);
      }
    }
    // 盗賊が動いた：元の場所から滑らせ、行き先を囲む
    if (prevRob !== null && S.robber !== prevRob) {
      robFx = { t: Date.now(), from: prevRob, to: S.robber }; clearTimeout(robTimer);
      robTimer = setTimeout(() => { robFx = null; if (screen === 'game' && S) render(); }, 3300);
      const hx = S.hexes[S.robber], where = hx.res === 'desert' ? '砂漠' : ICON[hx.res] + hx.num;
      const mine = m >= 0 && G.hexes[S.robber].v.some((v) => S.bld[v] && S.bld[v].p === m);
      if (m !== S.turn || room.local && !room.cpu) { if (mine) { toast('盗賊があなたの ' + where + ' に来た（ここは資源が出ない）', 3800); buzz([50, 40, 50]); } else toast(esc(S.players[S.turn].name) + ' が盗賊を ' + where + ' へ動かした', 3000); }
    }
    prevRob = S.robber;
    // 7の捨て札：捨て終わった人の席に「−○枚」を出す
    if (prevNeed) Object.keys(prevNeed).forEach((k) => { if (!S.discardNeed[k]) { chipFx[k] = { t: Date.now(), n: prevNeed[k] }; clearTimeout(chipTimer); chipTimer = setTimeout(() => { chipFx = {}; if (screen === 'game' && S) render(); }, 3000); } });
    prevNeed = clone(S.discardNeed);
    // 振動：交渉が届いた・逆提案が来た・決着
    if (S.trade) {
      if (S.trade.id !== lastTradeId) { lastTradeId = S.trade.id; lastCounterN = 0; if (m >= 0 && m !== S.turn && !room.local) buzz([25, 50, 25]); }
      const cn = S.trade.counters ? Object.keys(S.trade.counters).length : 0;
      if (cn > lastCounterN && m === S.turn) buzz(25);
      lastCounterN = cn;
    }
    if (S.phase === 'over' && lastOver !== S.gameId) { lastOver = S.gameId; buzz([100, 60, 100, 60, 220]); }
    // 収入の演出（サイコロと初期配置）
    const lg = S.lastGain, gk = S.gameId + ':' + (lg ? lg.seq : 0);
    if (lg && gk !== lastGainKey && lastGainKey !== '') { if (lg.roll === 7) buzz([60, 40, 60]); else if (lg.roll) buzz(m >= 0 && lg.g[m] && Object.keys(lg.g[m]).length ? [20, 40, 45] : 15); }
    if (lg && gk !== lastGainKey) { fx = { t: Date.now(), roll: lg.roll, hexes: lg.hexes, g: lg.g }; clearTimeout(fxTimer); fxTimer = setTimeout(() => { fx = null; if (screen === 'game' && S) render(); }, 3300); }
    lastGainKey = gk;
    // 自分の手札が増えた・減ったところを光らせる（交換や強奪もふくむ）
    if (m >= 0) {
      const h = S.players[m].res, hk = S.gameId + ':' + m;
      if (prevHand && prevHand.k === hk) {
        const d = {}; let any = false;
        RES.forEach((r) => { if (h[r] !== prevHand.h[r]) { d[r] = h[r] - prevHand.h[r]; any = true; } });
        // とられた・捨てさせられたときは強く、自分で使ったとき（建設・交換）は控えめに見せる
        const strong = hit || (!!prevHand.need && !S.discardNeed[m]);
        if (any) { handFx = { t: Date.now(), d, strong }; clearTimeout(handTimer); handTimer = setTimeout(() => { handFx = null; if (screen === 'game' && S) render(); }, strong ? 2600 : 1700); }
      }
      prevHand = { k: hk, h: Object.assign({}, h), need: S.discardNeed[m] || 0 };
    }
    render(); scheduleCpu();
    flies.forEach((x) => fly(x[0], x[1], x[2]));
  }

  // ---------- 盤面 ----------
  // 今タップできる場所。自分の番の建設フェーズでは、建てられるものを最初から全部光らせる
  function targets() {
    const t = { v: [], c: [], e: [], h: [], col: '#fff', sel: ui.sel };
    if (!S || S.phase === 'over' || reveal) return t;
    const m = meSeat(); if (m < 0 || m !== S.turn) return t;
    const p = S.players[m]; t.col = PCOL[m];
    if (S.phase === 'setup') { if (S.setup.need === 's') t.v = E.legalSettlements(S, m); else t.e = E.legalRoads(S, m); }
    else if (S.phase === 'robber') t.h = S.hexes.map((_, i) => i).filter((i) => i !== S.robber);
    else if (S.phase === 'roadbuilding') t.e = E.legalRoads(S, m);
    else if (S.phase === 'main' && !S.trade) {
      const want = (k) => !ui.mode || ui.mode === k;
      if (want('road') && p.roadsLeft > 0 && E.canAfford(p, E.COST.road)) t.e = E.legalRoads(S, m);
      if (want('settle') && p.settlementsLeft > 0 && E.canAfford(p, E.COST.settlement)) t.v = E.legalSettlements(S, m);
      if (want('city') && p.citiesLeft > 0 && E.canAfford(p, E.COST.city)) t.c = E.legalCities(S, m);
    }
    return t;
  }
  const inTargets = (t, x) => !!x && (t[x.k] || []).indexOf(x.i) >= 0;
  const HOUSE = 'M-8,8V-2L0,-10L8,-2V8Z', CITY = 'M-12,9V-4L-6,-11L0,-4V-1H12V9Z';
  // 建てられない理由（建てられるなら空文字）
  function whyNot(k, m) {
    const p = S.players[m], cost = E.COST[{ road: 'road', settle: 'settlement', city: 'city', dev: 'dev' }[k]];
    if (k === 'road' && p.roadsLeft <= 0) return '道のコマが残っていません';
    if (k === 'settle' && p.settlementsLeft <= 0) return '開拓地のコマが残っていません（都市にすると戻ります）';
    if (k === 'city' && p.citiesLeft <= 0) return '都市のコマが残っていません';
    if (k === 'dev' && !S.devDeck.length) return '発展カードは売り切れです';
    const lack = lackHtml(p, cost); if (lack) return 'あと ' + lack + ' 足りません';
    if (k === 'road' && !E.legalRoads(S, m).length) return '道を置ける場所がありません';
    if (k === 'settle' && !E.legalSettlements(S, m).length) return '建てられる場所がありません。道をのばすと建てられます';
    if (k === 'city' && !E.legalCities(S, m).length) return '都市にできる開拓地がありません';
    return '';
  }
  const lackHtml = (p, cost) => RES.filter((r) => (cost[r] || 0) > p.res[r]).map((r) => ICON[r] + (cost[r] - p.res[r] > 1 ? cost[r] - p.res[r] : '')).join('');
  const f = (n) => n.toFixed(1);
  function boardSVG(B, tg, gfx, cover, rfx) {
    let o = '<svg class="board" viewBox="-262 -236 524 472" role="img" aria-label="盤面">';
    if (!cover) B.ports.forEach((p) => { // タイルを伏せている間は港も見せない
      const ed = G.edges[p.e], m = G.mid(ed), hx = G.hexes[ed.hexes[0]];
      let dx = m.x - hx.x, dy = m.y - hx.y; const l = Math.hypot(dx, dy); dx /= l; dy /= l;
      const bx = m.x + dx * 25, by = m.y + dy * 25;
      [ed.a, ed.b].forEach((v) => { o += '<line class="pier" x1="' + f(bx) + '" y1="' + f(by) + '" x2="' + f(G.verts[v].x) + '" y2="' + f(G.verts[v].y) + '"/>'; });
      o += '<circle class="port" cx="' + f(bx) + '" cy="' + f(by) + '" r="13"/>';
      if (p.type === 'any') o += '<text class="ptx" x="' + f(bx) + '" y="' + f(by + 4) + '">3:1</text>';
      else o += '<text class="pic" x="' + f(bx) + '" y="' + f(by - 1) + '">' + ICON[p.type] + '</text><text class="ptx s" x="' + f(bx) + '" y="' + f(by + 10) + '">2:1</text>';
    });
    B.hexes.forEach((h, i) => {
      const g = G.hexes[i];
      o += '<polygon class="hex" points="' + g.v.map((v) => f(G.verts[v].x) + ',' + f(G.verts[v].y)).join(' ') + '" fill="' + HEXCOL[h.res] + '"/>';
      if (h.res !== 'desert') {
        const hot = h.num === 6 || h.num === 8, pips = 6 - Math.abs(7 - h.num);
        o += '<text class="hic" x="' + f(g.x) + '" y="' + f(g.y - 17) + '">' + ICON[h.res] + '</text>';
        o += '<circle class="tok" cx="' + f(g.x) + '" cy="' + f(g.y + 10) + '" r="15"/><text class="num' + (hot ? ' hot' : '') + '" x="' + f(g.x) + '" y="' + f(g.y + 13) + '">' + h.num + '</text>';
        for (let k = 0; k < pips; k++) o += '<circle class="pip' + (hot ? ' hot' : '') + '" cx="' + f(g.x + (k - (pips - 1) / 2) * 4) + '" cy="' + f(g.y + 19.5) + '" r="1.3"/>';
      }

    });
    if (cover) B.hexes.forEach((h, i) => {
      const g = G.hexes[i], rel = g.v.map((v) => f(G.verts[v].x - g.x) + ',' + f(G.verts[v].y - g.y)).join(' ');
      o += '<g transform="translate(' + f(g.x) + ',' + f(g.y) + ')"><g class="cov' + (cover.all ? ' still' : '') + '"' + (cover.all ? '' : ' style="animation-delay:' + Math.round(REVEAL_GAP * REVEAL_ORDER[i] - (Date.now() - cover.t)) + 'ms"') + '><polygon points="' + rel + '"/><text y="10">?</text></g></g>';
    });
    if (gfx && gfx.hexes.length) {
      const pts = (i) => G.hexes[i].v.map((v) => f(G.verts[v].x) + ',' + f(G.verts[v].y)).join(' ');
      if (gfx.roll) B.hexes.forEach((h, i) => { if (gfx.hexes.indexOf(i) < 0) o += '<polygon class="fxdim" ' + dl(gfx.t) + ' points="' + pts(i) + '"/>'; });
      gfx.hexes.forEach((i) => { o += '<polygon class="fxhex" ' + dl(gfx.t) + ' points="' + pts(i) + '"/>'; });
    }
    B.roads.forEach((s, e) => {
      if (s === null) return;
      const a = G.verts[G.edges[e].a], b = G.verts[G.edges[e].b];
      const x1 = a.x + (b.x - a.x) * 0.17, y1 = a.y + (b.y - a.y) * 0.17, x2 = b.x + (a.x - b.x) * 0.17, y2 = b.y + (a.y - b.y) * 0.17;
      const c = 'x1="' + f(x1) + '" y1="' + f(y1) + '" x2="' + f(x2) + '" y2="' + f(y2) + '"';
      o += '<line class="rdo" ' + c + ' style="stroke:' + PEDGE[s] + '"/><line class="rd" ' + c + ' stroke="' + PCOL[s] + '"/>';
    });
    B.bld.forEach((b, v) => {
      if (!b) return;
      const d = b.t === 1 ? 'M-8,8V-2L0,-10L8,-2V8Z' : 'M-12,9V-4L-6,-11L0,-4V-1H12V9Z';
      o += '<path class="bld" transform="translate(' + f(G.verts[v].x) + ',' + f(G.verts[v].y) + ')" d="' + d + '" fill="' + PCOL[b.p] + '" style="stroke:' + PEDGE[b.p] + '"/>';
    });
    if (!cover) {
      const rp = (i) => { const g = G.hexes[i], des = B.hexes[i].res === 'desert'; return { x: g.x + (des ? 0 : 22), y: g.y + (des ? 0 : -6) }; };
      const to = rp(B.robber), body = '<ellipse cy="7" rx="9" ry="8"/><circle cy="-6" r="6"/>';
      if (rfx && rfx.to === B.robber) {
        const fr = rp(rfx.from), g = G.hexes[B.robber], d = dl(rfx.t);
        o += '<circle class="robold" ' + d + ' cx="' + f(fr.x) + '" cy="' + f(fr.y) + '" r="13"/><line class="robline" ' + d + ' x1="' + f(fr.x) + '" y1="' + f(fr.y) + '" x2="' + f(to.x) + '" y2="' + f(to.y) + '"/><circle class="robring" ' + d + ' cx="' + f(g.x) + '" cy="' + f(g.y) + '" r="40"/>';
        o += '<g transform="translate(' + f(to.x) + ',' + f(to.y) + ')"><g class="robber robmove" style="--dx:' + f(fr.x - to.x) + 'px;--dy:' + f(fr.y - to.y) + 'px;animation-delay:-' + Math.max(0, Date.now() - rfx.t) + 'ms">' + body + '</g></g>';
      } else o += '<g class="robber" transform="translate(' + f(to.x) + ',' + f(to.y) + ')">' + body + '</g>';
    }
    if (gfx) {
      if (gfx.roll) gfx.hexes.forEach((i) => { const hx = G.hexes[i]; o += '<g transform="translate(' + f(hx.x) + ',' + f(hx.y + 10) + ')"><g class="fxtok" ' + dl(gfx.t) + '><circle r="15"/><text y="5">' + B.hexes[i].num + '</text></g></g>'; });
      const cnt = {};
      gfx.hexes.forEach((i) => {
        const res = B.hexes[i].res;
        G.hexes[i].v.forEach((v) => {
          const b = B.bld[v]; if (!b || !(gfx.g[b.p] && gfx.g[b.p][res])) return;
          const k = cnt[v] = (cnt[v] || 0) + 1, p = G.verts[v];
          const tx = p.x + (k - 1) * 17, ty = p.y - 16, hx = G.hexes[i];
          o += '<g transform="translate(' + f(tx) + ',' + f(ty) + ')"><g class="fxfly" style="--dx:' + f(hx.x - tx) + 'px;--dy:' + f(hx.y + 10 - ty) + 'px;animation-delay:-' + Math.max(0, Date.now() - gfx.t) + 'ms"><circle r="11" fill="' + PCOL[b.p] + '" style="stroke:' + PEDGE[b.p] + '"/><text class="fxi" y="1">' + ICON[res] + '</text>' + (b.t === 2 ? '<text class="fxn" x="8" y="-8">×2</text>' : '') + '</g></g>';
        });
      });
    }
    if (tg) {
      const cls = (k, i) => 'tg' + (tg.sel && tg.sel.k === k && tg.sel.i === i ? ' sel' : '');
      const at = (k, i) => '<g class="' + cls(k, i) + '" data-a="pick" data-k="' + k + '" data-i="' + i + '">';
      tg.h.forEach((i) => { const g = G.hexes[i], on = tg.sel && tg.sel.k === 'h' && tg.sel.i === i; o += at('h', i) + '<polygon class="tgh" points="' + g.v.map((v) => f(G.verts[v].x) + ',' + f(G.verts[v].y)).join(' ') + '"/><circle class="tgr" cx="' + f(g.x) + '" cy="' + f(g.y) + '" r="30"/>' + (on ? '<g class="robber" transform="translate(' + f(g.x) + ',' + f(g.y - 2) + ') scale(1.5)"><ellipse cy="7" rx="9" ry="8"/><circle cy="-6" r="6"/></g>' : '') + '</g>'; });
      tg.e.forEach((e) => { const ed = G.edges[e], a = G.verts[ed.a], b = G.verts[ed.b], m = G.mid(ed); const c = 'x1="' + f(a.x + (b.x - a.x) * 0.17) + '" y1="' + f(a.y + (b.y - a.y) * 0.17) + '" x2="' + f(b.x + (a.x - b.x) * 0.17) + '" y2="' + f(b.y + (a.y - b.y) * 0.17) + '"'; o += at('e', e) + '<line class="ghu" ' + c + '/><line class="ghl" ' + c + ' stroke="' + tg.col + '"/><circle class="tgx" cx="' + f(m.x) + '" cy="' + f(m.y) + '" r="19"/></g>'; });
      const many = tg.v.length > 12; // 候補が多いとき（初期配置）は小さな点で見せ、えらんだ所だけ家の形にする
      tg.v.forEach((v) => { const p = G.verts[v], on = tg.sel && tg.sel.k === 'v' && tg.sel.i === v; o += at('v', v) + '<circle class="tgx" cx="' + f(p.x) + '" cy="' + f(p.y) + '" r="21"/>' + (many && !on ? '<circle class="ghd" cx="' + f(p.x) + '" cy="' + f(p.y) + '" r="6.5" fill="' + tg.col + '"/>' : '<path class="gh" transform="translate(' + f(p.x) + ',' + f(p.y) + ')" d="' + HOUSE + '" fill="' + tg.col + '"/>') + '</g>'; });
      tg.c.forEach((v) => { const p = G.verts[v]; o += at('c', v) + '<circle class="tgx" cx="' + f(p.x) + '" cy="' + f(p.y) + '" r="21"/><path class="gh" transform="translate(' + f(p.x) + ',' + f(p.y) + ')" d="' + CITY + '" fill="' + tg.col + '"/><text class="ghup" x="' + f(p.x) + '" y="' + f(p.y - 15) + '">▲</text></g>'; });
    }
    return o + '</svg>';
  }

  // ---------- 画面 ----------
  const bundle = (b) => RES.filter((r) => b[r] > 0).map((r) => ICON[r] + '<b>' + b[r] + '</b>').join(' ') || 'なし';
  const side = (b) => (E.total(b) ? bundle(b) : '<span class="omk">おまかせ</span>');
  const costHtml = (c) => RES.filter((r) => c[r]).map((r) => ICON[r] + (c[r] > 1 ? c[r] : '')).join('');

  function homeHtml() {
    const saved = ls.get('shima.room');
    const off = net !== 'on' && net !== 'peer';
    let o = '<div class="home"><div class="hero">' + boardSVG(demo, null, null, { all: true }) + '</div><div class="card">';
    o += '<h1>HEXA ISLAND</h1><p class="lead">六角の島を切りひらく、3〜4人の資源あつめと陣取り。10点で勝ち。</p>';
    o += '<div class="sep">CPUと遊ぶ</div><div class="seg" role="group" aria-label="CPUの強さ">' + [[1, 'よわい'], [2, 'ふつう'], [3, 'つよい']].map((x) => '<button class="' + (cpuLevel === x[0] ? 'on' : '') + '" data-a="lv" data-i="' + x[0] + '" aria-pressed="' + (cpuLevel === x[0]) + '">' + x[1] + '</button>').join('') + '</div><div class="row2"><button class="btn pri" data-a="cpu" data-i="3">CPU 2人と</button><button class="btn pri" data-a="cpu" data-i="4">CPU 3人と</button></div><div class="sep">友達とオンライン</div>';
    o += '<label class="fld" for="name">あなたの名前<input id="name" maxlength="8" autocomplete="off" placeholder="8文字まで" value="' + esc(myName) + '"></label>';
    o += '<button class="btn" data-a="create"' + (off || busy ? ' disabled' : '') + '>部屋を作る</button>';
    o += '<div class="row"><input id="code" class="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="部屋コード" aria-label="部屋コード" value="' + esc(codeInput) + '"><button class="btn" data-a="join"' + (off || busy ? ' disabled' : '') + '>入る</button></div>';
    if (saved && !off) o += '<button class="btn ghost" data-a="rejoin" data-i="' + esc(saved) + '">前の部屋 ' + esc(saved) + ' にもどる</button>';
    if (net === 'checking') o += '<p class="note">オンラインの準備を確認しています…</p>';
    else if (net === 'off') o += '<p class="note warn">オンライン対戦は、Claudeにログインしてこのページを開いたときだけ使えます。</p>';
    else if (net === 'peer') o += '<p class="note">ログイン不要。部屋を作った人の端末が親になります。</p>';
    else if (!store.canWrite) o += '<p class="note warn">今の共有設定では見るだけになります。持ち主に「編集者」として招待してもらってください。</p>';
    o += '<div class="sep">1台をまわして遊ぶ</div><div class="row3"><button class="btn" data-a="local" data-i="2">2人</button><button class="btn" data-a="local" data-i="3">3人</button><button class="btn" data-a="local" data-i="4">4人</button></div>';
    o += '<button class="btn ghost" data-a="vibTest">振動テスト</button>';
    return o + '</div></div>';
  }
  const LVJA = { 1: 'よわい', 2: 'ふつう', 3: 'つよい' };
  const lvSeg = () => '<div class="seg" role="group" aria-label="CPUの強さ">' + [1, 2, 3].map((x) => '<button class="' + (cpuLevel === x ? 'on' : '') + '" data-a="lv" data-i="' + x + '" aria-pressed="' + (cpuLevel === x) + '">' + LVJA[x] + '</button>').join('') + '</div>';
  function lobbyHtml() {
    const host = room.host === store.uid, n = room.seats.length;
    let o = '<div class="home"><div class="card"><p class="eyebrow">部屋コード</p><div class="bigcode">' + esc(room.code) + '</div>';
    o += '<p class="lead">友達にこのコードを伝えて、同じページから入ってもらってください。</p><ul class="seats">';
    room.seats.forEach((s, i) => { o += '<li><i class="dot" style="background:' + (i < 4 ? '#3fb4a5' : '#9aa') + '"></i>' + esc(s.name) + (s.uid === room.host ? '<span class="pill">ホスト</span>' : '') + (s.uid === store.uid ? '<span class="pill me">あなた</span>' : '') + (s.cpu ? '<span class="pill">' + LVJA[s.level || 2] + '</span>' : '') + (i >= 4 ? '<span class="pill">観戦</span>' : '') + (s.cpu && host ? '<button class="rm" data-a="rmCpu" data-i="' + esc(s.id) + '" aria-label="' + esc(s.name) + 'を外す">×</button>' : '') + '</li>'; });
    if (!n) o += '<li class="muted">' + (room.slow ? 'つながりにくいようです。このまま待ってください…' : '読みこみ中…') + '</li>';
    o += '</ul>';
    if (room.netMsg) o += '<p class="note warn">' + esc(room.netMsg) + '</p>';
    if (host && net === 'peer') o += '<p class="note">この端末が親です。このページを閉じると部屋が止まります。</p>';
    if (host) o += '<div class="sep">CPUを足す</div>' + lvSeg() + '<button class="btn" data-a="addCpu"' + (n >= 4 ? ' disabled' : '') + '>' + (n >= 4 ? '席がいっぱいです' : 'CPUを1人足す') + '</button>';
    if (host) o += '<button class="btn pri" data-a="start"' + (n < 2 ? ' disabled' : '') + '>この' + Math.min(n, 4) + '人で始める</button><p class="note">3〜4人がおすすめ。席順は始めるときにくじで決まります。</p>';
    else o += '<p class="note">ホストが始めるのを待っています…</p>';
    return o + '<button class="btn ghost" data-a="leave">部屋を出る</button></div></div>';
  }

  function statusText(m) {
    if (reveal) return '島があらわれます…';
    const tn = esc(S.players[S.turn].name), mine = m === S.turn;
    switch (S.phase) {
      case 'setup': return mine ? (S.setup.need === 's' ? '開拓地を置く場所をタップ（' + (S.setup.i < S.players.length ? '1' : '2') + 'つ目）' : '今の開拓地から道を1本のばす') : tn + ' が初期配置中';
      case 'roll': return mine ? 'サイコロを振ってください' : tn + ' の番';
      case 'discard': return S.discardNeed[m] ? '7が出た。' + S.discardNeed[m] + '枚捨ててください' : '7が出た。' + Object.keys(S.discardNeed).map((k) => esc(S.players[k].name)).join('・') + ' の捨て札を待っています';
      case 'robber': return mine ? '盗賊を動かすタイルをタップ' : tn + ' が盗賊を動かします';
      case 'steal': return mine ? 'だれから奪うか選んでください' : tn + ' が奪う相手を選んでいます';
      case 'roadbuilding': return mine ? '道を置く場所をタップ（あと' + S.freeRoads + '本）' : tn + ' が道を置いています';
      case 'main':
        if (!mine) return tn + ' の番' + (S.trade ? '（交渉中）' : '');
        { const t = targets(), n = t.v.length + t.c.length + t.e.length;
          if (ui.mode) return n ? '光っている場所をタップ →「建てる」で決定' : '置ける場所がありません';
          return n ? '光っている場所をタップすると建てられます' : '交換するか、ターン終了'; }
      case 'over': return esc(S.players[S.winner].name) + ' の勝ち！';
    }
    return '';
  }
  function playersHtml(m) {
    let o = '<div class="players n' + S.players.length + '">';
    S.players.forEach((p, s) => {
      const vp = s === m ? E.totalVP(S, s) : E.publicVP(S, s);
      o += '<button class="pl' + (s === S.turn && S.phase !== 'over' ? ' on' : '') + (s === m ? ' me' : '') + '" style="--pc:' + PCOL[s] + '" data-a="view" data-i="' + s + '">';
      o += '<span class="pn"><i class="dot"></i>' + esc(p.name) + '</span>';
      const lr = S.longestRoad === s, la = S.largestArmy === s;
      o += '<span class="pv"><b>' + vp + '</b>点' + (lr ? '<em>最長+2</em>' : '') + (la ? '<em>騎士+2</em>' : '') + '</span>';
      const gg = fx && fx.g[s] ? RES.filter((r) => fx.g[s][r]) : [];
      const cf = chipFx[s] && Date.now() - chipFx[s].t < 3000 ? chipFx[s] : null;
      // 手札・発展カード・使った騎士・いちばん長い道。称号を持っている項目は金色
      o += '<span class="pst"><i>札<b>' + E.total(p.res) + '</b></i><i>発<b>' + (p.dev.length + p.devNew.length) + '</b></i><i class="' + (la ? 'hl' : '') + '">騎<b>' + p.knights + '</b></i><i class="' + (lr ? 'hl' : '') + '">道<b>' + (S.roadLens[s] || 0) + '</b></i>';
      if (cf) o += '<span class="pg neg" ' + dl(cf.t) + '>−' + cf.n + '枚 捨てた</span>';
      else if (gg.length) o += '<span class="pg" ' + dl(fx.t) + '>＋' + gg.map((r) => ICON[r] + (fx.g[s][r] > 1 ? fx.g[s][r] : '')).join('') + '</span>';
      o += '</span></button>';
    });
    return o + '</div>';
  }
  function handHtml(m) {
    if (m < 0) return '<div class="hand"><span class="muted">観戦中</span></div>';
    const p = S.players[m];
    return '<div class="hand">' + RES.map((r) => { const up = handFx ? handFx.d[r] || 0 : 0; return '<span class="rc' + (p.res[r] ? '' : ' z') + (up > 0 ? ' up' : up < 0 ? (handFx.strong ? ' down' : ' spent') : '') + '" data-r="' + r + '"' + (up ? ' ' + dl(handFx.t) : '') + '>' + ICON[r] + '<small>' + JA[r] + '</small><b>' + p.res[r] + '</b>' + (up > 0 ? '<i class="plus" ' + dl(handFx.t) + '>+' + up + '</i>' : up < 0 ? '<i class="plus minus' + (handFx.strong ? '' : ' soft') + '" ' + dl(handFx.t) + '>−' + (-up) + '</i>' : '') + '</span>'; }).join('') + '</div>';
  }
  function actionsHtml(m) {
    if (m < 0 || S.phase === 'over') return '<div class="acts"><button class="ab" data-a="sheet" data-i="log">記録</button><button class="ab" data-a="sheet" data-i="cost">コスト表</button><button class="ab" data-a="leave">' + (room.local ? 'やめる' : '部屋を出る') + '</button></div>';
    const p = S.players[m], mine = m === S.turn, main = mine && S.phase === 'main';
    const b = (a, i, label, sub, en, cls) => '<button class="ab' + (cls ? ' ' + cls : '') + '" data-a="' + a + '"' + (i ? ' data-i="' + i + '"' : '') + (en ? '' : ' disabled') + '>' + label + (sub ? '<small>' + sub + '</small>' : '') + '</button>';
    const devN = p.dev.length + p.devNew.length, col = PCOL[m];
    const piece = (k) => '<svg class="pi" viewBox="-15 -14 30 28" aria-hidden="true">' + (k === 'road' ? '<line x1="-9" y1="6" x2="9" y2="-6" stroke="#17303d" stroke-width="9" stroke-linecap="round"/><line x1="-9" y1="6" x2="9" y2="-6" stroke="' + col + '" stroke-width="5.5" stroke-linecap="round"/>' : k === 'dev' ? '<rect x="-8" y="-11" width="16" height="22" rx="3" fill="#fff" stroke="#17303d" stroke-width="2"/><text x="0" y="5" text-anchor="middle" font-size="13" font-weight="900" fill="#17303d">?</text>' : '<path d="' + (k === 'settle' ? HOUSE : CITY) + '" fill="' + col + '" stroke="#17303d" stroke-width="2" stroke-linejoin="round"/>') + '</svg>';
    const bb = (k, label, cost, left) => { const lack = lackHtml(p, cost), ok = main && !whyNot(k, m); return '<button class="ab bld2' + (ui.mode === k ? ' sel' : '') + (ok ? '' : ' off') + '" data-a="' + (k === 'dev' ? 'buyDev' : 'mode') + '" data-i="' + k + '"' + (main ? '' : ' disabled') + '>' + piece(k) + '<span>' + label + (left === null ? '' : '<i>' + left + '</i>') + '</span>' + (main && lack ? '<small class="lk">あと' + lack + '</small>' : '<small>' + costHtml(cost) + '</small>') + '</button>'; };
    let o = '<div class="acts">';
    if (mine && S.phase === 'roll') o += '<button class="ab pri wide" data-a="roll">🎲 サイコロを振る</button>';
    else {
      o += bb('road', '道', E.COST.road, p.roadsLeft) + bb('settle', '開拓地', E.COST.settlement, p.settlementsLeft) + bb('city', '都市', E.COST.city, p.citiesLeft) + bb('dev', '発展', E.COST.dev, null);
      o += b('sheet', 'trade', '交換', '', main);
    }
    o += b('sheet', 'dev', 'カード', devN ? devN + '枚' : '', devN > 0);
    o += b('sheet', 'log', '記録', '', true);
    if (!(mine && S.phase === 'roll')) o += b('endTurn', '', 'ターン終了', '', main, main ? 'pri' : '');
    return o + '</div>';
  }

  const miniHand = (p) => '<div class="mh"><span>手札</span>' + RES.map((r) => '<b class="' + (p.res[r] ? '' : 'z') + '">' + ICON[r] + p.res[r] + '</b>').join('') + '</div>';
  function stepper(kind, max, have) {
    return '<div class="steps">' + RES.map((r) => '<div class="stp"><span>' + ICON[r] + '<small>' + (have ? '持ち' + have[r] : JA[r]) + '</small></span><button data-a="st" data-k="' + kind + '" data-r="' + r + '" data-d="1"' + (ui[kind][r] >= max(r) ? ' disabled' : '') + ' aria-label="' + JA[r] + 'を増やす">＋</button><b>' + ui[kind][r] + '</b><button data-a="st" data-k="' + kind + '" data-r="' + r + '" data-d="-1"' + (ui[kind][r] <= 0 ? ' disabled' : '') + ' aria-label="' + JA[r] + 'を減らす">−</button></div>').join('') + '</div>';
  }
  function sheetHtml(m) {
    let kind = ui.sheet, forced = false;
    const mine = m === S.turn, p = m >= 0 ? S.players[m] : null;
    if (S.phase === 'over') { kind = 'over'; forced = true; }
    else if (p && S.phase === 'discard' && S.discardNeed[m]) { kind = 'discard'; forced = true; }
    else if (p && S.phase === 'steal' && mine) { kind = 'steal'; forced = true; }
    else if (p && S.trade && !mine && S.trade.resp[m] === undefined && ui.sentTrade !== S.trade.id && !room.local) { kind = 'tradeIn'; forced = true; }
    else if (p && S.trade && mine) { kind = 'tradeWait'; forced = true; }
    if (!kind) return '';
    let h = '';
    if (kind === 'over') {
      h = '<h2>' + esc(S.players[S.winner].name) + ' の勝ち！</h2><ul class="seats">' + S.players.map((q, s) => '<li><i class="dot" style="background:' + PCOL[s] + '"></i>' + esc(q.name) + '<span class="sc">' + E.totalVP(S, s) + '点</span></li>').join('') + '</ul>';
      if (room.local) h += '<button class="btn pri" data-a="' + (room.cpu ? 'cpu' : 'local') + '" data-i="' + S.players.length + '">もう一度</button>';
      else if (room.host === store.uid) h += '<button class="btn pri" data-a="start">同じ部屋でもう一度</button>';
      else h += '<p class="note">ホストが次のゲームを始められます。</p>';
      h += '<button class="btn ghost" data-a="leave">' + (room.local ? 'タイトルへ' : '部屋を出る') + '</button>';
    } else if (kind === 'discard') {
      const need = S.discardNeed[m], sel = E.total(ui.disc), tot = E.total(p.res);
      h = '<h2>7が出た：' + need + '枚捨てる</h2><p class="note">手札が' + tot + '枚（8枚以上）なので、半分を捨てます。</p>';
      if (ui.sentDiscard) h += '<p class="note">送りました。反映を待っています…</p>';
      else {
        h += '<p class="eyebrow">手札（タップすると捨てる側へ）</p><div class="pick">' + RES.map((r) => { const left = p.res[r] - ui.disc[r]; return '<button data-a="st" data-k="disc" data-r="' + r + '" data-d="1"' + (left > 0 && sel < need ? '' : ' disabled') + ' aria-label="' + JA[r] + 'を捨てる側へ">' + ICON[r] + '<small>のこり' + left + '</small></button>'; }).join('') + '</div>';
        h += '<p class="eyebrow">捨てる札 ' + sel + '/' + need + '（タップすると戻す）</p><div class="pick dz">' + RES.map((r) => '<button class="' + (ui.disc[r] ? 'on' : '') + '" data-a="st" data-k="disc" data-r="' + r + '" data-d="-1"' + (ui.disc[r] ? '' : ' disabled') + ' aria-label="' + JA[r] + 'を戻す">' + ICON[r] + '<small>' + (ui.disc[r] ? '×' + ui.disc[r] : '―') + '</small></button>').join('') + '</div>';
        h += '<div class="bar"><i style="width:' + Math.round(sel / need * 100) + '%"></i></div><button class="btn pri" data-a="discard"' + (sel === need ? '' : ' disabled') + '>' + (sel === need ? need + '枚を捨てる' : 'あと' + (need - sel) + '枚えらぶ') + '</button>';
      }
    } else if (kind === 'steal') {
      h = '<h2>だれから1枚うばう？</h2><div class="col">' + S.victims.map((s) => '<button class="btn" data-a="steal" data-i="' + s + '"><i class="dot" style="background:' + PCOL[s] + '"></i>' + esc(S.players[s].name) + '（札' + E.total(S.players[s].res) + '）</button>').join('') + '</div>';
    } else if (kind === 'tradeIn') {
      const t = S.trade, can = E.canAfford(p, t.want);
      if (ui.counter) {
        h = '<h2>条件を変えて返す</h2>' + miniHand(p) + '<p class="eyebrow">自分が出す</p>' + stepper('give', (r) => (ui.want[r] ? 0 : p.res[r]), p.res) + '<p class="eyebrow">欲しい</p>' + stepper('want', (r) => (ui.give[r] ? 0 : 9));
        h += '<button class="btn pri" data-a="counter"' + (E.total(ui.give) && E.total(ui.want) ? '' : ' disabled') + '>この条件で返す</button><button class="btn ghost" data-a="counterBack">もどる</button>';
      } else {
      h = '<h2>' + esc(S.players[S.turn].name) + (t.open ? ' が条件を聞いています' : ' からの提案') + '</h2>' + miniHand(p) + '<div class="deal"><div><small>もらえる</small>' + side(t.give) + '</div><div><small>わたす</small>' + side(t.want) + '</div></div>';
      if (t.open) h += '<div class="row2"><button class="btn pri" data-a="counterOpen">条件を出す</button><button class="btn" data-a="resp" data-i="0">ことわる</button></div>'; else
      h += '<div class="row2"><button class="btn pri" data-a="resp" data-i="1"' + (can ? '' : ' disabled') + '>' + (can ? '受ける' : '札が足りない') + '</button><button class="btn" data-a="resp" data-i="0">ことわる</button></div><button class="btn ghost" data-a="counterOpen">条件を変えて返す</button>';
      }
    } else if (kind === 'tradeWait') {
      const t = S.trade;
      h = '<h2>' + (t.open ? '条件を聞いています' : '提案中') + '</h2>' + miniHand(p) + '<div class="deal"><div><small>出す</small>' + side(t.give) + '</div><div><small>欲しい</small>' + side(t.want) + '</div></div><div class="col">';
      S.players.forEach((q, s) => {
        if (s === m) return;
        const r = t.resp[s], nm = '<i class="dot" style="background:' + PCOL[s] + '"></i>' + esc(q.name);
        if (room.local && !room.cpu) h += '<button class="btn" data-a="dealLocal" data-i="' + s + '"' + (E.canAfford(q, t.want) ? '' : ' disabled') + '>' + nm + ' と成立' + (E.canAfford(q, t.want) ? '' : '（札不足）') + '</button>';
        else if (r === 'counter' && t.counters && t.counters[s]) {
          const c = t.counters[s], ok = E.canAfford(p, c.want);
          h += '<div class="ctr"><div class="wait">' + nm + '<span>これならいいよ</span></div><div class="deal"><div><small>もらえる</small>' + bundle(c.give) + '</div><div><small>わたす</small>' + bundle(c.want) + '</div></div><div class="row2"><button class="btn pri" data-a="acceptCounter" data-i="' + s + '"' + (ok ? '' : ' disabled') + '>' + (ok ? 'これで成立' : '札が足りない') + '</button><button class="btn" data-a="rejectCounter" data-i="' + s + '">これは断る</button></div></div>';
        }
        else if (r === true) h += '<button class="btn pri" data-a="confirm" data-i="' + s + '">' + nm + ' と成立させる</button>';
        else h += '<div class="wait">' + nm + '<span>' + (r === false ? 'ことわった' : '返事待ち…') + '</span></div>';
      });
      h += '</div><button class="btn" data-a="reoffer">条件を変えて出し直す</button><button class="btn ghost" data-a="cancelTrade">取り下げる</button>';
    } else if (kind === 'trade') {
      h = '<div class="tabs"><button class="' + (ui.tab === 'bank' ? 'on' : '') + '" data-a="tab" data-i="bank">銀行・港</button><button class="' + (ui.tab === 'player' ? 'on' : '') + '" data-a="tab" data-i="player">みんなと交渉</button></div>' + miniHand(p);
      if (ui.tab === 'bank') {
        h += '<p class="eyebrow">出す</p><div class="pick">' + RES.map((r) => { const rate = E.tradeRate(S, m, r); return '<button class="' + (ui.bankGive === r ? 'on' : '') + '" data-a="bg" data-i="' + r + '"' + (p.res[r] >= rate ? '' : ' disabled') + '>' + ICON[r] + '<small>持ち' + p.res[r] + '</small><small class="rt">' + rate + '枚で1</small></button>'; }).join('') + '</div>';
        { const g = ui.bankGive, rate = g ? E.tradeRate(S, m, g) : 0, max = g ? Math.floor(p.res[g] / rate) : 0, n = ui.bankPick.length, cnt = E.zero(); ui.bankPick.forEach((r) => { cnt[r]++; });
          h += '<p class="eyebrow">もらう' + (g ? '（' + n + '/' + max + '枚まで。押した回数だけもらえる）' : '（先に出すものをえらぶ）') + '</p><div class="pick">' + RES.map((r) => '<button class="' + (cnt[r] ? 'on' : '') + '" data-a="bt" data-i="' + r + '"' + (g && r !== g && n < max && S.bank[r] - cnt[r] > 0 ? '' : ' disabled') + '>' + ICON[r] + '<small>' + (cnt[r] ? '×' + cnt[r] : JA[r]) + '</small></button>').join('') + '</div>';
          if (n) h += '<div class="deal"><div><small>出す</small>' + ICON[g] + '<b>' + rate * n + '</b></div><div><small>もらう</small>' + bundle(cnt) + '</div></div>';
          h += '<button class="btn pri" data-a="bank"' + (n ? '' : ' disabled') + '>交換する</button>' + (n ? '<button class="btn ghost" data-a="bkclr">えらび直す</button>' : ''); }

      } else {
        h += '<p class="eyebrow">出す</p>' + stepper('give', (r) => (ui.want[r] ? 0 : p.res[r]), p.res) + '<p class="eyebrow">欲しい</p>' + stepper('want', (r) => (ui.give[r] ? 0 : 9));
        { const g = E.total(ui.give), w = E.total(ui.want), hot = room.local && !room.cpu;
          h += '<button class="btn pri" data-a="offer"' + ((g && w) || (!hot && (g || w)) ? '' : ' disabled') + '>' + (g && w ? '全員に提案する' : w ? '「これが欲しい。何を出せばいい？」と聞く' : g ? '「これを出す。何をくれる？」と聞く' : '全員に提案する') + '</button>';
          if (!hot) h += '<p class="note">片方だけ入れると、相手に条件を出してもらえます。</p>'; }
      }
    } else if (kind === 'dev') {
      const cnt = {}; p.dev.forEach((c) => { cnt[c] = (cnt[c] || 0) + 1; });
      const canPlay = mine && (S.phase === 'roll' || S.phase === 'main') && !S.devPlayed;
      const info = { knight: '盗賊を動かして1枚うばう', road: '道を2本ただで置く', plenty: '銀行から好きな資源を2枚', mono: '1種類を全員から集める', vp: '1点。自動で数えます' };
      h = '<h2>発展カード</h2><div class="col">';
      ['knight', 'road', 'plenty', 'mono', 'vp'].forEach((c) => { if (!cnt[c]) return; h += '<div class="dv"><div><b>' + E.DEV_JA[c] + ' ×' + cnt[c] + '</b><small>' + info[c] + '</small></div>' + (c === 'vp' ? '' : '<button class="btn sm" data-a="dev" data-i="' + c + '"' + (canPlay ? '' : ' disabled') + '>使う</button>') + '</div>'; });
      if (p.devNew.length) h += '<p class="note">今買ったカード：' + p.devNew.map((c) => E.DEV_JA[c]).join('、') + '（次の番から使えます）</p>';
      if (mine && S.devPlayed) h += '<p class="note">この番はもう1枚使いました。</p>';
      h += '</div>';
    } else if (kind === 'plenty' || kind === 'mono') {
      const two = kind === 'plenty';
      h = '<h2>' + (two ? '豊作：2枚えらぶ' : '独占：1種類えらぶ') + '</h2>' + miniHand(p) + '<div class="pick">' + RES.map((r) => '<button data-a="pk" data-i="' + r + '"' + (two && S.bank[r] < 1 ? ' disabled' : '') + '>' + ICON[r] + '<small>' + JA[r] + (two ? ' ' + ui.pick.filter((x) => x === r).length : '') + '</small></button>').join('') + '</div>';
      if (two) h += '<button class="btn pri" data-a="pkgo"' + (ui.pick.length === 2 ? '' : ' disabled') + '>もらう（' + ui.pick.length + '/2）</button><button class="btn ghost" data-a="pkclr">えらび直す</button>';
    } else if (kind === 'player' && S.players[ui.pv]) {
      const s = ui.pv, q = S.players[s], isMe = s === m;
      const nS = S.bld.filter((b) => b && b.p === s && b.t === 1).length, nC = S.bld.filter((b) => b && b.p === s && b.t === 2).length;
      const lr = S.longestRoad === s, la = S.largestArmy === s, vpc = q.dev.concat(q.devNew).filter((c) => c === 'vp').length;
      const ports = S.ports.filter((pt) => [G.edges[pt.e].a, G.edges[pt.e].b].some((v) => S.bld[v] && S.bld[v].p === s)).map((pt) => (pt.type === 'any' ? '3:1' : ICON[pt.type] + '2:1'));
      const row = (k, v, hl) => '<tr class="' + (hl ? 'hl' : '') + '"><th>' + k + '</th><td>' + v + '</td></tr>';
      h = '<h2><i class="dot" style="background:' + PCOL[s] + '"></i> ' + esc(q.name) + (isMe ? '（あなた）' : '') + '</h2><table class="cost pinfo">';
      h += row('勝利点', '<b>' + (isMe ? E.totalVP(S, s) : E.publicVP(S, s)) + '点</b>' + (isMe ? '' : '（見えている分）'));
      h += row('　開拓地', nS + 'つ（' + nS + '点）') + row('　都市', nC + 'つ（' + nC * 2 + '点）');
      h += row('　最長交易路', lr ? '持っている（+2点）' : 'なし', lr) + row('　最大騎士力', la ? '持っている（+2点）' : 'なし', la);
      if (isMe && vpc) h += row('　勝利点カード', vpc + '枚（' + vpc + '点・ほかの人には見えない）');
      h += row('手札', E.total(q.res) + '枚' + (isMe ? '　' + bundle(q.res) : '')) + row('発展カード', (q.dev.length + q.devNew.length) + '枚（まだ使っていない分）');
      h += row('使った騎士', q.knights + '枚' + (la ? '' : '　<small>3枚以上で最多なら+2点</small>'), la) + row('いちばん長い道', (S.roadLens[s] || 0) + '本' + (lr ? '' : '　<small>5本以上で最長なら+2点</small>'), lr);
      h += row('港', ports.length ? ports.join('　') : 'なし') + row('残りのコマ', '道' + q.roadsLeft + '・開拓地' + q.settlementsLeft + '・都市' + q.citiesLeft) + '</table>';
    } else if (kind === 'menu') {
      const host = room.local || (store && room.host === store.uid), over = S.phase === 'over';
      const ask = { restart: ['最初からやり直す？', '今のゲームは消えて、新しい盤面で始まります。' + (room.local ? '' : '全員の画面が切りかわります。'), 'やり直す'], lobby: ['待合にもどる？', '今のゲームは消えます。全員が待合にもどり、メンバーやCPUを変えてから始め直せます。', 'もどる'], leave: [room.local ? 'タイトルにもどる？' : '部屋を出る？', room.local ? '今のゲームは消えます。' : (host ? 'あなたは親なので、出ると部屋が止まります。' : 'ゲームは続きます。同じコードでもどれます。'), room.local ? 'もどる' : '出る'] }[ui.confirm];
      if (ask) h = '<h2>' + ask[0] + '</h2><p class="lead">' + ask[1] + '</p><div class="row2"><button class="btn pri" data-a="menuDo">' + ask[2] + '</button><button class="btn" data-a="menuNo">やめる</button></div>';
      else {
        h = '<h2>メニュー</h2><div class="col">';
        if (host) h += '<button class="btn" data-a="menuAsk" data-i="restart">最初からやり直す</button>';
        if (host && !room.local) h += '<button class="btn" data-a="menuAsk" data-i="lobby">待合にもどる（メンバーを変える）</button>';
        if (!host) h += '<p class="note">やり直しと待合にもどる操作は、部屋を作った人（親）ができます。</p>';
        h += '<button class="btn" data-a="menuAsk" data-i="leave">' + (room.local ? 'タイトルにもどる' : '部屋を出る') + '</button>';
        h += '<button class="btn ghost" data-a="sheet" data-i="log">記録を見る</button><button class="btn ghost" data-a="sheet" data-i="cost">コスト表を見る</button>' + (canVib ? '<button class="btn ghost" data-a="vib">振動の強さ：' + VIBJA[vibLv] + '（押すと切りかえ）</button>' : '') + '</div>';
      }
    } else if (kind === 'log') {
      h = '<h2>記録</h2><ol class="log">' + S.log.slice().reverse().map((t) => '<li>' + esc(t) + '</li>').join('') + '</ol><button class="btn ghost" data-a="sheet" data-i="cost">コスト表を見る</button>' + (canVib ? '<button class="btn ghost" data-a="vib">振動の強さ：' + VIBJA[vibLv] + '（押すと切りかえ）</button>' : '') + '<button class="btn ghost" data-a="vibTest">振動テスト</button>' + (S.phase !== 'over' ? '<button class="btn ghost" data-a="leave">' + (room.local ? 'ゲームをやめる' : '部屋を出る') + '</button>' : '');
    } else if (kind === 'cost') {
      h = '<h2>コスト表</h2><table class="cost"><tr><th>道</th><td>' + costHtml(E.COST.road) + '</td><td></td></tr><tr><th>開拓地</th><td>' + costHtml(E.COST.settlement) + '</td><td>1点</td></tr><tr><th>都市</th><td>' + costHtml(E.COST.city) + '</td><td>2点・資源2倍</td></tr><tr><th>発展カード</th><td>' + costHtml(E.COST.dev) + '</td><td></td></tr><tr><th>最長交易路</th><td>5本以上で最長</td><td>2点</td></tr><tr><th>最大騎士力</th><td>騎士3枚以上で最多</td><td>2点</td></tr></table><p class="note">自分の番に10点で勝ち。7が出たら、8枚以上持つ人は半分捨てます。</p>';
    }
    return (forced ? '<div class="scrim"></div>' : '<div class="scrim" data-a="close"></div>') + '<div class="sheet" role="dialog" aria-modal="true">' + (forced ? '' : '<button class="x" data-a="close" aria-label="閉じる">×</button>') + h + '</div>';
  }
  function rollPop() {
    if (!fx || !fx.roll) return '';
    const none = !fx.g.some((g) => Object.keys(g).length);
    return '<div class="rollpop" ' + dl(fx.t) + '>🎲 ' + fx.roll + (fx.roll === 7 ? '<small>盗賊がうごく</small>' : none ? '<small>収入なし</small>' : '') + '</div>';
  }
  function gameHtml() {
    const m = meSeat();
    const dice = S.dice ? '<span class="dice"><b>' + S.dice[0] + '</b><b>' + S.dice[1] + '</b></span>' : '';
    const mine = m === S.turn && S.phase !== 'over';
    const tg = targets(), sel = inTargets(tg, ui.sel) ? ui.sel : null; tg.sel = sel;
    let bar;
    if (sel) {
      const free = S.phase === 'setup' || S.phase === 'roadbuilding';
      const label = sel.k === 'h' ? '盗賊をここへ動かす' : sel.k === 'v' ? (free ? '開拓地をここに置く' : '開拓地を建てる <small>' + costHtml(E.COST.settlement) + '</small>') : sel.k === 'c' ? '都市にする <small>' + costHtml(E.COST.city) + '</small>' : S.phase === 'roadbuilding' ? '道をここに置く（無料）' : free ? '道をここに置く' : '道を置く <small>' + costHtml(E.COST.road) + '</small>';
      bar = '<div class="status mine cf"><span>' + label + '</span><button class="okb" data-a="ok">' + (sel.k === 'h' ? '動かす' : free ? '置く' : '建てる') + '</button><button class="nob" data-a="no">やめる</button></div>';
    } else bar = '<div class="status' + (mine ? ' mine' : '') + '">' + dice + '<span>' + statusText(m) + '</span></div>';
    return '<div class="game">' + playersHtml(m) + (room.netMsg ? '<div class="netbar">' + esc(room.netMsg) + '</div>' : '') + '<div class="sea">' + boardSVG(S, tg, fx, reveal, robFx) + '<button class="menub" data-a="sheet" data-i="menu" aria-label="メニュー">☰</button>' + (room.local ? '' : '<span class="rcode">部屋 ' + esc(room.code) + '</span>') + rollPop() + '</div>'
      + bar + handHtml(m) + actionsHtml(m) + sheetHtml(m) + '</div>';
  }
  function render() {
    const app = $('#app');
    if (screen === 'game' && S && room) app.innerHTML = gameHtml();
    else if (screen === 'lobby' && room) app.innerHTML = lobbyHtml();
    else app.innerHTML = homeHtml();
  }

  // ---------- 操作の受け口 ----------
  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'name') myName = ev.target.value;
    if (ev.target.id === 'code') { codeInput = normCode(ev.target.value); if (ev.target.value !== codeInput) ev.target.value = codeInput; }
  });
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-a]');
    if (!el) { if (ui.sel && ev.target.closest && ev.target.closest('.board')) { ui.sel = null; render(); } return; }
    if (el.disabled) return;
    const a = el.dataset.a, i = el.dataset.i, m = meSeat();
    switch (a) {
      case 'create': createRoom(); break;
      case 'join': joinRoom(codeInput); break;
      case 'rejoin': { let d = null; if (net === 'peer') { try { d = JSON.parse(ls.get('shima.hostdump') || 'null'); } catch (e) { d = null; } } if (d && d.code === i && !needName()) rehost(i, d.docs); else joinRoom(i); break; }
      case 'local': startLocal(+i); break;
      case 'cpu': startCpu(+i); break;
      case 'addCpu': { const used = room.seats.map((s) => s.id); const k = [1, 2, 3].find((x) => used.indexOf('cpu' + x) < 0); if (k && room.seats.length < 4) store.set('games/' + room.code + '/seats/cpu' + k, { uid: 'cpu:' + k, name: 'CPU' + k, cpu: true, level: cpuLevel, t: Date.now() }).catch(fail); break; }
      case 'rmCpu': if (/^cpu[1-3]$/.test(i)) store.del('games/' + room.code + '/seats/' + i).catch(fail); break;
      case 'lv': cpuLevel = +i; ls.set('shima.lv', String(cpuLevel)); render(); break;
      case 'start': startGame(); break;
      case 'menuAsk': ui.confirm = i; render(); break;
      case 'menuNo': ui.confirm = null; render(); break;
      case 'menuDo': {
        const k = ui.confirm; ui.confirm = null; ui.sheet = null;
        if (k === 'restart') { if (room.local) { if (room.cpu) startCpu(S.players.length); else startLocal(S.players.length); } else if (room.host === store.uid) startGame(); }
        else if (k === 'lobby') { if (!room.local && room.host === store.uid) store.del('games/' + room.code + '/live/state').catch(fail); }
        else if (k === 'leave') { leaveRoom(); ls.set('shima.room', ''); screen = 'home'; ui = blankUi(); render(); }
        break;
      }
      case 'leave': leaveRoom(); ls.set('shima.room', ''); screen = 'home'; ui = blankUi(); render(); break;
      case 'view': if (room && room.local && !room.cpu) { ui.view = +i; ui.mode = null; ui.sheet = null; ui.sel = null; render(); } else if (S) { ui.pv = +i; ui.sheet = 'player'; render(); } break;
      case 'pick': ui.sel = { k: el.dataset.k, i: +i }; buzz(6); render(); break;
      case 'no': ui.sel = null; render(); break;
      case 'ok': { const x = ui.sel; ui.sel = null; if (!x) break; const a = x.k === 'v' ? { t: 'placeSettlement', v: x.i } : x.k === 'c' ? { t: 'buildCity', v: x.i } : x.k === 'e' ? { t: 'placeRoad', e: x.i } : { t: 'moveRobber', h: x.i }; if (!act(a)) render(); break; }
      case 'roll': act({ t: 'roll' }); break;
      case 'endTurn': act({ t: 'endTurn' }); break;
      case 'buyDev': { const w = whyNot('dev', m); if (w) { toast(w); break; } } if (act({ t: 'buyDev' })) { const d = S.players[m].devNew; toast(E.DEV_JA[d[d.length - 1]] + ' を引いた'); } break;
      case 'mode': { const w = whyNot(i, m); if (w) { toast(w); break; } ui.mode = ui.mode === i ? null : i; ui.sel = null; render(); break; }
      case 'sheet': ui.sheet = i; if (i === 'trade') { ui.give = E.zero(); ui.want = E.zero(); ui.bankGive = null; ui.bankPick = []; } render(); break;
      case 'close': ui.sheet = null; ui.confirm = null; render(); break;
      case 'tab': ui.tab = i; render(); break;
      case 'st': { const k = el.dataset.k, r = el.dataset.r; ui[k][r] = Math.max(0, ui[k][r] + (+el.dataset.d)); render(); break; }
      case 'discard': act({ t: 'discard', res: clone(ui.disc) }); break;
      case 'steal': act({ t: 'steal', target: +i }); break;
      case 'resp': act({ t: 'respondTrade', id: S.trade.id, ok: i === '1' }); break;
      case 'confirm': act({ t: 'confirmTrade', with: +i }); break;
      case 'acceptCounter': act({ t: 'acceptCounter', with: +i }); break;
      case 'rejectCounter': act({ t: 'rejectCounter', with: +i }); break;
      case 'reoffer': { const t = S.trade, g = clone(t.give), w = clone(t.want); if (act({ t: 'cancelTrade' })) { ui.give = g; ui.want = w; ui.tab = 'player'; ui.sheet = 'trade'; render(); } break; }
      case 'vibTest': vibTest(); break;
      case 'vib': vibLv = (vibLv + 1) % 4; ls.set('shima.vib2', String(vibLv)); buzz([30, 60, 30]); render(); break;
      case 'counterOpen': { const t = S.trade, hand = S.players[m].res; ui.counter = true; ui.give = E.zero(); ui.want = E.zero(); RES.forEach((r) => { ui.give[r] = Math.min(t.want[r], hand[r]); ui.want[r] = t.give[r]; }); render(); break; }
      case 'counterBack': ui.counter = false; render(); break;
      case 'counter': act({ t: 'counterTrade', id: S.trade.id, give: clone(ui.give), want: clone(ui.want) }); break;
      case 'dealLocal': if (act({ t: 'respondTrade', id: S.trade.id, ok: true }, +i)) act({ t: 'confirmTrade', with: +i }, S.turn); break;
      case 'cancelTrade': act({ t: 'cancelTrade' }); break;
      case 'bg': ui.bankGive = i; ui.bankPick = []; render(); break;
      case 'bt': ui.bankPick.push(i); render(); break;
      case 'bkclr': ui.bankPick = []; render(); break;
      case 'bank': { const g = ui.bankGive, gets = ui.bankPick.slice(); ui.bankPick = []; if (act({ t: 'bankTrade', give: g, gets })) { if (S.players[m].res[g] < E.tradeRate(S, m, g)) ui.bankGive = null; } render(); break; }
      case 'offer': if (act({ t: 'offerTrade', give: clone(ui.give), want: clone(ui.want) })) { ui.sheet = null; render(); } break;
      case 'dev':
        if (i === 'plenty' || i === 'mono') { ui.sheet = i; ui.pick = []; render(); }
        else { ui.sheet = null; if (!act({ t: 'playDev', card: i })) render(); }
        break;
      case 'pk':
        if (ui.sheet === 'mono') { ui.sheet = null; if (!act({ t: 'playDev', card: 'mono', res: i })) render(); }
        else if (ui.pick.length < 2) { ui.pick.push(i); render(); }
        break;
      case 'pkclr': ui.pick = []; render(); break;
      case 'pkgo': { const pk = ui.pick; ui.sheet = null; ui.pick = []; if (!act({ t: 'playDev', card: 'plenty', a: pk[0], b: pk[1] })) render(); break; }
    }
  });

  // ---------- 起動 ----------
  render();
  (async function () {
    try {
      store = await makeDbStore();
      if (!store && !hasPeer && isLocalhost && !window.claude) store = makeMemStore();
    } catch (e) { store = null; }
    net = store ? 'on' : hasPeer ? 'peer' : 'off';
    if (screen === 'home') render();
  })();
  if (isLocalhost) window.__shima = { get S() { return S; }, get room() { return room; }, get me() { return me; } };
})();
