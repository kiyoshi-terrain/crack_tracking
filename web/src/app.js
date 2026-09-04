// σ実測ツールの UI。
//
// 流れ:
//   写真を読む → EXIF の整合性を確認 → 解析範囲を選ぶ
//   → 1枚目を基準に各枚の変位場を計測 → カメラの動き（アフィン/ホモグラフィ）を差し引く
//   → 残差の散らばり = 測定ノイズ σ

import { parseExif, checkConsistency } from './exif.js';
import { decodeFile, toGray, downsample, makePreviewCanvas, clampRegion } from './image.js';
import { estimateGlobalShift, measureDisplacementField } from './dic.js';
import { fitAffine, fitHomography, residuals } from './transform.js';
import { summarize, detectionLimit, computeGSD, focalLengthPxFrom35mm } from './sigma.js';
import { speckleQuality, focusScore } from './speckle.js';
import { detectTargets, matchTargets, pairwiseDistances } from './targets.js';
import { estimateDistortion, orderGrid, gridWorld, isIdentity } from './lenscal.js';
import { initCloudPanel, refreshCloudScale, cloudGSD, cloudState } from './cloudpanel.js';
import { sampleOutOfPlane } from './pointcloud.js';
import { initHistoryPanel, refreshHistoryPanel, historySummary } from './historypanel.js';
import { initShell, updateHud, setViewfinderHint, openSheet, closeSheet, routeHud } from './shell.js';
import { initComparePanel, compareLamp, refreshSavedBaselines } from './comparepanel.js';
import { initCloudDiffPanel, cloudDiffLamp } from './clouddiffpanel.js';
import {
  initCapturePanel, toggleLive, liveActive, sessionActive,
  startSession, stopSessionEarly, stopLive, lensState, switchLens, setZoom, requestZoom, currentZoomValue,
} from './capturepanel.js';
import { saveBaseline } from './store.js';
import { crackOpeningSeries, crackPatches, crackFrame, lineToLocal } from './crackline.js';
import { APP_VERSION } from './version.js';

const $ = (id) => document.getElementById(id);

// 版の食い違い検知の目印（index.html の素のスクリプトが読む）。
// import が全部解決してここまで来られたことの証明なので、必ず最初に立てる。
// 立たなければ「新しい HTML ＋ 古いモジュール」か、起動時の例外
window.__JS_VERSION = APP_VERSION;

const state = {
  files: [],       // {file, exif, imageData, url, quality, focus}
  roi: null,
  preview: null,
  lastResult: null,
  // 亀裂測点。基準画像（1枚目）の画素座標で持つ線分 {label, x1, y1, x2, y2}。
  // 基準として保存すると meta に入り、次回の比較で同じ線が使われる
  cracks: [],
  crackPairs: [],  // σ 実測で出た亀裂ごとの開口の系列（ターゲット対と同じ扱い）
  drawMode: 'roi', // ビューファインダーのドラッグが何を引くか: 'roi' | 'crack'
};

// ═══════════════════════════════════════════ 読み込み

$('drop').addEventListener('click', () => $('fileInput').click());
$('drop').addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('over'); });
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('over');
  loadFiles([...e.dataTransfer.files]);
});
$('fileInput').addEventListener('change', (e) => {
  loadFiles([...e.target.files]);
  e.target.value = '';
});

// ◉ はライブ計測（getUserMedia のライブ映像＋自動セッション）。
// EXIF 付きの静止画が要るときは写真シートの「1枚ずつ撮る」（capture 属性）を使う
$('cameraBtn').addEventListener('click', async () => {
  try {
    const on = await toggleLive();
    if (on) setViewfinderHint('σ を押すと自動で撮り続け、収束したら止まります', 'info');
  } catch (err) {
    setViewfinderHint(err.message, 'warn');
    openSheet('photo');
  }
});
$('captureStillBtn').addEventListener('click', () => $('cameraInput').click());
$('cameraInput').addEventListener('change', (e) => {
  loadFiles([...e.target.files]);
  e.target.value = '';
});

$('clearBtn').addEventListener('click', () => {
  state.files.forEach((f) => URL.revokeObjectURL(f.url));
  state.files = [];
  state.roi = null;
  state.lastResult = null;
  state.limit = null;
  state.measurement = null;
  state.preview = null;
  $('thumbs').innerHTML = '';
  $('quickCheck').innerHTML = '';
  $('fileWarnings').innerHTML = '';
  $('preview').querySelectorAll('canvas').forEach((c) => c.remove());
  $('roiBox').style.display = 'none';
  setViewfinderHint(null);
  updateSteps();
});

async function loadFiles(fileList) {
  const images = fileList.filter(
    (f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|tiff?)$/i.test(f.name)
  );
  if (!images.length) return;
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // ファイルから読み込むときはライブ映像を閉じて、読み込んだ写真をファインダーに出す
  if (liveActive()) stopLive();
  state.lensMultiplier = null;   // EXIF 付きなので焦点距離はそのまま

  const errors = [];
  for (const [i, file] of images.entries()) {
    log(`読み込み中… ${i + 1} / ${images.length}`);
    await tick();
    try {
      const buffer = await file.arrayBuffer();
      const exif = parseExif(buffer);
      const imageData = await decodeFile(file);
      // 品質はサムネイル相当の縮小版で評価する（全画素だと1枚数秒かかる）
      const small = downsample(toGray(imageData, null, 'luma', true), Math.max(1, Math.round(imageData.width / 700)));
      state.files.push({
        file, exif, imageData,
        url: URL.createObjectURL(file),
        quality: speckleQuality(small, { subsetHalf: 9 }),
        focus: focusScore(small),
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  log('');

  if (!state.files.length) {
    showWarnings(errors.length ? errors : ['画像を読み込めませんでした。']);
    return;
  }

  showWarnings([...errors, ...checkConsistency(state.files.map((f) => f.exif))]);
  renderThumbs();
  setupScale();
  refreshCloudScale();
  setupPreview();
  renderQuickCheck();
  updateSteps();
}

function removeFile(index) {
  URL.revokeObjectURL(state.files[index].url);
  state.files.splice(index, 1);
  if (!state.files.length) {
    $('clearBtn').click();
    return;
  }
  renderThumbs();
  setupPreview();
  renderQuickCheck();
  updateSteps();
}

// ═══════════════════════════════════════════ サムネイル

function renderThumbs() {
  const focuses = state.files.map((f) => f.focus).sort((a, b) => a - b);
  const medianFocus = focuses[focuses.length >> 1] ?? 0;

  $('thumbs').innerHTML = state.files
    .map((f, i) => {
      const blurred = medianFocus > 0 && f.focus < medianFocus * 0.6;
      const cls = f.quality.verdict === 'poor' || blurred ? 'bad'
        : f.quality.verdict === 'fair' ? 'warn' : 'good';
      const label = blurred ? 'ボケ' : f.quality.verdict === 'poor' ? '模様なし' : `${f.focus.toFixed(3)}`;
      return `<div class="thumb ${i === 0 ? 'reference' : ''}">
        <img src="${f.url}" alt="">
        <span class="tag">${i === 0 ? '基準' : i}</span>
        <button class="drop-btn" data-index="${i}" title="この写真を外す" aria-label="外す">×</button>
        <div class="foot"><span class="dot ${cls}"></span>${label}</div>
      </div>`;
    })
    .join('');

  $('thumbs').querySelectorAll('.drop-btn').forEach((b) => {
    b.addEventListener('click', () => removeFile(Number(b.dataset.index)));
  });
}

function showWarnings(messages) {
  $('fileWarnings').innerHTML = messages
    .map((m) => `<div class="banner warn">${escapeHtml(m)}</div>`)
    .join('');
}

/**
 * 現地チェック。1枚あれば走ります。
 *
 * σ は複数枚ないと出ませんが、「この位置で撮って意味があるか」は
 * 1枚で判定できます。撮り直しが効くうちに気づくのが目的です。
 */
function renderQuickCheck() {
  if (!state.files.length) return;
  const latest = state.files[state.files.length - 1];
  const gsd = currentGSD();
  const cls = latest.quality.verdict === 'good' ? 'good'
    : latest.quality.verdict === 'fair' ? 'warn' : 'bad';

  $('quickCheck').innerHTML = `<div class="banner ${cls}"><div>
    <strong>現地チェック</strong> — ${escapeHtml(latest.quality.reason)}<br>
    <span class="mono" style="font-size:12px;color:var(--ink-soft)">
      ピント ${latest.focus.toFixed(4)}${gsd ? ` ／ 分解能 ${gsd.toFixed(4)} mm/px` : ' ／ 分解能は撮影距離の入力後'}
    </span>
  </div></div>`;

}

/**
 * ビューファインダーに出す一言。
 *
 * 優先順は「撮り直すべき」＞「次にやること」。良好かつ何も足りなければ黙る。
 * 常時何か言っていると読まれなくなるので、出す条件は絞る。
 */
function showHint() {
  const worst = pickWorstPhoto();
  if (worst && worst.lamp !== 'good') {
    const where = worst.index === 0 ? '基準画像' : `${worst.index} 枚目`;
    if (verdictToLamp(worst.file.quality.verdict) === 'bad') {
      setViewfinderHint(`${where}: 模様が乏しく DIC が成立しません — ${worst.file.quality.reason}`, 'bad');
    } else if (focusLamp(worst.file) === 'bad') {
      setViewfinderHint(`${where}: ピントが外れています。撮り直してください`, 'bad');
    } else {
      setViewfinderHint(`${where}: ${worst.file.quality.reason}`, 'warn');
    }
    return;
  }

  const next = nextAction();
  setViewfinderHint(next, next ? 'info' : 'info');
}

/** 次にやること。全部そろっていれば null。 */
function nextAction() {
  const n = state.files.length;
  if (n === 0) return null;                       // 空状態の案内は vf-empty が出している
  if (n === 1) return 'あと1枚以上撮ると σ が出ます';
  if (state.measurement) return null;
  if (state.lensMultiplier && state.lensMultiplier.kind !== 'wide' && state.lensMultiplier.factor == null) {
    return 'このレンズの倍率が未実測です。広角に戻してからもう一度切り替えると自動で測ります（望遠は手入力も可）';
  }
  if ((currentGSD() ?? (liveActive() ? liveGSD() : null)) == null) return 'スケールを決めると mm で出ます（未入力でも px では出ます）';
  return 'σ を押すと実測します';
}

// ═══════════════════════════════════════════ ステップ状態

function updateSteps() {
  const n = state.files.length;
  // 写真が無くてもライブ中なら、いま映っているレンズと距離で分解能が出せる。
  // 出さないと「距離も焦点距離も入れたのに — のまま」になり、
  // その場で撮る意味があるかを撮る前に判断できない
  const gsd = currentGSD() ?? (liveActive() ? liveGSD() : null);
  const latest = state.files[n - 1];
  const cloudScale = cloudState.scale;

  setNote('note1', n ? `${n} 枚` : '2枚以上');
  setNote('note2', gsd ? `${gsd.toFixed(4)} mm/px` : 'mm換算に必要');
  setNote('note3', state.roi ? `${state.roi.width}×${state.roi.height} px` : '');

  // レールのドットは「使えるか」ではなく「良いか」。
  // 未評価（灰）と良好（緑）を区別する
  ready('photo', latest ? worse(verdictToLamp(latest.quality.verdict), focusLamp(latest)) : null);
  ready('scale', gsd != null ? 'good' : null);
  ready('cloud', cloudState.plane ? (cloudState.plane.inlierRatio < 0.6 ? 'warn' : 'good') : null);
  ready('analyze', state.roi ? 'good' : null);
  ready('result', state.measurement != null ? 'good' : null);
  // 比較のドットは写真（面内）と点群（面外）の悪い方
  ready('compare', worse(compareLamp(), cloudDiffLamp()));
  ready('history', historyLamp());
  renderLensBar();

  updateHud({
    frames: n,
    gsd,
    distanceM: cloudState.plane
      ? (cloudState.plane.viewpointDistance * cloudState.unit.scale) / 1000
      : (parseFloat($('distance').value) || null),
    obliquityDeg: cloudScale?.centre?.obliquityDeg ?? null,
    limitMM: state.limit?.mm ?? null,
    limitPx: state.limit?.px ?? null,
  });

  // 距離は点群からも手入力からも来る。押したときに値の出どころへ飛ばす
  routeHud('hudDistance', cloudState.plane ? 'cloud' : 'scale');

  $('vfEmpty').classList.toggle('hidden', n > 0);
  $('vfBadge').classList.toggle('hidden', n === 0);
  updateScopes();
  showHint();
}

/**
 * レンズ切替のピル（カメラアプリの 0.5 / 1× / 5× 相当）。
 * レンズが1つでズームも無い端末では出さない。計測中は触れない。
 * 望遠は分解能が焦点距離に比例して上がる（高所・遠方の主戦力）。
 * ズームはデジタルなので 2× までに絞り、その旨を出す。
 */
// なぞってズームした直後の click を段の選択と誤解しないための旗
let suppressClick = false;

function renderLensBar() {
  const bar = $('lensBar');
  if (!bar) return;
  if (!liveActive()) { bar.innerHTML = ''; bar.classList.add('hidden'); return; }
  const ls = lensState();
  const names = { ultra: '超広角', wide: '広角', tele: '望遠' };
  const fmt = (f) => (f < 1 ? f.toFixed(1) : (Math.round(f * 10) / 10).toString().replace(/\.0$/, '')) + '×';

  // ピルは**ネイティブのカメラと同じズーム段**にする（0.5× / 1× / 2× / 5×）。
  // レンズ本数とボタン数は一致しない: 2× は広角センサーの切り出しなので、
  // 物理レンズ3本に対してボタンは4つになる。
  //
  // ラベルの倍率と、mm 換算に使う焦点距離は別物として扱う。
  // ラベルは「どれを使っているか」を示すだけなので、焦点距離が未入力でも
  // 公称値（超広角 0.5×）で名乗ってよい。計算は focalOf() しか見ない。
  const NOMINAL = { ultra: 0.5, wide: 1, tele: null };
  const label = (kind, zoom) => {
    const measured = factorOf(kind);
    const v = measured != null ? measured * zoom
      : (NOMINAL[kind] != null ? NOMINAL[kind] * zoom : null);
    return v != null ? fmt(v) : names[kind];
  };

  const wide = ls.lenses.find((l) => l.kind === 'wide');
  const steps = [];
  for (const l of ls.lenses.filter((x) => x.kind === 'ultra')) {
    steps.push({ device: l.deviceId, kind: 'ultra', zoom: 1 });
  }
  if (wide) steps.push({ device: wide.deviceId, kind: 'wide', zoom: 1 });
  // センサークロップの 2×。48MP 機では分解能が実質的に上がるので出す
  if (wide && ls.zoom && ls.zoom.max >= 2) {
    steps.push({ device: wide.deviceId, kind: 'wide', zoom: 2 });
  }
  for (const l of ls.lenses.filter((x) => x.kind === 'tele')) {
    steps.push({ device: l.deviceId, kind: 'tele', zoom: 1 });
  }
  if (steps.length <= 1) { bar.innerHTML = ''; bar.classList.add('hidden'); return; }

  const nowZoom = ls.zoom?.value || 1;
  const items = steps.map((st, i) => {
    const on = st.device === ls.activeDeviceId && Math.abs(nowZoom - st.zoom) < 0.15;
    const text = label(st.kind, st.zoom);
    // 倍率が出せないレンズは名前だけ。「望遠 望遠」と重ねない
    const body = text === names[st.kind] ? text : `<small>${names[st.kind]}</small>${text}`;
    return `<button class="lens${on ? ' on' : ''}" data-step="${i}"`
      + ` data-device="${st.device}" data-zoom="${st.zoom}">${body}</button>`;
  });

  // 「いま何で撮っているか」は一行。焦点距離が無いことは、ここでは責めない
  // （mm が要るのは σ を出すときで、それは HUD の分解能とヒントが受け持つ）
  const m = lensMultiplierNow();
  const activeLabel = label(ls.activeKind, nowZoom);
  // 倍率が出せないレンズでも、ズーム中ならその値は出す（画角の手がかりを落とさない）
  const shown = activeLabel !== names[ls.activeKind] ? ` ${activeLabel}`
    : (nowZoom > 1.02 ? ` ズーム ${fmt(nowZoom)}` : '');
  const caption = `使用中 <b>${names[ls.activeKind]}${shown}</b>`
    + (m.focal > 0
      ? ` <span class="mono">${(m.focal * nowZoom).toFixed(0)}mm</span>`
      : ' <button class="lens-fix" data-open-scale>mm 未設定</button>');

  bar.innerHTML = `<div class="lens-caption">${caption}</div>`
    + `<div class="lens-pills">${items.join('')}</div>`;
  bar.classList.remove('hidden');

  bar.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', async () => {
    if (suppressClick) { suppressClick = false; return; }
    const dev = b.dataset.device;
    const z = Number(b.dataset.zoom) || 1;
    try {
      if (dev !== lensState().activeDeviceId) await switchLens(dev);
      setZoom(z);
    } catch (e) {
      setViewfinderHint(`レンズを切り替えられません: ${e.message}`, 'warn');
    }
  }));
  bar.querySelector('[data-open-scale]')?.addEventListener('click', () => openSheet('scale'));
}

// ═══════════════════════════════════════════ 連続ズーム（ピンチ・ダイヤル）
//
// 段のボタンだけでは画角を追い込めない。端末のカメラと同じく、
// 映像をピンチ、ピルの帯を横になぞる、の2通りで連続的に変えられるようにする。
//
// 計測への影響: 拡大しても画素数は変わらないので、実際の情報が増えるのは
// センサーを切り出せる範囲まで。それを超えると画が甘くなるが、σ は実測なので
// 甘くなったぶん σ(px) も比例して大きくなり、mm 換算した最終値は変わらない。
// 変わるのは画角だけ。ただし**縮尺は変わる**ので、計測中の変更は必ず弾く。

/** 段の近くでは吸い付かせる（端末のカメラと同じ感触にする） */
function snapZoom(z, max) {
  for (const step of [1, 2, 3, 5, max]) {
    if (step > 0 && Math.abs(z - step) / step < 0.04) return step;
  }
  return Math.round(z * 100) / 100;
}

function zoomBounds() {
  const zr = lensState().zoom;
  return zr ? { min: zr.min || 1, max: zr.max } : null;
}

/** ズームを相対倍率で動かす。計測中は理由を出して断る */
function applyRelativeZoom(base, ratio) {
  const b = zoomBounds();
  if (!b) return;
  if (sessionActive()) {
    setViewfinderHint('計測中はズームを変えられません（縮尺が変わるため）。停止してから', 'warn');
    return;
  }
  const z = snapZoom(Math.max(b.min, Math.min(b.max, base * ratio)), b.max);
  requestZoom(z);
}

function initZoomGestures() {
  const vf = $('viewfinder');
  if (!vf) return;

  // iOS Safari はピンチを gesture* で出す。preventDefault しないと頁が拡大する
  let gestureBase = 1;
  vf.addEventListener('gesturestart', (e) => {
    if (!liveActive()) return;
    e.preventDefault();
    gestureBase = currentZoomValue();
  });
  vf.addEventListener('gesturechange', (e) => {
    if (!liveActive()) return;
    e.preventDefault();
    applyRelativeZoom(gestureBase, e.scale);
  });
  vf.addEventListener('gestureend', (e) => { if (liveActive()) e.preventDefault(); });

  // gesture* を出さない環境（Android・PC）用に、2本指の距離から自前で作る
  const points = new Map();
  let pinchStart = null;
  const spread = () => {
    const [a, b] = [...points.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  vf.addEventListener('pointerdown', (e) => {
    if (!liveActive() || e.pointerType === 'mouse') return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 2) pinchStart = { dist: spread(), zoom: currentZoomValue() };
  });
  vf.addEventListener('pointermove', (e) => {
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 2 && pinchStart && pinchStart.dist > 0) {
      e.preventDefault();
      applyRelativeZoom(pinchStart.zoom, spread() / pinchStart.dist);
    }
  });
  const drop = (e) => {
    points.delete(e.pointerId);
    if (points.size < 2) pinchStart = null;
  };
  vf.addEventListener('pointerup', drop);
  vf.addEventListener('pointercancel', drop);

  // ピルの帯を横になぞるとダイヤルになる（端末のカメラの長押しズームに相当）。
  // ズームのたびに帯の中身は差し替わるので、handler は差し替わらない #lensBar に付ける。
  // 内側に付けると、最初のズームで要素ごと消えて操作が切れる
  const bar = $('lensBar');
  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (!liveActive() || !lensState().zoom) return;
    if (e.pointerType === 'mouse' && e.buttons !== 1) return;
    drag = { x: e.clientX, zoom: currentZoomValue(), moved: false };
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    // 8px 未満の動きはタップ扱い。段の選択と両立させる
    if (!drag.moved && Math.abs(dx) < 8) return;
    if (!drag.moved) bar.setPointerCapture?.(e.pointerId);
    drag.moved = true;
    // 帯の幅ぶんなぞって約 2.7 倍。指の動きに対して素直な感触になる
    applyRelativeZoom(drag.zoom, Math.exp(dx / 160));
  });
  const endDrag = () => { if (drag?.moved) suppressClick = true; drag = null; };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
}

function setNote(id, text) {
  const el = $(id);
  if (el && text !== undefined) el.textContent = text;
}

function ready(name, state) {
  const el = $(`rail-${name}`);
  if (el) el.dataset.ready = state ?? 'idle';
}

/** 悪い方を採る。良否をまとめるときは必ず悪い側に寄せる。 */
function worse(a, b) {
  const rank = { bad: 3, warn: 2, good: 1 };
  if (!a) return b ?? null;
  if (!b) return a;
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b;
}

function verdictToLamp(verdict) {
  return verdict === 'good' ? 'good' : verdict === 'fair' ? 'warn' : 'bad';
}

/**
 * ピントのランプ。
 * 絶対値はレンズと被写体で変わるので、セッション内の中央値と比べて判定する。
 */
function focusLamp(file) {
  const values = state.files.map((f) => f.focus).filter((v) => isFinite(v)).sort((a, b) => a - b);
  if (!values.length) return null;
  const median = values[values.length >> 1];
  if (!(median > 0)) return 'bad';
  const ratio = file.focus / median;
  return ratio < 0.6 ? 'bad' : ratio < 0.85 ? 'warn' : 'good';
}

function historyLamp() {
  const h = historySummary();
  if (!h.stationCount) return null;
  if (h.significant == null) return 'warn';
  return h.significant ? 'bad' : 'good';
}

/**
 * スコープ帯。カメラのヒストグラム・音声メーターに相当する常時表示。
 * ここに出るのは「撮り直すべきか」「有意か」だけに絞る。
 */
function updateScopes() {
  // 最後の1枚ではなく**一番悪い1枚**を出す。
  // 1枚でもピントが外れていればセッション全体の σ が悪化するので、
  // 平均や最新では見逃す
  const worstPhoto = pickWorstPhoto();

  if (worstPhoto) {
    const { file, index, lamp } = worstPhoto;
    // MIG は 0.02 も出れば十分。そこを満点として目盛る
    setBar('barTexture', file.quality.mig / 0.02, verdictToLamp(file.quality.verdict));
    setBar('barFocus', file.focus / 0.35, focusLamp(file));
    $('scopeQualityNote').textContent = lamp === 'good'
      ? `${state.files.length} 枚とも良好`
      : `${index === 0 ? '基準' : `${index} 枚目`}が最も悪い — ${file.quality.reason}`;
  } else {
    setBar('barTexture', 0, null);
    setBar('barFocus', 0, null);
    $('scopeQualityNote').textContent = '写真を読み込むと判定します';
  }

  const limit = state.limit;
  $('scopeLimit').textContent = limit
    ? `${limit.mm != null ? limit.mm.toFixed(4) : limit.px.toFixed(3)}`
    : '—';
  $('scopeLimitNote').textContent = limit
    ? `${limit.mm != null ? 'mm' : 'px'}・${limit.frames} 枚平均・${limit.method}`
    : 'σ を実測してください';

  const h = historySummary();
  // 「測っていない」を「差なし」に見せない。測点が無いうちは項目ごと出さない
  $('scopeHistory')?.classList.toggle('hidden', !h.stationCount);
  $('scopeDelta').textContent = h.deltaMM != null
    ? `${h.deltaMM > 0 ? '+' : ''}${h.deltaMM.toFixed(4)}`
    : '—';
  $('scopeDeltaNote').textContent = h.note;
}

/** セッション中で最も悪い1枚。良否は「模様」と「ピント」の悪い方で決める。 */
function pickWorstPhoto() {
  if (!state.files.length) return null;
  const rank = { bad: 3, warn: 2, good: 1 };
  let best = null;
  state.files.forEach((file, index) => {
    const lamp = worse(verdictToLamp(file.quality.verdict), focusLamp(file));
    if (!best || (rank[lamp] ?? 0) > (rank[best.lamp] ?? 0)) best = { file, index, lamp };
  });
  return best;
}

function setBar(id, fraction, lamp) {
  const el = $(id);
  if (!el) return;
  el.style.width = `${Math.max(0, Math.min(1, fraction || 0)) * 100}%`;
  el.className = lamp === 'bad' ? 'bad' : lamp === 'warn' ? 'warn' : '';
}

// ═══════════════════════════════════════════ スケール

function setupScale() {
  const exif = state.files[0].exif ?? {};
  if (exif.focalLength35mm && !$('focal35').value) $('focal35').value = exif.focalLength35mm;
  updateGSD();
}

for (const id of ['distance', 'focal35', 'referenceLength', 'focalTele', 'focalUltra']) {
  $(id).addEventListener('input', () => { refreshCloudScale(); updateGSD(); });
}
$('referencePair').addEventListener('change', updateGSD);

function currentGSD() {
  if (!state.files.length) return null;
  // 既知の基準距離があればそちらを優先する。
  // レーザー距離計も焦点距離も要らず、印刷倍率やレンズの個体差も吸収できるため。
  const referenceMM = parseFloat($('referenceLength').value);
  const referencePx = parseFloat($('referencePair').value);
  if (referenceMM > 0 && referencePx > 0) return referenceMM / referencePx;

  // 次に点群。距離だけでなく斜角も入るので、距離計＋焦点距離より確か。
  const fromCloud = cloudGSD();
  if (fromCloud > 0) return fromCloud;

  const distance = parseFloat($('distance').value);
  const focal35 = effectiveFocal35();
  if (!(distance > 0) || !(focal35 > 0)) return null;
  const focalPx = focalLengthPxFrom35mm({
    focal35mm: focal35,
    imageWidthPx: Math.max(state.files[0].imageData.width, state.files[0].imageData.height),
  });
  return computeGSD({ distanceM: distance, focalLengthPx: focalPx });
}

/**
 * 35mm換算焦点距離の実効値。
 * EXIF 付きの写真は入力値そのまま。ライブ計測のフレームは撮ったレンズの倍率と
 * ズームを掛ける（スケールシートの焦点距離は広角 1× の値として扱う）。
 * 望遠の倍率は API から取れないので、スケールシートで一度入れてもらう。
 */
function effectiveFocal35() {
  const base = parseFloat($('focal35').value);
  const m = state.lensMultiplier;
  // 写真（EXIF あり）は入力値そのまま。ライブのフレームは撮ったレンズの
  // 焦点距離 × デジタルズーム（2× は広角センサーの切り出しなので焦点距離2倍と同じ）
  if (!m) return base > 0 ? base : null;
  return m.focal > 0 ? m.focal * (m.zoom || 1) : null;
}

/** ライブ映像の GSD。距離 × 焦点距離（いまのレンズ・ズーム）だけで決める。 */
function liveGSD() {
  const video = document.getElementById('liveVideo');
  if (!video || !(video.videoWidth > 0)) return null;
  const distance = parseFloat($('distance').value);
  const m = lensMultiplierNow();
  if (!(distance > 0) || !(m.focal > 0)) return null;
  const focalPx = focalLengthPxFrom35mm({
    focal35mm: m.focal * (m.zoom || 1),
    imageWidthPx: Math.max(video.videoWidth, video.videoHeight),
  });
  return computeGSD({ distanceM: distance, focalLengthPx: focalPx });
}

/**
 * レンズごとの 35mm 換算焦点距離[mm]。倍率を推し量るのではなく、
 * メーカーが公表している数値をそのまま使う。mm/px は結局これだけで決まる。
 */
function focalOf(kind) {
  const id = kind === 'tele' ? 'focalTele' : kind === 'ultra' ? 'focalUltra' : 'focal35';
  const f = parseFloat($(id).value);
  return f > 0 ? f : null;
}

/** 表示用の倍率（広角比）。広角の値が無ければ出さない。 */
function factorOf(kind) {
  const f = focalOf(kind);
  const wide = focalOf('wide');
  if (!(f > 0) || !(wide > 0)) return kind === 'wide' && f > 0 ? 1 : null;
  return f / wide;
}

/** いまのレンズの状態。焦点距離が未入力なら null（mm が出ず、その理由を出す）。 */
function lensMultiplierNow() {
  const ls = lensState();
  const zoom = ls.zoom?.value || 1;
  return { kind: ls.activeKind, focal: focalOf(ls.activeKind), factor: factorOf(ls.activeKind), zoom };
}

function updateGSD() {
  const gsd = currentGSD();
  $('gsd').value = gsd ? `${gsd.toFixed(4)} mm/px` : '';
  // どれを採用したかを必ず出す。3通りあるので、黙って切り替わると事故になる
  $('gsdSource').textContent = gsd ? `採用: ${gsdSourceName()}` : '';
  updateSteps();
  renderQuickCheck();
}

function gsdSourceName() {
  const referenceMM = parseFloat($('referenceLength').value);
  const referencePx = parseFloat($('referencePair').value);
  if (referenceMM > 0 && referencePx > 0) return '既知の基準距離';
  if (cloudGSD() > 0) return '点群（斜め補正あり）';
  return '撮影距離 × 焦点距離';
}

/**
 * 点群パネルに渡すカメラ内部パラメータ。
 * 焦点距離は EXIF（または手入力）由来なので、写真が無い間は null を返す。
 */
function cameraIntrinsicsFor(width, height) {
  const focal35 = effectiveFocal35();
  if (!(focal35 > 0) || !(width > 0) || !(height > 0)) return null;
  const focalLengthPx = focalLengthPxFrom35mm({
    focal35mm: focal35,
    imageWidthPx: Math.max(width, height),
  });
  if (!(focalLengthPx > 0)) return null;
  return { focalLengthPx, cx: width / 2, cy: height / 2, width, height };
}

function cameraIntrinsics() {
  if (!state.files.length) return null;
  const { width, height } = state.files[0].imageData;
  return cameraIntrinsicsFor(width, height);
}

initCloudPanel({
  getIntrinsics: cameraIntrinsics,
  onChange: updateGSD,
});

// 経時管理は解析結果を受け取るだけで、解析には関与しない
initHistoryPanel({
  getMeasurement: () => state.measurement ?? null,
  onChange: updateSteps,
});

initComparePanel({
  getFrames: () => state.files,
  getGsd: () => currentGSD(),
  getRoi: () => state.roi,
  getLens: () => lensForCurrentPhotos(),
  // 2時期比較で出た亀裂の開口を、σ 実測の結果と同じ棚に置く。
  // 経時管理はここから拾うだけで、比較の中身には関与しない
  onMeasurement: (m) => {
    state.measurement = { ...m, at: exifDateISO(m.atExif) ?? new Date().toISOString() };
    refreshHistoryPanel();
    updateSteps();
  },
  // 視差補正の材料。基準画像は今回の写真と画素数が違うことがあるので、
  // 内部パラメータはそのつど基準画像の寸法で組み直す
  getSurface: (width, height) => {
    const { plane, camera, map, unit } = cloudState;
    if (!plane || !camera || !map || !unit) return null;
    const intrinsics = cameraIntrinsicsFor(width, height);
    if (!intrinsics) return null;
    return {
      camera, plane, intrinsics,
      unitScaleToMM: unit.scale,
      heightAt: (p) => sampleOutOfPlane(map, p[0], p[1], p[2]),
    };
  },
  onChange: updateSteps,
});

// ═══════════════════════════════════════════ レンズ校正
//
// 完全なカメラ校正はしない。焦点距離は仕様値で分かっており、主点は中心でよい。
// ホモグラフィで吸えない放射歪みだけを、平面格子の1枚から実測する。
const CALIB_KEY = 'lens-distortion';
const CALIB_COLS = 7;
const CALIB_ROWS = 5;

function loadCalibrations() {
  try { return JSON.parse(localStorage.getItem(CALIB_KEY)) || {}; } catch { return {}; }
}
function saveCalibrations(all) {
  try { localStorage.setItem(CALIB_KEY, JSON.stringify(all)); } catch { /* 記憶できないだけ */ }
}

/**
 * いま解析している写真に対応するレンズの校正を返す。
 * 焦点距離がいちばん近いレンズのものを採る。判定できなければ補正しない
 *（間違った補正は無補正より悪い。誤った係数を当てると偽陽性は減らない）。
 */
function lensForCurrentPhotos() {
  const all = loadCalibrations();
  if (!Object.keys(all).length) return null;
  const focal = effectiveFocal35() ?? parseFloat($('focal35').value);
  if (!(focal > 0)) return null;
  let best = null;
  for (const kind of ['ultra', 'wide', 'tele']) {
    const f = focalOf(kind);
    if (!(f > 0) || !all[kind]) continue;
    const d = Math.abs(Math.log(focal / f));
    if (!best || d < best.d) best = { d, kind, cal: all[kind] };
  }
  // 焦点距離が 15% 以上違うなら、そのレンズの校正ではない
  if (!best || best.d > 0.14) return null;
  return isIdentity(best.cal) ? null : best.cal;
}

function renderCalibStatus(message) {
  const kind = $('calibLens').value;
  const cal = loadCalibrations()[kind];
  const names = { ultra: '超広角', wide: '広角', tele: '望遠' };
  const stored = cal
    ? `<div class="banner good"><div><b>${names[kind]}の校正あり</b><br>`
      + `k1 <span class="mono">${cal.k1.toFixed(4)}</span>`
      + ` / k2 <span class="mono">${cal.k2.toFixed(4)}</span>　`
      + `残差 <span class="mono">${cal.rmsBeforePx.toFixed(2)} → ${cal.rmsPx.toFixed(3)} px</span>`
      + `（${cal.points} 点・${cal.views} 枚）</div></div>`
    : `<div class="banner"><div>${names[kind]}は未校正です。校正シートを撮って読み込んでください。</div></div>`;
  $('calibStatus').innerHTML = (message ?? '') + stored;
}

$('calibLens').addEventListener('change', () => renderCalibStatus());
$('calibLoad').addEventListener('click', () => $('calibInput').click());
$('calibClear').addEventListener('click', () => {
  const all = loadCalibrations();
  delete all[$('calibLens').value];
  saveCalibrations(all);
  renderCalibStatus();
  updateSteps();
});

$('calibInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const kind = $('calibLens').value;
  renderCalibStatus('<p class="note">解析中…</p>');
  await tick();

  const views = [];
  const problems = [];
  let frame = null;
  for (const [i, file] of files.entries()) {
    try {
      const image = await decodeFile(file);
      // k1 は半対角で正規化しているので、縮小画像で測っても同じ値になる。
      // 全解像度で探すと点が大きすぎて検出の想定半径から外れる
      const factor = Math.max(1, Math.round(image.width / 1100));
      const gray = downsample(toGray(image, null, 'luma', true), factor);
      frame = { width: gray.width, height: gray.height };
      const found = detectTargets(gray, {
        minRadius: 6, maxRadius: 60, backgroundRadius: 70, darkTargets: true,
      });
      // 大きい順に並んでいる。用紙の文字より点のほうがずっと大きいので上位を採る
      const ord = orderGrid(found.slice(0, CALIB_COLS * CALIB_ROWS), CALIB_COLS, CALIB_ROWS);
      if (!ord.ok) { problems.push(`${file.name}: ${ord.reason}`); continue; }
      views.push({ observed: ord.points, world: gridWorld(CALIB_COLS, CALIB_ROWS) });
    } catch (err) {
      problems.push(`${file.name}: ${err.message}`);
    }
    await tick();
  }

  if (!views.length) {
    renderCalibStatus(`<div class="banner bad"><div><b>読み込めませんでした</b><br>`
      + `${problems.map(escapeHtml).join('<br>')}</div></div>`);
    return;
  }
  const est = estimateDistortion(views, frame);
  if (!est) {
    renderCalibStatus('<div class="banner bad"><div><b>推定できませんでした</b></div></div>');
    return;
  }
  const all = loadCalibrations();
  all[kind] = { ...est, views: views.length, at: new Date().toISOString() };
  saveCalibrations(all);
  renderCalibStatus(problems.length
    ? `<div class="banner warn"><div>${problems.length} 枚は使えませんでした<br>`
      + `${problems.map(escapeHtml).join('<br>')}</div></div>`
    : '');
  updateSteps();
});

renderCalibStatus();

initCloudDiffPanel({
  onChange: updateSteps,
});

initCapturePanel({
  setFrames: setLiveFrames,
  runAnalysis: runMeasurement,
  // ライブ中は「いま映っているレンズ」の GSD。currentGSD() は前回読み込んだ写真セットの
  // レンズで計算するので、望遠→広角と切り替えた直後の限界表示が倍率ぶん狂う
  getGsd: () => (liveActive() ? liveGSD() : currentGSD()),
  onStateChange: updateSteps,
  // ライブ中はスコープ帯をライブ映像の判定で上書きする
  onLiveQuality: ({ quality, focus }) => {
    setBar('barTexture', quality.mig / 0.02, verdictToLamp(quality.verdict));
    setBar('barFocus', focus / 0.35, quality.verdict === 'poor' ? 'bad' : 'good');
    $('scopeQualityNote').textContent = `ライブ — ${quality.reason}`;
  },
  onLiveStatus: (text, kind) => setViewfinderHint(text, kind === 'good' ? 'info' : kind),
});

// 計測後に「基準として保存」。次回はフォルダ読み込みなしで比較できる
$('baselineSaveBtn').addEventListener('click', async () => {
  const name = $('baselineName').value.trim();
  if (!name) { $('baselineName').focus(); return; }
  if (!state.files.length) return;
  try {
    await saveBaseline(name, state.files.map((f) => f.file), {
      gsd: currentGSD(),
      focal35: parseFloat($('focal35').value) || null,
      distanceM: parseFloat($('distance').value) || null,
      capturedAt: new Date().toISOString(),
      // 亀裂測点の線（基準画像の画素座標）。次回の比較で同じ線が自動で使われる
      cracks: state.cracks.map((c) => ({ ...c })),
      roi: state.roi ? { ...state.roi } : null,
      subsetHalf: clampInt($('subsetHalf').value, 5, 60, 15),
    });
    $('baselineSaveBtn').textContent = '保存しました';
    setTimeout(() => { $('baselineSaveBtn').textContent = '保存'; }, 1800);
    refreshSavedBaselines();
  } catch (err) {
    setViewfinderHint(`保存できませんでした: ${err.message}`, 'warn');
  }
});

// スケール入力は端末に記憶する。毎回同じ機材なら、二度目からは入力なしで mm が出る
const SCALE_KEY = 'sigma-scale-inputs';
try {
  const saved = JSON.parse(localStorage.getItem(SCALE_KEY)) || {};
  for (const id of ['distance', 'focal35', 'referenceLength', 'focalTele', 'focalUltra']) {
    if (saved[id] && !$(id).value) $(id).value = saved[id];
  }
} catch { /* プライベートモード等では記憶しないだけ */ }
for (const id of ['distance', 'focal35', 'referenceLength', 'focalTele', 'focalUltra']) {
  $(id).addEventListener('input', () => {
    try {
      const saved = JSON.parse(localStorage.getItem(SCALE_KEY)) || {};
      saved[id] = $(id).value;
      localStorage.setItem(SCALE_KEY, JSON.stringify(saved));
    } catch { /* 同上 */ }
  });
}

// 仕様値をまとめて入れる。推測しないための入り口で、値の出どころは Apple の公表値
// 焦点距離を EXIF から取り込む。仕様値は写真に書いてあるので、打ち込ませない。
// どのレンズで撮るかは人が選ぶ（ネイティブのカメラで倍率を切り替えてもらう）。
// 値からレンズ種別を推測すると、2× の切り出し（48mm）を望遠と取り違える
let grabTarget = null;
for (const btn of document.querySelectorAll('[data-grab]')) {
  btn.addEventListener('click', () => {
    grabTarget = { id: btn.dataset.grab, name: btn.dataset.grabName };
    $('focalGrabNote').textContent = `${grabTarget.name} に切り替えて1枚撮ってください。`;
    $('focalInput').click();
  });
}
$('focalInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !grabTarget) return;
  try {
    const exif = parseExif(await file.arrayBuffer());
    const f = exif?.focalLength35mm;
    if (!(f > 0)) {
      $('focalGrabNote').textContent = 'この写真には 35mm 換算焦点距離が入っていませんでした。手で入れてください。';
      return;
    }
    $(grabTarget.id).value = f;
    $(grabTarget.id).dispatchEvent(new Event('input', { bubbles: true }));
    $('focalGrabNote').textContent = `${grabTarget.name} に ${f}mm を取り込みました。`;
    updateGSD();
  } catch (err) {
    $('focalGrabNote').textContent = `読み取れませんでした: ${err.message}`;
  }
});

$('presetIphone16Pro').addEventListener('click', () => {
  const preset = { focal35: '24', focalTele: '120', focalUltra: '13' };
  for (const [id, v] of Object.entries(preset)) {
    $(id).value = v;
    $(id).dispatchEvent(new Event('input', { bubbles: true }));
  }
  updateGSD();
});

initZoomGestures();
initShell();
updateSteps();

// ── 版とエラーを画面に出す。iPhone には開発者ツールが無いので、黙って死ぬのが最悪
$('appVersion').textContent = APP_VERSION;
$('hudVersion').textContent = APP_VERSION;
$('diagVersion').textContent = `版 ${APP_VERSION}`;
// HUD の版を押すと診断情報を開いた状態で写真シートへ
$('hudVersion').closest('button').addEventListener('click', () => { $('diagBody').closest('details').open = true; });
// 更新の再読み込み直後なら、何が起きたかを一言出す（黙って画面が変わるのは不親切）
try {
  if (sessionStorage.getItem('sw-updated') === '1') {
    sessionStorage.removeItem('sw-updated');
    setTimeout(() => setViewfinderHint(`${APP_VERSION} に更新しました`, 'info'), 1200);
  }
} catch { /* 記憶なし */ }
const diagLog = [];
function noteError(kind, message) {
  const line = `${new Date().toISOString().slice(11, 19)} ${kind}: ${message}`;
  diagLog.push(line);
  if (diagLog.length > 8) diagLog.shift();
  setViewfinderHint(`エラー: ${String(message).slice(0, 120)}`, 'bad');
  renderDiagnostics();
}
window.addEventListener('error', (e) => noteError('error', e.message || e.type));
window.addEventListener('unhandledrejection', (e) => noteError('promise', e.reason?.message ?? String(e.reason)));

function renderDiagnostics() {
  const el = $('diagBody');
  if (!el) return;
  const ls = liveActive() ? lensState() : null;
  const lines = [
    `版 ${APP_VERSION}`,
    `UA ${navigator.userAgent}`,
    `画面 ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}`,
    `ライブ ${liveActive() ? 'on' : 'off'}`,
    ...(ls ? [
      `レンズ ${ls.lenses.length}: ${ls.lenses.map((l) => `${l.kind}「${l.label || '(無名)'}」`).join(' / ')}`,
      `使用中 ${ls.activeKind} 焦点距離 ${focalOf(ls.activeKind) ?? '未入力'}mm ズーム ${ls.zoom ? `${ls.zoom.value} (最大 ${ls.zoom.max})` : '非対応'}`,
      `映像 ${document.getElementById('liveVideo')?.videoWidth ?? 0}×${document.getElementById('liveVideo')?.videoHeight ?? 0}`,
    ] : []),
    `写真 ${state.files.length} 枚 / 焦点距離 ${effectiveFocal35() ?? '—'} / GSD ${currentGSD()?.toFixed(4) ?? '—'}`,
    ...(diagLog.length ? ['直近のエラー:', ...diagLog] : ['エラーなし']),
  ];
  el.textContent = lines.join('\n');
}
$('diagRefresh').addEventListener('click', renderDiagnostics);
$('diagCopy').addEventListener('click', async () => {
  renderDiagnostics();
  try {
    await navigator.clipboard.writeText($('diagBody').textContent);
    $('diagCopy').textContent = 'コピーしました';
    setTimeout(() => { $('diagCopy').textContent = 'コピー'; }, 1500);
  } catch { $('diagCopy').textContent = '長押しで選択してコピー'; }
});
renderDiagnostics();

// カメラアプリなので起動＝ファインダー。許可が無い・カメラが無い端末では
// 黙って従来の空画面に落ち、◉ から手で起こせる
async function autoStartLive() {
  if (!navigator.mediaDevices?.getUserMedia || liveActive() || state.files.length) return;
  try {
    await toggleLive();
    setViewfinderHint('σ を押すと自動で撮り続け、収束したら止まります', 'info');
  } catch {
    setViewfinderHint('カメラを使うには ◉ を押して許可してください。写真の読み込みは右の「写真」から', 'info');
  }
}
autoStartLive();

// 裏に回ったらカメラを止める（電池）。戻ってきたら、写真を読み込んでいなければ再開。
// 計測中でも止める。裏では映像が最後の1枚で止まったまま撮り続けて、同じ画が
// 何枚も積まれ、σ がありえないほど小さく出る
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (liveActive()) stopLive(); }
  else autoStartLive();
});

// 画面の向きが変わるとビューファインダーの実寸が変わる。ROI の枠を置き直す
window.addEventListener('shell:resize', () => { if (state.roi) setRoi(state.roi); renderCrackLayer(); });

// ═══════════════════════════════════════════ 解析範囲

function setupPreview() {
  const { imageData } = state.files[0];
  const preview = makePreviewCanvas(imageData, 880);
  state.preview = preview;
  const container = $('preview');
  container.querySelectorAll('canvas').forEach((c) => c.remove());
  container.insertBefore(preview.canvas, $('roiBox'));

  // 線は前の写真の座標なので、写真が替わったら捨てる
  state.cracks = [];
  state.crackPairs = [];
  renderCrackLayer();
  renderCrackList();

  const side = Math.round(Math.min(imageData.width, imageData.height) * 0.6);
  setRoi({
    x: Math.round((imageData.width - side) / 2),
    y: Math.round((imageData.height - side) / 2),
    width: side, height: side,
  });

  let dragStart = null;
  let dragCur = null;
  preview.canvas.addEventListener('pointerdown', (e) => {
    const rect = preview.canvas.getBoundingClientRect();
    dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragCur = dragStart;
    preview.canvas.setPointerCapture(e.pointerId);
  });
  preview.canvas.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const rect = preview.canvas.getBoundingClientRect();
    const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragCur = cur;
    const toImage = (preview.canvas.width / rect.width) / preview.scale;
    if (state.drawMode === 'crack') {
      renderCrackLayer({
        x1: dragStart.x * toImage, y1: dragStart.y * toImage,
        x2: cur.x * toImage, y2: cur.y * toImage,
      });
      return;
    }
    setRoi({
      x: Math.min(dragStart.x, cur.x) * toImage,
      y: Math.min(dragStart.y, cur.y) * toImage,
      width: Math.abs(cur.x - dragStart.x) * toImage,
      height: Math.abs(cur.y - dragStart.y) * toImage,
    });
  });
  preview.canvas.addEventListener('pointerup', () => {
    if (dragStart && dragCur && state.drawMode === 'crack') {
      const rect = preview.canvas.getBoundingClientRect();
      const toImage = (preview.canvas.width / rect.width) / preview.scale;
      const line = {
        x1: dragStart.x * toImage, y1: dragStart.y * toImage,
        x2: dragCur.x * toImage, y2: dragCur.y * toImage,
      };
      // 短すぎる線はタップの誤りとみなす
      if (Math.hypot(line.x2 - line.x1, line.y2 - line.y1) >= 40) {
        addCrack(line);
      } else {
        renderCrackLayer();
      }
    }
    dragStart = null;
    dragCur = null;
    updateSteps();
  });
}

$('roiCenter').addEventListener('click', () => {
  if (!state.files.length) return;
  const { imageData } = state.files[0];
  const side = Math.round(Math.min(imageData.width, imageData.height) * 0.6);
  setRoi({
    x: Math.round((imageData.width - side) / 2),
    y: Math.round((imageData.height - side) / 2),
    width: side, height: side,
  });
  closeSheet();
  updateSteps();
});

$('roiFull').addEventListener('click', () => {
  if (!state.files.length) return;
  const { imageData } = state.files[0];
  setRoi({ x: 0, y: 0, width: imageData.width, height: imageData.height });
  closeSheet();
  updateSteps();
});

function setRoi(roi) {
  const { imageData } = state.files[0];
  const clamped = clampRegion(roi, imageData.width, imageData.height);
  if (clamped.width < 80 || clamped.height < 80) return;
  state.roi = clamped;

  const rect = state.preview.canvas.getBoundingClientRect();
  const displayScale = (rect.width / state.preview.canvas.width) * state.preview.scale;
  const box = $('roiBox');
  box.style.display = 'block';
  box.style.left = `${clamped.x * displayScale}px`;
  box.style.top = `${clamped.y * displayScale}px`;
  box.style.width = `${clamped.width * displayScale}px`;
  box.style.height = `${clamped.height * displayScale}px`;
}

// ═══════════════════════════════════════════ 亀裂測点

/** パッチの寸法。線をまたぐサブセットは使わないので、margin はサブセット半径より広く */
function crackPatchOptions() {
  const subsetHalf = clampInt($('subsetHalf').value, 5, 60, 15);
  const step = clampInt($('step').value, 8, 200, 25);
  return { margin: subsetHalf + 5, depth: step * 4 };
}

function nextCrackLabel() {
  const used = new Set(state.cracks.map((c) => c.label));
  for (const ch of 'ABCDEFGHJKLMNPQRSTUVWXYZ') if (!used.has(ch)) return ch;
  return `L${state.cracks.length + 1}`;
}

function addCrack(line) {
  if (!state.files.length) return;
  const { imageData } = state.files[0];
  const clamp = (v, hi) => Math.max(0, Math.min(hi, Math.round(v)));
  state.cracks.push({
    label: nextCrackLabel(),
    x1: clamp(line.x1, imageData.width - 1), y1: clamp(line.y1, imageData.height - 1),
    x2: clamp(line.x2, imageData.width - 1), y2: clamp(line.y2, imageData.height - 1),
  });
  state.crackPairs = [];
  renderCrackLayer();
  renderCrackList();
  const f = crackFrame(state.cracks[state.cracks.length - 1]);
  setViewfinderHint(`亀裂 ${state.cracks[state.cracks.length - 1].label}（${f?.orientation ?? ''}）を引きました。`
    + '続けて引けます。終わったら方式シートの「亀裂を引く」をもう一度押してください', 'info');
}

function setCrackDrawMode(on) {
  state.drawMode = on ? 'crack' : 'roi';
  const btn = $('crackDrawToggle');
  if (btn) {
    btn.dataset.on = on ? '1' : '0';
    btn.textContent = on ? '亀裂を引く（終了）' : '亀裂を引く';
  }
  document.body.classList.toggle('crack-draw', on);
  if (on) {
    setViewfinderHint('亀裂に沿ってドラッグして線を引いてください（解析範囲の中に）', 'info');
  } else {
    setViewfinderHint('ドラッグで解析範囲を選べます', 'info');
  }
}

/** ビューファインダー上の線とパッチ。draft は引いている途中の線 */
function renderCrackLayer(draft = null) {
  const layer = $('crackLayer');
  if (!layer) return;
  if (!state.preview || !state.files.length) { layer.innerHTML = ''; return; }
  const rect = state.preview.canvas.getBoundingClientRect();
  if (!(rect.width > 0)) { layer.innerHTML = ''; return; }
  // 画像座標 → 表示座標
  const k = (rect.width / state.preview.canvas.width) * state.preview.scale;
  layer.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  const opts = crackPatchOptions();
  const px = (v) => (v * k).toFixed(1);
  const parts = [];
  for (const c of state.cracks) {
    const p = crackPatches(c, opts);
    if (!p) continue;
    const poly = (pts) => pts.map(([x, y]) => `${px(x)},${px(y)}`).join(' ');
    parts.push(`<polygon class="ck-patch" points="${poly(p.side1)}"/>`);
    parts.push(`<polygon class="ck-patch" points="${poly(p.side2)}"/>`);
    parts.push(`<line class="ck-line" x1="${px(c.x1)}" y1="${px(c.y1)}" x2="${px(c.x2)}" y2="${px(c.y2)}"/>`);
    parts.push(`<text class="ck-label" x="${(Number(px(c.x1)) + 6).toFixed(1)}" y="${(Number(px(c.y1)) - 6).toFixed(1)}">${escapeHtml(c.label)}</text>`);
  }
  if (draft) {
    parts.push(`<line class="ck-draft" x1="${px(draft.x1)}" y1="${px(draft.y1)}" x2="${px(draft.x2)}" y2="${px(draft.y2)}"/>`);
  }
  layer.innerHTML = parts.join('');
}

/** 方式シートの一覧 */
function renderCrackList() {
  const el = $('crackList');
  if (!el) return;
  if (!state.cracks.length) {
    el.innerHTML = '<p class="note" style="margin:4px 0 0">線はまだありません。</p>';
    return;
  }
  el.innerHTML = state.cracks.map((c, i) => {
    const f = crackFrame(c);
    return `<div class="ck-row"><span class="ck-sw"></span>`
      + `<span>亀裂 <b>${escapeHtml(c.label)}</b> — ${f?.orientation ?? ''}・長さ ${Math.round(f?.length ?? 0)} px</span>`
      + `<button data-crack-delete="${i}">削除</button></div>`;
  }).join('');
}

/** 結果シートの表。同日の連写なので平均は 0 付近が正常。σ が「この亀裂をどこまで読めるか」 */
function renderCrackResults(gsd) {
  const el = $('crackResults');
  if (!el) return;
  if (!state.cracks.length) { el.innerHTML = ''; return; }
  const fmt = (px) => (gsd ? `${(px * gsd).toFixed(4)} mm` : `${px.toFixed(4)} px`);
  const rows = state.crackPairs.map((p) => {
    const c = state.cracks.find((x) => x.label === p.label);
    const f = c ? crackFrame(c) : null;
    if (p.ok === false) {
      return `<tr><td>${escapeHtml(p.label)}</td><td>${f?.orientation ?? ''}</td>`
        + `<td colspan="4" class="note" style="padding:6px 8px">${escapeHtml(p.reason ?? '算出できませんでした')}</td></tr>`;
    }
    return `<tr><td>${escapeHtml(p.label)}</td><td>${f?.orientation ?? ''}</td>`
      + `<td class="num">${fmt(p.meanPx)}</td><td class="num">${fmt(p.sigmaPx)}</td>`
      + `<td class="num">${fmt(p.shearPx)}</td><td class="num">${p.frames}<br><span class="note">${p.n1} / ${p.n2} 点</span></td></tr>`;
  });
  el.innerHTML = `
    <h3 class="sec">亀裂測点（線の両側の相対変位）</h3>
    <div class="scroll-x"><table>
      <tr><th>亀裂</th><th>向き</th><th class="num">開口の平均</th><th class="num">σ（1枚あたり）</th><th class="num">ずれの平均</th><th class="num">枚 / 点数</th></tr>
      ${rows.join('')}
    </table></div>
    <p class="note">同日の連写なので平均は 0 付近が正常です。<b>σ が「この構図でこの亀裂の開口をどこまで読めるか」</b>。
      経時管理にはこの σ が付いて記録され、次回の 2 時期比較で「基準からの開口の変化」が出ます。
      開口は線に直交する成分（正＝開いた）、ずれは線に沿う成分（縦線なら正＝右側が下がった）。</p>`;
}

$('crackDrawToggle')?.addEventListener('click', () => {
  if (!state.files.length) { setViewfinderHint('先に写真を読み込んでください', 'warn'); return; }
  const on = state.drawMode !== 'crack';
  setCrackDrawMode(on);
  if (on) closeSheet();
});
$('crackClear')?.addEventListener('click', () => {
  state.cracks = [];
  state.crackPairs = [];
  renderCrackLayer();
  renderCrackList();
  renderCrackResults(currentGSD());
});
$('crackList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-crack-delete]');
  if (!btn) return;
  state.cracks.splice(Number(btn.dataset.crackDelete), 1);
  state.crackPairs = [];
  renderCrackLayer();
  renderCrackList();
  renderCrackResults(currentGSD());
});
renderCrackList();

// ═══════════════════════════════════════════ 解析

/**
 * σ が出せない理由。出せるなら null。
 *
 * ボタンを無効化して黙っているのが一番たちが悪いので、
 * 押されたら理由を言って、直せる場所まで連れて行く。
 */
function runBlockReason() {
  const n = state.files.length;
  if (n === 0) {
    return { reason: '写真がありません。◉ で撮るか、写真シートから読み込んでください', sheet: 'photo' };
  }
  if (n === 1) {
    return {
      reason: 'σ は「動いていないはずのものが動いて見える量」なので、2枚以上必要です',
      sheet: 'photo',
    };
  }
  return null;
}

$('run').addEventListener('click', async () => {
  // ライブ中のシャッターは「計測セッション」。枚数と終了はアプリが決める
  if (sessionActive()) { stopSessionEarly(); return; }
  if (liveActive()) { startSession(); return; }

  const block = runBlockReason();
  if (block) {
    setViewfinderHint(block.reason, 'warn');
    openSheet(block.sheet);
    return;
  }
  await runMeasurement();
});

async function runMeasurement() {
  closeSheet();
  $('run').disabled = true;
  $('progress').classList.add('on');
  try {
    await analyze();
  } catch (error) {
    log(`エラー: ${error.message}`);
    console.error(error);
  }
  $('progress').classList.remove('on');
  setProgress(0);
  $('run').disabled = false;
  // 解析中に新しい版が入っていたら、終わってから切り替える
  if (state.reloadPending) {
    try { sessionStorage.setItem('sw-updated', '1'); } catch { /* 記憶できないだけ */ }
    location.reload();
  }
}

/**
 * ライブセッションで撮れたフレームを写真セットとして差し替える。
 * getUserMedia のフレームには EXIF が無いので、焦点距離は端末に記憶した値
 * （スケールシート）・点群・基準距離のどれかに任せる。
 */
async function setLiveFrames(records) {
  state.files.forEach((f) => URL.revokeObjectURL(f.url));
  state.files = [];
  state.lensMultiplier = lensMultiplierNow();
  for (const r of records) {
    const small = downsample(toGray(r.imageData, null, 'luma', true),
      Math.max(1, Math.round(r.imageData.width / 700)));
    state.files.push({
      file: new File([r.blob], r.name, { type: 'image/jpeg' }),
      exif: {},
      imageData: r.imageData,
      url: URL.createObjectURL(r.blob),
      quality: speckleQuality(small, { subsetHalf: 9 }),
      focus: focusScore(small),
    });
  }
  renderThumbs();
  refreshCloudScale();
  setupPreview();
  renderQuickCheck();
  updateSteps();
}

async function analyze() {
  const channel = $('channel').value;
  const subsetHalf = clampInt($('subsetHalf').value, 5, 60, 15);
  const step = clampInt($('step').value, 8, 200, 25);
  const useHomography = $('model').value === 'homography';
  const method = $('method').value;
  const roi = state.roi;

  log('基準画像を準備中…');
  await tick();
  const reference = toGray(state.files[0].imageData, roi, channel, true);

  let targetSigma = null;
  if (method === 'targets' || method === 'both') {
    targetSigma = await analyzeTargets(reference, channel, roi);
  } else {
    $('targetResults').innerHTML = '';
  }

  let dicStats = null;
  let lastField = null;
  const frameResiduals = [];
  state.crackPairs = [];

  if (method !== 'targets') {
    const quality = speckleQuality(reference, { subsetHalf });
    renderQuality(quality);
    if (quality.verdict === 'poor') {
      log('模様が乏しく DIC が成立しません。');
    } else {
      const perFrame = [];
      const allResiduals = [];

      for (let i = 1; i < state.files.length; i++) {
        log(`解析中… ${i} / ${state.files.length - 1} 組`);
        setProgress(i / (state.files.length - 1));
        await tick();

        const target = toGray(state.files[i].imageData, roi, channel, true);
        const shift = estimateGlobalShift(reference, target, downsample, { maxShiftPx: 300 });
        const field = measureDisplacementField(reference, target, {
          subsetHalf, step, searchRange: 3, minZNCC: 0.75, initialShift: shift,
        });

        const transform = field.points.length >= 12
          ? (useHomography ? fitHomography(field.points) : fitAffine(field.points))
          : null;
        if (!transform) {
          perFrame.push({ index: i, points: field.points.length, rejected: field.rejected, sigma: NaN });
          continue;
        }
        const res = residuals(transform, field.points);
        const stats = summarize(res);
        perFrame.push({ index: i, points: field.points.length, rejected: field.rejected, sigma: stats.sigma, shift });
        allResiduals.push(...res);
        lastField = { residuals: res, roi };
        frameResiduals.push(res);
      }

      // 亀裂測点: 残差は解析範囲内の座標なので線も同じ座標系へ移す
      if (state.cracks.length && frameResiduals.length >= 2) {
        const opts = crackPatchOptions();
        state.crackPairs = state.cracks.map((c) => {
          const r = crackOpeningSeries(frameResiduals, lineToLocal(c, roi), opts);
          if (!r.ok) return { label: c.label, kind: 'crack', ok: false, reason: r.reason };
          return {
            label: c.label, kind: 'crack', method: '亀裂測点（連写 DIC）',
            meanPx: r.openingPx, sigmaPx: r.sigmaOpeningPx,
            shearPx: r.shearPx, sigmaShearPx: r.sigmaShearPx,
            frames: r.frames, n1: r.perFrame[0].n1, n2: r.perFrame[0].n2,
          };
        });
      }

      if (allResiduals.length) {
        dicStats = summarize(allResiduals);
        renderFrameTable(perFrame, currentGSD());
      } else {
        log('有効な測点が得られませんでした。範囲を広げるか、模様のある場所を選んでください。');
      }
    }
  } else {
    $('quality').innerHTML = '';
    $('frameTable').innerHTML = '';
  }

  log('');
  renderVerdict(dicStats, targetSigma);
  renderCrackResults(currentGSD());
  updateSteps();
  if (lastField) drawField(lastField); else $('fieldCanvas').classList.add('hidden');
  openSheet('result');
}

// ═══════════════════════════════════════════ 結果表示

function renderVerdict(dicStats, targetSigma) {
  const gsd = currentGSD();
  const frames = state.files.length;
  // DIC とターゲットの両方が出ていれば、精度の良い方を代表値にする
  const candidates = [
    dicStats ? { name: 'DIC', sigma: dicStats.sigma } : null,
    targetSigma != null && isFinite(targetSigma) ? { name: 'ターゲット', sigma: targetSigma } : null,
  ].filter(Boolean);

  if (!candidates.length) {
    $('verdict').innerHTML = `<div class="eyebrow">結果</div>
      <div class="answer">σ を算出できませんでした。</div>
      <div class="sub">模様が乏しいか、ターゲットが検出できていません。解析範囲と方式を見直してください。</div>`;
    $('stats').innerHTML = '';
    state.limit = null;
    state.measurement = null;
    updateSteps();
    return;
  }

  const best = candidates.reduce((a, b) => (a.sigma <= b.sigma ? a : b));
  const limit = detectionLimit({ sigmaPx: best.sigma, millimetersPerPixel: gsd ?? 1, frames });
  state.measurement = gsd ? {
    // 先月撮った写真を今日解析しても、記録すべき日時は撮影日。EXIF があればそれ
    at: exifDateISO(state.files[0]?.exif?.dateTimeOriginal) ?? new Date().toISOString(),
    gsd, frames,
    method: best.name,
    // 2時期を比べるときに必要なのは「1測点」ではなく「き裂を挟む2点」の σ
    pairSigmaMM: limit.pairSigmaMM,
    pairs: [
      ...(state.targetPairs ?? []).map((p) => ({ ...p, meanMM: p.meanPx * gsd })),
      // 亀裂測点。基準日は「開口 0 ± σ」として記録され、次回の比較で変化が乗る
      ...(state.crackPairs ?? []).filter((p) => p.ok !== false).map((p) => ({
        ...p, meanMM: p.meanPx * gsd, sigmaMM: p.sigmaPx * gsd,
      })),
    ],
    bulgeMM: cloudState.bulges?.regions?.[0]?.peak != null
      ? cloudState.bulges.regions[0].peak * cloudState.unit.scale
      : null,
  } : null;
  refreshHistoryPanel();
  const unit = gsd ? 'mm' : 'px';
  const value = gsd ? limit.detectionLimitMM : 3 * Math.SQRT2 * best.sigma / Math.sqrt(frames);
  state.limit = {
    mm: gsd ? limit.detectionLimitMM : null,
    px: 3 * Math.SQRT2 * best.sigma / Math.sqrt(frames),
    frames, method: best.name,
  };

  $('verdict').innerHTML = `
    <div class="eyebrow">この機材・この条件での検出限界</div>
    <div class="answer"><b>${value.toFixed(gsd ? 3 : 4)}</b> ${unit} より大きい変化なら、ノイズと区別できます。</div>
    <div class="sub">
      ${frames} 枚平均・3σ 基準${gsd ? '' : '（撮影距離を入力すると mm で表示します）'}。
      これを下回る変化は「有意差なし」と判断してください。
      ${candidates.length > 1 ? `代表値は精度の良い <strong>${best.name}</strong> 方式を採用。` : ''}
    </div>`;

  const cells = [
    ['σ（1測点・1枚）', `${best.sigma.toFixed(4)} px`],
    [`σ（${frames}枚平均）`, `${(best.sigma / Math.sqrt(frames)).toFixed(4)} px`],
    ...(gsd ? [['分解能', `${gsd.toFixed(4)} mm/px`]] : []),
    ...candidates.map((c) => [`${c.name} の σ`, `${c.sigma.toFixed(4)} px`]),
  ];
  $('stats').innerHTML = cells
    .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');

  state.lastResult = {
    生成日時: new Date().toISOString(),
    枚数: frames,
    解析方式: $('method').value,
    変換モデル: $('model').value,
    分解能_mm_per_px: gsd,
    代表方式: best.name,
    σ_px: best.sigma,
    σ_平均後_px: best.sigma / Math.sqrt(frames),
    検出限界_3σ: `${value.toFixed(4)} ${unit}`,
    各方式: Object.fromEntries(candidates.map((c) => [c.name, c.sigma])),
    解析範囲_px: state.roi,
    写真: state.files.map((f, i) => ({
      名前: f.file.name, 役割: i === 0 ? '基準' : String(i),
      ピント: f.focus, 模様: f.quality.verdict,
      焦点距離35mm換算: f.exif?.focalLength35mm ?? null,
      撮影日時: f.exif?.dateTimeOriginal ?? null,
    })),
  };
}

$('exportBtn').addEventListener('click', () => {
  if (!state.lastResult) return;
  const blob = new Blob([JSON.stringify(state.lastResult, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sigma_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function renderQuality(q) {
  const cls = q.verdict === 'good' ? 'good' : q.verdict === 'fair' ? 'warn' : 'bad';
  $('quality').innerHTML = `<div class="banner ${cls}"><div>
    テクスチャ判定: <strong>${q.verdict}</strong> — ${escapeHtml(q.reason)}<br>
    <span class="mono" style="font-size:12px;color:var(--ink-soft)">MIG ${q.mig.toFixed(5)} ／ 局所コントラスト ${q.contrast.toFixed(4)} ／ 飽和 ${(q.saturatedRatio * 100).toFixed(1)}%</span>
  </div></div>`;
}

function renderFrameTable(perFrame, gsd) {
  const rows = perFrame.map((f) => `<tr>
    <td>基準 ↔ ${f.index}</td>
    <td class="num">${f.points}</td>
    <td class="num">${f.rejected}</td>
    <td class="num">${f.shift ? `${Math.round(f.shift.dx)}, ${Math.round(f.shift.dy)}` : '—'}</td>
    <td class="num">${isFinite(f.sigma) ? f.sigma.toFixed(4) + (gsd ? ` (${(f.sigma * gsd).toFixed(4)} mm)` : '') : '失敗'}</td>
  </tr>`).join('');
  $('frameTable').innerHTML = `<h3 class="sec">DIC の内訳</h3><table>
    <tr><th>組</th><th class="num">測点</th><th class="num">棄却</th><th class="num">粗いずれ(px)</th><th class="num">σ (px)</th></tr>
    ${rows}</table>`;
}

/**
 * ターゲット方式の解析。
 *
 * 各フレームでターゲットを検出し、基準フレームと対応付けたうえで
 * 全ターゲット対の距離を求めます。同じ対の距離が枚ごとにどれだけばらつくかが
 * そのまま測定ノイズです。既知量を動かして撮った場合は、距離の系列に段差として現れます。
 *
 * @returns {number|null} 対ごとの σ の中央値[px]
 */
async function analyzeTargets(reference, channel, roi) {
  log('ターゲットを検出中…');
  await tick();

  const referenceTargets = detectTargets(reference, { backgroundRadius: 60 });
  if (referenceTargets.length < 2) {
    $('targetResults').innerHTML = `<div class="banner bad"><div>
      基準画像からターゲットを ${referenceTargets.length} 点しか検出できませんでした。
      解析範囲にターゲット全体が入っているか、白地に黒丸として写っているか確認してください。
    </div></div>`;
    return null;
  }

  const referencePairs = pairwiseDistances(referenceTargets);
  const series = referencePairs.map(() => []);
  const perFrame = [];

  for (let f = 0; f < state.files.length; f++) {
    log(`ターゲット解析中… ${f + 1} / ${state.files.length} 枚`);
    setProgress((f + 1) / state.files.length);
    await tick();

    const gray = f === 0 ? reference : toGray(state.files[f].imageData, roi, channel, true);
    const found = f === 0 ? referenceTargets : detectTargets(gray, { backgroundRadius: 60 });
    const shift = f === 0
      ? { dx: 0, dy: 0 }
      : estimateGlobalShift(reference, gray, downsample, { maxShiftPx: 300 });
    const matches = f === 0
      ? referenceTargets.map((t, i) => ({ a: t, b: t, index: i }))
      : matchTargets(referenceTargets, found, shift, Math.max(30, (found[0]?.radius ?? 10) * 3));

    const byIndex = new Map(matches.map((m) => [m.index, m.b]));
    perFrame.push({ frame: f, detected: found.length, matched: matches.length });

    referencePairs.forEach((pair, k) => {
      const a = byIndex.get(pair.i);
      const b = byIndex.get(pair.j);
      series[k].push(a && b ? Math.hypot(a.x - b.x, a.y - b.y) : NaN);
    });
  }

  // 既知距離からスケールを決めるための選択肢
  $('referencePair').innerHTML = '<option value="">選択しない</option>' +
    referencePairs.map((p) => `<option value="${p.distance}">対 ${p.i + 1}–${p.j + 1}（${p.distance.toFixed(2)} px）</option>`).join('');
  $('referenceScale').classList.remove('hidden');

  const gsd = currentGSD();
  const rows = referencePairs.map((pair, k) => {
    const values = series[k].filter((v) => isFinite(v));
    const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
    return { pair, values, mean, sigma: robustSigmaOf(values), span: values.length ? Math.max(...values) - Math.min(...values) : 0 };
  });

  // 経時管理では「どの対を測点の量とするか」を選ばせるので、対ごとの結果を残す
  state.targetPairs = rows.map((r) => ({
    label: `${r.pair.i + 1}–${r.pair.j + 1}`,
    meanPx: r.mean,
    sigmaPx: r.sigma,
  }));

  const sigmas = rows.map((r) => r.sigma).filter((s) => isFinite(s) && s > 0).sort((a, b) => a - b);
  const medianSigma = sigmas.length ? sigmas[sigmas.length >> 1] : NaN;

  $('targetResults').innerHTML = `
    <h3 class="sec">ターゲット方式の内訳</h3>
    <div class="banner ${referenceTargets.length >= 4 ? 'good' : 'warn'}"><div>
      基準画像で <strong>${referenceTargets.length} 点</strong>検出。対ごとの距離の σ（中央値）
      <span class="mono">${isFinite(medianSigma) ? medianSigma.toFixed(4) : '—'} px</span>
      ${gsd && isFinite(medianSigma) ? `= <span class="mono">${(medianSigma * gsd).toFixed(4)} mm</span>` : ''}
    </div></div>
    <div class="scroll-x"><table>
      <tr><th>枚</th><th class="num">検出</th><th class="num">対応付け</th></tr>
      ${perFrame.map((p) => `<tr><td>${p.frame === 0 ? '基準' : p.frame}</td><td class="num">${p.detected}</td><td class="num">${p.matched}</td></tr>`).join('')}
    </table></div>
    <div class="scroll-x" style="margin-top:12px"><table>
      <tr><th>対</th><th class="num">平均距離</th><th class="num">σ</th><th class="num">最大−最小</th><th class="num">各枚の値(px)</th></tr>
      ${rows.map((r) => `<tr>
        <td>${r.pair.i + 1}–${r.pair.j + 1}</td>
        <td class="num">${r.mean.toFixed(3)}${gsd ? ` (${(r.mean * gsd).toFixed(3)} mm)` : ''}</td>
        <td class="num">${isFinite(r.sigma) ? r.sigma.toFixed(4) : '—'}</td>
        <td class="num">${r.span.toFixed(4)}</td>
        <td class="num" style="font-size:11px">${r.values.map((v) => v.toFixed(3)).join(', ')}</td>
      </tr>`).join('')}
    </table></div>
    <p class="note">既知量を動かして撮った場合、「各枚の値」に段差として現れます。
    段差を σ と混同しないよう、動かす前後は別々に解析してください。</p>`;

  return medianSigma;
}

function robustSigmaOf(values) {
  if (values.length < 2) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const deviations = values.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = deviations[deviations.length >> 1];
  if (mad > 0) return 1.4826 * mad;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

function drawField(field) {
  const canvas = $('fieldCanvas');
  canvas.classList.remove('hidden');
  const { roi, residuals: res } = field;
  const width = 860;
  const scale = width / roi.width;
  canvas.width = width;
  canvas.height = Math.round(roi.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0e0c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const magnitudes = res.map((r) => Math.hypot(r.du, r.dv));
  const maxMag = Math.max(...magnitudes, 1e-6);
  const arrowScale = 30 / maxMag;

  for (const r of res) {
    const x = r.x * scale;
    const y = r.y * scale;
    const t = Math.hypot(r.du, r.dv) / maxMag;
    // 小さい残差＝フォレストグリーン、大きい＝アンバー
    ctx.strokeStyle = `hsl(${152 - t * 110}, ${45 + t * 25}%, ${52 + t * 8}%)`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + r.du * arrowScale, y + r.dv * arrowScale);
    ctx.stroke();
    ctx.fillStyle = 'rgba(230,236,232,.45)';
    ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
  }

  $('fieldNote').textContent =
    `矢印は実際の ${arrowScale.toFixed(0)} 倍。最大残差 ${maxMag.toFixed(4)} px。` +
    `方向がランダムならノイズ、揃っていたり渦を巻いていたら、変換モデルで取り切れていない歪み` +
    `（レンズ歪・被写体の実際の動き）が残っています。`;
}

// ═══════════════════════════════════════════ 補助

/** EXIF の "YYYY:MM:DD HH:MM:SS" を ISO 文字列に。読めなければ null。 */
function exifDateISO(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(String(s ?? ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  return isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function log(message) { $('log').textContent = message; }
function setProgress(fraction) { $('progress').firstElementChild.style.width = `${Math.round(fraction * 100)}%`; }
function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 現場は圏外が普通なので、一度開けば通信なしで使えるようにする。
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', async () => {
    try {
      // 初回（まだ誰も制御していない）はネットワークから読んだ最新なので再読み込み不要。
      // 制御が**入れ替わった**とき＝新しい版が入ったときだけ再読み込みする。
      // 以前は「再読み込み済みの版」を sessionStorage に版番号で記録していたが、
      // 記録するのは古い頁の版番号なので、次の更新時に同じ番号と一致して
      // 再読み込みされず、新版が入っているのに古い画面のままになっていた
      const hadController = !!navigator.serviceWorker.controller;
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || refreshing) return;
        // 万一 SW の更新が毎回走る環境でも無限に回らないよう、直近の自動再読み込みから
        // 10 秒以内はもう一度はしない
        let last = 0;
        try { last = Number(sessionStorage.getItem('sw-reloaded-at')) || 0; } catch { /* 記憶なし */ }
        if (Date.now() - last < 10000) return;
        // 計測中・解析中に再読み込みすると撮った枚を捨てることになる。終わってから
        if (sessionActive() || $('run').disabled) { state.reloadPending = true; return; }
        refreshing = true;
        try {
          sessionStorage.setItem('sw-reloaded-at', String(Date.now()));
          sessionStorage.setItem('sw-updated', '1');
        } catch { /* 記憶できないだけ */ }
        location.reload();
      });
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.update().catch(() => {});
    } catch { /* SW が使えない環境ではそのまま動く */ }
  });
}
