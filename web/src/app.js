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
import { initCloudPanel, refreshCloudScale, cloudGSD, cloudState } from './cloudpanel.js';
import { initHistoryPanel, refreshHistoryPanel, historySummary } from './historypanel.js';
import { initShell, updateHud, setViewfinderHint, openSheet, closeSheet, routeHud } from './shell.js';
import { initComparePanel, compareLamp, refreshSavedBaselines } from './comparepanel.js';
import { initCloudDiffPanel, cloudDiffLamp } from './clouddiffpanel.js';
import {
  initCapturePanel, toggleLive, liveActive, sessionActive,
  startSession, stopSessionEarly, stopLive, lensState, switchLens, setZoom, lensFactorOf,
} from './capturepanel.js';
import { saveBaseline } from './store.js';
import { APP_VERSION } from './version.js';

const $ = (id) => document.getElementById(id);

const state = {
  files: [],       // {file, exif, imageData, url, quality, focus}
  roi: null,
  preview: null,
  lastResult: null,
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
  if (currentGSD() == null) return 'スケールを決めると mm で出ます（未入力でも px では出ます）';
  return 'σ を押すと実測します';
}

// ═══════════════════════════════════════════ ステップ状態

function updateSteps() {
  const n = state.files.length;
  const gsd = currentGSD();
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
function renderLensBar() {
  const bar = $('lensBar');
  if (!bar) return;
  if (!liveActive()) { bar.innerHTML = ''; bar.classList.add('hidden'); return; }
  const ls = lensState();
  const names = { ultra: '超広角', wide: '広角', tele: '望遠' };
  const fmt = (f) => (f < 1 ? f.toFixed(1) : (Math.round(f * 10) / 10).toString().replace(/\.0$/, '')) + '×';
  const seen = {};
  const zoomOn = ls.zoom && ls.activeKind === 'wide' && Math.abs((ls.zoom.value || 1) - 2) < 0.05;
  // ピルはレンズ名＋倍率の2段。「0.5×」だけでは何のレンズか分からず、
  // 「望遠」だけでは何倍か分からない。両方を必ず出す
  const items = ls.lenses.map((l) => {
    seen[l.kind] = (seen[l.kind] ?? 0) + 1;
    const active = l.deviceId === ls.activeDeviceId && !zoomOn;
    const factor = l.kind === 'wide' ? 1 : (l.deviceId === ls.activeDeviceId ? ls.factor : lensFactorOf(l.deviceId));
    let name = names[l.kind];
    if (seen[l.kind] > 1) name += ` ${seen[l.kind]}`;
    const value = factor != null ? fmt(factor) : '未実測';
    return `<button class="lens${active ? ' on' : ''}${factor == null ? ' unknown' : ''}" data-lens="${l.deviceId}">`
      + `<small>${name}</small>${value}</button>`;
  });
  // デジタル 2× は広角のときだけ（48MP 機のセンサークロップに限り実質的に効く）。
  // 望遠のときにズームのピルを出すと「1×」が点いたままになり、倍率を誤読させる
  if (ls.zoom && ls.activeKind === 'wide' && 2 <= ls.zoom.max) {
    const wideIdx = items.findIndex((_, i) => ls.lenses[i].kind === 'wide');
    const pill = `<button class="lens zoom${zoomOn ? ' on' : ''}" data-zoom="${zoomOn ? 1 : 2}"><small>デジタル</small>2×</button>`;
    items.splice(wideIdx + 1, 0, pill);
  }
  if (items.length <= 1) { bar.innerHTML = ''; bar.classList.add('hidden'); return; }

  // 「いま何で撮っているか」を文で出す。ピルの点灯だけでは読めない
  const activeName = names[ls.activeKind];
  const zoom = ls.zoom?.value || 1;
  let caption;
  let captionKind = 'ok';
  if (ls.calibrating) {
    caption = `使用中 <b>${activeName}</b> 倍率を実測中…`;
    captionKind = 'warn';
  } else if (ls.factor == null) {
    caption = `使用中 <b>${activeName}</b> 倍率 未実測<br>広角に戻してから${activeName}を押し直すと実測します`;
    captionKind = 'warn';
  } else {
    const total = ls.factor * zoom;
    caption = `使用中 <b>${activeName} ${fmt(total)}</b>`
      + (zoom > 1.05 ? `（${fmt(ls.factor)} × デジタル ${fmt(zoom)}）` : '')
      + (ls.activeKind !== 'wide' ? ' 実測' : '');
  }
  bar.innerHTML = `<div class="lens-caption" data-kind="${captionKind}">${caption}</div>`
    + `<div class="lens-pills">${items.join('')}</div>`;
  bar.classList.remove('hidden');
  bar.querySelectorAll('[data-lens]').forEach((b) => b.addEventListener('click', async () => {
    try { await switchLens(b.dataset.lens); } catch (e) { setViewfinderHint(`レンズを切り替えられません: ${e.message}`, 'warn'); }
  }));
  bar.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => setZoom(Number(b.dataset.zoom))));
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

for (const id of ['distance', 'focal35', 'referenceLength', 'teleFactor']) {
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
  if (!(base > 0)) return null;
  const m = state.lensMultiplier;
  if (!m) return base;
  return m.factor != null ? base * m.factor * (m.zoom || 1) : null;
}

/** ライブ映像の GSD。距離 × 焦点距離（いまのレンズ・ズーム）だけで決める。 */
function liveGSD() {
  const video = document.getElementById('liveVideo');
  if (!video || !(video.videoWidth > 0)) return null;
  const distance = parseFloat($('distance').value);
  const base = parseFloat($('focal35').value);
  const m = lensMultiplierNow();
  if (!(distance > 0) || !(base > 0) || m.factor == null) return null;
  const focalPx = focalLengthPxFrom35mm({
    focal35mm: base * m.factor * (m.zoom || 1),
    imageWidthPx: Math.max(video.videoWidth, video.videoHeight),
  });
  return computeGSD({ distanceM: distance, focalLengthPx: focalPx });
}

/** いまのレンズの倍率。望遠は入力必須（無ければ null → mm が出ず、その理由を出す）。 */
function lensMultiplierNow() {
  const ls = lensState();
  const zoom = ls.zoom?.value || 1;
  // 実測値（広角→切替時にアプリが測った比）を最優先。無ければ手入力（望遠のみ）
  if (ls.factor != null) return { kind: ls.activeKind, factor: ls.factor, zoom, measured: ls.activeKind !== 'wide' };
  if (ls.activeKind === 'tele') {
    const f = parseFloat($('teleFactor').value);
    return { kind: 'tele', factor: f > 0 ? f : null, zoom, measured: false };
  }
  if (ls.activeKind === 'ultra') return { kind: 'ultra', factor: null, zoom, measured: false };
  return { kind: 'wide', factor: 1, zoom, measured: false };
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
function cameraIntrinsics() {
  if (!state.files.length) return null;
  const focal35 = effectiveFocal35();
  if (!(focal35 > 0)) return null;
  const { width, height } = state.files[0].imageData;
  const focalLengthPx = focalLengthPxFrom35mm({
    focal35mm: focal35,
    imageWidthPx: Math.max(width, height),
  });
  if (!(focalLengthPx > 0)) return null;
  return { focalLengthPx, cx: width / 2, cy: height / 2, width, height };
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
  onChange: updateSteps,
});

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
  for (const id of ['distance', 'focal35', 'referenceLength', 'teleFactor']) {
    if (saved[id] && !$(id).value) $(id).value = saved[id];
  }
} catch { /* プライベートモード等では記憶しないだけ */ }
for (const id of ['distance', 'focal35', 'referenceLength', 'teleFactor']) {
  $(id).addEventListener('input', () => {
    try {
      const saved = JSON.parse(localStorage.getItem(SCALE_KEY)) || {};
      saved[id] = $(id).value;
      localStorage.setItem(SCALE_KEY, JSON.stringify(saved));
    } catch { /* 同上 */ }
  });
}

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
      `レンズ ${ls.lenses.length}: ${ls.lenses.map((l) => `${l.kind}「${l.label || '(無名)'}」${lensFactorOf(l.deviceId) ?? '未実測'}×`).join(' / ')}`,
      `使用中 ${ls.activeKind} 倍率 ${ls.factor ?? '未実測'} ズーム ${ls.zoom ? `${ls.zoom.value} (最大 ${ls.zoom.max})` : '非対応'}`,
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
window.addEventListener('shell:resize', () => { if (state.roi) setRoi(state.roi); });

// ═══════════════════════════════════════════ 解析範囲

function setupPreview() {
  const { imageData } = state.files[0];
  const preview = makePreviewCanvas(imageData, 880);
  state.preview = preview;
  const container = $('preview');
  container.querySelectorAll('canvas').forEach((c) => c.remove());
  container.insertBefore(preview.canvas, $('roiBox'));

  const side = Math.round(Math.min(imageData.width, imageData.height) * 0.6);
  setRoi({
    x: Math.round((imageData.width - side) / 2),
    y: Math.round((imageData.height - side) / 2),
    width: side, height: side,
  });

  let dragStart = null;
  preview.canvas.addEventListener('pointerdown', (e) => {
    const rect = preview.canvas.getBoundingClientRect();
    dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    preview.canvas.setPointerCapture(e.pointerId);
  });
  preview.canvas.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const rect = preview.canvas.getBoundingClientRect();
    const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const toImage = (preview.canvas.width / rect.width) / preview.scale;
    setRoi({
      x: Math.min(dragStart.x, cur.x) * toImage,
      y: Math.min(dragStart.y, cur.y) * toImage,
      width: Math.abs(cur.x - dragStart.x) * toImage,
      height: Math.abs(cur.y - dragStart.y) * toImage,
    });
  });
  preview.canvas.addEventListener('pointerup', () => { dragStart = null; updateSteps(); });
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
    pairs: (state.targetPairs ?? []).map((p) => ({ ...p, meanMM: p.meanPx * gsd })),
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
