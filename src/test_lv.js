const E=require('./engine.js'),AI=require('./ai.js');
function play(lvs){const n=lvs.length;const S=E.newGame(lvs.map((_,i)=>({uid:'c'+i,name:'C'+i})));let m=0,turns=0;
 while(S.phase!=='over'){let seat=S.turn;if(S.phase==='discard')seat=+Object.keys(S.discardNeed)[0];const a=AI.decide(S,seat,lvs[seat]);const r=a?E.apply(S,seat,a):{err:'null'};if(r.err){console.log('ERR',r.err,JSON.stringify(a),S.phase,lvs[seat]);process.exit(1);}if(a.t==='endTurn')turns++;if(++m>40000){console.log('too long');process.exit(1);}}
 return {w:lvs[S.winner],rounds:turns/n};}
const wins={1:0,2:0,3:0};const perms=[[1,2,3],[1,3,2],[2,1,3],[2,3,1],[3,1,2],[3,2,1]];
for(let g=0;g<240;g++)wins[play(perms[g%6]).w]++;
console.log('3人混合 240戦 勝ち数 よわい/ふつう/つよい',wins[1],wins[2],wins[3]);
for(const lv of [1,2,3]){let r=[];for(let g=0;g<40;g++)r.push(play([lv,lv,lv,lv]).rounds);r.sort((a,b)=>a-b);console.log('Lv'+lv+'同士 4人 手番数の中央値',r[20].toFixed(0));}
