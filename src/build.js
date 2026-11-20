// 組み立て：src の部品から、公開用の index.html（リポジトリ直下）を作る
//   node src/build.js
const fs = require('fs'), path = require('path');
const d = __dirname, rd = (f) => fs.readFileSync(path.join(d, f), 'utf8');
const body = rd('template.html').replace('/*ENGINE*/', () => rd('engine.js')).replace('/*AI*/', () => rd('ai.js')).replace('/*APP*/', () => rd('app.js'));
// GitHub Pages 用（ログイン不要のオンライン対戦つき）
fs.writeFileSync(path.join(d, '..', 'index.html'), body.replace('<!--PEER-->', '<script src="peerjs.min.js"></script>'));
fs.copyFileSync(path.join(d, 'vendor', 'peerjs.min.js'), path.join(d, '..', 'peerjs.min.js'));
// Claude の公開ページ用（通信ライブラリなし。CPU対戦と1台まわしだけ動く）
fs.mkdirSync(path.join(d, '..', 'build'), { recursive: true });
fs.writeFileSync(path.join(d, '..', 'build', 'artifact.html'), body.replace('<!--PEER-->\n', ''));
console.log('built', body.length);
