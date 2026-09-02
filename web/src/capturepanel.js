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
import { shouldStop, frameGate, quickSigma, limitEstimate, resample } from './capture.js';

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
let lenses = [];          // [{deviceId, label, kind: 'ultra'|'wide'|'tele'}]
let activeDeviceId = null;
let currentZoom = 1;
const LENS_KEY = 'live-lens';
let session = null;    // { frames: [{imageData, small, focus}], sigmas, limits, rejects, timer }
let finishing = false; // セッション終了後、本解析へ渡し終わるまで true（二重起動を防ぐ）
let starting = null;   // startLive の進行中 Promise（二重起動でストリームが漏れないように）
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
  return !!session || finishing;
}

/** ライブビューの入切。 */
export async function toggleLive() {
  if (starting) { await starting; return !!stream; }
  if (stream) { stopLive(); return false; }
  // 起動中（許可ダイアログが出ている間）にもう一度呼ばれても2本目を開かない。
  // 開くと最初のストリームが止められず、カメラが点いたまま・video が2枚・
  // 判定タイマーが2本になる
  starting = startLive().finally(() => { starting = null; });
  await starting;
  return true;
}

/** カメラを開く。deviceId があればそのレンズ、無ければ背面の既定（広角）。 */
async function openStream(deviceId) {
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } }
    : { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

/**
 * 背面レンズの一覧。許可が下りた後でないとラベルが空なので、最初の getUserMedia の後に呼ぶ。
 * iOS Safari は「背面望遠カメラ」「背面超広角カメラ」を個別の device として出す。
 * 倍率は API から取れないので、種別（超広角/広角/望遠）だけ判定する。
 */
async function refreshLenses() {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const back = devices.filter((d) => d.kind === 'videoinput' && !/front|前面|フロント|user/i.test(d.label));
  const kindOf = (label) => /tele|望遠/i.test(label) ? 'tele'
    : /ultra|超広角/i.test(label) ? 'ultra' : 'wide';
  // デュアル/トリプルの「合成カメラ」は個別レンズと重複するので除く
  const singles = back.filter((d) => !/dual|triple|デュアル|トリプル/i.test(d.label));
  const rank = { ultra: 0, wide: 1, tele: 2 };
  lenses = (singles.length ? singles : back)
    .map((d) => ({ deviceId: d.deviceId, label: d.label, kind: kindOf(d.label) }))
    .sort((a, b) => rank[a.kind] - rank[b.kind]);
}

async function startLive() {
  const vf = $('viewfinder');
  let remembered = null;
  try { remembered = localStorage.getItem(LENS_KEY); } catch { /* 記憶なし */ }
  try {
    stream = await openStream(remembered);
  } catch {
    try {
      stream = await openStream(null);   // 記憶したレンズが無い端末（機種変更など）
    } catch (err) {
      throw new Error('カメラを起動できませんでした。ブラウザのカメラ許可を確認するか、写真シートから読み込んでください');
    }
  }
  activeDeviceId = stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? remembered;
  currentZoom = stream.getVideoTracks()[0]?.getSettings?.().zoom ?? 1;
  await refreshLenses();

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

/** いまのレンズとズームの状態。UI（レンズ切替のピル）とスケール計算が読む。 */
export function lensState() {
  const track = stream?.getVideoTracks()[0];
  let zoom = null;
  const caps = track?.getCapabilities?.();
  if (caps && caps.zoom && Number.isFinite(caps.zoom.max) && caps.zoom.max > 1) {
    zoom = { min: caps.zoom.min ?? 1, max: caps.zoom.max, value: currentZoom };
  }
  const active = lenses.find((l) => l.deviceId === activeDeviceId) ?? null;
  const kind = active?.kind ?? 'wide';
  // 倍率: 広角は 1。それ以外はここでは決めない（スケールシートの手入力に任せる）
  const factor = kind === 'wide' ? 1 : null;
  return { lenses, activeDeviceId, activeKind: kind, zoom, factor };
}

/** レンズを切り替える（計測中は不可）。 */
export async function switchLens(deviceId) {
  if (!stream || session || deviceId === activeDeviceId) return false;
  const next = await openStream(deviceId);
  stream.getTracks().forEach((t) => t.stop());
  stream = next;
  video.srcObject = stream;
  await video.play();
  activeDeviceId = deviceId;
  currentZoom = stream.getVideoTracks()[0]?.getSettings?.().zoom ?? 1;
  try { localStorage.setItem(LENS_KEY, deviceId); } catch { /* 記憶できないだけ */ }
  deps.onStateChange?.();
  return true;
}

/**
 * ズーム（対応端末のみ）。デジタルズームは画を切り出すだけで分解能は上がらない
 * （48MP 機のセンサークロップ 2× までは実質的に上がる）。UI 側で 2× までに絞る。
 */
export async function setZoom(z) {
  const track = stream?.getVideoTracks()[0];
  // 計測中にズームを変えると1枚目と縮尺が違うフレームが混ざる。必ず弾く
  if (!track || session) return false;
  const caps = track.getCapabilities?.().zoom;
  const lo = caps?.min ?? 1;
  const hi = caps?.max ?? 1;
  const want = Math.max(lo, Math.min(hi, z));
  try {
    await track.applyConstraints({ advanced: [{ zoom: want }] });
    // 要求値ではなく**実際に適用された値**を持つ。端末が丸めることがあり、
    // 要求値で mm/px を計算すると縮尺がずれる
    currentZoom = track.getSettings?.().zoom ?? want;
    deps.onStateChange?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * 連続ズーム（ピンチ・ダイヤル用）。要求が来るたびに applyConstraints を
 * 投げると詰まるので、実行中は最後の要求だけ覚えて追いかける。
 */
let zoomInFlight = false;
let zoomQueued = null;
export function requestZoom(z) {
  if (session) return false;
  zoomQueued = z;
  if (zoomInFlight) return true;
  (async () => {
    zoomInFlight = true;
    try {
      while (zoomQueued != null) {
        const next = zoomQueued;
        zoomQueued = null;
        await setZoom(next);
      }
    } finally {
      zoomInFlight = false;
    }
  })();
  return true;
}

/** いまのズーム値（適用済みの実値）。 */
export function currentZoomValue() {
  return currentZoom || 1;
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
  // 基準（静止画 4032 幅など）とライブ（3840 幅）は整数縮小の結果の幅が違うので、
  // 幅を基準に揃えてから比べる。揃えないと 1 割の寸法差がそのまま相関を落とす
  const live = Math.abs(small.gray.width - baseline.small.width) > 1
    ? resample(small.gray, baseline.small.width / small.gray.width) : small.gray;
  const shift = estimateGlobalShift(baseline.small, live, downsample,
    { maxShiftPx: Math.floor(Math.min(live.width, live.height) / 8) });
  const off = Math.hypot(shift.dx, shift.dy);
  const okDist = off < live.width * 0.05;
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
  if (!video || session || finishing) return false;
  session = { frames: [], sigmas: [], limits: [], rejects: 0 };
  document.body.classList.add('session-on');
  setLiveStatus('計測 開始 · 動かさないでください', 'rec');
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
  // 途中で端末を回すと縦横が入れ替わる。寸法の違うフレームを混ぜると相関は
  // 端をクランプして「それらしい嘘の σ」を出すので、1枚目と違えば弾く
  const first = session.frames[0]?.imageData;
  if (first && (first.width !== w || first.height !== h)) {
    session.rejects += 1;
    setLiveStatus('画面の向きが変わりました — この1枚は使いません', 'warn');
    const v = shouldStop(session.limits, { frames: session.frames.length, consecutiveRejects: session.rejects });
    if (v.stop) endSession(v.reason);
    return;
  }
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
      // 簡易 σ は縮小画で測っているので、縮小前の px に戻してから限界にする。
      // 戻さないと「限界 … px」の表示が縮小率ぶん（4K なら 4 倍）小さく出る
      const sigma = quickSigma(ref, small);
      if (sigma != null) session.sigmas.push(sigma * qFactor);
      const gsd = deps.getGsd?.();
      const est = limitEstimate(session.sigmas, gsd || null);
      if (est) {
        session.limits.push(est.mm ?? est.px);
        setLiveStatus(
          `計測 ${session.frames.length}枚 · 限界 ${est.mm != null
            ? `${est.mm.toFixed(3)} mm` : `${est.px.toFixed(3)} px`}`, 'rec');
      } else {
        setLiveStatus(`計測 ${session.frames.length}枚`, 'rec');
      }
    } else {
      setLiveStatus('計測 1枚（基準）', 'rec');
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
  finishing = true;   // 本解析へ渡し終わるまで、次のセッションを始めさせない
  document.body.classList.remove('session-on');
  deps.onStateChange?.();
  try {
    await finishSession(reason, frames);
  } finally {
    finishing = false;
    deps.onStateChange?.();
  }
}

async function finishSession(reason, frames) {
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

// canvas は1枚を使い回し、終わったら 0×0 にして裏の画素メモリを返す。
// 4K の canvas を 15 枚作ると iOS Safari の canvas メモリ上限に当たってタブが落ちる
function toJpeg(imageData, quality = 0.92) {
  const canvas = toJpeg.canvas ?? (toJpeg.canvas = document.createElement('canvas'));
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      canvas.width = canvas.height = 0;
      if (b) resolve(b); else reject(new Error('JPEG 化に失敗しました'));
    }, 'image/jpeg', quality);
  });
}
