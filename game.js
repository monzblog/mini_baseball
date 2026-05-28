"use strict";

/* =========================================================================
 * ミニ野球 - パワプロ風ベースボール
 * 純粋な HTML5 Canvas + JavaScript（ビルド・依存なし）
 * ------------------------------------------------------------------------
 * 視点：打席アップ。投手の球種・コース選択と、打者のミート＋タイミング打撃。
 * 表＝CPU打撃 / プレイヤー投球、裏＝プレイヤー打撃 / CPU投球。
 * ========================================================================= */

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

/* ----------------------------- 設定値 ---------------------------------- */
const INNINGS = 3;            // 試合のイニング数
const FPS = 60;

// ストライクゾーン（打席アップ視点での描画矩形）
const ZONE = { w: 170, h: 210, cx: W / 2, cy: 312 };
ZONE.x = ZONE.cx - ZONE.w / 2;
ZONE.y = ZONE.cy - ZONE.h / 2;

const RELEASE = { x: W / 2, y: 150 }; // 投手のリリースポイント（画面上、遠く）

// 打撃のタイミング
const MEET_P = 0.82;     // 最適スイング進行度
const TIMING_TOL = 0.24; // 許容タイミング誤差
const MEET_RADIUS = 70;  // ミート判定半径（カーソルとボールの許容距離）

/* --------------------------- 球種データ -------------------------------- */
// breakX/breakY: 本塁到達時点での最終変化量（px）
// shape: 変化の出方（進行度 p → 0..1）。late ほど終盤に曲がる
const PITCHES = {
  straight: {
    name: "ストレート", key: "1", color: "#ffffff",
    frames: 48, breakX: 0, breakY: -6, shape: (p) => p,
  },
  curve: {
    name: "カーブ", key: "2", color: "#7fd0ff",
    frames: 62, breakX: -46, breakY: 64, shape: (p) => p * p,
  },
  slider: {
    name: "スライダー", key: "3", color: "#ffe07f",
    frames: 56, breakX: 58, breakY: 18, shape: (p) => p * p * p,
  },
  fork: {
    name: "フォーク", key: "4", color: "#c79bff",
    frames: 68, breakX: 6, breakY: 78, shape: (p) => p * p * p,
  },
};
const PITCH_KEYS = { "1": "straight", "2": "curve", "3": "slider", "4": "fork" };

/* --------------------------- ゲーム状態 -------------------------------- */
const game = {
  phase: "title", // title|pitch_select|pitch|atbat_result|field|change|gameover
  inning: 1,
  half: 0,          // 0 = 表(ビジター攻撃), 1 = 裏(ホーム攻撃)
  outs: 0,
  balls: 0,
  strikes: 0,
  bases: [false, false, false], // 1塁,2塁,3塁
  score: { away: [], home: [] },  // イニングごとの得点
  awayTotal: 0,
  homeTotal: 0,
  msg: "スペース / タップで開始",
};

function playerBatting() { return game.half === 1; }   // 裏はプレイヤー攻撃
function playerPitching() { return game.half === 0; }  // 表はプレイヤー守備

/* --------------------------- 投球の状態 -------------------------------- */
const pitch = {
  type: "straight",
  // 狙ったコース（本塁でのボール基準位置。break はここに加算される）
  target: { x: ZONE.cx, y: ZONE.cy },
  p: 0,            // 進行度 0..1
  frames: 48,
  active: false,
  plate: { x: 0, y: 0 },  // 本塁到達時のボール最終位置
  isStrike: false,
};

// カーソル（投球時は狙い、打撃時はミート）
const cursor = { x: ZONE.cx, y: ZONE.cy };

// スイング状態
const swing = { done: false, p: 0 };

// CPU バッターの判断
const cpuBat = { willSwing: false, swingP: 0, cursorX: 0, cursorY: 0 };

/* --------------------------- 入力処理 ---------------------------------- */
const keys = {};
window.addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Space"].includes(e.key)) {
    e.preventDefault();
  }
  if (e.repeat) return;
  handleKey(e.key);
  keys[e.key] = true;
});
window.addEventListener("keyup", (e) => { keys[e.key] = false; });

/* --------------------------- タッチ/ポインタ操作 ----------------------- */
// アクションボタン（スペース相当）＝ 投球 / スイング / 開始 / 次へ など
function fireAction() { handleKey(" "); }

// 画面（CSSピクセル）座標 → Canvas内部座標(800x600)へ変換
function canvasPos(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (clientX - r.left) * (W / r.width),
    y: (clientY - r.top) * (H / r.height),
  };
}

// なぞった位置にカーソルを移動（指の少し上に表示して見やすく）
function moveCursorTo(clientX, clientY) {
  const pos = canvasPos(clientX, clientY);
  cursor.x = pos.x;
  cursor.y = pos.y - 30;
  clampCursor();
}

let pointerDragging = false;
canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  // タイトル/交代/試合終了画面はタップで進行
  if (["title", "change", "gameover"].includes(game.phase)) {
    fireAction();
    return;
  }
  pointerDragging = true;
  moveCursorTo(e.clientX, e.clientY);
});
canvas.addEventListener("pointermove", (e) => {
  if (!pointerDragging) return; // ドラッグ中のみ（マウスのホバーでは動かさない）
  e.preventDefault();
  moveCursorTo(e.clientX, e.clientY);
});
window.addEventListener("pointerup", () => { pointerDragging = false; });
window.addEventListener("pointercancel", () => { pointerDragging = false; });

// 画面上のボタン
const actionBtn = document.getElementById("action-btn");
const pitchBtnWrap = document.getElementById("pitch-buttons");
if (actionBtn) {
  actionBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); fireAction(); });
}
if (pitchBtnWrap) {
  pitchBtnWrap.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("[data-pitch]");
    if (b) { e.preventDefault(); handleKey(b.dataset.pitch); updateHUD(); }
  });
}

function handleKey(key) {
  const k = key === "Space" ? " " : key;

  if (game.phase === "title") {
    if (k === " ") startGame();
    return;
  }
  if (game.phase === "change") {
    if (k === " ") nextHalfStart();
    return;
  }
  if (game.phase === "atbat_result") {
    // 自動で進むので入力不要
    return;
  }
  if (game.phase === "gameover") {
    if (k === " ") location.reload();
    return;
  }

  // 球種選択（プレイヤー投球の準備中）
  if (game.phase === "pitch_select" && PITCH_KEYS[k]) {
    pitch.type = PITCH_KEYS[k];
    return;
  }

  // 投球開始（プレイヤー守備）
  if (game.phase === "pitch_select" && k === " ") {
    launchPitch();
    return;
  }

  // スイング（プレイヤー攻撃・投球中）
  if (game.phase === "pitch" && k === " " && playerBatting() && !swing.done) {
    swing.done = true;
    swing.p = pitch.p;
    return;
  }
}

// 押しっぱなし対応のカーソル移動
function updateCursorHold() {
  const speed = 4.5;
  let moved = false;
  if (keys["ArrowLeft"]) { cursor.x -= speed; moved = true; }
  if (keys["ArrowRight"]) { cursor.x += speed; moved = true; }
  if (keys["ArrowUp"]) { cursor.y -= speed; moved = true; }
  if (keys["ArrowDown"]) { cursor.y += speed; moved = true; }
  if (moved) clampCursor();
}

function clampCursor() {
  const mx = ZONE.w * 0.75; // ゾーン外にもある程度出せる
  const my = ZONE.h * 0.7;
  cursor.x = Math.max(ZONE.cx - mx, Math.min(ZONE.cx + mx, cursor.x));
  cursor.y = Math.max(ZONE.cy - my, Math.min(ZONE.cy + my, cursor.y));
}

/* --------------------------- ゲーム開始 -------------------------------- */
function startGame() {
  game.score.away = [];
  game.score.home = [];
  game.awayTotal = 0;
  game.homeTotal = 0;
  game.inning = 1;
  game.half = 0;
  beginHalfInning();
}

function beginHalfInning() {
  game.outs = 0;
  game.bases = [false, false, false];
  resetCount();
  cursor.x = ZONE.cx;
  cursor.y = ZONE.cy;
  setupAtBat();
  updateHUD();
}

function resetCount() { game.balls = 0; game.strikes = 0; }

/* --------------------------- 打席セットアップ -------------------------- */
function setupAtBat() {
  swing.done = false;
  swing.p = 0;
  pitch.active = false;
  pitch.p = 0;

  if (playerPitching()) {
    // プレイヤーが投球：球種選択フェーズへ
    game.phase = "pitch_select";
    cursor.x = ZONE.cx;
    cursor.y = ZONE.cy;
    game.msg = "球種を選び（1〜4）、← → ↑ ↓ で狙いを定めてスペースで投球！";
  } else {
    // CPU が投球：少し待ってから自動で投げる
    game.phase = "pitch_select";
    game.msg = "← → ↑ ↓ でミートカーソルを動かして構えよう…";
    // CPU の投球を予約
    cpuPitchTimer = 70 + Math.floor(Math.random() * 40);
  }
  updateHUD();
}

let cpuPitchTimer = 0;

/* --------------------------- 投球ロジック ------------------------------ */
function launchPitch() {
  // プレイヤー投球：cursor が狙い
  pitch.target.x = cursor.x;
  pitch.target.y = cursor.y;
  firePitch();
}

function cpuPitch() {
  // CPU 投球：球種とコースをランダムに（半々でボール球も）
  const types = Object.keys(PITCHES);
  pitch.type = types[Math.floor(Math.random() * types.length)];

  const aimStrike = Math.random() < 0.62;
  if (aimStrike) {
    pitch.target.x = ZONE.cx + rand(-ZONE.w * 0.32, ZONE.w * 0.32);
    pitch.target.y = ZONE.cy + rand(-ZONE.h * 0.32, ZONE.h * 0.32);
  } else {
    // ボール球（誘い）
    const side = Math.random() < 0.5 ? -1 : 1;
    pitch.target.x = ZONE.cx + side * rand(ZONE.w * 0.45, ZONE.w * 0.7);
    pitch.target.y = ZONE.cy + rand(-ZONE.h * 0.55, ZONE.h * 0.55);
  }
  firePitch();
}

function firePitch() {
  const def = PITCHES[pitch.type];
  pitch.frames = def.frames;
  pitch.p = 0;
  pitch.active = true;
  swing.done = false;
  swing.p = 0;

  // 本塁到達時の最終位置（狙い + 変化量）
  pitch.plate.x = pitch.target.x + def.breakX;
  pitch.plate.y = pitch.target.y + def.breakY;
  pitch.isStrike = inZone(pitch.plate.x, pitch.plate.y);

  game.phase = "pitch";

  if (playerPitching()) {
    // CPU が打席：スイング判断を準備
    game.msg = `${def.name}！`;
    prepareCpuBatter();
  } else {
    // CPU が投球・プレイヤーが打席
    game.msg = "スペースでスイング！";
  }
}

// CPU が打席に立つ場合（プレイヤー投球時）の判断を準備
function prepareCpuBatter() {
  const skill = 0.55; // CPU 打者の技量 0..1
  // CPU はおおよそ本塁位置を読む（技量に応じた誤差）
  const readErr = (1 - skill) * 90;
  const predX = pitch.plate.x + rand(-readErr, readErr);
  const predY = pitch.plate.y + rand(-readErr, readErr);

  // ストライクっぽければ振る、ボール球は時々追う
  const looksStrike = inZone(predX, predY, 18);
  let swingProb = looksStrike ? 0.82 : 0.22;
  if (game.strikes === 2) swingProb += 0.1; // 追い込まれたら振りやすい
  cpuBat.willSwing = Math.random() < swingProb;

  const timingErr = (1 - skill) * 0.18;
  cpuBat.swingP = MEET_P + rand(-timingErr, timingErr);
  cpuBat.cursorX = pitch.plate.x + rand(-readErr, readErr) * 0.5;
  cpuBat.cursorY = pitch.plate.y + rand(-readErr, readErr) * 0.5;
}

/* --------------------------- 投球の更新 -------------------------------- */
function updatePitch() {
  pitch.p += 1 / pitch.frames;

  // CPU バッターのスイング判定（プレイヤー投球時）
  if (playerPitching() && cpuBat.willSwing && !swing.done && pitch.p >= cpuBat.swingP) {
    swing.done = true;
    swing.p = cpuBat.swingP;
  }

  if (pitch.p >= 1.0) {
    pitch.p = 1.0;
    pitch.active = false;
    resolvePitch();
  }
}

/* --------------------------- 投球結果判定 ------------------------------ */
function resolvePitch() {
  const batterIsPlayer = playerBatting();
  const swung = swing.done;

  // ミート判定用のカーソル位置
  let cx, cy;
  if (batterIsPlayer) {
    cx = cursor.x; cy = cursor.y;
  } else {
    cx = cpuBat.cursorX; cy = cpuBat.cursorY;
  }

  if (!swung) {
    // 見逃し
    if (pitch.isStrike) {
      addStrike("見逃しストライク");
    } else {
      addBall("ボール");
    }
    return;
  }

  // スイングした：タイミングと空間の精度
  const timingErr = Math.abs(swing.p - MEET_P);
  const timingQ = clamp(1 - timingErr / TIMING_TOL, 0, 1);
  const dist = Math.hypot(cx - pitch.plate.x, cy - pitch.plate.y);
  const spaceQ = clamp(1 - dist / MEET_RADIUS, 0, 1);
  const contactQ = timingQ * spaceQ;

  if (contactQ <= 0.04) {
    addStrike("空振り！");
    return;
  }

  // 打球発生
  resetCountAfterContact();
  const timingDelta = swing.p - MEET_P; // 早い(<0)=引っ張り, 遅い(>0)=流し
  resolveBattedBall(contactQ, timingDelta);
}

function resetCountAfterContact() { /* カウントは打球結果側で処理 */ }

/* --------------------------- ボール/ストライク ------------------------- */
function addStrike(text) {
  game.strikes++;
  if (game.strikes >= 3) {
    showAtBatResult(text + " 三振！", () => { recordOut(); });
  } else {
    showAtBatResult(text, () => { setupAtBat(); });
  }
  updateHUD();
}

function addBall(text) {
  game.balls++;
  if (game.balls >= 4) {
    showAtBatResult(text + " フォアボール！", () => { doWalk(); });
  } else {
    showAtBatResult(text, () => { setupAtBat(); });
  }
  updateHUD();
}

function showAtBatResult(text, then) {
  game.phase = "atbat_result";
  game.msg = text;
  updateHUD();
  atBatResultTimer = 80;
  atBatResultThen = then;
}
let atBatResultTimer = 0;
let atBatResultThen = null;

/* --------------------------- 打球処理 ---------------------------------- */
// field ビュー用の打球データ
const batted = {
  active: false,
  t: 0, dur: 80,
  angle: 0,       // 散布角 -1(三塁線) .. +1(一塁線)
  power: 0,       // 飛距離 0..1
  landX: 0, landY: 0,
  startX: 0, startY: 0,
  outcome: "",    // 表示用
  resolved: null, // 結果処理関数
};

function resolveBattedBall(contactQ, timingDelta) {
  // 散布角：タイミング由来 + ランダム
  // 早い → 引っ張り(左/三塁側=-)、遅い → 流し(右/一塁側=+)
  let angle = clamp(timingDelta / TIMING_TOL, -1, 1) + rand(-0.18, 0.18);
  angle = clamp(angle, -1.2, 1.2);

  const power = clamp(contactQ + rand(-0.08, 0.08), 0, 1.1);

  // ファウル判定（角度が大きすぎる）
  const foul = Math.abs(angle) > 1.0;

  if (foul) {
    // ファウル：2ストライクからは三振にならずカウント維持
    if (game.strikes < 2) game.strikes++;
    showAtBatResult("ファウル", () => { setupAtBat(); });
    updateHUD();
    return;
  }

  // 打席はクリア。フィールドビューへ
  setupFieldView(angle, power);
}

function setupFieldView(angle, power) {
  game.phase = "field";
  batted.active = true;
  batted.t = 0;
  batted.dur = 70;
  batted.angle = angle;
  batted.power = power;

  // 着弾点を決定（フィールドビュー座標で）
  const field = getFieldGeom();
  const a = angle * (Math.PI / 4); // -45..45°
  const dist = power; // 0..1（外野フェンスまで）
  const reach = field.fenceR * (0.18 + dist * 0.95);
  batted.startX = field.home.x;
  batted.startY = field.home.y;
  batted.landX = field.home.x + Math.sin(a) * reach;
  batted.landY = field.home.y - Math.cos(a) * reach;

  // 結果カテゴリを決定
  decideOutcome(angle, power, reach, field);
  updateHUD();
}

function decideOutcome(angle, power, reach, field) {
  const beyondFence = reach >= field.fenceR * 0.985;
  const luck = Math.random();
  let label, run;

  if (beyondFence && power > 0.93) {
    if (luck < 0.1) { label = "大飛球…フェンス際で好捕！"; run = () => recordOut(); }
    else { label = "ホームラン！🎉"; run = () => batterAdvance(4); }
  } else if (power > 0.80) {
    // 長打圏
    if (luck < 0.22) { label = "フライアウト"; run = () => recordOut(); }
    else if (power > 0.9) { label = "ツーベースヒット！"; run = () => batterAdvance(2); }
    else { label = "ヒット！"; run = () => batterAdvance(1); }
  } else if (power > 0.58) {
    if (luck < 0.42) { label = "フライアウト"; run = () => recordOut(); }
    else { label = "ヒット！"; run = () => batterAdvance(1); }
  } else if (power > 0.33) {
    // 内野方向のゴロ/ライナー
    if (luck < 0.62) { label = "ゴロアウト"; run = () => recordOut(); }
    else { label = "内野安打！"; run = () => batterAdvance(1); }
  } else {
    if (luck < 0.5) { label = "ピッチャーゴロ"; run = () => recordOut(); }
    else { label = "ポップフライ"; run = () => recordOut(); }
  }

  batted.outcome = label;
  batted.resolved = run;
}

/* --------------------------- 進塁・得点 -------------------------------- */
function batterAdvance(numBases) {
  let runs = 0;
  const b = game.bases;

  if (numBases >= 4) {
    // ホームラン：全員生還
    runs = 1 + (b[0] ? 1 : 0) + (b[1] ? 1 : 0) + (b[2] ? 1 : 0);
    game.bases = [false, false, false];
  } else {
    // 既存走者を numBases だけ進める
    const newBases = [false, false, false];
    for (let i = 2; i >= 0; i--) {
      if (b[i]) {
        const dest = i + 1 + numBases; // 0=1塁..; dest>=4 で生還
        if (dest >= 4) runs++;
        else newBases[dest - 1] = true;
      }
    }
    // 打者
    const bdest = numBases; // 1→1塁(index0)
    if (bdest >= 4) runs++;
    else newBases[bdest - 1] = true;
    game.bases = newBases;
  }

  addRuns(runs);
  const tail = runs > 0 ? `（${runs}点）` : "";
  game.msg = batted.outcome + tail;
  updateHUD();
  endPlay(false);
}

function doWalk() {
  // フォアボール：押し出し的に強制進塁のみ
  const b = game.bases;
  let runs = 0;
  if (b[0]) {
    if (b[1]) {
      if (b[2]) { runs++; } // 満塁押し出し
      b[2] = true;
    }
    b[1] = true;
  }
  b[0] = true;
  addRuns(runs);
  resetCount();
  game.msg = "フォアボールで出塁" + (runs ? "（押し出し1点）" : "");
  updateHUD();
  // 次の打者へ
  setupAtBat();
}

function addRuns(runs) {
  if (runs <= 0) return;
  if (game.half === 0) game.awayTotal += runs;
  else game.homeTotal += runs;
  addInningRuns(runs);
}

function addInningRuns(runs) {
  const arr = game.half === 0 ? game.score.away : game.score.home;
  const idx = game.inning - 1;
  while (arr.length <= idx) arr.push(0);
  arr[idx] += runs;
}

function ensureInningCell() {
  const arr = game.half === 0 ? game.score.away : game.score.home;
  const idx = game.inning - 1;
  while (arr.length <= idx) arr.push(0);
}

/* --------------------------- アウト処理 -------------------------------- */
function recordOut() {
  game.outs++;
  resetCount();
  ensureInningCell();
  updateHUD();
  if (game.outs >= 3) {
    endPlay(true);
  } else {
    // フィールドビュー中のアウトはメッセージ表示後に次打者
    if (game.phase === "field") {
      game.msg = batted.outcome;
      endPlay(false);
    } else {
      setupAtBat();
    }
  }
}

// 打球プレー or カウント結果のあと、次の状態へ
function endPlay(inningOver) {
  if (inningOver || game.outs >= 3) {
    // ハーフイニング終了 → コールド/試合終了判定
    changeTimer = 110;
    pendingChange = true;
  } else {
    // 同じ攻撃を継続：少し見せてから次打者
    nextBatterTimer = 90;
  }
}
let nextBatterTimer = 0;
let changeTimer = 0;
let pendingChange = false;

/* --------------------------- 攻守交代 ---------------------------------- */
function goToChangeScreen() {
  pendingChange = false;
  ensureInningCell();

  // 試合終了判定
  if (isGameOver()) {
    finishGame();
    return;
  }

  game.phase = "change";
  const side = game.half === 0 ? "表" : "裏";
  game.msg = `${game.inning}回${side} 終了 — スペースで次へ`;
  updateHUD();
}

function nextHalfStart() {
  if (game.half === 0) {
    game.half = 1;
  } else {
    game.half = 0;
    game.inning++;
  }
  beginHalfInning();
}

function isGameOver() {
  // 規定イニング終了後
  if (game.inning < INNINGS) return false;

  // 最終回・表終了後、ホームがリードしていれば即終了
  if (game.inning >= INNINGS && game.half === 0) {
    if (game.homeTotal > game.awayTotal) return true; // 9回表終了でホームリード→終了は通常裏不要だが簡略化
    return false;
  }
  // 最終回・裏終了後
  if (game.inning >= INNINGS && game.half === 1) {
    if (game.homeTotal !== game.awayTotal) return true;
    // 同点なら延長
    return false;
  }
  return false;
}

function finishGame() {
  game.phase = "gameover";
  let result;
  if (game.homeTotal > game.awayTotal) result = "ホーム（あなた）の勝ち！🏆";
  else if (game.homeTotal < game.awayTotal) result = "ビジター（CPU）の勝ち…";
  else result = "引き分け";
  game.msg = `試合終了　${game.awayTotal} - ${game.homeTotal}　${result}　（スペースで再戦）`;
  updateHUD();
}

/* --------------------------- メインループ ------------------------------ */
function update() {
  switch (game.phase) {
    case "pitch_select":
      if (playerPitching()) {
        updateCursorHold(); // 狙いを動かす
      } else {
        updateCursorHold(); // ミート位置を構える
        cpuPitchTimer--;
        if (cpuPitchTimer <= 0) {
          cpuPitch();
        }
      }
      break;

    case "pitch":
      if (playerBatting()) updateCursorHold();
      updatePitch();
      break;

    case "atbat_result":
      atBatResultTimer--;
      if (atBatResultTimer <= 0 && atBatResultThen) {
        const fn = atBatResultThen;
        atBatResultThen = null;
        fn();
      }
      break;

    case "field":
      if (batted.active) {
        batted.t++;
        if (batted.t >= batted.dur) {
          batted.active = false;
          if (batted.resolved) {
            const fn = batted.resolved;
            batted.resolved = null;
            fn();
          }
        }
      } else {
        // 結果メッセージを少し表示
        if (nextBatterTimer > 0) {
          nextBatterTimer--;
          if (nextBatterTimer <= 0) setupAtBat();
        } else if (pendingChange) {
          changeTimer--;
          if (changeTimer <= 0) goToChangeScreen();
        }
      }
      break;
  }

  // フィールドビュー外でも保留中の交代・次打者を処理
  if (game.phase !== "field") {
    if (nextBatterTimer > 0) {
      nextBatterTimer--;
      if (nextBatterTimer <= 0 && game.phase !== "atbat_result") setupAtBat();
    }
    if (pendingChange && changeTimer > 0) {
      changeTimer--;
      if (changeTimer <= 0) goToChangeScreen();
    }
  }
}

/* --------------------------- 描画：打席ビュー -------------------------- */
function drawAtBatView() {
  // 背景：グラウンド
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#1d6b2e");
  g.addColorStop(0.55, "#2e8b3d");
  g.addColorStop(1, "#246b30");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 遠近の土（投手前）
  ctx.fillStyle = "rgba(201,138,75,0.55)";
  ctx.beginPath();
  ctx.ellipse(W / 2, 170, 120, 34, 0, 0, Math.PI * 2);
  ctx.fill();

  // 本塁付近の土（手前の扇形）
  ctx.fillStyle = "#b9793f";
  ctx.beginPath();
  ctx.moveTo(W / 2 - 260, H);
  ctx.quadraticCurveTo(W / 2, H - 180, W / 2 + 260, H);
  ctx.closePath();
  ctx.fill();

  // 投手シルエット
  drawPitcher(W / 2, 150);

  // ストライクゾーン（3x3 グリッド）
  drawStrikeZone();

  // 捕手・打者の手前シルエット
  drawCatcher();
  if (playerBatting()) drawBatter(true);
  else drawBatter(false);

  // ボール
  if (pitch.active || (game.phase === "atbat_result")) {
    drawPitchedBall();
  }

  // カーソル（ミート or 狙い）
  drawCursor();

  // 球種・狙いガイド（プレイヤー投球の選択中）
  if (game.phase === "pitch_select" && playerPitching()) {
    drawPitchSelectUI();
  }

  // フェーズ別の中央テキスト
  if (game.phase === "atbat_result") {
    drawBigText(game.msg);
  }
}

function drawStrikeZone() {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2;
  ctx.strokeRect(ZONE.x, ZONE.y, ZONE.w, ZONE.h);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const xx = ZONE.x + (ZONE.w / 3) * i;
    ctx.beginPath(); ctx.moveTo(xx, ZONE.y); ctx.lineTo(xx, ZONE.y + ZONE.h); ctx.stroke();
    const yy = ZONE.y + (ZONE.h / 3) * i;
    ctx.beginPath(); ctx.moveTo(ZONE.x, yy); ctx.lineTo(ZONE.x + ZONE.w, yy); ctx.stroke();
  }
  // 本塁ベース
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  const by = ZONE.y + ZONE.h + 26;
  ctx.moveTo(ZONE.cx - 34, by);
  ctx.lineTo(ZONE.cx + 34, by);
  ctx.lineTo(ZONE.cx + 28, by + 16);
  ctx.lineTo(ZONE.cx, by + 26);
  ctx.lineTo(ZONE.cx - 28, by + 16);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPitchedBall() {
  // 進行度に応じた位置とサイズ
  const def = PITCHES[pitch.type];
  const p = pitch.p;
  const brk = def.shape(p);
  const baseX = lerp(RELEASE.x, pitch.target.x, easeIn(p));
  const baseY = lerp(RELEASE.y, pitch.target.y, easeIn(p));
  const x = baseX + def.breakX * brk;
  const y = baseY + def.breakY * brk;
  const r = lerp(5, 15, p);

  // 影/軌跡
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = def.color;
  ctx.beginPath(); ctx.arc(x, y - r * 0.6, r * 0.8, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.fillStyle = def.color;
  ctx.strokeStyle = "rgba(180,40,40,0.8)";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  // 縫い目
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y, r * 0.9, -0.6, 0.6);
  ctx.stroke();
}

function drawCursor() {
  if (game.phase === "title" || game.phase === "change" || game.phase === "gameover") return;
  if (game.phase === "field") return;

  const isMeet = playerBatting();
  // CPU 打席のときはミートカーソルを表示しない（プレイヤー投球の狙いを表示）
  let x = cursor.x, y = cursor.y;

  if (isMeet) {
    // ミートカーソル（青リング）
    ctx.save();
    ctx.strokeStyle = swing.done ? "#ff5d5d" : "#54b0ff";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 36, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - 44, y); ctx.lineTo(x - 30, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 30, y); ctx.lineTo(x + 44, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y - 44); ctx.lineTo(x, y - 30); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y + 30); ctx.lineTo(x, y + 44); ctx.stroke();
    ctx.restore();
  } else if (playerPitching()) {
    // 投球の狙い（黄色い十字）
    ctx.save();
    ctx.strokeStyle = "#ffd23f";
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(x - 16, y); ctx.lineTo(x + 16, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y - 16); ctx.lineTo(x, y + 16); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

function drawPitchSelectUI() {
  const def = PITCHES[pitch.type];
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  roundRect(14, 14, 200, 132, 8); ctx.fill();
  ctx.fillStyle = "#ffd23f";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText("球種選択", 26, 36);
  ctx.font = "13px sans-serif";
  let yy = 60;
  for (const key of Object.keys(PITCHES)) {
    const pd = PITCHES[key];
    ctx.fillStyle = key === pitch.type ? "#ffd23f" : "#cfe0f0";
    const mark = key === pitch.type ? "▶ " : "   ";
    ctx.fillText(`${mark}${pd.key}: ${pd.name}`, 26, yy);
    yy += 20;
  }
  ctx.restore();
}

/* --------------------------- キャラクター描画 -------------------------- */
function drawPitcher(x, y) {
  ctx.save();
  // 体
  ctx.fillStyle = "#3a4a8a";
  ctx.beginPath(); ctx.ellipse(x, y + 14, 16, 22, 0, 0, Math.PI * 2); ctx.fill();
  // 頭
  ctx.fillStyle = "#ffd9b3";
  ctx.beginPath(); ctx.arc(x, y - 14, 12, 0, Math.PI * 2); ctx.fill();
  // 帽子
  ctx.fillStyle = "#26337a";
  ctx.beginPath(); ctx.arc(x, y - 16, 12, Math.PI, 0); ctx.fill();
  ctx.fillRect(x - 12, y - 16, 18, 4);
  ctx.restore();
}

function drawCatcher() {
  const x = ZONE.cx, y = H - 70;
  ctx.save();
  ctx.fillStyle = "#1f3a5a";
  ctx.beginPath(); ctx.ellipse(x, y + 30, 46, 40, 0, 0, Math.PI * 2); ctx.fill();
  // ミット
  ctx.fillStyle = "#7a4a22";
  ctx.beginPath(); ctx.arc(x, y - 6, 18, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#5e3618";
  ctx.beginPath(); ctx.arc(x, y - 6, 11, 0, Math.PI * 2); ctx.fill();
  // ヘルメット
  ctx.fillStyle = "#2a4f78";
  ctx.beginPath(); ctx.arc(x, y + 14, 16, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawBatter(isPlayer) {
  // 右打者：本塁の左側に立つ
  const x = ZONE.cx - 120;
  const y = H - 150;
  ctx.save();
  // 体
  ctx.fillStyle = isPlayer ? "#d23b3b" : "#cccccc";
  ctx.beginPath(); ctx.ellipse(x, y + 30, 18, 30, 0, 0, Math.PI * 2); ctx.fill();
  // 頭
  ctx.fillStyle = "#ffd9b3";
  ctx.beginPath(); ctx.arc(x, y - 4, 13, 0, Math.PI * 2); ctx.fill();
  // ヘルメット
  ctx.fillStyle = isPlayer ? "#a52121" : "#888";
  ctx.beginPath(); ctx.arc(x, y - 6, 14, Math.PI, 0); ctx.fill();

  // バット（スイング中は振る）
  const swinging = (game.phase === "pitch" || game.phase === "atbat_result") && swing.done;
  ctx.strokeStyle = "#c8a24a";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.beginPath();
  if (swinging) {
    ctx.moveTo(x + 4, y + 8);
    ctx.lineTo(x + 70, y - 8);
  } else {
    ctx.moveTo(x - 6, y + 6);
    ctx.lineTo(x + 8, y - 44);
  }
  ctx.stroke();
  ctx.restore();
}

/* --------------------------- 描画：フィールドビュー -------------------- */
function getFieldGeom() {
  const home = { x: W / 2, y: H - 70 };
  const fenceR = 440;
  return { home, fenceR };
}

function drawFieldView() {
  const field = getFieldGeom();
  const { home, fenceR } = field;

  // 背景
  ctx.fillStyle = "#0d3b16";
  ctx.fillRect(0, 0, W, H);

  // 外野フェアグラウンド（扇形）
  ctx.save();
  ctx.fillStyle = "#2e8b3d";
  ctx.beginPath();
  ctx.moveTo(home.x, home.y);
  ctx.arc(home.x, home.y, fenceR, -Math.PI * 0.75, -Math.PI * 0.25);
  ctx.closePath();
  ctx.fill();

  // 内野の土
  ctx.fillStyle = "#c98a4b";
  ctx.beginPath();
  ctx.moveTo(home.x, home.y);
  ctx.arc(home.x, home.y, 170, -Math.PI * 0.75, -Math.PI * 0.25);
  ctx.closePath();
  ctx.fill();

  // 内野芝（ダイヤモンド内）
  ctx.fillStyle = "#2e8b3d";
  const b1 = basePos(1, field), b2 = basePos(2, field), b3 = basePos(3, field);
  ctx.beginPath();
  ctx.moveTo(home.x, home.y - 8);
  ctx.lineTo(b1.x, b1.y);
  ctx.lineTo(b2.x, b2.y);
  ctx.lineTo(b3.x, b3.y);
  ctx.closePath();
  ctx.fill();

  // フェンス弧
  ctx.strokeStyle = "#f0d59a";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(home.x, home.y, fenceR, -Math.PI * 0.75, -Math.PI * 0.25);
  ctx.stroke();

  // ファウルライン
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(home.x, home.y);
  ctx.lineTo(home.x + Math.sin(-Math.PI / 4) * fenceR, home.y - Math.cos(-Math.PI / 4) * fenceR);
  ctx.moveTo(home.x, home.y);
  ctx.lineTo(home.x + Math.sin(Math.PI / 4) * fenceR, home.y - Math.cos(Math.PI / 4) * fenceR);
  ctx.stroke();
  ctx.restore();

  // 塁
  drawBase(home, true);
  drawBase(b1, game.bases[0]);
  drawBase(b2, game.bases[1]);
  drawBase(b3, game.bases[2]);

  // 打球
  if (batted.active) {
    const t = batted.t / batted.dur;
    const x = lerp(batted.startX, batted.landX, t);
    const y = lerp(batted.startY, batted.landY, t);
    const arc = Math.sin(t * Math.PI) * 60 * (0.4 + batted.power);
    // 影
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath(); ctx.ellipse(x, y, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
    // ボール
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(x, y - arc, 6, 0, Math.PI * 2); ctx.fill();
  } else {
    // 着弾マーク
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.beginPath(); ctx.arc(batted.landX, batted.landY, 5, 0, Math.PI * 2); ctx.fill();
  }

  // 結果テキスト（着弾後のみ表示。飛球中は結果を伏せる）
  if (!batted.active) drawBigText(game.msg || batted.outcome);
}

function basePos(n, field) {
  const { home, fenceR } = field;
  const d = 150; // ダイヤモンド辺の長さ相当
  if (n === 1) return { x: home.x + d * 0.78, y: home.y - d * 0.78 };
  if (n === 2) return { x: home.x, y: home.y - d * 1.1 };
  if (n === 3) return { x: home.x - d * 0.78, y: home.y - d * 0.78 };
  return home;
}

function drawBase(pos, on) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = on ? "#ffd23f" : "#ffffff";
  ctx.strokeStyle = "#444";
  ctx.lineWidth = 1.5;
  ctx.fillRect(-9, -9, 18, 18);
  ctx.strokeRect(-9, -9, 18, 18);
  ctx.restore();
}

/* --------------------------- 描画：タイトル等 -------------------------- */
function drawTitle() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0d3b16");
  g.addColorStop(1, "#2e8b3d");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.fillStyle = "#ffd23f";
  ctx.font = "bold 56px sans-serif";
  ctx.fillText("⚾ ミニ野球", W / 2, 200);
  ctx.fillStyle = "#fff";
  ctx.font = "22px sans-serif";
  ctx.fillText("パワプロ風ベースボール", W / 2, 250);

  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#cfe0f0";
  const lines = [
    `${INNINGS}イニング制 — あなたはホームチーム`,
    "表＝あなたの投球（守備） / 裏＝あなたの打撃（攻撃）",
    "",
    "【投球】球種ボタン/1〜4、画面なぞりで狙い、大ボタンで投球",
    "【打撃】画面なぞりでミート、大ボタン/スペースでスイング",
  ];
  let y = 330;
  for (const l of lines) { ctx.fillText(l, W / 2, y); y += 30; }

  ctx.fillStyle = "#ffd23f";
  ctx.font = "bold 24px sans-serif";
  ctx.fillText("▶ スペース / タップで開始 ◀", W / 2, 520);
  ctx.textAlign = "left";
}

function drawChange() {
  drawFieldView();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, W, H);
  drawBigText(game.msg);
}

function drawGameOver() {
  drawFieldView();
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffd23f";
  ctx.font = "bold 40px sans-serif";
  ctx.fillText("試合終了", W / 2, H / 2 - 60);
  ctx.fillStyle = "#fff";
  ctx.font = "22px sans-serif";
  ctx.fillText(`${game.awayTotal} - ${game.homeTotal}`, W / 2, H / 2 - 10);
  ctx.font = "18px sans-serif";
  ctx.fillText(game.msg, W / 2, H / 2 + 40);
  ctx.textAlign = "left";
}

function drawBigText(text) {
  if (!text) return;
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "bold 34px sans-serif";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.strokeText(text, W / 2, H / 2 - 30);
  ctx.fillStyle = "#ffd23f";
  ctx.fillText(text, W / 2, H / 2 - 30);
  ctx.restore();
  ctx.textAlign = "left";
}

/* --------------------------- 描画ルート -------------------------------- */
function render() {
  switch (game.phase) {
    case "title": drawTitle(); break;
    case "field": drawFieldView(); break;
    case "change": drawChange(); break;
    case "gameover": drawGameOver(); break;
    default: drawAtBatView(); break;
  }
}

/* --------------------------- HUD（DOM）更新 ---------------------------- */
function updateHUD() {
  // カウント
  setDots("balls", game.balls, 3, "ball");
  setDots("strikes", game.strikes, 2, "strike");
  setDots("outs", game.outs, 2, "out");

  // 回表示
  const side = game.half === 0 ? "表" : "裏";
  document.getElementById("inning-label").textContent = `${game.inning}回 ${side}`;

  // ベース
  document.getElementById("mini-1").classList.toggle("on", game.bases[0]);
  document.getElementById("mini-2").classList.toggle("on", game.bases[1]);
  document.getElementById("mini-3").classList.toggle("on", game.bases[2]);

  // スコアボード
  renderScoreboard();

  // プロンプト
  document.getElementById("prompt").textContent = game.msg;

  // タッチ操作ボタンの表示更新
  updateTouchUI();
}

function updateTouchUI() {
  const ab = document.getElementById("action-btn");
  if (ab) {
    let label = "—";
    if (game.phase === "title") label = "開始";
    else if (game.phase === "change") label = "次へ";
    else if (game.phase === "gameover") label = "再戦";
    else if (game.phase === "pitch_select" && playerPitching()) label = "投球";
    else if (game.phase === "pitch" && playerBatting()) label = "スイング";
    else if (game.phase === "pitch_select" && playerBatting()) label = "構え";
    ab.textContent = label;
  }

  const pb = document.getElementById("pitch-buttons");
  if (pb) {
    const show = game.phase === "pitch_select" && playerPitching();
    pb.style.visibility = show ? "visible" : "hidden";
    for (const btn of pb.querySelectorAll("[data-pitch]")) {
      btn.classList.toggle("sel", PITCH_KEYS[btn.dataset.pitch] === pitch.type);
    }
  }
}

function setDots(id, count, max, cls) {
  const el = document.getElementById(id);
  el.innerHTML = "";
  for (let i = 0; i < max; i++) {
    const d = document.createElement("span");
    d.className = "dot " + cls + (i < count ? " on" : "");
    el.appendChild(d);
  }
}

function renderScoreboard() {
  const innRow = document.getElementById("inning-row");
  const awayRow = document.getElementById("away-row");
  const homeRow = document.getElementById("home-row");

  // ヘッダ・行を再構築
  innRow.innerHTML = '<th class="team-cell"></th>';
  awayRow.innerHTML = '<td class="team-cell">ビジター</td>';
  homeRow.innerHTML = '<td class="team-cell">ホーム</td>';

  const shown = Math.max(INNINGS, game.inning);
  for (let i = 0; i < shown; i++) {
    const th = document.createElement("th");
    th.textContent = i + 1;
    if (i + 1 === game.inning) th.className = "cur";
    innRow.appendChild(th);

    const at = document.createElement("td");
    const ht = document.createElement("td");
    at.textContent = cellVal(game.score.away, i, 0);
    ht.textContent = cellVal(game.score.home, i, 1);
    awayRow.appendChild(at);
    homeRow.appendChild(ht);
  }

  // 合計（R）列
  const rh = document.createElement("th");
  rh.textContent = "R";
  rh.className = "cur";
  innRow.appendChild(rh);

  const ra = document.createElement("td");
  ra.textContent = game.awayTotal;
  ra.style.fontWeight = "bold";
  ra.style.color = "var(--accent)";
  awayRow.appendChild(ra);

  const rht = document.createElement("td");
  rht.textContent = game.homeTotal;
  rht.style.fontWeight = "bold";
  rht.style.color = "var(--accent)";
  homeRow.appendChild(rht);
}

function cellVal(arr, idx, half) {
  // そのイニング・サイドがまだ来ていなければ空欄
  if (idx > game.inning - 1) return "";
  if (idx === game.inning - 1) {
    // 現在進行中
    if (game.half < half) return ""; // まだそのサイドが来ていない
  }
  return arr[idx] != null ? arr[idx] : 0;
}

/* --------------------------- ユーティリティ ---------------------------- */
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }
function easeIn(t) { return t * t; }
function inZone(x, y, pad = 6) {
  return x >= ZONE.x - pad && x <= ZONE.x + ZONE.w + pad &&
         y >= ZONE.y - pad && y <= ZONE.y + ZONE.h + pad;
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* --------------------------- ループ起動 -------------------------------- */
function loop() {
  update();
  render();
  requestAnimationFrame(loop);
}

updateHUD();
loop();
