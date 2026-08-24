// PixiJSでアバターを描画するモジュール。DOM/フレームワークに依存しない
// 疎結合な作りにしておき（基本設計.md §6）、公開APIは
// createAvatarStage(containerEl, initialCharacterId) が返す
// { setState, setSubagentCount, setCharacter, destroy } の4つだけにする。
// 呼び出し側（index.html）はWebSocketで受け取った状態と、ユーザーが選んだ
// アバターIDをこのAPIに渡すだけでよい。
import { Application, Assets, AnimatedSprite, Texture, Rectangle, Text } from '/vendor/pixi.min.mjs';

const FRAME_SIZE = 128;
const DEFAULT_DISPLAY_SCALE = 2; // ドット絵なので整数倍で拡大しにじませない
const MAX_VISIBLE_SUBAGENTS = 6; // 基本設計.md §2.1：上限6体＋オーバーフローバッジ

// dengentの状態 → アセットのアニメーションキーの対応
const STATE_TO_ANIM = {
  IDLE: 'idle',
  WORKING: 'working',
  WAITING_CONFIRMATION: 'waiting',
};

// Free：3種類から選択可能（企画書.md §5）。CraftPix「Free Homeless Character
// Sprite Sheets」の3キャラをそのままFreeのラインナップとして使う。
// キャラごとにフレーム数が異なる点に注意（実ファイルを確認して個別に設定）。
export const CHARACTERS = {
  homeless_1: {
    label: 'アバターA',
    idle: { url: '/assets/avatars/homeless_1/Idle_2.png', frames: 11, fps: 8 },
    working: { url: '/assets/avatars/homeless_1/Run.png', frames: 8, fps: 12 },
    waiting: { url: '/assets/avatars/homeless_1/Hurt.png', frames: 3, fps: 6 },
  },
  homeless_2: {
    label: 'アバターB',
    idle: { url: '/assets/avatars/homeless_2/Idle_2.png', frames: 9, fps: 8 },
    working: { url: '/assets/avatars/homeless_2/Run.png', frames: 8, fps: 12 },
    waiting: { url: '/assets/avatars/homeless_2/Hurt.png', frames: 3, fps: 6 },
  },
  homeless_3: {
    label: 'アバターC',
    idle: { url: '/assets/avatars/homeless_3/Idle_2.png', frames: 11, fps: 8 },
    working: { url: '/assets/avatars/homeless_3/Run.png', frames: 8, fps: 12 },
    waiting: { url: '/assets/avatars/homeless_3/Hurt.png', frames: 3, fps: 6 },
  },
};

export const DEFAULT_CHARACTER_ID = 'homeless_1';

// 1枚のスプライトシート（横一列のPNG）を、frame数ぶんのTextureに切り出す
async function loadFrames(url, frameCount) {
  const sheet = await Assets.load(url);
  sheet.source.scaleMode = 'nearest'; // ドット絵をぼかさない
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(new Texture({
      source: sheet.source,
      frame: new Rectangle(i * FRAME_SIZE, 0, FRAME_SIZE, FRAME_SIZE),
    }));
  }
  return frames;
}

function makeAnimatedSprite(frames, fps, scale) {
  const sprite = new AnimatedSprite(frames);
  sprite.anchor.set(0.5, 1); // 足元を基準点にする（地面に立っているように見せる）
  sprite.animationSpeed = fps / 60; // Pixiのticker(60fps想定)に対する再生速度
  sprite.loop = true;
  sprite.play();
  sprite.scale.set(scale);
  return sprite;
}

// scale：コンテナのサイズに応じて呼び出し側が指定する（例：複数カラムの
// コンパクトな表示では小さめにしないと、128px元絵×2倍固定だと頭が
// canvas上端からはみ出て切れてしまう。2026-08-23、実機で確認した不具合）
export async function createAvatarStage(containerEl, initialCharacterId = DEFAULT_CHARACTER_ID, options = {}) {
  const scale = options.scale || DEFAULT_DISPLAY_SCALE;
  const app = new Application();
  await app.init({
    width: containerEl.clientWidth || 480,
    height: containerEl.clientHeight || 320,
    backgroundAlpha: 0, // 背景色は#stage側のCSSに任せる
    antialias: false,
  });
  app.canvas.style.imageRendering = 'pixelated';
  containerEl.appendChild(app.canvas);

  // キャラクターごとのフレームキャッシュ（一度読み込んだら切り替え時に再取得しない）
  const frameCache = new Map();
  async function getCharacterFrames(characterId) {
    if (frameCache.has(characterId)) return frameCache.get(characterId);
    const cfg = CHARACTERS[characterId];
    const framesByKey = {};
    await Promise.all(
      Object.entries(cfg).map(async ([key, anim]) => {
        if (key === 'label') return;
        framesByKey[key] = await loadFrames(anim.url, anim.frames);
      })
    );
    frameCache.set(characterId, framesByKey);
    return framesByKey;
  }

  let currentCharacterId = initialCharacterId;
  let framesByKey = await getCharacterFrames(currentCharacterId);

  const centerX = app.screen.width / 2;
  const groundY = app.screen.height * 0.75;

  // メインアバター
  let currentStateKey = 'idle';
  const main = makeAnimatedSprite(framesByKey.idle, CHARACTERS[currentCharacterId].idle.fps, scale);
  main.x = centerX;
  main.y = groundY;
  app.stage.addChild(main);

  // サブエージェント分身用のプール（毎回作り直さず使い回す）
  const subagentSprites = [];
  const overflowText = new Text({
    text: '',
    style: { fill: '#ffffff', fontSize: 20, fontWeight: 'bold' },
  });
  overflowText.anchor.set(0, 1);
  app.stage.addChild(overflowText);

  function setState(state) {
    const key = STATE_TO_ANIM[state] || 'idle';
    if (key === currentStateKey) return;
    currentStateKey = key;
    main.textures = framesByKey[key];
    main.animationSpeed = CHARACTERS[currentCharacterId][key].fps / 60;
    main.gotoAndPlay(0);
  }

  // 分身はWORKINGと同じ見た目を複製表示するだけでよい（基本設計.md §2.1）
  function setSubagentCount(count) {
    const shown = Math.min(count, MAX_VISIBLE_SUBAGENTS);
    const workingFps = CHARACTERS[currentCharacterId].working.fps;

    while (subagentSprites.length < shown) {
      const s = makeAnimatedSprite(framesByKey.working, workingFps, scale * 0.6); // 分身は本体より一回り小さく
      s.alpha = 0.85;
      app.stage.addChild(s);
      subagentSprites.push(s);
    }
    while (subagentSprites.length > shown) {
      const s = subagentSprites.pop();
      app.stage.removeChild(s);
      s.destroy();
    }

    // メインアバターの左右に振り分けて並べる（間隔もscaleに応じて調整）
    const spacing = 35 * scale;
    subagentSprites.forEach((s, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      const rank = Math.floor(i / 2) + 1;
      s.x = centerX + side * (spacing * rank);
      s.y = groundY + 10;
    });

    if (count > MAX_VISIBLE_SUBAGENTS) {
      overflowText.text = '+' + (count - MAX_VISIBLE_SUBAGENTS);
      overflowText.x = centerX + spacing * (Math.ceil(shown / 2) + 1);
      overflowText.y = groundY + 10;
    } else {
      overflowText.text = '';
    }
  }

  // アバターセットの切り替え（企画書.md §5：Free3種類/Pro追加分）。
  // 現在の状態・分身数はそのまま、見た目だけ差し替える。
  async function setCharacter(characterId) {
    if (characterId === currentCharacterId || !CHARACTERS[characterId]) return;
    framesByKey = await getCharacterFrames(characterId);
    currentCharacterId = characterId;

    main.textures = framesByKey[currentStateKey];
    main.animationSpeed = CHARACTERS[currentCharacterId][currentStateKey].fps / 60;
    main.gotoAndPlay(0);

    const workingFps = CHARACTERS[currentCharacterId].working.fps;
    subagentSprites.forEach((s) => {
      s.textures = framesByKey.working;
      s.animationSpeed = workingFps / 60;
      s.gotoAndPlay(0);
    });
  }

  function destroy() {
    app.destroy(true, { children: true, texture: false });
  }

  return { setState, setSubagentCount, setCharacter, destroy };
}
