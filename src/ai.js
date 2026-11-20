// HEXA ISLAND CPUの考え方（1手ずつ決める）
(function (root) {
  'use strict';
  const E = root.Shima || require('./engine.js');
  const G = E.G, RES = E.RES, COST = E.COST;
  const pips = (n) => (n ? 6 - Math.abs(7 - n) : 0);
  const PV = {}; G.portSlots.forEach((e) => { PV[G.edges[e].a] = 1; PV[G.edges[e].b] = 1; });
  const free = (S, v) => !S.bld[v] && !G.verts[v].adj.some((u) => S.bld[u]);
  const miss = (hand, cost) => RES.reduce((s, r) => s + Math.max(0, (cost[r] || 0) - hand[r]), 0);
  let NOISE = 0.01, LV = 3; // 強さ 1=よわい 2=ふつう 3=つよい。弱いほど判断がぶれる
  function best(list, fn) { let b = null, bs = -1e9; list.forEach((x) => { const s = fn(x) + Math.random() * NOISE; if (s > bs) { bs = s; b = x; } }); return b; }

  function myProd(S, seat) {
    const have = {};
    S.bld.forEach((b, v) => { if (b && b.p === seat) G.verts[v].hexes.forEach((h) => { const r = S.hexes[h].res; if (r !== 'desert') have[r] = 1; }); });
    return have;
  }
  // 場所の良さ：出やすさ＋資源の種類（まだ持っていない種類を高く）＋港
  function vScore(S, v, have) {
    let s = 0; const seen = {};
    G.verts[v].hexes.forEach((h) => { const x = S.hexes[h]; if (x.res === 'desert') return; s += pips(x.num); if (!seen[x.res]) { seen[x.res] = 1; s += have[x.res] ? 0.5 : 2; } });
    return s + (PV[v] ? 1 : 0);
  }
  function roadScore(S, seat, e, have) {
    const ed = G.edges[e]; let sc = 0;
    [ed.a, ed.b].forEach((o) => {
      const b = S.bld[o];
      if (b && b.p !== seat) return;
      if ((b && b.p === seat) || G.verts[o].edges.some((x) => x !== e && S.roads[x] === seat)) return;
      if (free(S, o)) sc = Math.max(sc, vScore(S, o, have) + 6);
      else G.verts[o].adj.forEach((n) => { if (free(S, n)) sc = Math.max(sc, vScore(S, n, have)); });
    });
    const before = E.roadLen(S, seat); S.roads[e] = seat; const after = E.roadLen(S, seat); S.roads[e] = null;
    if (after > before) {
      sc += 1.5;
      const top = Math.max.apply(null, S.roadLens.filter((_, i) => i !== seat).concat([4]));
      if (after > top && S.longestRoad !== seat) sc += 5;
    }
    return sc;
  }
  function goals(S, seat) {
    const p = S.players[seat], g = [];
    const spots = p.settlementsLeft > 0 && G.verts.some((_, v) => free(S, v) && G.verts[v].edges.some((e) => S.roads[e] === seat));
    if (p.citiesLeft > 0 && E.legalCities(S, seat).length > 0) g.push('city');
    if (spots) g.push('settlement');
    if (!spots && p.roadsLeft > 0 && p.settlementsLeft > 0 && G.edges.some((_, e) => E.okRoad(S, seat, e, null))) g.push('road');
    if (S.devDeck.length) g.push('dev');
    return g;
  }
  const mySpots = (S, seat) => G.verts.map((_, v) => v).filter((v) => free(S, v) && G.verts[v].edges.some((e) => S.roads[e] === seat));
  const myRoads = (S, seat) => G.edges.map((_, e) => e).filter((e) => E.okRoad(S, seat, e, null));
  function tradeFor(S, seat, cost, mustComplete) {
    const hand = S.players[seat].res;
    const lack = RES.filter((r) => (cost[r] || 0) > hand[r]);
    if (!lack.length || lack.some((r) => S.bank[r] < 1)) return null;
    const sur = (r) => hand[r] - (cost[r] || 0), rate = (r) => E.tradeRate(S, seat, r);
    const n = RES.reduce((s, r) => s + Math.max(0, Math.floor(sur(r) / rate(r))), 0);
    if (n < 1 || (mustComplete && n < miss(hand, cost))) return null;
    const give = best(RES.filter((r) => sur(r) >= rate(r)), (r) => sur(r) - rate(r));
    const get = best(lack, (r) => (cost[r] || 0) - hand[r]);
    return { t: 'bankTrade', give, get };
  }
  const robberOnMine = (S, seat) => G.hexes[S.robber].v.some((v) => S.bld[v] && S.bld[v].p === seat);

  function decide(S, seat, lv) {
    LV = lv || 3; NOISE = [5, 2, 0.01][LV - 1];
    const p = S.players[seat], have = myProd(S, seat);
    if (S.phase === 'discard') {
      let n = S.discardNeed[seat]; if (!n) return null;
      const h = Object.assign({}, p.res), out = E.zero(), gl = goals(S, seat)[0], keep = gl ? COST[gl] : {};
      while (n--) { const r = best(RES.filter((x) => h[x] > 0), (x) => h[x] - (keep[x] || 0) * 1.5); h[r]--; out[r]++; }
      return { t: 'discard', res: out };
    }
    if (seat !== S.turn) return null;
    const canDev = !S.devPlayed;
    switch (S.phase) {
      case 'setup':
        if (S.setup.need === 's') return { t: 'placeSettlement', v: best(E.legalSettlements(S, seat), (v) => vScore(S, v, have)) };
        return { t: 'placeRoad', e: best(E.legalRoads(S, seat), (e) => roadScore(S, seat, e, have)) };
      case 'robber': {
        const h = best(S.hexes.map((_, i) => i).filter((i) => i !== S.robber), (i) => {
          let s = 0, mine = false;
          G.hexes[i].v.forEach((v) => { const b = S.bld[v]; if (!b) return; if (b.p === seat) mine = true; else s += pips(S.hexes[i].num) * b.t * (1 + E.publicVP(S, b.p) / 5) + (E.total(S.players[b.p].res) > 0 ? 1 : 0); });
          return mine ? -100 : LV === 1 ? Math.random() * 3 : s;
        });
        return { t: 'moveRobber', h };
      }
      case 'steal': return { t: 'steal', target: best(S.victims, (s) => E.publicVP(S, s) * 10 + E.total(S.players[s].res)) };
      case 'roadbuilding': return { t: 'placeRoad', e: best(myRoads(S, seat), (e) => roadScore(S, seat, e, have)) };
      case 'roll':
        if (canDev && p.dev.indexOf('knight') >= 0 && (robberOnMine(S, seat) || (LV > 1 && p.knights >= 2))) return { t: 'playDev', card: 'knight' };
        return { t: 'roll' };
      case 'main': break;
      default: return null;
    }
    const gl = goals(S, seat), hand = p.res, tot = E.total(hand);
    if (canDev) {
      const d = p.dev;
      if (d.indexOf('knight') >= 0 && (robberOnMine(S, seat) || (LV > 1 && (p.knights >= 2 || Math.random() < 0.25)))) return { t: 'playDev', card: 'knight' };
      if (LV > 1 && d.indexOf('road') >= 0 && p.roadsLeft > 0 && myRoads(S, seat).length) return { t: 'playDev', card: 'road' };
      if (LV > 1 && d.indexOf('plenty') >= 0) {
        for (const g of gl) {
          const m = miss(hand, COST[g]); if (m < 1 || m > 2) continue;
          const list = []; RES.forEach((r) => { for (let i = 0; i < Math.max(0, (COST[g][r] || 0) - hand[r]); i++) list.push(r); });
          const a = list[0], b = list[1] || best(RES.filter((r) => S.bank[r] > (r === a ? 1 : 0)), (r) => -hand[r]);
          const need = E.zero(); need[a]++; need[b]++;
          if (RES.every((r) => S.bank[r] >= need[r])) return { t: 'playDev', card: 'plenty', a, b };
        }
      }
      if (LV > 1 && d.indexOf('mono') >= 0) {
        const cnt = (r) => S.players.reduce((s, q, i) => s + (i === seat ? 0 : q.res[r]), 0);
        const r = best(RES, cnt); if (cnt(r) >= (LV === 2 ? 5 : 3)) return { t: 'playDev', card: 'mono', res: r };
      }
    }
    if (LV === 1 && Math.random() < 0.25) return { t: 'endTurn' }; // よわい：ときどき何もせず終える
    if (gl.indexOf('city') >= 0 && E.canAfford(p, COST.city)) return { t: 'buildCity', v: best(E.legalCities(S, seat), (v) => G.verts[v].hexes.reduce((s, h) => s + pips(S.hexes[h].num), 0)) };
    if (gl.indexOf('settlement') >= 0 && E.canAfford(p, COST.settlement)) return { t: 'placeSettlement', v: best(mySpots(S, seat), (v) => vScore(S, v, have)) };
    if (LV > 1) for (const g of (LV === 2 ? gl.slice(0, 1) : gl)) { const t = tradeFor(S, seat, COST[g], true); if (t) return t; }
    const road = () => ({ t: 'placeRoad', e: best(myRoads(S, seat), (e) => roadScore(S, seat, e, have)) });
    if (gl.indexOf('road') >= 0 && E.canAfford(p, COST.road)) return road();
    const top = gl[0];
    if (gl.indexOf('dev') >= 0 && E.canAfford(p, COST.dev) && !(top && top !== 'dev' && top !== 'road' && miss(hand, COST[top]) <= 1)) return { t: 'buyDev' };
    if (p.roadsLeft > 2 && tot > 6 && E.canAfford(p, COST.road) && myRoads(S, seat).length) return road();
    if (tot > 7 && top) { const t = tradeFor(S, seat, COST[top], false); if (t) return t; }
    return { t: 'endTurn' };
  }
  // 「おまかせ」の提案に条件を返す
  function respondOpen(S, seat, lv) {
    const t = S.trade, p = S.players[seat], theirs = S.players[S.turn].res;
    if (lv > 1 && E.publicVP(S, S.turn) >= (lv === 3 ? 7 : 8)) return false;
    const gl = goals(S, seat), d = (h) => (gl.length ? Math.min.apply(null, gl.map((g) => miss(h, COST[g]))) : 0), before = d(p.res);
    const mk = (give, want) => (E.total(give) && E.total(want) && E.canAfford(p, give) ? { give, want } : false);
    if (t.open === 'give') { // 相手：「○○が欲しい。何を出せばいい？」
      const n = E.total(t.want), cands = RES.filter((r) => theirs[r] > 0 && !t.want[r]);
      if (!cands.length) return false;
      const score = (r) => { const h = Object.assign({}, p.res); RES.forEach((x) => { h[x] -= t.want[x]; }); h[r] += Math.min(n, theirs[r]); return (before - d(h)) * 10 - p.res[r]; };
      const r = lv === 1 ? cands[Math.floor(Math.random() * cands.length)] : best(cands, score);
      if (lv > 1 && score(r) <= -10) return false; // 自分の建設が遠のくなら断る
      const want = E.zero(); want[r] = Math.min(n + (lv === 3 && E.publicVP(S, S.turn) >= 5 ? 1 : 0), theirs[r]);
      return mk(Object.assign(E.zero(), t.want), want);
    }
    // 相手：「○○を出す。何をくれる？」
    const n = E.total(t.give), h3 = {}; RES.forEach((r) => { h3[r] = p.res[r] + t.give[r]; });
    const top = gl.filter((g) => g !== 'dev')[0] || gl[0], cost = top ? COST[top] : {};
    const spare = (r) => p.res[r] - (cost[r] || 0);
    const cands = RES.filter((r) => !t.give[r] && (lv === 1 ? p.res[r] > 0 : spare(r) >= 1));
    if (!cands.length || (lv > 1 && d(h3) >= before)) return false;
    const r = best(cands, (x) => spare(x)), give = E.zero(); give[r] = Math.max(1, Math.min(n, lv === 1 ? p.res[r] : spare(r)));
    return mk(give, Object.assign(E.zero(), t.give));
  }
  // 相手からの交渉に答える
  function respond(S, seat, lv) {
    lv = lv || 3;
    const t = S.trade, p = S.players[seat];
    if (!t || !E.canAfford(p, t.want)) return false;
    if (t.open) return respondOpen(S, seat, lv);
    if (lv === 1) return E.total(t.give) >= E.total(t.want);
    if (E.publicVP(S, S.turn) >= (lv === 3 ? 7 : 8)) return false;
    const gl = goals(S, seat); if (!gl.length) return false;
    const d = (h) => Math.min.apply(null, gl.map((g) => miss(h, COST[g])));
    const h2 = {}; RES.forEach((r) => { h2[r] = p.res[r] - t.want[r] + t.give[r]; });
    const before = d(p.res), after = d(h2);
    if (after < before || (after === before && E.total(t.give) > E.total(t.want))) return true;
    // ことわる前に「この条件なら」を考える
    const top = gl.filter((g) => g !== 'dev')[0] || gl[0], cost = COST[top];
    const spare = (r) => p.res[r] - (cost[r] || 0);
    const lack = RES.filter((r) => (cost[r] || 0) > p.res[r]).sort((a, b) => (cost[b] - p.res[b]) - (cost[a] - p.res[a]));
    const mk = (give, want) => (E.total(give) && E.total(want) && E.canAfford(p, give) && !RES.some((r) => give[r] && want[r]) ? { give, want } : false);
    const nW = E.total(t.want);
    // 相手の欲しい物は出せるが、もらう物がいらない → 自分の欲しい物を指定する
    // （相手が持っていない物を頼んでも成立しないので、相手が持っている物の中から選ぶ）
    const theirs = S.players[S.turn].res, ask = lack.filter((r) => theirs[r] >= 1)[0];
    if (ask && RES.every((r) => t.want[r] <= Math.max(0, spare(r)))) {
      const want = E.zero(); want[ask] = Math.max(1, Math.min(nW, cost[ask] - p.res[ask], theirs[ask]));
      if (lv === 3 && E.publicVP(S, S.turn) >= 5) want[ask] = Math.min(want[ask] + 1, theirs[ask], 3);
      if (RES.some((r) => want[r] !== t.give[r])) return mk(Object.assign(E.zero(), t.want), want);
    }
    // もらう物は欲しいが、言われた物は手放せない → 余っている別の物を出す
    const h3 = {}; RES.forEach((r) => { h3[r] = p.res[r] + t.give[r]; });
    if (d(h3) < before) {
      const r = best(RES.filter((x) => spare(x) >= 1 && !t.give[x] && !t.want[x]), (x) => spare(x));
      if (r) { const give = E.zero(); give[r] = Math.min(nW, spare(r)); return mk(give, Object.assign(E.zero(), t.give)); }
    }
    return false;
  }
  const api = { decide, respond };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ShimaAI = api;
})(typeof window !== 'undefined' ? window : globalThis);
