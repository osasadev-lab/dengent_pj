# dengent

複数のディレクトリで複数のAIコーディングエージェントを同時に起動・管理できる、ブラウザベースのランチャー。各セッションの作業状況（作業中／確認待ち／サブエージェント起動中）を2Dアバターとしてリアルタイムに可視化する。

## これは何か

Claude Codeにタスクを投げて別作業と並行させていると、「今ちゃんと動いているか」「確認待ちで止まっていないか」を確認するためだけにターミナルを何度も見に行くことになりがちです。さらに複数のディレクトリで複数のエージェントを並行稼働させたい場合、ターミナルウィンドウがいくつも並ぶだけで全体像を把握しづらくなります。

dengentはブラウザだけで完結するランチャーです。画面上のパネルにディレクトリと最初の指示を入力するだけでエージェントのセッションを開始でき、以降はカラムごとに独立したアバター・チャットログ・状態表示で並行管理できます。ターミナルを一切開かなくても、複数の作業ディレクトリのエージェントを同時に立ち上げて状況を一目で把握できることが最大の特徴です。

## 対応プロバイダ

- **Claude Code**：対応済み
- **Codex**：次のマイルストーンで着手予定（現状はUIの選択肢とエラーハンドリングのみ実装済み。選択すると「近日対応予定」の案内を返す）

## アーキテクチャ

```
ブラウザ（セッション開始パネル）
  → POST /start（ディレクトリ・プロバイダ・最初の指示を送信）
  → リレーサーバーが `claude --print` をヘッドレス起動
  → Claude Codeのhooks発火
      → hookクライアント（Node.js、stdinでJSON受信・非同期POST）
      → リレーサーバー（Express + ws、セッションごとに状態管理）
      → WebSocketで該当カラムへpush（トークン認証付き）
      → PixiJSでアバター描画
```

- **hookは絶対にClaude Code本体をブロックしない**設計（観測用フックに限る）。stdin受信からHTTP送信までを非同期化し、リレーサーバーが落ちていても300msでハード終了するタイムアウトを持たせている（実測パイプライン遅延：数ms〜数十ms）
- 状態はセッションID単位でサーバー側が`IDLE` / `WORKING` / `SUBAGENT_ACTIVE`（並行カウンター） / `WAITING_CONFIRMATION`のステートマシンとして管理し、1カラム＝1セッションとしてブラウザへ配信
- Free/Pro相当の表示制限を見据え、hooksは`~/.claude/settings.json`（ユーザーレベルのグローバル設定）に登録。ただしdengentが`/start`で起動したセッションだけを追跡し、それ以外（ターミナル等から起動された他のセッション）のイベントは完全に無視する
- アバター描画は[PixiJS](https://pixijs.com/)。DOM/フレームワークに依存しない疎結合モジュール（`public/avatar.js`）として実装し、公開APIは`setState` / `setSubagentCount` / `setCharacter` / `destroy`の4つだけ

## 技術的な工夫

- **ヘッドレス実行中のWrite/Edit/Bashをブラウザで許可/拒否**：`claude --print`はTTYが無く対話的な承認プロンプトを出せないため、標準では書き込み系ツールが実行不能になる。`PreToolUse`フック（`Write|Edit|Bash`にのみ発火）がリレーサーバーへ同期的にブロックするHTTPリクエストを送り、ブラウザでユーザーが許可/拒否を押すまでプロセスを待たせる方式で解決した。dengentが起動していないセッション（このdengentを開発しているセッション自身を含む）には即座に「対象外」を返して素通りさせるため、他のClaude Codeセッションを一切妨げない。ブラウザが未接続・再読み込み中に承認要求が発火した場合に備え、保留中のリクエストもセッション状態と同様に再接続時のスナップショットへ含めて復元する
- **セッション開始時のレース条件対策**：`launchId`をサーバーではなくブラウザ側で発行し、`/start`リクエスト送信前に同期的にカラムへ紐付けるようにした。サーバー側で発行する方式だと、HTTPレスポンスが届く前に実プロセスの`UserPromptSubmit`がWebSocket経由で先に届いてしまい、まだ紐付けの終わっていないカラムではなく新しい空カラムが作られてしまう不具合があった
- **同一ディレクトリでの多重起動を防止**：既に稼働中／起動中のセッションと同じディレクトリが指定された場合はサーバー側で`409`を返して拒否する
- **コマンドインジェクション対策**：ブラウザからの返信を`claude --resume`で送り込む機能があるが、`shell: true`を使うと自由入力テキストがそのままシェル文字列に連結される脆弱性があったため、Windowsの`.cmd`シムを解析して実体の`.exe`を直接起動する方式に変更（shellを一切介さない）
- **CSRF/盗聴対策**：ローカルサーバーとはいえ`127.0.0.1`宛のリクエストは任意のWebページから飛ばせてしまうため、サーバー起動ごとに発行するワンタイムトークンで`/start`・`/reply`・WebSocket接続を認証
- **同一セッションへの二重書き込み防止**：ターミナルが作業中の間にブラウザから返信を送ると会話ログが壊れるため、`IDLE`時のみ受付＋送信中ロックで排他制御
- **レイテンシの実測**：hookクライアント自身の処理時間とネットワーク遅延を分離して計測し、体感ではなく数値でボトルネックを追えるようにしている

## 利用までの手順

dengentは自分のPC上でサーバーを立ち上げて使うローカルツールです（外部にデプロイして誰でもアクセスできる形にはまだ対応していません）。現状Windowsでの動作を前提としています。

### 前提条件

- Node.js（18以上推奨）
- [Claude Code CLI](https://docs.claude.com/claude-code)がインストール・ログイン済みで、ターミナルから`claude`コマンドが使える状態になっていること

### 1. リポジトリを取得して依存関係をインストール

```bash
git clone https://github.com/osasadev-lab/dengent_pj.git
cd dengent_pj
npm install
```

### 2. Claude Codeのhooksを登録する

dengentはClaude Codeの`hooks`機能を使って作業状況を検知するため、ユーザーレベルのグローバル設定ファイル`~/.claude/settings.json`（Windowsなら`%USERPROFILE%\.claude\settings.json`）にhooksを登録する必要があります。これによりPC上で起動するClaude Codeのセッション全体がdengentに観測されるようになります（dengent以外から起動したセッションは自動的に無視されます）。

ファイルが無ければ新規作成し、既にある場合は`hooks`キーを以下の内容とマージしてください。`<dengent_pjへのパス>`は手順1でクローンした実際の絶対パスに置き換えてください（Windowsでもパス区切りは`/`のままで問題ありません）。

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node <dengent_pjへのパス>/.claude-avatar/hook-relay.js", "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node <dengent_pjへのパス>/.claude-avatar/hook-relay.js", "timeout": 5 }] },
      { "matcher": "Write|Edit|Bash", "hooks": [{ "type": "command", "command": "node <dengent_pjへのパス>/.claude-avatar/permission-gate.js", "timeout": 120 }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node <dengent_pjへのパス>/.claude-avatar/hook-relay.js", "timeout": 5 }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node <dengent_pjへのパス>/.claude-avatar/hook-relay.js", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node <dengent_pjへのパス>/.claude-avatar/hook-relay.js", "timeout": 5 }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node <dengent_pjへのパス>/.claude-avatar/hook-relay.js", "timeout": 5 }] }
    ]
  }
}
```

- `hook-relay.js`は状態を観測してdengentへ転送するだけの軽量フック（Claude Code本体をブロックしない）
- `permission-gate.js`はWrite/Edit/Bash実行前にブラウザでの許可待ちを行うフック（dengentが起動していないセッションには一切影響しない）
- hooksは**セッション開始時にのみ読み込まれる**ため、設定変更後は新規にセッションを開始する必要があります（既存のターミナルセッションには反映されません）

### 3. サーバーを起動する

```bash
npm start
```

`http://127.0.0.1:4317/` をブラウザで開くと、セッション開始パネルが表示されます。

### 4. セッションを開始する

プロバイダ（現状はClaude Codeのみ）・ディレクトリ（📂ボタンで選択）・最初の指示を入力して「開始」を押すと、そのディレクトリに対するエージェントセッションがバックグラウンドで立ち上がります。セッションが増えるとカラムが自動で追加され、複数ディレクトリを並行して管理できます。Write/Edit/Bashの実行前にはチャット上に許可/拒否ボタンが表示されるので、内容を確認して許可してください。

デバッグログ（hookイベントの生データ・レイテンシ計測）は `?debug=1` を付けるか、画面右上の「🛠 デバッグ」ボタンで表示できます。

## アンインストール

hooksは`~/.claude/settings.json`というグローバル設定に登録されるため、フォルダを削除しただけでは残ってしまいます。以下の順で片付けてください。

### 1. サーバーを停止する

`npm start`を実行しているターミナルで`Ctrl+C`。

### 2. hooksの登録を削除する

`~/.claude/settings.json`（Windowsなら`%USERPROFILE%\.claude\settings.json`）を開き、`"利用までの手順"`の手順2で追加した`command`が`dengent_pj/.claude-avatar/`を指しているエントリだけを削除してください。他のツール用に自分で追加した`hooks`やその他の設定（`theme`など）が同じファイルにある場合は、それらは残したままで構いません。

全てのエントリを削除した後、`hooks`キーの中身が空になった場合は`hooks`キーごと削除して構いません。

これを忘れてdengent_pjのフォルダだけを削除すると、以後Claude Codeのセッションで`node <消したはずのパス>/.claude-avatar/hook-relay.js`のようなコマンドが見つからずエラーになり続けるので、必ずhooksの削除を先に行ってください。

### 3. リポジトリを削除する

`dengent_pj`フォルダごと削除して問題ありません。Claude Code側の会話履歴（`claude --resume`で辿れるもの）はdengentとは独立して保存されているため、影響を受けません。

## 使用アセット

キャラクターアバターは[CraftPix.net](https://craftpix.net/)の無料素材（[Free Homeless Character Sprite Sheets Pixel Art](https://craftpix.net/freebies/free-homeless-character-sprite-sheets-pixel-art/)）を使用。商用利用可・クレジット表記不要のライセンス（[craftpix.net/file-licenses](https://craftpix.net/file-licenses/)で確認済み）。Free版は3種類のアバターから選択可能。

## ステータス

コア体験のMVP化フェーズ進行中。Claude Codeでの複数ディレクトリ並行運用・ブラウザ承認フローまで実装済み。次のマイルストーンはCodexプロバイダの実装。
