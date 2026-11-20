# このリポジトリで作業するとき

- 直すのは `src/` の中。直したら必ず `node src/build.js` を実行し、できた `index.html` と `peerjs.min.js` も一緒にコミットする（GitHub Pages は main ブランチ直下をそのまま配信する）。
- コミット前に `node src/test_engine.js && node src/test_lv.js && node src/test_counter.js` を通す。
- 画面の文言は日本語。スマホ縦画面が基本。
- 名前・見た目・文言はオリジナルを保つ（市販ゲームの名称やロゴ、絵を入れない）。
- `build/artifact.html` は Claude の公開ページ「ひらけ島」用。そちらの更新は持ち主に確認してから。
- オンライン対戦は親の端末が全データを持つ方式。手番の人の端末がルールを進め、ほかの人の操作（捨て札・交渉の返事）は `inputs` 経由で取りこむ。
