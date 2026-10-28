# DotAI — ドット絵ジェネレーター

プロンプトからLLMにピクセルデータ（パレット＋文字の行）を出力させ、ドット絵として描画・編集・保存するローカルWebアプリです。

## 起動

- `start.bat` をダブルクリック（初回は自動で `npm install`、ブラウザも自動で開きます）
- または `npm install` → `npm start` → http://localhost:3000

必要なもの: Node.js 18 以上

## 使い方

1. 右上の「⚙ 設定」で使うAI（Claude / Gemini / OpenAI / Ollama）を選び、APIキーとモデル名を設定
2. 左パネルでテンプレート・プロンプト・サイズ・パレット・色数・スタイルと「案の数」を選んで「✨ 生成する」
   - 複数案は並列で生成され、右パネルの「候補」から選べます（全案が履歴にも保存されます）
3. 中央のキャンバスで手直し（ペン B / 消しゴム E・右クリック / 塗りつぶし G / スポイト I / 左右対称描き M / Ctrl+Z, Ctrl+Y / 前後のコマ , .）
4. 「今の絵をAIで修正」で、プロンプトを修正指示として今の絵を作り直せます
5. 「5. アニメーション」で動きとコマ数を選び「🎞 今の絵からアニメを生成」→ 今のコマを1コマ目に残りのコマを生成
   - キャンバス下のコマ一覧で複製・追加・並べ替え・削除、👻で前のコマを薄く表示、FPSで再生速度を変更
6. 右パネルから書き出し：PNG（今のコマ）/ スプライトシート（列数0で横一列）/ アニメGIF / JSON。生成した絵は履歴に自動保存されます

## 仕組み

```
プロンプト + 設定 ──► server.js ──► LLM (JSON: palette + rows)
                                    │
ブラウザ ◄── グリッド (palette, pixels) ◄┘
   └ 後処理: パレット固定 / 減色 / 左右対称 / 背景透過 → 編集 → 保存
```

| ファイル | 役割 |
| --- | --- |
| `server.js` | 画面配信・生成API・設定/履歴API（サーバーはこれ1つ） |
| `lib/prompt.js` | LLMへの指示文と出力の検証・補正（行数や幅のズレを自動修正） |
| `lib/providers.js` | 各AIの呼び出し（Claude は公式SDK、他は fetch） |
| `lib/storage.js` | `data/settings.json`・`data/history/` への保存 |
| `public/js/data.js` | パレット・テンプレートの定義（ここを編集して追加できます） |
| `public/js/pixel.js` | 減色・輪郭線・背景除去・リサイズなどの加工 |
| `public/js/editor.js` | ピクセル編集キャンバス（複数コマ・Undo対応） |
| `public/js/gif.js` | 依存なしのアニメGIFエンコーダー |

APIキーは `data/settings.json`（git管理外）に保存されます。環境変数 `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` でも指定できます。
