# ひらけ島

六角タイルの島を切りひらく、3〜4人用の資源あつめと陣取りのゲーム。ブラウザだけで動く。

- CPUと遊ぶ（よわい／ふつう／つよい）
- 1台をまわして遊ぶ
- 友達とオンライン：部屋コードで集まる。ログイン不要。部屋を作った人の端末が親になり、全員がそこへ直接つながる（PeerJS）

## 作り
- `src/engine.js` ルール（状態はただのJSON、`apply(S, seat, action)`）
- `src/ai.js` CPUの考え方
- `src/app.js` 画面と通信
- `src/template.html` 見た目（HTMLとCSS）
- `index.html` `peerjs.min.js` は `node src/build.js` で作られる公開用ファイル

## 確かめ方
```
node src/test_engine.js   # ルール：自動対戦300ゲーム
node src/test_lv.js       # CPUの強さの差
node src/test_counter.js  # 交渉の逆提案
```
