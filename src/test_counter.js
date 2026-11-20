const E=require('./engine.js'),AI=require('./ai.js');const assert=(c,m)=>{if(!c)throw new Error(m)};
// ルール：逆提案→成立で札が正しく動く
{const S=E.newGame([{uid:'a',name:'A'},{uid:'b',name:'B'},{uid:'c',name:'C'}]);while(S.phase==='setup')E.apply(S,S.turn,AI.decide(S,S.turn));S.phase='main';S.turn=0;
 const z=E.zero;S.players.forEach(p=>{E.RES.forEach(r=>{S.bank[r]+=p.res[r];p.res[r]=0})});const giveTo=(s,r,n)=>{S.players[s].res[r]+=n;S.bank[r]-=n};giveTo(0,'wood',2);giveTo(0,'ore',1);giveTo(1,'sheep',2);
 assert(!E.apply(S,0,{t:'offerTrade',give:{wood:1},want:{sheep:1}}).err,'offer');
 assert(E.apply(S,0,{t:'counterTrade',id:S.trade.id,give:{wood:1},want:{ore:1}}).err,'offerer cannot counter');
 assert(E.apply(S,1,{t:'counterTrade',id:S.trade.id,give:{brick:1},want:{wood:1}}).err,'cannot afford');
 assert(!E.apply(S,1,{t:'counterTrade',id:S.trade.id,give:{sheep:1},want:{wood:2}}).err,'counter ok');
 assert(S.trade.resp[1]==='counter','resp');assert(E.apply(S,0,{t:'confirmTrade',with:1}).err,'confirm must fail');
 assert(E.apply(S,0,{t:'acceptCounter',with:2}).err,'no counter from 2');
 assert(!E.apply(S,0,{t:'acceptCounter',with:1}).err,'accept');
 assert(S.players[0].res.wood===0&&S.players[0].res.sheep===1&&S.players[1].res.wood===2&&S.players[1].res.sheep===1&&S.trade===null,'moved');
 E.RES.forEach(r=>assert(S.bank[r]+S.players.reduce((s,p)=>s+p.res[r],0)===19,'conserve'));}
// CPU：対戦の途中で1対1の提案をたくさん投げ、返事の内訳を見る
const cnt={1:{y:0,n:0,c:0},2:{y:0,n:0,c:0},3:{y:0,n:0,c:0}};
for(let g=0;g<60;g++){const S=E.newGame([0,1,2,3].map(i=>({uid:'c'+i,name:'C'+i})));let m=0;
 while(S.phase!=='over'&&m++<20000){let seat=S.turn;if(S.phase==='discard')seat=+Object.keys(S.discardNeed)[0];
  if(S.phase==='main'&&!S.trade&&Math.random()<0.3){const p=S.players[seat];const have=E.RES.filter(r=>p.res[r]>0);if(have.length){const gv=have[Math.floor(Math.random()*have.length)];const wt=E.RES.filter(r=>r!==gv)[Math.floor(Math.random()*4)];const T=JSON.parse(JSON.stringify(S));if(!E.apply(T,seat,{t:'offerTrade',give:{[gv]:1},want:{[wt]:1}}).err){for(let o=0;o<4;o++){if(o===seat)continue;for(const lv of [1,2,3]){const a=AI.respond(T,o,lv);if(a&&typeof a==='object'){cnt[lv].c++;const U=JSON.parse(JSON.stringify(T));const r=E.apply(U,o,{t:'counterTrade',id:U.trade.id,give:a.give,want:a.want});assert(!r.err,'cpu counter invalid: '+r.err+JSON.stringify(a));assert(JSON.stringify(a.give)!==JSON.stringify(T.trade.want)||JSON.stringify(a.want)!==JSON.stringify(T.trade.give),'same as original');}else if(a)cnt[lv].y++;else cnt[lv].n++;}}}}}
  const a=AI.decide(S,seat,3);if(E.apply(S,seat,a).err)throw new Error('ai err');}}
console.log('返事の内訳（受ける/ことわる/逆提案）',JSON.stringify(cnt));
