/**
 * ライブ計測セッション。
 *
 * 3Dスキャンアプリの撮影体験に寄せた「押したら勝手に終わる」計測。
 *
 * - ビューファインダーは getUserMedia のライブ映像
 * - 撮影中の品質判定・枚数・終了はアプリが決める（capture.js の判断ロジック）
 * - 再訪時は保存済みの基準と**機械が照合**し、矢印で立ち位置を誘導、
 *   合ったら自動でセッションを開始する。人がやるのは歩くことだけ
 *
 * 制約: getUserMedia のフレームには EXIF が無いので焦点距離は自動で取れない。
 * スケールは点群・基準距離・（端末に記憶した）焦点距離のどれかで決める。
 * 静止画の per-shot 撮影（EXIF 付き・写真シート）は残してある。
 */

import { toGray, downsample } from './image.js';
import { speckleQuality, focusScore } from './speckle.js';
import { estimateGlobalShift } from './dic.js';
import { shouldStop, frameGate, quickSigma, limitEstimate } from './capture.js';

const $ = (id) => document.getElementById(id);

const LIVE_CHECK_MS = 400;    // ライブ品質・照合の周期
const FRAME_INTERVAL_MS = 800; // セッション中の撮影間隔
const SMALL_WIDTH = 420;       // ライブ判定に使う縮小幅
const QUICK_WIDTH = 1000;      // 簡易σに使う縮小幅

let video = null;
let stream = null;
let overlay = null;    // ゴースト＋誘導矢印の描画先
let deps = null;

let liveTimer = null;
let session = null;    // { frames: [{imageData, small, focus}], sigmas, limits, rejects, timer }
let baseline = null;   // { small, bitmap, name } 再訪照合用
let alignedStreak = 0;
let autoArm = false;   // 照合が合ったら自動でセッションを始める

export function initCapturePanel(options) {
  deps = options;   // { setFrames, runAnalysis, getGsd, onStateChange }
}

export function liveActive() {
  return !!stream;
}

export function sessionActive() {
  return !!session;
}

/** ライブビューの入切。 */
export async function toggleLive() {
  if (stream) { stopLive(); return false; }
  await startLive();
  return true;
}

async function startLive() {
  const vf = $('viewfinder');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
      audio: false,
    });
  } catch (err) {
    throw new Error('カメラを起動できませんでした。ブラウザのカメラ許可を確認するか、写真シートから読み込んでください');
  }

  video = document.createElement('video');
  video.id = 'liveVideo';
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  vf.insertBefore(video, $('vfBadge'));

  overlay = document.createElement('canvas');
  overlay.id = 'liveOverlay';
  vf.insertBefore(overlay, $('vfBadge'));

  await video.play();
  document.body.classList.add('live-on');
  liveTimer = setInterval(liveCheck, LIVE_CHECK_MS);
  deps.onStateChange?.();
}

export function stopLive() {
  if (session) endSession('aborted');
  clearInterval(liveTimer);
  liveTimer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video?.remove();
  video = null;
  overlay?.remove();
  overlay = null;
  document.body.classList.remove('live-on');
  deps.onStateChange?.();
}

/** 再訪照合の基準を設定する。null で解除。 */
export function setBaseline(b) {
  baseline = b;
  alignedStreak = 0;
  autoArm = !!b;
  if (overlay) drawOverlay(null);
}

export function baselineName() {
  return baseline?.name ?? null;
}

// ---------------------------------------------------------------- ライブ判定

function grabSmall(width) {
  if (!video || video.videoWidth === 0) return null;
  const factor = Math.max(1, Math.round(video.videoWidth / width));
  const w = Math.floor(video.videoWidth / factor);
  const h = Math.floor(video.videoHeight / factor);
  const canvas = grabSmall.canvas ?? (grabSmall.canvas = document.createElement('canvas'));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  return { gray: toGray(ctx.getImageData(0, 0, w, h), null, 'luma', true), factor };
}

function liveCheck() {
  if (!video || session) return;
  const small = grabSmall(SMALL_WIDTH);
  if (!small) return;

  const quality = speckleQuality(small.gray, { subsetHalf: 9 });
  const focus = focusScore(small.gray);
  deps.onLiveQuality?.({ quality, focus });

  if (!baseline) { drawOverlay(null); return; }

  // 基準との照合。ずれの向きを矢印で出し、合ったら自動で計測を始める。
  // 探索半径はフレーム寸法の 1/8 に抑える。これより大きなずれは「まだ合っていない」
  // として扱えば十分で、半径を欲張ると縮小画像で探索点が全部画面外に落ちる
  const shift = estimateGlobalShift(baseline.small, small.gray, downsample,
    { maxShiftPx: Math.floor(Math.min(small.gray.width, small.gray.height) / 8) });
  const off = Math.hypot(shift.dx, shift.dy);
  const okDist = off < small.gray.width * 0.05;
  const okConf = shift.confidence > 0.4;

  if (okDist && okConf) {
    alignedStreak += 1;
    drawOverlay({ aligned: true });
    if (autoArm && alignedStreak >= 3) {
      autoArm = false;   // 二重起動しない
      startSession();
    }
  } else {
    alignedStreak = 0;
    drawOverlay(okConf ? { dx: shift.dx, dy: shift.dy } : { lost: true });
  }
}

/** ゴーストと誘導。ゴーストは常時 35%、誘導は状態に応じて。 */
function drawOverlay(guide) {
  if (!overlay || !video) return;
  const w = overlay.width = overlay.clientWidth * (window.devicePixelRatio || 1);
  const h = overlay.height = overlay.clientHeight * (window.devicePixelRatio || 1);
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!baseline) return;

  // ゴースト: 基準画像を video と同じ contain 配置で薄く重ねる
  if (baseline.bitmap) {
    const scale = Math.min(w / baseline.bitmap.width, h / baseline.bitmap.height);
    const dw = baseline.bitmap.width * scale;
    const dh = baseline.bitmap.height * scale;
    ctx.globalAlpha = 0.3;
    ctx.drawImage(baseline.bitmap, (w - dw) / 2, (h - dh) / 2, dw, dh);
    ctx.globalAlpha = 1;
  }

  const cx = w / 2;
  const cy = h / 2;
  if (guide?.aligned) {
    ctx.strokeStyle = 'rgba(94,196,138,.9)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(w, h) * 0.09, 0, Math.PI * 2);
    ctx.stroke();
    setLiveStatus('位置が合いました — 自動で計測を始めます', 'good');
  } else if (guide?.lost) {
    setLiveStatus(`基準「${baseline.name}」の壁にカメラを向けてください`, 'warn');
  } else if (guide) {
    // 内容が (dx,dy) にずれている → その向きへパンすると中央に戻る
    const len = Math.hypot(guide.dx, guide.dy);
    const ux = guide.dx / len;
    const uy = guide.dy / len;
    const r = Math.min(w, h) * 0.14;
    ctx.strokeStyle = 'rgba(217,154,43,.95)';
    ctx.fillStyle = 'rgba(217,154,43,.95)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(cx - ux * r * 0.6, cy - uy * r * 0.6);
    ctx.lineTo(cx + ux * r, cy + uy * r);
    ctx.stroke();
    const a = Math.atan2(uy, ux);
    ctx.beginPath();
    ctx.moveTo(cx + ux * r * 1.35, cy + uy * r * 1.35);
    ctx.lineTo(cx + Math.cos(a - 2.6) * r * 0.35 + ux * r, cy + Math.sin(a - 2.6) * r * 0.35 + uy * r);
    ctx.lineTo(cx + Math.cos(a + 2.6) * r * 0.35 + ux * r, cy + Math.sin(a + 2.6) * r * 0.35 + uy * r);
    ctx.closePath();
    ctx.fill();
    setLiveStatus('矢印の方へゆっくり向けてください', 'info');
  }
}

function setLiveStatus(text, kind) {
  deps.onLiveStatus?.(text, kind);
}

// ---------------------------------------------------------------- セッション

/** 計測セッション。ライブでなければ false を返す（呼び出し側は従来動作へ）。 */
export function startSession() {
  if (!video || session) return false;
  session = { frames: [], sigmas: [], limits: [], rejects: 0 };
  document.body.classList.add('session-on');
  setLiveStatus('計測中… そのまま動かさないでください', 'info');
  session.timer = setInterval(captureFrame, FRAME_INTERVAL_MS);
  deps.onStateChange?.();
  return true;
}

export function stopSessionEarly() {
  if (session) endSession(session.frames.length >= 2 ? 'manual' : 'aborted');
}

async function captureFrame() {
  if (!video || !session) return;

  // フル解像度で1枚
  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = captureFrame.canvas ?? (captureFrame.canvas = document.createElement('canvas'));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);

  // 合否は縮小版で判定（フル解像度だと1枚数秒かかる）
  const factor = Math.max(1, Math.round(w / SMALL_WIDTH));
  const tiny = downsample(toGray(imageData, null, 'luma', true), factor);
  const quality = speckleQuality(tiny, { subsetHalf: 9 });
  const focus = focusScore(tiny);
  const gate = frameGate({ focus, verdict: quality.verdict },
    session.frames.map((f) => f.focus));

  if (!gate.ok) {
    session.rejects += 1;
    setLiveStatus(`${gate.reason} — この1枚は使いません`, 'warn');
  } else {
    session.rejects = 0;
    const qFactor = Math.max(1, Math.round(w / QUICK_WIDTH));
    const small = downsample(toGray(imageData, null, 'luma', true), qFactor);
    session.frames.push({ imageData, small, focus, quality, qFactor });

    if (session.frames.length >= 2) {
      const ref = session.frames[0].small;
      const sigma = quickSigma(ref, small);
      if (sigma != null) session.sigmas.push(sigma);
      const gsd = deps.getGsd?.();
      const est = limitEstimate(session.sigmas, gsd ? gsd * session.frames[0].qFactor : null);
      if (est) {
        session.limits.push(est.mm ?? est.px);
        setLiveStatus(
          `計測中 ${session.frames.length} 枚 · 限界の見積もり ${est.mm != null
            ? `${est.mm.toFixed(3)} mm` : `${est.px.toFixed(3)} px`} · 収束待ち`, 'info');
      } else {
        setLiveStatus(`計測中 ${session.frames.length} 枚`, 'info');
      }
    } else {
      setLiveStatus('計測中 1 枚（基準）', 'info');
    }
  }

  const verdict = shouldStop(session.limits, {
    frames: session.frames.length,
    consecutiveRejects: session.rejects,
  });
  if (verdict.stop) endSession(verdict.reason);
}

async function endSession(reason) {
  clearInterval(session.timer);
  const frames = session.frames;
  session = null;
  document.body.classList.remove('session-on');
  deps.onStateChange?.();

  if (reason === 'quality') {
    setLiveStatus('条件が悪く、使える写真が続きませんでした。距離とピントを変えて撮り直してください', 'bad');
    if (frames.length < 2) return;
  }
  if (reason === 'aborted' || frames.length < 2) {
    setLiveStatus(frames.length ? '計測を中止しました' : null, 'info');
    return;
  }

  const label = reason === 'converged' ? 'σ が収束しました'
    : reason === 'max' ? '上限枚数に達しました' : '計測を締めます';
  setLiveStatus(`${label} — ${frames.length} 枚で解析します`, 'good');

  // フレームを本解析へ渡す（JPEG 化は保存や書き出しに使うので併せて作る）
  const records = [];
  for (const [i, f] of frames.entries()) {
    records.push({
      imageData: f.imageData,
      blob: await toJpeg(f.imageData),
      name: `live_${String(i).padStart(2, '0')}.jpg`,
    });
  }
  await deps.setFrames(records);
  await deps.runAnalysis();
}

function toJpeg(imageData, quality = 0.92) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG 化に失敗しました'))), 'image/jpeg', quality);
  });
}
