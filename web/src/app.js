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
import { speckleQuality } from './speckle.js';

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

async function loadFiles(fileList) {
  const images = fileList.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|tiff?)$/i.test(f.name));
  if (images.length < 2) {
    showFileWarnings(['2枚以上を選んでください。1枚では σ を測れません。']);
    return;
  }
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  log(`${images.length} 枚を読み込み中…`);
  state.files = [];
  const errors = [];
  for (const file of images) {
    try {
      const buffer = await file.arrayBuffer();
      const exif = parseExif(buffer);
      const imageData = await decodeFile(file);
      state.files.push({ file, exif, imageData });
    } catch (error) {
      errors.push(error.message);
    }
  }
  log('');

  if (state.files.length < 2) {
    showFileWarnings(errors.length ? errors : ['読み込めた画像が 2 枚未満です。']);
    return;
  }

  const warnings = [...errors, ...checkConsistency(state.files.map((f) => f.exif))];
  showFileWarnings(warnings);
  renderFileTable();
  setupScale();
  setupPreview();
  $('scaleSection').classList.remove('hidden');
  $('roiSection').classList.remove('hidden');
  $('runSection').classList.remove('hidden');
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

function currentGSD() {
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
  const roi = state.roi;

  log('基準画像を準備中…');
  await tick();
  const reference = toGray(state.files[0].imageData, roi, channel, true);

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
