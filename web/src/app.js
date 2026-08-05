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

const $ = (id) => document.getElementById(id);
const state = {
  files: [],       // {file, exif, imageData}
  roi: null,       // 画像座標のROI
  preview: null,   // {canvas, scale}
};

// ------------------------------------------------------------ 読み込み

$('drop').addEventListener('click', () => $('fileInput').click());
$('drop').addEventListener('dragover', (e) => {
  e.preventDefault();
  $('drop').classList.add('over');
});
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('over');
  loadFiles([...e.dataTransfer.files]);
});
$('fileInput').addEventListener('change', (e) => loadFiles([...e.target.files]));

// その場で撮影。capture 属性で端末のカメラアプリが開き、
// 最大解像度＋EXIF 付きの写真が返ります。
// getUserMedia のプレビュー映像だと解像度が落ちるので、計測用にはこちらを使います。
$('cameraBtn').addEventListener('click', () => $('cameraInput').click());
$('cameraInput').addEventListener('change', (e) => {
  loadFiles([...e.target.files]);
  e.target.value = ''; // 同じ端末で連続撮影できるようにリセット
});

$('clearBtn').addEventListener('click', () => {
  state.files = [];
  state.roi = null;
  $('fileTable').innerHTML = '';
  $('quickCheck').innerHTML = '';
  $('fileWarnings').innerHTML = '';
  for (const id of ['scaleSection', 'roiSection', 'runSection', 'results']) {
    $(id).classList.add('hidden');
  }
});

async function loadFiles(fileList) {
  const images = fileList.filter(
    (f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|tiff?)$/i.test(f.name)
  );
  if (!images.length) return;
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  log(`${images.length} 枚を読み込み中…`);
  const errors = [];
  for (const file of images) {
    try {
      const buffer = await file.arrayBuffer();
      const exif = parseExif(buffer);
      const imageData = await decodeFile(file);
      // 追加していく方式。カメラは1回1枚しか返さないため。
      state.files.push({ file, exif, imageData });
    } catch (error) {
      errors.push(error.message);
    }
  }
  log('');

  if (!state.files.length) {
    showFileWarnings(errors.length ? errors : ['画像を読み込めませんでした。']);
    return;
  }

  const warnings = [...errors, ...checkConsistency(state.files.map((f) => f.exif))];
  if (state.files.length < 2) {
    warnings.push('σ の実測には 2 枚以上必要です。同じ位置からもう数枚撮ってください（5〜20枚推奨）。');
  }
  showFileWarnings(warnings);
  renderFileTable();
  setupScale();
  setupPreview();
  await runQuickCheck();

  $('scaleSection').classList.remove('hidden');
  $('roiSection').classList.remove('hidden');
  $('runSection').classList.remove('hidden');
  $('run').disabled = state.files.length < 2;
}

/**
 * 現地チェック。1枚あれば走ります。
 *
 * σ は複数枚ないと出ませんが、「この位置で撮って意味があるか」は
 * 1枚で判定できます。撮り直しが効くうちに気づくのが目的です。
 */
async function runQuickCheck() {
  const channel = $('channel')?.value ?? 'luma';
  const rows = [];
  const focuses = [];

  for (const f of state.files) {
    const gray = toGray(f.imageData, state.roi, channel, true);
    const quality = speckleQuality(gray, { subsetHalf: 15 });
    const focus = focusScore(gray);
    focuses.push(focus);
    rows.push({ name: f.file.name, quality, focus });
  }

  // ピントの絶対値はレンズと被写体で変わるので、
  // セッション内の中央値と比べて外れている枚を指摘する
  const sorted = [...focuses].sort((a, b) => a - b);
  const medianFocus = sorted[sorted.length >> 1];

  const latest = rows[rows.length - 1];
  const gsd = currentGSD();
  const cls =
    latest.quality.verdict === 'good' ? 'good' : latest.quality.verdict === 'fair' ? 'warn' : 'bad';

  const blurred = rows
    .map((r, i) => ({ ...r, i }))
    .filter((r) => medianFocus > 0 && r.focus < medianFocus * 0.6);

  $('quickCheck').innerHTML = `
    <div class="banner ${cls}">
      <strong>現地チェック（最新の1枚）</strong><br>
      模様: ${latest.quality.verdict} — ${escapeHtml(latest.quality.reason)}<br>
      ピント: ${latest.focus.toFixed(4)}（セッション中央値 ${medianFocus.toFixed(4)}）<br>
      ${gsd ? `分解能: ${gsd.toFixed(4)} mm/px　→ 幅 ${(gsd * 3).toFixed(2)} mm 以上の特徴が識別可能` : '分解能: 撮影距離を入力すると表示します'}
    </div>
    ${blurred.length
      ? `<div class="banner warn">${blurred.length} 枚がセッション中で明らかにボケています
         （${blurred.map((b) => escapeHtml(b.name)).join(', ')}）。除外して撮り直してください。</div>`
      : ''}
  `;
}

function showFileWarnings(messages) {
  $('fileWarnings').innerHTML = messages
    .map((m) => `<div class="banner warn">${escapeHtml(m)}</div>`)
    .join('');
}

function renderFileTable() {
  const rows = state.files
    .map((f, i) => {
      const e = f.exif ?? {};
      return `<tr>
        <td>${i === 0 ? '<strong>基準</strong>' : i}</td>
        <td>${escapeHtml(f.file.name)}</td>
        <td class="num">${f.imageData.width}×${f.imageData.height}</td>
        <td class="num">${e.focalLength35mm ?? e.focalLength ?? '—'}</td>
        <td class="num">${e.exposureTime ? `1/${Math.round(1 / e.exposureTime)}s` : '—'}</td>
        <td class="num">${e.iso ?? '—'}</td>
        <td>${escapeHtml(e.dateTimeOriginal ?? '—')}</td>
      </tr>`;
    })
    .join('');
  $('fileTable').innerHTML = `<table>
    <tr><th>#</th><th>ファイル</th><th class="num">画素</th><th class="num">焦点距離</th>
        <th class="num">露光</th><th class="num">ISO</th><th>撮影日時</th></tr>
    ${rows}</table>`;
}

// ------------------------------------------------------------ スケール

function setupScale() {
  const exif = state.files[0].exif ?? {};
  if (exif.focalLength35mm) $('focal35').value = exif.focalLength35mm;
  updateGSD();
}
$('distance').addEventListener('input', updateGSD);
$('focal35').addEventListener('input', updateGSD);
$('referenceLength').addEventListener('input', updateGSD);
$('referencePair').addEventListener('change', updateGSD);

function currentGSD() {
  // 既知の基準距離があればそちらを優先する。
  // レーザー距離計も焦点距離も要らず、印刷倍率やレンズの個体差も吸収できるため。
  const referenceMM = parseFloat($('referenceLength').value);
  const referencePx = parseFloat($('referencePair').value);
  if (referenceMM > 0 && referencePx > 0) return referenceMM / referencePx;

  const distance = parseFloat($('distance').value);
  const focal35 = parseFloat($('focal35').value);
  if (!(distance > 0) || !(focal35 > 0)) return null;
  const focalPx = focalLengthPxFrom35mm({
    focal35mm: focal35,
    imageWidthPx: Math.max(state.files[0].imageData.width, state.files[0].imageData.height),
  });
  return computeGSD({ distanceM: distance, focalLengthPx: focalPx });
}

function updateGSD() {
  const gsd = currentGSD();
  $('gsd').value = gsd ? `${gsd.toFixed(4)} mm/px` : '';
}

// ------------------------------------------------------------ ROI 選択

function setupPreview() {
  const { imageData } = state.files[0];
  const preview = makePreviewCanvas(imageData, 880);
  state.preview = preview;
  const container = $('preview');
  container.querySelectorAll('canvas').forEach((c) => c.remove());
  container.insertBefore(preview.canvas, $('roiBox'));

  // 既定は中央 60%
  const side = Math.round(Math.min(imageData.width, imageData.height) * 0.6);
  setRoi({
    x: Math.round((imageData.width - side) / 2),
    y: Math.round((imageData.height - side) / 2),
    width: side,
    height: side,
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
    // 画面上の縮小率（CSS でさらに縮んでいる場合を考慮）
    const cssScale = preview.canvas.width / rect.width;
    const toImage = cssScale / preview.scale;
    setRoi({
      x: Math.min(dragStart.x, cur.x) * toImage,
      y: Math.min(dragStart.y, cur.y) * toImage,
      width: Math.abs(cur.x - dragStart.x) * toImage,
      height: Math.abs(cur.y - dragStart.y) * toImage,
    });
  });
  preview.canvas.addEventListener('pointerup', () => {
    dragStart = null;
  });
}

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

// ------------------------------------------------------------ 解析

$('run').addEventListener('click', run);

async function run() {
  $('run').disabled = true;
  $('results').classList.add('hidden');
  try {
    await analyze();
  } catch (error) {
    log(`エラー: ${error.message}`);
    console.error(error);
  }
  $('run').disabled = false;
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

  if (method === 'targets' || method === 'both') {
    await analyzeTargets(reference, channel, roi);
  } else {
    $('targetResults').innerHTML = '';
  }

  if (method === 'targets') {
    $('quality').innerHTML = '';
    $('frameTable').innerHTML = '';
    $('results').classList.remove('hidden');
    log('');
    return;
  }

  const quality = speckleQuality(reference, { subsetHalf });
  renderQuality(quality);
  if (quality.verdict === 'poor') {
    log('模様が乏しく DIC が成立しません。解析を中止しました。');
    $('results').classList.remove('hidden');
    return;
  }

  const perFrame = [];
  const allResiduals = [];
  let lastField = null;

  for (let i = 1; i < state.files.length; i++) {
    log(`解析中… ${i} / ${state.files.length - 1} 組`);
    await tick();

    const target = toGray(state.files[i].imageData, roi, channel, true);
    const shift = estimateGlobalShift(reference, target, downsample, { maxShiftPx: 300 });
    const field = measureDisplacementField(reference, target, {
      subsetHalf,
      step,
      searchRange: 3,
      minZNCC: 0.75,
      initialShift: shift,
    });

    if (field.points.length < 12) {
      perFrame.push({ index: i, points: field.points.length, rejected: field.rejected, sigma: NaN });
      continue;
    }

    const transform = useHomography ? fitHomography(field.points) : fitAffine(field.points);
    if (!transform) {
      perFrame.push({ index: i, points: field.points.length, rejected: field.rejected, sigma: NaN });
      continue;
    }
    const res = residuals(transform, field.points);
    const stats = summarize(res);
    perFrame.push({
      index: i,
      points: field.points.length,
      rejected: field.rejected,
      sigma: stats.sigma,
      p95: stats.p95,
      shift,
    });
    allResiduals.push(...res);
    lastField = { residuals: res, roi };
  }

  log('');
  if (!allResiduals.length) {
    log('有効な測点が得られませんでした。範囲を広げるか、模様のある場所を選んでください。');
    $('results').classList.remove('hidden');
    return;
  }

  const overall = summarize(allResiduals);
  const gsd = currentGSD();
  const frames = state.files.length;
  const limit = detectionLimit({
    sigmaPx: overall.sigma,
    millimetersPerPixel: gsd ?? 1,
    frames,
  });

  $('sigmaPx').innerHTML = `${overall.sigma.toFixed(4)} <small>px</small>`;
  $('limitPx').innerHTML = `${(3 * Math.SQRT2 * overall.sigma).toFixed(4)} <small>px</small>`;
  $('limitMM').innerHTML = gsd
    ? `${limit.detectionLimitMM.toFixed(4)} <small>mm</small>`
    : '<small>撮影距離を入力すると mm で表示します</small>';

  renderFrameTable(perFrame, gsd, frames, overall);
  if (lastField) drawField(lastField);
  $('results').classList.remove('hidden');
}

/**
 * ターゲット方式の解析。
 *
 * 各フレームでターゲットを検出し、基準フレームと対応付けたうえで
 * 全ターゲット対の距離を求めます。同じ対の距離が枚ごとにどれだけばらつくかが
 * そのまま測定ノイズです。
 *
 * 既知量を動かして撮った場合は、距離の系列に段差として現れます。
 */
async function analyzeTargets(reference, channel, roi) {
  log('ターゲットを検出中…');
  await tick();

  const referenceTargets = detectTargets(reference, { backgroundRadius: 60 });
  if (referenceTargets.length < 2) {
    $('targetResults').innerHTML = `<div class="banner bad">
      基準画像からターゲットを ${referenceTargets.length} 点しか検出できませんでした。
      解析範囲にターゲット全体が入っているか、白地に黒丸として写っているか確認してください。
    </div>`;
    return;
  }

  // 各フレームで検出 → 基準と対応付け → 対ごとの距離
  const referencePairs = pairwiseDistances(referenceTargets);
  const series = referencePairs.map(() => []);
  const perFrame = [];

  for (let f = 0; f < state.files.length; f++) {
    log(`ターゲット解析中… ${f + 1} / ${state.files.length} 枚`);
    await tick();

    const gray = f === 0 ? reference : toGray(state.files[f].imageData, roi, channel, true);
    const found = f === 0 ? referenceTargets : detectTargets(gray, { backgroundRadius: 60 });
    const shift =
      f === 0 ? { dx: 0, dy: 0 } : estimateGlobalShift(reference, gray, downsample, { maxShiftPx: 300 });
    const matches = f === 0
      ? referenceTargets.map((t, i) => ({ a: t, b: t, index: i }))
      : matchTargets(referenceTargets, found, shift, Math.max(30, 0.5 * (found[0]?.radius ?? 10) * 6));

    const byIndex = new Map(matches.map((m) => [m.index, m.b]));
    perFrame.push({ frame: f, detected: found.length, matched: matches.length });

    referencePairs.forEach((pair, k) => {
      const a = byIndex.get(pair.i);
      const b = byIndex.get(pair.j);
      series[k].push(a && b ? Math.hypot(a.x - b.x, a.y - b.y) : NaN);
    });
  }

  // 基準ペアの選択肢を用意（既知距離からスケールを決めるため）
  const select = $('referencePair');
  select.innerHTML =
    '<option value="">選択しない</option>' +
    referencePairs
      .map((p, k) => `<option value="${p.distance}">対 ${p.i + 1}–${p.j + 1}（${p.distance.toFixed(2)} px）</option>`)
      .join('');
  $('referenceScale').classList.remove('hidden');

  const gsd = currentGSD();
  const rows = referencePairs.map((pair, k) => {
    const values = series[k].filter((v) => isFinite(v));
    const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
    const sigma = robustSigmaOf(values);
    const span = values.length ? Math.max(...values) - Math.min(...values) : 0;
    return { pair, values, mean, sigma, span };
  });

  const validSigmas = rows.map((r) => r.sigma).filter((s) => isFinite(s) && s > 0).sort((a, b) => a - b);
  const medianSigma = validSigmas.length ? validSigmas[validSigmas.length >> 1] : NaN;

  const detectionRow = perFrame
    .map((p) => `<tr><td>${p.frame === 0 ? '基準' : p.frame}</td>
      <td class="num">${p.detected}</td><td class="num">${p.matched}</td></tr>`)
    .join('');

  const pairRows = rows
    .map((r) => {
      const mm = gsd ? ` (${(r.mean * gsd).toFixed(3)} mm)` : '';
      const sigmaMM = gsd && isFinite(r.sigma) ? ` (${(r.sigma * gsd).toFixed(4)} mm)` : '';
      const spanMM = gsd ? ` (${(r.span * gsd).toFixed(4)} mm)` : '';
      return `<tr>
        <td>${r.pair.i + 1}–${r.pair.j + 1}</td>
        <td class="num">${r.mean.toFixed(3)}${mm}</td>
        <td class="num">${isFinite(r.sigma) ? r.sigma.toFixed(4) + sigmaMM : '—'}</td>
        <td class="num">${r.span.toFixed(4)}${spanMM}</td>
        <td class="num" style="font-size:11px">${r.values.map((v) => v.toFixed(3)).join(', ')}</td>
      </tr>`;
    })
    .join('');

  const limitMM = gsd && isFinite(medianSigma) ? 3 * Math.SQRT2 * medianSigma * gsd : null;

  $('targetResults').innerHTML = `
    <h2 style="margin-top:20px">ターゲット方式</h2>
    <div class="banner ${referenceTargets.length >= 4 ? 'good' : 'warn'}">
      基準画像で <strong>${referenceTargets.length} 点</strong>のターゲットを検出。
      対ごとの距離の σ（中央値）= <strong>${isFinite(medianSigma) ? medianSigma.toFixed(4) : '—'} px</strong>
      ${gsd && isFinite(medianSigma) ? ` = ${(medianSigma * gsd).toFixed(4)} mm` : ''}
      ${limitMM ? `／ 検出限界 3σ = <strong>${limitMM.toFixed(4)} mm</strong>` : ''}
    </div>
    <table style="margin-bottom:12px">
      <tr><th>枚</th><th class="num">検出</th><th class="num">対応付け</th></tr>
      ${detectionRow}
    </table>
    <table>
      <tr><th>対</th><th class="num">平均距離</th><th class="num">σ</th><th class="num">最大−最小</th><th class="num">各枚の値(px)</th></tr>
      ${pairRows}
    </table>
    <p class="note">既知量を動かして撮った場合、「各枚の値」に段差として現れます。
    その段差が既知量と一致すれば、計測系が正しく動いている証拠になります。
    段差を σ と混同しないよう、動かす前後は別々に解析してください。</p>
  `;
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

function renderQuality(q) {
  const cls = q.verdict === 'good' ? 'good' : q.verdict === 'fair' ? 'warn' : 'bad';
  $('quality').innerHTML = `<div class="banner ${cls}">
    テクスチャ判定: <strong>${q.verdict}</strong> — ${escapeHtml(q.reason)}<br>
    <span style="font-size:12px">MIG = ${q.mig.toFixed(5)} / 局所コントラスト = ${q.contrast.toFixed(4)} / 飽和 = ${(q.saturatedRatio * 100).toFixed(1)}%</span>
  </div>`;
}

function renderFrameTable(perFrame, gsd, frames, overall) {
  const rows = perFrame
    .map((f) => {
      const sigmaMM = gsd && isFinite(f.sigma) ? ` (${(f.sigma * gsd).toFixed(4)} mm)` : '';
      return `<tr>
        <td>基準 ↔ ${f.index}</td>
        <td class="num">${f.points}</td>
        <td class="num">${f.rejected}</td>
        <td class="num">${f.shift ? `${Math.round(f.shift.dx)}, ${Math.round(f.shift.dy)}` : '—'}</td>
        <td class="num">${isFinite(f.sigma) ? f.sigma.toFixed(4) + sigmaMM : '<span class="bad">失敗</span>'}</td>
      </tr>`;
    })
    .join('');

  const averaged = overall.sigma / Math.sqrt(frames);
  const note = gsd
    ? `<p class="note">${frames} 枚を平均すると σ は ${averaged.toFixed(4)} px = ${(averaged * gsd).toFixed(4)} mm まで下がります
       （検出限界 3σ = ${(3 * Math.SQRT2 * averaged * gsd).toFixed(4)} mm）。
       この値を下回る変化は、測定ノイズと区別できません。</p>`
    : `<p class="note">${frames} 枚平均で σ = ${averaged.toFixed(4)} px。撮影距離を入力すると mm 換算します。</p>`;

  $('frameTable').innerHTML = `<table>
    <tr><th>組</th><th class="num">測点</th><th class="num">棄却</th>
        <th class="num">粗いずれ(px)</th><th class="num">σ (px)</th></tr>
    ${rows}</table>${note}`;
}

function drawField(field) {
  const canvas = $('fieldCanvas');
  const { roi, residuals: res } = field;
  const width = 880;
  const scale = width / roi.width;
  canvas.width = width;
  canvas.height = Math.round(roi.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d1017';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const magnitudes = res.map((r) => Math.hypot(r.du, r.dv));
  const maxMag = Math.max(...magnitudes, 1e-6);
  // 最大残差が 30px で描かれるように拡大する
  const arrowScale = 30 / maxMag;

  for (const r of res) {
    const x = r.x * scale;
    const y = r.y * scale;
    const mag = Math.hypot(r.du, r.dv);
    const t = mag / maxMag;
    ctx.strokeStyle = `hsl(${(1 - t) * 200}, 80%, 60%)`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + r.du * arrowScale, y + r.dv * arrowScale);
    ctx.stroke();
    ctx.fillStyle = 'rgba(230,234,242,.5)';
    ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
  }

  $('fieldNote').textContent =
    `矢印は実際の ${arrowScale.toFixed(0)} 倍に拡大。最大残差 ${maxMag.toFixed(4)} px。` +
    `方向がランダムならノイズ、揃っていたり渦を巻いていたら、` +
    `変換モデルで取り切れていない歪み（レンズ歪・被写体の実際の動き）が残っています。`;
}

// ------------------------------------------------------------ 補助

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function log(message) {
  $('log').textContent = message;
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// 現場は圏外が普通なので、一度開けば通信なしで使えるようにする。
// file:// で開いた場合は登録できないが、その場合は元々ローカルにある。
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
