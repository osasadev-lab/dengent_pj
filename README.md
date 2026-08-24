# dengent

Claude Codeの作業状況（作業中／確認待ち／サブエージェント起動中）を、ブラウザ上の2Dアバターとしてリアルタイムに可視化するツール。

![dengent demo](./docs/dengent-demo.gif)

## これは何か

Claude Codeにタスクを投げて別作業と並行させていると、「今ちゃんと動いているか」「確認待ちで止まっていないか」を確認するためだけにターミナルを何度も見に行くことになりがちです。dengentは、Claude Codeのhooksを購読してその状態をアバターの動き・吹き出しとしてブラウザに表示し、ターミナルを見なくても一目で状況がわかるようにします。

デモモード（画面右上の「▶ デモを再生」）を使えば、実際にClaude Codeを起動していなくても一連の状態遷移を確認できます。

## アーキテクチャ

```
Claude Code (hooks発火)
  → hookクライアント（Node.js、stdinでJSON受信・非同期POST）
  → ローカルリレーサーバー（Express + ws、状態管理）
  → WebSocketでブラウザへpush（トークン認証付き）
  → PixiJSでアバター描画
```

- **hookは絶対にClaude Code本体をブロックしない**設計。stdin受信からHTTP送信までを非同期化し、リレーサーバーが落ちていても300msでハード終了するタイムアウトを持たせている（実測パイプライン遅延：数ms〜数十ms）
- 状態はサーバー側で`IDLE` / `WORKING` / `SUBAGENT_ACTIVE`（並行カウンター） / `WAITING_CONFIRMATION`のステートマシンとして管理
- アバター描画は[PixiJS](https://pixijs.com/)。DOM/フレームワークに依存しない疎結合モジュール（`public/avatar.js`）として実装し、公開APIは`setState` / `setSubagentCount`の2つだけ

## 技術的な工夫

- **コマンドインジェクション対策**：ブラウザからの返信を`claude --resume`で送り込む機能があるが、`shell: true`を使うと自由入力テキストがそのままシェル文字列に連結される脆弱性があったため、Windowsの`.cmd`シムを解析して実体の`.exe`を直接起動する方式に変更（shellを一切介さない）
- **CSRF/盗聴対策**：ローカルサーバーとはいえ`127.0.0.1`宛のリクエストは任意のWebページから飛ばせてしまうため、サーバー起動ごとに発行するワンタイムトークンで`/reply`とWebSocket接続の両方を認証
- **同一セッションへの二重書き込み防止**：ターミナルが作業中の間にブラウザから返信を送ると会話ログが壊れるため、`IDLE`時のみ受付＋送信中ロックで排他制御
- **レイテンシの実測**：hookクライアント自身の処理時間とネットワーク遅延を分離して計測し、体感ではなく数値でボトルネックを追えるようにしている
- **ヘッドレス実行中のWrite/Edit/Bashをブラウザで許可/拒否**：`claude --print`はTTYが無く対話的な承認プロンプトを出せないため、標準では書き込み系ツールが実行不能になる。`PreToolUse`フック（`Write|Edit|Bash`にのみ発火）がリレーサーバーへ同期的にブロックするHTTPリクエストを送り、ブラウザでユーザーが許可/拒否を押すまでプロセスを待たせる方式で解決した。dengentが起動していないセッション（このdengentを開発しているセッション自身を含む）には即座に「対象外」を返して素通りさせるため、他のClaude Codeセッションを一切妨げない。ブラウザが未接続・再読み込み中に承認要求が発火した場合に備え、保留中のリクエストもセッション状態と同様に再接続時のスナップショットへ含めて復元する

## セットアップ

```bash
npm install
npm start
```

別ウィンドウでこのディレクトリに対してClaude Codeを起動すると、hooksが自動的にイベントを送るようになります（`.claude/settings.json`で設定済み）。

```bash
cd dengent_pj
claude
```

ブラウザで `http://127.0.0.1:4317/` を開くとアバターが表示されます。デバッグログは `?debug=1` を付けるか、画面右上の「🛠 デバッグ」ボタンで表示できます。

## 使用アセット

キャラクターアバターは[CraftPix.net](https://craftpix.net/)の無料素材（[Free Homeless Character Sprite Sheets Pixel Art](https://craftpix.net/freebies/free-homeless-character-sprite-sheets-pixel-art/)）を使用。商用利用可・クレジット表記不要のライセンス（[craftpix.net/file-licenses](https://craftpix.net/file-licenses/)で確認済み）。

## ステータス

現在Phase2（コア体験のMVP化）進行中。詳細は`docs/dengent/`配下の企画書・基本設計・実行計画を参照。
