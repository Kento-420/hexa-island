// ひらけ島 ルールエンジン（六角タイルの開拓ゲーム・3〜4人の基本ルール）
// 状態 S はただの JSON。apply(S, seat, action) が S を書き換え、{ok:true} か {err:'理由'} を返す。
(function (root) {
  'use strict';
  const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
  const RES_JA = { wood: '木', brick: '土', sheep: '羊', wheat: '麦', ore: '鉄' };
  const DEV_JA = { knight: '騎士', road: '街道建設', plenty: '豊作', mono: '独占', vp: '勝利点' };
  const COST = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { wheat: 2, ore: 3 },
    dev: { sheep: 1, wheat: 1, ore: 1 },
  };
  const WIN = 10;
  const zero = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
  const total = (h) => RES.reduce((s, r) => s + (h[r] || 0), 0);

  // ---------- 盤の形（全員共通・固定） ----------
  const G = (function () {
    const SZ = 50, hexes = [], verts = [], edges = [], vmap = {}, emap = {};
    for (let r = -2; r <= 2; r++) for (let q = -2; q <= 2; q++) {
      if (Math.abs(q + r) > 2) continue;
      hexes.push({ q, r, x: SZ * Math.sqrt(3) * (q + r / 2), y: SZ * 1.5 * r, v: [], e: [] });
    }
    hexes.forEach((h, hi) => {
      for (let i = 0; i < 6; i++) {
        const ang = Math.PI / 180 * (60 * i - 30);
        const x = h.x + SZ * Math.cos(ang), y = h.y + SZ * Math.sin(ang);
        const k = Math.round(x) + ',' + Math.round(y);
        if (!(k in vmap)) { vmap[k] = verts.length; verts.push({ x, y, adj: [], edges: [], hexes: [] }); }
        h.v.push(vmap[k]); verts[vmap[k]].hexes.push(hi);
      }
      for (let i = 0; i < 6; i++) {
        const a = h.v[i], b = h.v[(i + 1) % 6];
        const k = Math.min(a, b) + '-' + Math.max(a, b);
        if (!(k in emap)) {
          emap[k] = edges.length; edges.push({ a, b, hexes: [] });
          verts[a].adj.push(b); verts[b].adj.push(a);
          verts[a].edges.push(emap[k]); verts[b].edges.push(emap[k]);
        }
        edges[emap[k]].hexes.push(hi); h.e.push(emap[k]);
      }
    });
    const mid = (e) => ({ x: (verts[e.a].x + verts[e.b].x) / 2, y: (verts[e.a].y + verts[e.b].y) / 2 });
    const coast = edges.map((e, i) => i).filter((i) => edges[i].hexes.length === 1)
      .sort((i, j) => { const a = mid(edges[i]), b = mid(edges[j]); return Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x); });
    const portSlots = [0, 3, 6, 10, 13, 16, 20, 23, 26].map((i) => coast[i]);
    const hexAdj = hexes.map(() => []);
    edges.forEach((e) => { if (e.hexes.length === 2) { hexAdj[e.hexes[0]].push(e.hexes[1]); hexAdj[e.hexes[1]].push(e.hexes[0]); } });
    return { SZ, hexes, verts, edges, coast, portSlots, hexAdj, mid };
  })();

  function shuffle(a, rnd) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  // ---------- 新しいゲーム ----------
  function newGame(players, rnd) {
    rnd = rnd || Math.random;
    let hexes;
    for (let tries = 0; tries < 500; tries++) {
      const res = shuffle(['wood', 'wood', 'wood', 'wood', 'sheep', 'sheep', 'sheep', 'sheep', 'wheat', 'wheat', 'wheat', 'wheat', 'brick', 'brick', 'brick', 'ore', 'ore', 'ore', 'desert'], rnd);
      const nums = shuffle([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12], rnd);
      hexes = res.map((r) => ({ res: r, num: r === 'desert' ? 0 : nums.pop() }));
      const hot = (n) => n === 6 || n === 8;
      if (!hexes.some((h, i) => hot(h.num) && G.hexAdj[i].some((j) => hot(hexes[j].num)))) break;
    }
    const types = shuffle(['any', 'any', 'any', 'any', 'wood', 'brick', 'sheep', 'wheat', 'ore'], rnd);
    const deck = [];
    for (let i = 0; i < 14; i++) deck.push('knight');
    for (let i = 0; i < 5; i++) deck.push('vp');
    for (let i = 0; i < 2; i++) deck.push('road', 'plenty', 'mono');
    const n = players.length;
    const order = []; for (let i = 0; i < n; i++) order.push(i); for (let i = n - 1; i >= 0; i--) order.push(i);
    return {
      rev: 1, gameId: Math.floor(rnd() * 1e9).toString(36),
      hexes, robber: hexes.findIndex((h) => h.res === 'desert'),
      ports: G.portSlots.map((e, i) => ({ e, type: types[i] })),
      bld: G.verts.map(() => null), roads: G.edges.map(() => null),
      players: players.map((p) => ({ uid: p.uid, name: p.name, res: zero(), dev: [], devNew: [], knights: 0, roadsLeft: 15, settlementsLeft: 5, citiesLeft: 4 })),
      devDeck: shuffle(deck, rnd), bank: { wood: 19, brick: 19, sheep: 19, wheat: 19, ore: 19 },
      phase: 'setup', turn: 0, setup: { order, i: 0, need: 's', v: null },
      dice: null, devPlayed: false, discardNeed: {}, victims: null, resume: 'main', freeRoads: 0,
      trade: null, tradeSeq: 0, longestRoad: null, largestArmy: null, roadLens: players.map(() => 0),
      winner: null, seen: {}, log: [], gainSeq: 0, lastGain: null,
    };
  }

  // ---------- 判定 ----------
  const name = (S, s) => S.players[s].name;
  function log(S, t) { S.log.push(t); if (S.log.length > 60) S.log.shift(); }
  const canAfford = (p, cost) => RES.every((r) => (p.res[r] || 0) >= (cost[r] || 0));
  function pay(S, p, cost) { RES.forEach((r) => { const c = cost[r] || 0; p.res[r] -= c; S.bank[r] += c; }); }

  function okSettlement(S, seat, v, setup) {
    if (S.bld[v]) return false;
    if (G.verts[v].adj.some((u) => S.bld[u])) return false;
    if (!setup && !G.verts[v].edges.some((e) => S.roads[e] === seat)) return false;
    return true;
  }
  function okRoad(S, seat, e, anchor) {
    if (S.roads[e] !== null) return false;
    const ed = G.edges[e];
    if (anchor !== null && anchor !== undefined) return ed.a === anchor || ed.b === anchor;
    return [ed.a, ed.b].some((v) => {
      const b = S.bld[v];
      if (b) return b.p === seat;
      return G.verts[v].edges.some((x) => x !== e && S.roads[x] === seat);
    });
  }
  const okCity = (S, seat, v) => !!S.bld[v] && S.bld[v].p === seat && S.bld[v].t === 1;

  function legalSettlements(S, seat) {
    const setup = S.phase === 'setup';
    return G.verts.map((_, v) => v).filter((v) => okSettlement(S, seat, v, setup));
  }
  function legalRoads(S, seat) {
    const anchor = S.phase === 'setup' ? S.setup.v : null;
    return G.edges.map((_, e) => e).filter((e) => okRoad(S, seat, e, anchor));
  }
  const legalCities = (S, seat) => G.verts.map((_, v) => v).filter((v) => okCity(S, seat, v));

  function tradeRate(S, seat, res) {
    let rate = 4;
    S.ports.forEach((p) => {
      const ed = G.edges[p.e];
      const mine = [ed.a, ed.b].some((v) => S.bld[v] && S.bld[v].p === seat);
      if (!mine) return;
      if (p.type === 'any') rate = Math.min(rate, 3);
      else if (p.type === res) rate = 2;
    });
    return rate;
  }

  function roadLen(S, seat) {
    const used = {};
    const blocked = (v) => S.bld[v] && S.bld[v].p !== seat;
    function dfs(v) {
      let best = 0;
      for (const e of G.verts[v].edges) {
        if (S.roads[e] !== seat || used[e]) continue;
        const o = G.edges[e].a === v ? G.edges[e].b : G.edges[e].a;
        used[e] = 1;
        const l = 1 + (blocked(o) ? 0 : dfs(o));
        if (l > best) best = l;
        used[e] = 0;
      }
      return best;
    }
    let best = 0;
    for (let v = 0; v < G.verts.length; v++) {
      if (!G.verts[v].edges.some((e) => S.roads[e] === seat)) continue;
      const l = dfs(v); if (l > best) best = l;
    }
    return best;
  }
  function updateRoads(S) {
    const lens = S.players.map((_, s) => roadLen(S, s));
    S.roadLens = lens;
    const max = Math.max.apply(null, lens);
    const prev = S.longestRoad;
    let now = null;
    if (max >= 5) {
      if (prev !== null && lens[prev] === max) now = prev;
      else { const c = lens.map((l, s) => (l === max ? s : -1)).filter((s) => s >= 0); now = c.length === 1 ? c[0] : null; }
    }
    if (now !== prev) { S.longestRoad = now; if (now !== null) log(S, name(S, now) + ' が最長交易路（' + max + '本）'); else log(S, '最長交易路は持ち主なしに'); }
  }
  function updateArmy(S) {
    const cur = S.largestArmy;
    S.players.forEach((p, s) => {
      if (p.knights >= 3 && (S.largestArmy === null || p.knights > S.players[S.largestArmy].knights)) S.largestArmy = s;
    });
    if (S.largestArmy !== cur) log(S, name(S, S.largestArmy) + ' が最大騎士力');
  }
  // 見えている点数（勝利点カードは含めない）
  function publicVP(S, seat) {
    let v = 0;
    S.bld.forEach((b) => { if (b && b.p === seat) v += b.t; });
    if (S.longestRoad === seat) v += 2;
    if (S.largestArmy === seat) v += 2;
    return v;
  }
  function totalVP(S, seat) {
    const p = S.players[seat];
    return publicVP(S, seat) + p.dev.concat(p.devNew).filter((c) => c === 'vp').length;
  }
  function checkWin(S) {
    if (S.phase === 'over' || S.phase === 'setup') return;
    if (totalVP(S, S.turn) >= WIN) { S.phase = 'over'; S.winner = S.turn; S.trade = null; log(S, name(S, S.turn) + ' の勝ち！（' + totalVP(S, S.turn) + '点）'); }
  }

  function distribute(S, roll) {
    const gain = S.players.map(() => zero());
    const before = S.players.map((q) => Object.assign({}, q.res));
    S.hexes.forEach((h, hi) => {
      if (h.num !== roll || hi === S.robber) return;
      G.hexes[hi].v.forEach((v) => { const b = S.bld[v]; if (b) gain[b.p][h.res] += b.t; });
    });
    const got = S.players.map(() => []);
    RES.forEach((r) => {
      const tot = gain.reduce((s, g) => s + g[r], 0);
      if (!tot) return;
      const takers = gain.filter((g) => g[r] > 0).length;
      if (tot > S.bank[r] && takers > 1) { log(S, RES_JA[r] + ' は銀行に足りず、だれももらえない'); return; }
      gain.forEach((g, s) => {
        const n = Math.min(g[r], S.bank[r]);
        if (n > 0) { S.players[s].res[r] += n; S.bank[r] -= n; got[s].push(RES_JA[r] + n); }
      });
    });
    got.forEach((g, s) => { if (g.length) log(S, name(S, s) + ' ＋' + g.join(' ')); });
    const after = S.players.map((q) => q.res);
    S.lastGain = { seq: ++S.gainSeq, roll, hexes: S.hexes.map((h, hi) => hi).filter((hi) => S.hexes[hi].num === roll && hi !== S.robber), g: before.map((b, s) => { const o = {}; RES.forEach((r) => { if (after[s][r] > b[r]) o[r] = after[s][r] - b[r]; }); return o; }) };
  }

  function stealFrom(S, seat, target, rnd) {
    const t = S.players[target], pool = [];
    RES.forEach((r) => { for (let i = 0; i < t.res[r]; i++) pool.push(r); });
    if (!pool.length) return;
    const r = pool[Math.floor(rnd() * pool.length)];
    t.res[r]--; S.players[seat].res[r]++;
    S.lastSteal = { by: seat, from: target, res: r, rev: S.rev };
    log(S, name(S, seat) + ' が ' + name(S, target) + ' から1枚うばった');
  }
  function endFreeRoadsIfStuck(S) {
    const p = S.players[S.turn];
    if (S.freeRoads <= 0 || p.roadsLeft <= 0 || !G.edges.some((_, e) => okRoad(S, S.turn, e, null))) { S.freeRoads = 0; S.phase = S.resume; }
  }
  const validBundle = (b) => b && typeof b === 'object' && RES.every((r) => b[r] === undefined || (Number.isInteger(b[r]) && b[r] >= 0));

  // ---------- 操作 ----------
  function apply(S, seat, a, rnd) {
    rnd = rnd || Math.random;
    const r = step(S, seat, a, rnd);
    if (r.err) return r;
    S.rev++;
    checkWin(S);
    return r;
  }
  function step(S, seat, a, rnd) {
    const E = (m) => ({ err: m }), OK = { ok: true };
    if (!a || typeof a.t !== 'string') return E('不明な操作');
    if (seat < 0 || seat >= S.players.length) return E('席がありません');
    if (S.phase === 'over') return E('ゲームは終わっています');
    const p = S.players[seat], myTurn = seat === S.turn;

    // 手番でなくてもできる操作
    if (a.t === 'discard') {
      const need = S.discardNeed[seat];
      if (S.phase !== 'discard' || !need) return E('今は捨てる必要がありません');
      if (!validBundle(a.res) || total(a.res) !== need) return E(need + '枚えらんでください');
      if (!canAfford(p, a.res)) return E('持っていない札です');
      pay(S, p, a.res); delete S.discardNeed[seat];
      log(S, name(S, seat) + ' が ' + need + '枚捨てた');
      if (!Object.keys(S.discardNeed).length) S.phase = 'robber';
      return OK;
    }
    if (a.t === 'respondTrade') {
      if (!S.trade || a.id !== S.trade.id) return E('その提案はもうありません');
      if (myTurn) return E('自分の提案です');
      if (a.ok && !canAfford(p, S.trade.want)) return E('札が足りません');
      S.trade.resp[seat] = !!a.ok;
      return OK;
    }
    if (a.t === 'counterTrade') { // 逆提案：「この条件ならいいよ」
      if (!S.trade || a.id !== S.trade.id) return E('その提案はもうありません');
      if (myTurn) return E('自分の提案です');
      if (!validBundle(a.give) || !validBundle(a.want) || !total(a.give) || !total(a.want)) return E('出すものと欲しいものを両方えらんでください');
      if (RES.some((r) => (a.give[r] || 0) > 0 && (a.want[r] || 0) > 0)) return E('同じ資源は出すと欲しいの両方にできません');
      if (!canAfford(p, a.give)) return E('札が足りません');
      const g = zero(), w = zero(); RES.forEach((r) => { g[r] = a.give[r] || 0; w[r] = a.want[r] || 0; });
      if (!S.trade.counters) S.trade.counters = {};
      S.trade.counters[seat] = { give: g, want: w }; S.trade.resp[seat] = 'counter';
      return OK;
    }
    if (!myTurn) return E('あなたの番ではありません');

    switch (a.t) {
      case 'placeSettlement': {
        const v = a.v;
        if (!(v >= 0 && v < G.verts.length)) return E('場所が不正です');
        if (S.phase === 'setup') {
          if (S.setup.need !== 's') return E('先に道を置いてください');
          if (!okSettlement(S, seat, v, true)) return E('そこには置けません');
          S.bld[v] = { p: seat, t: 1 }; p.settlementsLeft--;
          if (S.setup.i >= S.players.length) {
            const g = S.players.map(() => ({})), hs = [];
            G.verts[v].hexes.forEach((hi) => { const h = S.hexes[hi]; if (h.res !== 'desert' && S.bank[h.res] > 0) { p.res[h.res]++; S.bank[h.res]--; g[seat][h.res] = (g[seat][h.res] || 0) + 1; hs.push(hi); } });
            S.lastGain = { seq: ++S.gainSeq, roll: 0, hexes: hs, g };
          }
          S.setup.need = 'r'; S.setup.v = v;
          return OK;
        }
        if (S.phase !== 'main') return E('今は建てられません');
        if (p.settlementsLeft <= 0) return E('開拓地のコマがありません');
        if (!canAfford(p, COST.settlement)) return E('資源が足りません');
        if (!okSettlement(S, seat, v, false)) return E('そこには建てられません');
        pay(S, p, COST.settlement); S.bld[v] = { p: seat, t: 1 }; p.settlementsLeft--;
        log(S, name(S, seat) + ' が開拓地を建てた'); updateRoads(S);
        return OK;
      }
      case 'placeRoad': {
        const e = a.e;
        if (!(e >= 0 && e < G.edges.length)) return E('場所が不正です');
        if (S.phase === 'setup') {
          if (S.setup.need !== 'r') return E('先に開拓地を置いてください');
          if (!okRoad(S, seat, e, S.setup.v)) return E('今置いた開拓地につなげてください');
          S.roads[e] = seat; p.roadsLeft--;
          S.setup.i++; S.setup.v = null; S.setup.need = 's';
          if (S.setup.i >= S.setup.order.length) { S.phase = 'roll'; S.turn = 0; updateRoads(S); log(S, '初期配置おわり。' + name(S, 0) + ' から開始'); }
          else S.turn = S.setup.order[S.setup.i];
          return OK;
        }
        if (S.phase === 'roadbuilding') {
          if (!okRoad(S, seat, e, null)) return E('そこには置けません');
          S.roads[e] = seat; p.roadsLeft--; S.freeRoads--;
          updateRoads(S); endFreeRoadsIfStuck(S);
          return OK;
        }
        if (S.phase !== 'main') return E('今は建てられません');
        if (p.roadsLeft <= 0) return E('道のコマがありません');
        if (!canAfford(p, COST.road)) return E('資源が足りません');
        if (!okRoad(S, seat, e, null)) return E('そこには置けません');
        pay(S, p, COST.road); S.roads[e] = seat; p.roadsLeft--;
        log(S, name(S, seat) + ' が道を置いた'); updateRoads(S);
        return OK;
      }
      case 'buildCity': {
        if (S.phase !== 'main') return E('今は建てられません');
        if (p.citiesLeft <= 0) return E('都市のコマがありません');
        if (!canAfford(p, COST.city)) return E('資源が足りません');
        if (!okCity(S, seat, a.v)) return E('自分の開拓地をえらんでください');
        pay(S, p, COST.city); S.bld[a.v].t = 2; p.citiesLeft--; p.settlementsLeft++;
        log(S, name(S, seat) + ' が都市にした');
        return OK;
      }
      case 'buyDev': {
        if (S.phase !== 'main') return E('今は買えません');
        if (!S.devDeck.length) return E('発展カードは売り切れです');
        if (!canAfford(p, COST.dev)) return E('資源が足りません');
        pay(S, p, COST.dev); p.devNew.push(S.devDeck.pop());
        log(S, name(S, seat) + ' が発展カードを買った');
        return OK;
      }
      case 'roll': {
        if (S.phase !== 'roll') return E('今は振れません');
        const d = [1 + Math.floor(rnd() * 6), 1 + Math.floor(rnd() * 6)];
        S.dice = d; const sum = d[0] + d[1];
        log(S, name(S, seat) + ' の出目 ' + sum);
        if (sum === 7) {
          S.discardNeed = {};
          S.players.forEach((q, s) => { const n = total(q.res); if (n > 7) S.discardNeed[s] = Math.floor(n / 2); });
          S.resume = 'main';
          S.phase = Object.keys(S.discardNeed).length ? 'discard' : 'robber';
          S.lastGain = { seq: ++S.gainSeq, roll: 7, hexes: [], g: S.players.map(() => ({})) };
        } else { distribute(S, sum); S.phase = 'main'; }
        return OK;
      }
      case 'moveRobber': {
        if (S.phase !== 'robber') return E('今は盗賊を動かせません');
        if (!(a.h >= 0 && a.h < S.hexes.length) || a.h === S.robber) return E('別のタイルへ動かしてください');
        S.robber = a.h;
        const vs = [];
        G.hexes[a.h].v.forEach((v) => { const b = S.bld[v]; if (b && b.p !== seat && total(S.players[b.p].res) > 0 && vs.indexOf(b.p) < 0) vs.push(b.p); });
        if (vs.length === 0) S.phase = S.resume;
        else if (vs.length === 1) { stealFrom(S, seat, vs[0], rnd); S.phase = S.resume; }
        else { S.victims = vs; S.phase = 'steal'; }
        return OK;
      }
      case 'steal': {
        if (S.phase !== 'steal') return E('今はうばえません');
        if (!S.victims || S.victims.indexOf(a.target) < 0) return E('その相手からはうばえません');
        stealFrom(S, seat, a.target, rnd); S.victims = null; S.phase = S.resume;
        return OK;
      }
      case 'playDev': {
        if (S.phase !== 'roll' && S.phase !== 'main') return E('今は使えません');
        if (S.devPlayed) return E('発展カードは1ターンに1枚までです');
        const c = a.card, i = p.dev.indexOf(c);
        if (c === 'vp' || i < 0) return E('そのカードは今使えません');
        if (c === 'plenty') {
          if (RES.indexOf(a.a) < 0 || RES.indexOf(a.b) < 0) return E('資源を2つえらんでください');
          const need = zero(); need[a.a]++; need[a.b]++;
          if (!RES.every((r) => S.bank[r] >= need[r])) return E('銀行にありません');
          RES.forEach((r) => { p.res[r] += need[r]; S.bank[r] -= need[r]; });
          log(S, name(S, seat) + ' が豊作で ' + RES_JA[a.a] + ' と ' + RES_JA[a.b] + ' を得た');
        } else if (c === 'mono') {
          if (RES.indexOf(a.res) < 0) return E('資源をえらんでください');
          let n = 0;
          S.players.forEach((q, s) => { if (s !== seat) { n += q.res[a.res]; p.res[a.res] += q.res[a.res]; q.res[a.res] = 0; } });
          log(S, name(S, seat) + ' が独占で ' + RES_JA[a.res] + ' を' + n + '枚あつめた');
        } else if (c === 'knight') {
          p.knights++; log(S, name(S, seat) + ' が騎士を使った'); updateArmy(S);
          S.resume = S.phase; S.phase = 'robber';
        } else if (c === 'road') {
          log(S, name(S, seat) + ' が街道建設を使った');
          S.resume = S.phase; S.phase = 'roadbuilding'; S.freeRoads = 2; endFreeRoadsIfStuck(S);
        } else return E('不明なカード');
        p.dev.splice(i, 1); S.devPlayed = true;
        return OK;
      }
      case 'bankTrade': {
        if (S.phase !== 'main') return E('交換はサイコロのあとです');
        if (RES.indexOf(a.give) < 0 || RES.indexOf(a.get) < 0 || a.give === a.get) return E('資源をえらんでください');
        const rate = tradeRate(S, seat, a.give);
        if (p.res[a.give] < rate) return E(RES_JA[a.give] + ' が' + rate + '枚必要です');
        if (S.bank[a.get] < 1) return E('銀行にありません');
        p.res[a.give] -= rate; S.bank[a.give] += rate; p.res[a.get]++; S.bank[a.get]--;
        log(S, name(S, seat) + ' が ' + RES_JA[a.give] + rate + ' → ' + RES_JA[a.get] + '1 に交換');
        return OK;
      }
      case 'offerTrade': {
        if (S.phase !== 'main') return E('交渉はサイコロのあとです');
        if (!validBundle(a.give) || !validBundle(a.want) || !total(a.give) || !total(a.want)) return E('出すものと欲しいものを両方えらんでください');
        if (RES.some((r) => (a.give[r] || 0) > 0 && (a.want[r] || 0) > 0)) return E('同じ資源は出すと欲しいの両方にできません');
        if (!canAfford(p, a.give)) return E('札が足りません');
        const g = zero(), w = zero(); RES.forEach((r) => { g[r] = a.give[r] || 0; w[r] = a.want[r] || 0; });
        S.trade = { id: ++S.tradeSeq, give: g, want: w, resp: {}, counters: {} };
        return OK;
      }
      case 'confirmTrade': {
        const t = S.trade; if (!t) return E('提案がありません');
        const o = S.players[a.with];
        if (!o || a.with === seat || t.resp[a.with] !== true) return E('相手が受けていません');
        if (!canAfford(p, t.give) || !canAfford(o, t.want)) return E('札が足りなくなりました');
        RES.forEach((r) => { p.res[r] += t.want[r] - t.give[r]; o.res[r] += t.give[r] - t.want[r]; });
        log(S, name(S, seat) + ' と ' + name(S, a.with) + ' が交換した');
        S.trade = null;
        return OK;
      }
      case 'acceptCounter': {
        const t = S.trade, c = t && t.counters && t.counters[a.with], o = S.players[a.with];
        if (!c || !o || t.resp[a.with] !== 'counter') return E('逆提案がありません');
        if (!canAfford(p, c.want) || !canAfford(o, c.give)) return E('札が足りなくなりました');
        RES.forEach((r) => { p.res[r] += c.give[r] - c.want[r]; o.res[r] += c.want[r] - c.give[r]; });
        log(S, name(S, seat) + ' と ' + name(S, a.with) + ' が交換した（逆提案）');
        S.trade = null;
        return OK;
      }
      case 'cancelTrade': { if (!S.trade) return E('提案がありません'); S.trade = null; return OK; }
      case 'endTurn': {
        if (S.phase !== 'main') return E('今は終われません');
        S.trade = null; p.dev = p.dev.concat(p.devNew); p.devNew = []; S.devPlayed = false; S.dice = null;
        S.turn = (S.turn + 1) % S.players.length; S.phase = 'roll';
        return OK;
      }
    }
    return E('不明な操作');
  }

  const api = { G, RES, RES_JA, DEV_JA, COST, WIN, zero, total, newGame, apply, canAfford, legalSettlements, legalRoads, legalCities, tradeRate, publicVP, totalVP, roadLen, okRoad };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Shima = api;
})(typeof window !== 'undefined' ? window : globalThis);
