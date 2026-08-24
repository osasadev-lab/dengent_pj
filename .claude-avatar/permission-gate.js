#!/usr/bin/env node
// Write/Edit/Bash実行直前に発火するPreToolUseフック。dengentが/startで起動した
// ヘッドレスセッション（claude --print、TTYが無く対話的な承認プロンプトを
// 出せない）に限り、リレーサーバー経由でブラウザに許可/拒否を問い合わせ、
// 人間の判断が返るまでこのプロセス自体をブロックする。
//
// dengent外のセッション（ターミナルから直接起動されたもの。dengentを開発中の
// このセッション自身も含む）に対しては、サーバーが即座に{tracked:false}を
// 返すため、待たされることなくstdoutに何も出力せず終了する＝通常の権限フロー
// （対話プロンプト等）にそのまま委ねる。ネットワークエラー・タイムアウト・
// 想定外の例外が起きた場合も同様にフェイルオープン（何も出力せず終了）する。
// 「バグって全セッションのWrite/Edit/Bashが固まる」事態を避けるための設計。
'use strict';

const http = require('http');

const RELAY_HOST = '127.0.0.1';
const RELAY_PORT = 4317;

// サーバー側のPERMISSION_TIMEOUT_MS（90秒）より余裕を持たせた上限。
// settings.jsonのこのフック自体のtimeout設定（120秒）ともここで整合させる。
const REQUEST_TIMEOUT_MS = 100000;
const HARD_EXIT_MS = 105000;

const TARGET_TOOLS = new Set(['Write', 'Edit', 'Bash']);

function exitSilently() {
  process.exit(0);
}

function respondDecision(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('error', exitSilently);
process.stdin.on('end', () => {
  const forceExit = setTimeout(exitSilently, HARD_EXIT_MS);
  forceExit.unref?.();

  let payload;
  try {
    payload = JSON.parse(stdin || '{}');
  } catch {
    return exitSilently();
  }

  if (!TARGET_TOOLS.has(payload.tool_name)) return exitSilently();
  if (!payload.session_id) return exitSilently();

  const body = JSON.stringify({
    session_id: payload.session_id,
    tool_name: payload.tool_name,
    tool_input: payload.tool_input,
  });

  const req = http.request(
    {
      hostname: RELAY_HOST,
      port: RELAY_PORT,
      path: '/permission-request',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
    (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(forceExit);
        let parsed;
        try {
          parsed = JSON.parse(data || '{}');
        } catch {
          return exitSilently();
        }
        if (!parsed.tracked) return exitSilently(); // dengent外のセッション → 通常フローに委ねる
        if (parsed.decision === 'allow') {
          return respondDecision('allow', 'dengent: ブラウザで承認されました');
        }
        return respondDecision('deny', 'dengent: ' + (parsed.reason === 'timeout' ? 'ブラウザでの承認待ちがタイムアウトしました' : 'ブラウザで拒否されました'));
      });
    }
  );

  req.on('error', () => {
    clearTimeout(forceExit);
    exitSilently(); // リレーサーバーが落ちている等でもClaude Code側には影響を出さない
  });
  req.on('timeout', () => req.destroy());

  req.write(body);
  req.end();
});
