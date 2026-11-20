// 自動対戦でルールエンジンを検証する
const E = require('./engine.js');
const { G, RES } = E;
function mulberry(a) { return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const assert = (c, m) => { if (!c) throw new Error(m); };

assert(G.hexes.length === 19 && G.verts.length === 54 && G.edges.length === 72, 'geometry counts');
assert(G.coast.length === 30, 'coast ' + G.coast.length);
assert(G.verts.every((v) => v.adj.length >= 2 && v.adj.length <= 3), 'vertex degree');
// 港どうしが頂点を共有しない
{ const used = {}; G.portSlots.forEach((e) => { [G.edges[e].a, G.edges[e].b].forEach((v) => { assert(!used[v], 'ports share vertex'); used[v] = 1; }); }); }

function conserve(S) {
  RES.forEach((r) => { const t = S.bank[r] + S.players.reduce((s, p) => s + p.res[r], 0); assert(t === 19, 'conservation ' + r + '=' + t); assert(S.bank[r] >= 0, 'bank<0'); S.players.forEach((p) => assert(p.res[r] >= 0, 'neg hand')); });
  const dev = S.devDeck.length + S.players.reduce((s, p) => s + p.dev.length + p.devNew.length + p.knights, 0);
  assert(dev <= 25, 'dev count');
  S.players.forEach((p, s) => {
    const st = S.bld.filter((b) => b && b.p === s && b.t === 1).length, ct = S.bld.filter((b) => b && b.p === s && b.t === 2).length, rd = S.roads.filter((x) => x === s).length;
    assert(st + p.settlementsLeft === 5, 'settlement pieces'); assert(ct + p.citiesLeft === 4, 'city pieces'); assert(rd + p.roadsLeft === 15, 'road pieces');
  });
  // 距離ルール
  S.bld.forEach((b, v) => { if (b) G.verts[v].adj.forEach((u) => assert(!S.bld[u], 'distance rule')); });
}
const pick = (a, rnd) => a[Math.floor(rnd() * a.length)];

function botMove(S, rnd) {
  const s = S.turn, p = S.players[s];
  if (S.phase === 'discard') {
    const seat = +Object.keys(S.discardNeed)[0], q = S.players[seat], res = E.zero(); let n = S.discardNeed[seat];
    const pool = []; RES.forEach((r) => { for (let i = 0; i < q.res[r]; i++) pool.push(r); });
    while (n--) res[pool.splice(Math.floor(rnd() * pool.length), 1)[0]]++;
    return [seat, { t: 'discard', res }];
  }
  if (S.phase === 'setup') return S.setup.need === 's' ? [s, { t: 'placeSettlement', v: pick(E.legalSettlements(S, s), rnd) }] : [s, { t: 'placeRoad', e: pick(E.legalRoads(S, s), rnd) }];
  if (S.phase === 'robber') { let h; do { h = Math.floor(rnd() * 19); } while (h === S.robber); return [s, { t: 'moveRobber', h }]; }
  if (S.phase === 'steal') return [s, { t: 'steal', target: pick(S.victims, rnd) }];
  if (S.phase === 'roadbuilding') return [s, { t: 'placeRoad', e: pick(E.legalRoads(S, s), rnd) }];
  const playable = p.dev.filter((c) => c !== 'vp');
  if (!S.devPlayed && playable.length && rnd() < 0.5) {
    const c = pick(playable, rnd);
    if (c === 'plenty') { const a = pick(RES, rnd), b = pick(RES, rnd); const need = E.zero(); need[a]++; need[b]++; if (RES.every((r) => S.bank[r] >= need[r])) return [s, { t: 'playDev', card: c, a, b }]; }
    else if (c === 'mono') return [s, { t: 'playDev', card: c, res: pick(RES, rnd) }];
    else return [s, { t: 'playDev', card: c }];
  }
  if (S.phase === 'roll') return [s, { t: 'roll' }];
  // main
  if (S.trade) {
    const others = S.players.map((_, i) => i).filter((i) => i !== s);
    const un = others.filter((i) => S.trade.resp[i] === undefined);
    if (un.length) { const o = un[0]; return [o, { t: 'respondTrade', id: S.trade.id, ok: E.canAfford(S.players[o], S.trade.want) && rnd() < 0.7 }]; }
    const acc = others.filter((i) => S.trade.resp[i] === true);
    return acc.length ? [s, { t: 'confirmTrade', with: pick(acc, rnd) }] : [s, { t: 'cancelTrade' }];
  }
  const opts = [];
  if (E.canAfford(p, E.COST.city) && p.citiesLeft > 0) E.legalCities(S, s).forEach((v) => opts.push({ t: 'buildCity', v }));
  if (E.canAfford(p, E.COST.settlement) && p.settlementsLeft > 0) E.legalSettlements(S, s).forEach((v) => opts.push({ t: 'placeSettlement', v }));
  if (opts.length) return [s, pick(opts, rnd)];
  if (E.canAfford(p, E.COST.road) && p.roadsLeft > 0 && rnd() < 0.5) { const l = E.legalRoads(S, s); if (l.length) return [s, { t: 'placeRoad', e: pick(l, rnd) }]; }
  if (E.canAfford(p, E.COST.dev) && S.devDeck.length && rnd() < 0.5) return [s, { t: 'buyDev' }];
  const rich = RES.filter((r) => p.res[r] >= E.tradeRate(S, s, r));
  if (rich.length && rnd() < 0.4) { const give = pick(rich, rnd); const get = pick(RES.filter((r) => r !== give && S.bank[r] > 0), rnd); if (get) return [s, { t: 'bankTrade', give, get }]; }
  if (rnd() < 0.15) { const have = RES.filter((r) => p.res[r] > 0); if (have.length) { const g = pick(have, rnd), w = pick(RES.filter((r) => r !== g), rnd); const give = {}, want = {}; give[g] = 1; want[w] = 1; return [s, { t: 'offerTrade', give, want }]; } }
  return [s, { t: 'endTurn' }];
}

let stats = { games: 0, moves: 0, lr: 0, la: 0, trades: 0, wins: [0, 0, 0, 0], maxVP: 0 };
for (let g = 0; g < 300; g++) {
  const rnd = mulberry(1000 + g), n = 2 + (g % 3);
  const S = E.newGame(Array.from({ length: n }, (_, i) => ({ uid: 'u' + i, name: 'P' + i })), rnd);
  // 6と8が隣り合わない
  S.hexes.forEach((h, i) => { if (h.num === 6 || h.num === 8) G.hexAdj[i].forEach((j) => assert(!(S.hexes[j].num === 6 || S.hexes[j].num === 8), 'hot adjacent')); });
  let moves = 0;
  while (S.phase !== 'over') {
    const [seat, a] = botMove(S, rnd);
    const before = JSON.stringify(S);
    const r = E.apply(S, seat, a, rnd);
    assert(!r.err, 'bot move rejected: ' + JSON.stringify(a) + ' ' + r.err + ' phase=' + S.phase);
    assert(JSON.stringify(S) !== before, 'no change');
    conserve(S);
    if (a.t === 'confirmTrade') stats.trades++;
    if (++moves > 60000) throw new Error('game did not end, seed ' + g);
  }
  assert(E.totalVP(S, S.winner) >= 10, 'winner vp');
  assert(JSON.stringify(JSON.parse(JSON.stringify(S))) === JSON.stringify(S), 'json roundtrip');
  stats.games++; stats.moves += moves; stats.wins[S.winner]++; if (S.longestRoad !== null) stats.lr++; if (S.largestArmy !== null) stats.la++;
}
// 不正な操作ははじく
{
  const S = E.newGame([{ uid: 'a', name: 'A' }, { uid: 'b', name: 'B' }, { uid: 'c', name: 'C' }], mulberry(5));
  assert(E.apply(S, 1, { t: 'placeSettlement', v: 0 }).err, 'not your turn');
  assert(!E.apply(S, 0, { t: 'placeSettlement', v: 0 }).err, 'place ok');
  assert(E.apply(S, 0, { t: 'placeSettlement', v: 1 }).err, 'need road');
  const far = G.edges.findIndex((e) => e.a !== 0 && e.b !== 0);
  assert(E.apply(S, 0, { t: 'placeRoad', e: far }).err, 'road must touch');
  assert(E.apply(S, 0, { t: 'roll' }).err, 'no roll in setup');
  assert(E.apply(S, 0, { t: 'discard', res: { wood: -1, brick: 1 } }).err, 'bad bundle');
}
// 最長交易路：相手の開拓地で分断される
{
  const S = E.newGame([{ uid: 'a', name: 'A' }, { uid: 'b', name: 'B' }], mulberry(9));
  S.phase = 'main';
  const h = G.hexes[9]; // 中央タイルを一周（6本）
  h.e.forEach((e) => { S.roads[e] = 0; });
  assert(E.roadLen(S, 0) === 6, 'loop len ' + E.roadLen(S, 0));
  S.bld[h.v[0]] = { p: 1, t: 1 };
  assert(E.roadLen(S, 0) === 6, 'loop cut once still 6: ' + E.roadLen(S, 0));
  S.bld[h.v[3]] = { p: 1, t: 1 };
  assert(E.roadLen(S, 0) === 3, 'loop cut twice 3: ' + E.roadLen(S, 0));
}
console.log('OK', JSON.stringify(stats), 'avg moves', Math.round(stats.moves / stats.games));
