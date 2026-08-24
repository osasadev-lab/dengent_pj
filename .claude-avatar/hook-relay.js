#!/usr/bin/env node
// Claude Codeのhookペイロードをstdinで受け取り、ローカルのリレーサーバーへ
// 転送するだけのスクリプト。Claude Code本体を絶対にブロックしないよう、
// どの経路を通っても短時間で確実にプロセスを終了させる（強制終了タイマー）。
// stdoutには何も出力しない（PreToolUseの場合、stdout出力は許可/拒否の
// 判定として解釈されうるため、意図せぬブロックを避ける目的）。
'use strict';

const http = require('http');

const RELAY_HOST = '127.0.0.1';
const RELAY_PORT = 4317;
const HARD_EXIT_MS = 300; // これを超えたら問答無用でプロセスを終了する保険
const REQUEST_TIMEOUT_MS = 250;

// スクリプト実行開始時刻。node起動直後（ファイル先頭）で取得するため、
// 「このhookスクリプトがClaude Code本体をどれだけ待たせているか」の
// 起点としてほぼ正確な値になる（検証項目④：本体への影響確認に使う）。
const scriptStartAt = Date.now();

// 補足：Stopイベントのペイロードにはtranscript_path経由でファイルを
// 自分で読まなくても、Claude Codeが既に last_assistant_message フィールドで
// 直近の応答本文を渡してくれる（実機確認済み）。よってhook-relay.js側では
// 何も加工せず、そのままリレーサーバーに転送するだけでよい。

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  const forceExit = setTimeout(() => process.exit(0), HARD_EXIT_MS);

  // Claude Codeから渡された生のhookペイロード。加工せずそのまま
  // hookEventPayloadとして送る（ブラウザ側でのペイロード全体確認＝
  // 検証項目④のためのため、途中で情報を落とさない）。
  let hookEventPayload;
  try {
    hookEventPayload = JSON.parse(stdin || '{}');
  } catch {
    hookEventPayload = {};
  }

  // HTTPリクエストを送信する直前の時刻。scriptStartAtとの差分が
  // 「このスクリプト自身の処理にかかった時間（hookOverheadMs）」になる。
  const beforeSendAt = Date.now();

  const body = JSON.stringify({
    hookEventPayload,
    dengentMeta: { scriptStartAt, beforeSendAt },
  });

  const req = http.request(
    {
      hostname: RELAY_HOST,
      port: RELAY_PORT,
      path: '/event',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
    (res) => {
      res.resume();
      res.on('end', () => {
        clearTimeout(forceExit);
        process.exit(0);
      });
    }
  );

  req.on('error', () => {
    // リレーサーバーが起動していない・応答不能等でもClaude Code側には
    // 一切影響を出さず、静かに終了する。
    clearTimeout(forceExit);
    process.exit(0);
  });
  req.on('timeout', () => req.destroy());

  req.write(body);
  req.end();
});
