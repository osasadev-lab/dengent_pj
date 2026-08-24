// dengent Phase1 ローカルリレーサーバー
// hook-relay.jsからのイベントをHTTPで受け、WebSocketで接続中のブラウザへ
// そのままpushする。セッションごとの状態（IDLE/WORKING/...）もここで
// 保持・計算する。
//
// 方針転換（2026-08-23）：単一セッションの観測ツールから、ブラウザ側で
// 複数ディレクトリ・複数AIプロバイダ（Claude/将来Codex）のセッションを
// 起動・管理する「ランチャー」に変わった。これに伴い、hooksはグローバル
// （~/.claude/settings.json）に登録されているため、ターミナルから独立に
// 起動されたセッションのイベントも本来は届いてしまう。dengentは
// 「このサーバー自身が/startで起動したセッション」だけを追跡し、それ以外の
// イベントは無視する（launchedSessions参照）。
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');

// サーバー起動ごとに使い捨てのトークンを発行する。/replyとWS /streamは
// このトークンを持つリクエストしか受け付けない。悪意あるWebページが
// ローカルの127.0.0.1:4317に直接fetch/WebSocket接続してきても、
// レスポンス本文（トークンが埋め込まれたHTML）はCORSで読み取れないため
// このトークンを知りようがない（詳細は index.html 配信ルートのコメント参照）。
const DENGENT_TOKEN = crypto.randomBytes(32).toString('hex');

// ブラウザからの返信をclaude --resumeで送り込んでから、次のUserPromptSubmit
// フックが来るまでの猶予（この間に返信が来なければ送信失敗とみなし解除する）
const REPLY_ACK_TIMEOUT_MS = 20000;

// /startで起動してから、最初のUserPromptSubmitで実session_idと紐付くまでの猶予。
// これを過ぎても紐付かなければ起動失敗とみなしクライアントへエラー通知する
const LAUNCH_ACK_TIMEOUT_MS = 20000;

// claudeの実行ファイルを解決する。shell:trueは使わない方針（ブラウザから来た
// 自由入力をシェル文字列に連結することになり、コマンドインジェクションの
// リスクがあるため）。Windowsのnpmグローバルインストールは`claude.cmd`という
// シム（バッチファイル）で、.cmdはshellを介さないと直接起動できずEINVALになる
// ため、シムの中身を読んで実体（claude.exe）のパスを解決してそれを直接叩く。
function resolveClaudeBinary() {
  try {
    if (process.platform === 'win32') {
      const whereOut = execFileSync('where', ['claude.cmd'], { encoding: 'utf8' });
      const cmdPath = whereOut.split(/\r?\n/)[0].trim();
      const cmdContent = fs.readFileSync(cmdPath, 'utf8');
      const match = cmdContent.match(/"([^"]+\.(exe|js))"/i);
      if (match) {
        // シム内の%dp0%はこの.cmdファイル自身のディレクトリ（末尾\付き）を指すバッチ変数
        return match[1].replace(/%dp0%/i, path.dirname(cmdPath) + path.sep);
      }
      console.error('[dengent] could not parse claude.cmd shim, falling back to "claude"');
    } else {
      const whereOut = execFileSync('which', ['claude'], { encoding: 'utf8' });
      return whereOut.trim();
    }
  } catch (err) {
    console.error('[dengent] failed to resolve claude binary path:', err.message);
  }
  return null;
}

const CLAUDE_BIN = resolveClaudeBinary();

const PORT = 4317;

// 受信イベントの永続ログ（検証項目④の振り返り用：ブラウザを閉じても
// あとから「Notificationは本当に毎回飛んだか」等を確認できるようにする）
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'events.jsonl');
fs.mkdirSync(LOG_DIR, { recursive: true });

// NODE_ENV=productionで起動した場合は「デプロイ後」とみなし、デバッグ機能
// （ボタン・?debug=1・デモ再生）を一切クライアントに露出しない
const IS_DEV_MODE = process.env.NODE_ENV !== 'production';

const app = express();
app.use(express.json({ limit: '2mb' }));

// index.htmlだけは静的配信せず、トークンを埋め込んでから返す。
// （このHTMLを取得できるのはこのPC上のブラウザだけ＝127.0.0.1宛のリクエストが
// 通る相手だが、外部サイトがfetchしても同一オリジンでないためレスポンスの
// 中身は読めず、トークンを盗み出すことはできない）
app.get(['/', '/index.html'], (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  res.type('html')
    .send(html.replace('__DENGENT_TOKEN__', DENGENT_TOKEN).replace('__DENGENT_DEV__', String(IS_DEV_MODE)));
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// PixiJSはバンドラを使わずESモジュールとしてブラウザへそのまま配信する
// （Phase2はVanilla HTML/JS方針のため、node_modules内のビルド済みファイルを直接返す）
app.get('/vendor/pixi.min.mjs', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'node_modules', 'pixi.js', 'dist', 'pixi.min.mjs'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/stream',
  // WebSocketはブラウザJSからカスタムヘッダーを付けられないため、
  // トークンはクエリパラメータで渡す。ハンドシェイクの時点で弾く。
  verifyClient: (info, callback) => {
    try {
      const url = new URL(info.req.url, 'http://localhost');
      if (url.searchParams.get('token') === DENGENT_TOKEN) return callback(true);
    } catch {
      // fallthrough to reject below
    }
    callback(false, 401, 'Unauthorized');
  },
});

/** @type {Map<string, {sessionId: string, launchId: string, provider: string, cwd: string, state: string, subagentCount: number, notification: string|null, lastMessage: string|null, pendingReply: boolean, lastEvent: string, lastUpdated: number}>} */
const sessions = new Map();

// dengentが/startで起動したものだけを追跡するための2つの台帳。
// pendingLaunches: launchId -> {cwd, provider, createdAt}（まだ実session_idが不明なもの）
// launchIdBySessionId: session_id -> launchId（実session_idが判明した後の紐付け）
// この2つに登場しないsession_idからのイベントは、ターミナル等dengent外で
// 起動されたセッションとみなして無視する（今回の要望の核）。
const pendingLaunches = new Map();
const launchIdBySessionId = new Map();

function getOrCreateSession(sessionId, cwd, launchId, provider) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      sessionId,
      launchId,
      provider: provider || 'claude',
      cwd: cwd || '',
      state: 'IDLE',
      subagentCount: 0,
      notification: null,
      lastMessage: null, // Claudeが直前に応答したメッセージ本文（last_assistant_messageから取得）
      pendingReply: false, // ブラウザからの返信をclaude --resumeで送信中かどうか（二重送信防止）
      lastEvent: null,
      lastUpdated: Date.now(),
    };
    sessions.set(sessionId, s);
  }
  if (cwd) s.cwd = cwd;
  return s;
}

// 基本設計.md §2の状態遷移表に沿ってセッション状態を更新する
function reduce(session, evt) {
  const name = evt.hook_event_name;
  switch (name) {
    case 'UserPromptSubmit':
      session.state = 'WORKING';
      // 新しいやり取りが始まったので、前回の応答メッセージ表示はクリアする
      session.lastMessage = null;
      // ブラウザ発の返信であれ、ターミナルからの入力であれ、新しいターンが
      // 開始した時点でpendingReplyロックは解除してよい
      session.pendingReply = false;
      break;
    case 'PreToolUse':
      if (evt.tool_name === 'Task') {
        // サブエージェント起動：カウンターを+1（真偽値ではなくカウント管理）
        session.subagentCount = (session.subagentCount || 0) + 1;
      }
      session.state = 'WORKING';
      break;
    case 'PostToolUse':
      session.state = 'WORKING';
      break;
    case 'Notification':
      // notification_typeによって性質が全く異なる（実機検証で判明、2026-08-23）：
      // - "permission_prompt"：Claudeが本当に先に進めず、承認が無いと止まったまま。緊急度が高い
      // - "idle_prompt"：Stopで応答が終わった後、しばらく次の入力が無いだけの軽い催促。
      //   この時点で既にIDLEのはずなので、確認待ちの強い演出（赤点滅等）は出さない
      // それ以外の未知のtype（auth_success等）は、安全側に倒してWAITING_CONFIRMATION扱いにする
      if (evt.notification_type === 'idle_prompt') {
        session.state = 'IDLE';
      } else {
        session.state = 'WAITING_CONFIRMATION';
        session.notification = evt.message || '';
      }
      break;
    case 'Stop':
      session.state = 'IDLE';
      // last_assistant_messageはClaude Code自身がペイロードに含めてくれる
      // フィールド（実機確認済み）。自分でtranscriptを読み直す必要はない。
      if (evt.last_assistant_message) {
        session.lastMessage = evt.last_assistant_message;
      }
      break;
    case 'SubagentStop':
      session.subagentCount = Math.max(0, (session.subagentCount || 0) - 1);
      break;
    default:
      // 未登録のhook（PreCompact等）が来てもエラーにせず無視する
      break;
  }
  session.lastEvent = name;
  session.lastUpdated = Date.now();
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(data);
    }
  }
}

// イベントをファイルに追記する（fire-and-forget、失敗してもリクエスト処理は止めない）
function appendEventLog(entry) {
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', (err) => {
    if (err) console.error('[dengent] event log write failed:', err.message);
  });
}

// セッション更新をブラウザへpush＋ファイルへ記録する共通処理
// （/eventからのhook由来イベントと、/replyや/startからの合成イベントの両方で使う）
function emitUpdate({ launchId, sessionId, session, latency = null, raw }) {
  const payload = {
    type: 'update',
    launchId,
    sessionId,
    session,
    receivedAt: Date.now(),
    latency,
    raw,
  };
  broadcast(payload);
  appendEventLog(payload);
}

// ブラウザに「起動に失敗した」ことを伝えるための合成イベント。
// セッションがまだ存在しない段階の失敗なので、sessionオブジェクトは作らず
// launchIdだけを頼りにクライアント側の該当カラムへ届ける。
function emitLaunchFailed(launchId, provider, cwd, errorMessage) {
  broadcast({
    type: 'launch-failed',
    launchId,
    provider,
    cwd,
    error: errorMessage,
    receivedAt: Date.now(),
  });
}

// ============================================================
// Write/Edit/Bash実行前にブラウザで許可/拒否を求める仕組み
// （実行計画.md「未決事項」：ヘッドレス起動には対話的な承認UIが無い問題への対応、2026-08-24実装）
//
// PreToolUse hook（.claude-avatar/permission-gate.js、matcher: "Write|Edit|Bash"）が
// このエンドポイントへ同期的にPOSTし、レスポンスが返るまでブロックして待つ。
// dengentが追跡していないsession_id（ターミナル等dengent外のセッション）には
// 即座に{tracked:false}を返し、通常の権限フロー（対話プロンプト等）に委ねる。
// これにより、このマシン上の他のClaude Codeセッション（このdengent自身を
// 開発しているセッションを含む）を一切妨げない。
// ============================================================
const pendingPermissions = new Map(); // requestId -> { res, timeoutHandle, launchId, sessionId }

// hook側のtimeout（settings.jsonで設定、後述）より短くしておき、Claude Code側の
// タイムアウトに先んじて確実に応答を返せるようにする
const PERMISSION_TIMEOUT_MS = 90000;

app.post('/permission-request', (req, res) => {
  const evt = req.body || {};
  const sessionId = evt.session_id;
  const launchId = sessionId && launchIdBySessionId.get(sessionId);
  if (!launchId) {
    res.json({ tracked: false });
    return;
  }

  const requestId = crypto.randomBytes(8).toString('hex');
  const timeoutHandle = setTimeout(() => {
    if (!pendingPermissions.has(requestId)) return;
    pendingPermissions.delete(requestId);
    res.json({ tracked: true, decision: 'deny', reason: 'timeout' });
    broadcast({ type: 'permission-resolved', launchId, sessionId, requestId, decision: 'deny', reason: 'timeout' });
  }, PERMISSION_TIMEOUT_MS);

  pendingPermissions.set(requestId, { res, timeoutHandle, launchId, sessionId, toolName: evt.tool_name, toolInput: evt.tool_input });

  broadcast({
    type: 'permission-request',
    launchId,
    sessionId,
    requestId,
    toolName: evt.tool_name,
    toolInput: evt.tool_input,
  });
});

app.post('/permission-decision', (req, res) => {
  if (req.get('X-Dengent-Token') !== DENGENT_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { requestId, decision } = req.body || {};
  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    return res.status(404).json({ ok: false, error: 'not found (already resolved or timed out)' });
  }
  clearTimeout(pending.timeoutHandle);
  pendingPermissions.delete(requestId);
  const finalDecision = decision === 'allow' ? 'allow' : 'deny';
  pending.res.json({ tracked: true, decision: finalDecision });
  broadcast({ type: 'permission-resolved', launchId: pending.launchId, sessionId: pending.sessionId, requestId, decision: finalDecision });
  res.json({ ok: true });
});

// セッションが切られた場合、そのセッションに紐づく未解決の承認待ちがあれば
// 拒否として片付ける（放置するとhookスクリプトがタイムアウトまで無駄に待ち続ける）
function rejectPendingPermissionsForSession(sessionId) {
  for (const [requestId, pending] of pendingPermissions) {
    if (pending.sessionId !== sessionId) continue;
    clearTimeout(pending.timeoutHandle);
    pendingPermissions.delete(requestId);
    pending.res.json({ tracked: true, decision: 'deny', reason: 'session forgotten' });
    broadcast({ type: 'permission-resolved', launchId: pending.launchId, sessionId, requestId, decision: 'deny', reason: 'session forgotten' });
  }
}

app.post('/event', (req, res) => {
  // hookクライアントはfire-and-forgetなので即座に応答を返す
  res.status(202).end();

  const serverReceivedAt = Date.now();
  const body = req.body || {};

  // hook-relay.js経由なら { hookEventPayload, dengentMeta } の封筒形式で届く。
  // 手動curl等での動作確認のために、封筒なしの生ペイロードもフォールバックで許容する。
  const evt = body.hookEventPayload || body;
  const meta = body.dengentMeta || null;

  const sessionId = evt.session_id;
  if (!sessionId) return; // session_idが無いイベントは扱いようが無い

  // このsession_idがdengent自身の起動（/start）に由来するかどうかを判定する。
  // 既知でなければ、まだpendingLaunchesに紐付け余地が無いか確認する
  // （UserPromptSubmitでcwdが一致する最古のpending launchに割り当てる）。
  // それでも見つからなければ、ターミナル等dengent外で起動されたセッション
  // とみなし、以降の処理を一切行わず無視する（今回の要望の核）。
  let launchId = launchIdBySessionId.get(sessionId);
  if (!launchId && evt.hook_event_name === 'UserPromptSubmit') {
    const evtCwd = normalizeCwd(evt.cwd);
    let bestMatch = null;
    for (const [pendingId, pending] of pendingLaunches) {
      if (normalizeCwd(pending.cwd) === evtCwd) {
        if (!bestMatch || pending.createdAt < bestMatch.pending.createdAt) {
          bestMatch = { pendingId, pending };
        }
      }
    }
    if (bestMatch) {
      launchId = bestMatch.pendingId;
      launchIdBySessionId.set(sessionId, launchId);
      pendingLaunches.delete(bestMatch.pendingId);
    }
  }
  if (!launchId) return; // dengentが起動したセッションではない → 完全に無視

  const pendingInfo = pendingLaunches.get(launchId); // 通常はもう無い想定（デバッグ用に残す）
  const provider = pendingInfo ? pendingInfo.provider : undefined;

  // パイプライン遅延の計測（検証項目①のGo/No-Go判定を体感でなく数値で行うため）
  let latency = null;
  if (meta && typeof meta.scriptStartAt === 'number' && typeof meta.beforeSendAt === 'number') {
    latency = {
      // hook-relay.js自身の処理時間（Claude Code本体を待たせている時間の目安、検証項目④）
      hookOverheadMs: meta.beforeSendAt - meta.scriptStartAt,
      // リクエスト送信〜サーバー受信までのネットワーク遅延
      networkMs: serverReceivedAt - meta.beforeSendAt,
      // hook起動〜サーバー受信までの合計（検証項目①のレイテンシそのもの）
      pipelineLatencyMs: serverReceivedAt - meta.scriptStartAt,
    };
  }

  const session = getOrCreateSession(sessionId, evt.cwd, launchId, provider);
  reduce(session, evt);

  emitUpdate({ launchId, sessionId, session, latency, raw: evt });
});

// パスの区切り文字・大文字小文字・末尾スラッシュの違いを吸収して比較する
// （Windowsなので大文字小文字は無視、\ と / も統一する）
function normalizeCwd(p) {
  if (!p || typeof p !== 'string') return '';
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// ブラウザからの返信を受け取り、`claude --resume <sessionId> --print "<text>"`を
// バックグラウンドで起動して同じセッションに新しいターンとして送り込む。
// これ以降の進捗（UserPromptSubmit/PreToolUse/.../Stop）は通常のhook経路で
// 自動的にブラウザへ流れてくるので、ここでは起動するだけでよい。
app.post('/reply', (req, res) => {
  if (req.get('X-Dengent-Token') !== DENGENT_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!CLAUDE_BIN) {
    return res.status(500).json({ ok: false, error: 'claude executable could not be resolved on this machine' });
  }

  const { sessionId, text } = req.body || {};
  if (!sessionId || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'sessionId and text are required' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'unknown session' });
  }

  // ターミナル側が作業中/確認待ちの間に横から送り込むと、同じセッションへの
  // 二重書き込みで会話ログが壊れるリスクがあるため、IDLE時のみ受け付ける
  if (session.state !== 'IDLE') {
    return res.status(409).json({ ok: false, error: `session is ${session.state}, not accepting replies right now` });
  }
  if (session.pendingReply) {
    return res.status(409).json({ ok: false, error: 'a reply is already being sent' });
  }

  session.pendingReply = true;
  emitUpdate({
    launchId: session.launchId,
    sessionId,
    session,
    raw: { hook_event_name: 'DengentReplySent', session_id: sessionId, text },
  });

  // shell: trueは使わない（ブラウザから来た自由入力のtextをそのままシェル文字列に
  // 連結することになり、コマンドインジェクションの危険がある）。shellを介さず
  // 引数配列のまま渡すことで、textはあくまで1つの引数として安全に渡される。
  const child = spawn(CLAUDE_BIN, ['--resume', sessionId, '--print', text], {
    cwd: session.cwd || process.cwd(),
    windowsHide: true,
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (err) => {
    console.error('[dengent] failed to spawn claude --resume:', err.message);
    session.pendingReply = false;
    emitUpdate({
      launchId: session.launchId,
      sessionId,
      session,
      raw: { hook_event_name: 'DengentReplyFailed', session_id: sessionId, error: err.message },
    });
  });
  child.unref();

  // 一定時間UserPromptSubmitが来なければ、起動失敗とみなしロックを解除する保険
  setTimeout(() => {
    if (session.pendingReply) {
      session.pendingReply = false;
      emitUpdate({
        launchId: session.launchId,
        sessionId,
        session,
        raw: { hook_event_name: 'DengentReplyTimeout', session_id: sessionId },
      });
    }
  }, REPLY_ACK_TIMEOUT_MS);

  res.json({ ok: true });
});

// ブラウザ標準のフォルダ選択ではOS上の実パス文字列が取得できない
// （File System Access APIはハンドルしか返さず、child_process.spawnの
// cwdに使えない）ため、サーバー（＝同じPC上で動いている）側からOS標準の
// フォルダ選択ダイアログを開き、選んだパスを返す方式にする。
// PowerShellのFolderBrowserDialogはユーザーがダイアログを閉じるまで
// 終了しないため、必ずexecFile（非同期）を使う。execFileSyncだと
// ダイアログが開いている間Node.jsのイベントループごと止まり、
// その間に届くhookイベントの処理が遅延してしまう。
app.post('/pick-directory', (req, res) => {
  if (req.get('X-Dengent-Token') !== DENGENT_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (process.platform !== 'win32') {
    return res.status(501).json({ ok: false, error: 'folder picker is only implemented for Windows' });
  }

  // バックグラウンドのNode.jsサーバープロセスから直接ShowDialog()すると、
  // Windowsのフォーカス制御によりダイアログが他ウィンドウの後ろに隠れて
  // 出てこないことがある。それを避けるため非表示のTopMostな親フォームを
  // 作り、それを親にしてダイアログを表示することで強制的に最前面に出す。
  // 注意：Hide()を呼んで親を非表示にすると、ShowDialog(owner)が正しく
  // 機能せず即座にCancel扱いで返ってきてしまう（実機で確認した不具合）。
  // 見えないようにしたいだけなら Hide() ではなく Opacity=0 にする。
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.StartPosition = "CenterScreen"',
    '$owner.Size = New-Object System.Drawing.Size(0,0)',
    '$owner.ShowInTaskbar = $false',
    '$owner.Opacity = 0',
    '$owner.Show()',
    '$owner.Focus() | Out-Null',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'Claude Codeを起動するディレクトリを選択'",
    '$result = $dialog.ShowDialog($owner)',
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
    '$owner.Dispose()',
  ].join('; ');

  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 120000, windowsHide: false },
    (err, stdout) => {
      if (err) {
        console.error('[dengent] folder picker failed:', err.message);
        return res.status(500).json({ ok: false, error: 'folder picker failed' });
      }
      const selectedPath = stdout.trim();
      res.json({ ok: true, path: selectedPath || null }); // null = キャンセルされた
    }
  );
});

// 対応済みのAIプロバイダ。Codexは選択肢としてUIに出すが、実行はまだ
// 実装しない（ユーザー要望通り）。ここで弾くことで、失敗理由が
// ブラウザのチャット上にはっきり表示される（emitLaunchFailed経由）。
const SUPPORTED_PROVIDERS = new Set(['claude']);

// ターミナルを使わずブラウザだけで完結させるための起点。指定ディレクトリで
// `claude --print "<text>"` を新規起動する。Claude Codeが割り当てる
// session_idはこちらからは事前にわからないため、launchIdを発行して
// pendingLaunchesに登録しておき、/eventで最初のUserPromptSubmitが来た
// タイミングでcwd一致により実session_idと紐付ける。
app.post('/start', (req, res) => {
  if (req.get('X-Dengent-Token') !== DENGENT_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { cwd, text, launchId: clientLaunchId } = req.body || {};
  const provider = (req.body && req.body.provider) || 'claude';
  if (!cwd || typeof cwd !== 'string') {
    return res.status(400).json({ ok: false, error: 'cwd is required' });
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'text is required' });
  }
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return res.status(400).json({ ok: false, error: `${provider}はまだ対応していません（近日対応予定）` });
  }
  if (!CLAUDE_BIN) {
    return res.status(500).json({ ok: false, error: 'claude executable could not be resolved on this machine' });
  }
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return res.status(400).json({ ok: false, error: `directory not found: ${cwd}` });
  }
  if (!stat.isDirectory()) {
    return res.status(400).json({ ok: false, error: `not a directory: ${cwd}` });
  }

  // 同じディレクトリで既に動いている（or 起動中の）セッションがあれば弾く。
  // 会話が2本並行してしまうと片方が古い状態のまま取り残されて紛らわしいため
  const evtCwdNorm = normalizeCwd(cwd);
  const alreadyRunning = [...sessions.values()].some((s) => normalizeCwd(s.cwd) === evtCwdNorm)
    || [...pendingLaunches.values()].some((p) => normalizeCwd(p.cwd) === evtCwdNorm);
  if (alreadyRunning) {
    return res.status(409).json({ ok: false, error: 'このディレクトリは既に別のセッションで使用中です' });
  }

  // launchIdはブラウザ側で先に発行してもらい、ここではそれをそのまま使う
  // （サーバーでもここで生成する形だと、HTTPレスポンスが届く前にhookの
  // UserPromptSubmitがWebSocket経由で先に届いてしまい、ブラウザ側がまだ
  // 自分のカラムにlaunchIdを紐付けられていないせいで別カラムを新規作成して
  // しまうレース条件があった。ブラウザがfetch送信前に同期的にcol.launchIdへ
  // 登録しておけるよう、IDの発行元をサーバーからブラウザ側へ移した、2026-08-24）
  const launchId = (typeof clientLaunchId === 'string' && clientLaunchId) || crypto.randomBytes(8).toString('hex');
  pendingLaunches.set(launchId, { cwd, provider, createdAt: Date.now() });

  // 一定時間実session_idと紐付かなければ起動失敗とみなし、pendingを掃除して
  // ブラウザのチャットにエラーとして表示させる
  setTimeout(() => {
    if (pendingLaunches.has(launchId)) {
      pendingLaunches.delete(launchId);
      emitLaunchFailed(launchId, provider, cwd, '起動を確認できませんでした（タイムアウト）。ディレクトリやClaude Codeの状態を確認してください');
    }
  }, LAUNCH_ACK_TIMEOUT_MS);

  // /replyと同じ理由でshell: trueは使わない
  const child = spawn(CLAUDE_BIN, ['--print', text], {
    cwd,
    windowsHide: true,
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (err) => {
    console.error('[dengent] failed to spawn claude (start):', err.message);
    pendingLaunches.delete(launchId);
    emitLaunchFailed(launchId, provider, cwd, '起動に失敗しました: ' + err.message);
  });
  child.unref();

  res.json({ ok: true, launchId });
});

// 「セッションを切る」ボタン用。実行中のClaude Codeプロセスを強制終了する
// 手段は無い（--printは1ターンごとに起動しては終了する短命プロセスのため、
// 殺すべき常駐プロセスがそもそも存在しない）。ここでやるのは、dengent側で
// このセッションを「現在表示中」として扱うのをやめるだけ。会話履歴自体は
// Claude Code側にそのまま残るので、後で`claude --resume`すれば続きから再開できる。
app.post('/forget', (req, res) => {
  if (req.get('X-Dengent-Token') !== DENGENT_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { sessionId } = req.body || {};
  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
    launchIdBySessionId.delete(sessionId);
    rejectPendingPermissionsForSession(sessionId);
  }
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, sessions: sessions.size }));
app.get('/sessions', (_req, res) => res.json({ sessions: [...sessions.values()] }));

wss.on('connection', (ws) => {
  // 新規接続時（ページ再読み込み含む）に、dengentが把握している全セッションを
  // まとめて送る。ブラウザ側はこれを見て、既存セッションぶんのカラムを
  // 再構築できる（複数カラム対応、2026-08-23）
  // 保留中の承認リクエストも一緒に送る。これが無いと、実際のPreToolUse発火から
  // ブラウザ接続の間にタイミングのズレがあった場合（今回の開発中に実機で発生：
  // /startした直後にリロードすると、承認要求のブロードキャストがまだ誰も
  // 接続していないタイミングで飛んで消えてしまい、カードが二度と出ないまま
  // 90秒後に自動タイムアウト拒否されていた）、ユーザーが一生気づけない
  ws.send(JSON.stringify({
    type: 'init',
    sessions: [...sessions.values()],
    pendingPermissions: [...pendingPermissions.entries()].map(([requestId, p]) => ({
      requestId, launchId: p.launchId, sessionId: p.sessionId, toolName: p.toolName, toolInput: p.toolInput,
    })),
    receivedAt: Date.now(),
  }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dengent relay server listening on http://127.0.0.1:${PORT}`);
  console.log(`  POST /event   <- hook-relay.js posts hook payloads here`);
  console.log(`  WS   /stream  <- browser connects here`);
  console.log(`  log file: ${LOG_FILE}`);
  console.log(`  auth token (for manual curl testing): ${DENGENT_TOKEN}`);
});
