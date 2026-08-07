/**
 * 点群パネル。
 *
 * 写真と点群の「良いとこどり」の UI 側。点群がやるのは2つだけです。
 *
 * 1. **スケールを渡す** — 平面までの距離と斜角から mm/px を厳密に出す。
 *    レーザー距離計も焦点距離の手入力も要らなくなる
 * 2. **面外を測る** — 石材が手前にはらみ出していないか。写真には出ない量
 *
 * 面内（き裂の開き）は一切やりません。点群では2桁足りないからです。
 */

import {
  parsePointCloud, decimate, estimateUnitScaleToMM,
  fitWallPlane, outOfPlaneMap, findBulges, bounds,
} from './pointcloud.js';
import { cameraFromPlane, pixelScale, frameScaleSummary } from './surface.js';

const $ = (id) => document.getElementById(id);

// ブラウザで回す上限。これ以上は等間隔で間引く（結果の再現性のため乱数は使わない）
const MAX_POINTS = 250000;

export const cloudState = {
  plane: null,
  camera: null,
  map: null,
  bulges: null,
  unit: null,
  centroid: null,
  scale: null,      // frameScaleSummary の戻り値
  fileName: null,
};

let onChange = () => {};
let getIntrinsics = () => null;

export function initCloudPanel(options = {}) {
  onChange = options.onChange ?? (() => {});
  getIntrinsics = options.getIntrinsics ?? (() => null);

  $('cloudBtn').addEventListener('click', () => $('cloudInput').click());
  $('cloudInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadCloud(file);
    e.target.value = '';
  });
  $('cloudUp').addEventListener('change', (e) => {
    e.target.dataset.touched = '1';
    if (cloudState.plane) recompute();
  });
  $('cloudCell').addEventListener('input', () => { if (cloudState.plane) recompute(); });
  $('cloudClear').addEventListener('click', clearCloud);
}

/** 写真が読み込まれた／焦点距離が変わったときに呼ぶ。 */
export function refreshCloudScale() {
  if (!cloudState.plane) return;
  computeScale();
  renderSummary();
}

/** 点群から決めた mm/px。写真が無ければ null。 */
export function cloudGSD() {
  return cloudState.scale?.centre?.mmPerPx ?? null;
}

function clearCloud() {
  Object.keys(cloudState).forEach((k) => { cloudState[k] = null; });
  $('cloudSummary').innerHTML = '';
  $('cloudResults').classList.add('hidden');
  $('cloudControls').classList.add('hidden');
  onChange();
}

async function loadCloud(file) {
  $('cloudSummary').innerHTML = '<p class="note">読み込み中…</p>';
  try {
    const buffer = await file.arrayBuffer();
    const parsed = parsePointCloud(buffer);

    const points = decimate(parsed.points, MAX_POINTS);
    const unit = estimateUnitScaleToMM(points);

    cloudState.fileName = file.name;
    cloudState.rawCount = parsed.count;
    cloudState.points = points;
    cloudState.unit = unit;

    // Scaniverse など ARKit 由来の PLY は Y が上、LAS は Z が上のことが多い。
    // 形式から推すだけで、外しても測定値は変わらない（図の向きだけ）。
    // 一度でも手で選ばれていたらその選択を尊重する。
    if (!$('cloudUp').dataset.touched) $('cloudUp').value = parsed.format ? 'y' : 'z';

    $('cloudControls').classList.remove('hidden');
    recompute();
  } catch (err) {
    $('cloudSummary').innerHTML = `<div class="banner bad"><div><b>点群を読めませんでした</b><br>${escapeHtml(err.message)}</div></div>`;
    $('cloudResults').classList.add('hidden');
  }
}

function recompute() {
  const points = cloudState.points;
  if (!points) return;

  const up = $('cloudUp').value === 'y' ? [0, 1, 0] : [0, 0, 1];

  // 視点は原点。Scaniverse の座標原点はスキャン開始地点なので、
  // 「スキャンを始めた場所から写真を撮る」手順を前提にしている。
  const plane = fitWallPlane(points, { viewpoint: [0, 0, 0] });
  cloudState.plane = plane;
  cloudState.centroid = centroidOf(points);
  cloudState.camera = cameraFromPlane(plane, cloudState.centroid, { worldUp: up });

  // セルの大きさは mm 指定。大谷石は 1個 300〜900mm なので、その 1/6 前後が既定
  const cellMM = Math.max(5, parseFloat($('cloudCell').value) || 50);
  const cell = cellMM / cloudState.unit.scale;

  cloudState.map = outOfPlaneMap(points, plane, { cellSize: cell, minPointsPerCell: 3 });

  // しきい値は面そのもののばらつきから決める。σ実測と同じ考え方で、
  // 「この点群で何 mm の出っ張りなら本物と言えるか」を点群自身に決めさせる。
  const threshold = 3 * plane.rms;
  cloudState.bulges = findBulges(cloudState.map, { threshold, minCells: 3 });
  cloudState.threshold = threshold;

  computeScale();
  renderSummary();
  renderMap();
  renderBulgeTable();
  $('cloudResults').classList.remove('hidden');
  onChange();
}

function computeScale() {
  const intr = getIntrinsics();
  if (!intr || !cloudState.plane) { cloudState.scale = null; return; }
  cloudState.scale = frameScaleSummary(
    cloudState.camera, cloudState.plane, intr,
    intr.width, intr.height, cloudState.unit.scale
  );
}

function centroidOf(points) {
  const c = [0, 0, 0];
  const n = points.length / 3;
  for (let p = 0; p < points.length; p += 3) {
    c[0] += points[p]; c[1] += points[p + 1]; c[2] += points[p + 2];
  }
  return c.map((v) => v / n);
}

// ---------------------------------------------------------------- 表示

function renderSummary() {
  const { plane, unit, scale } = cloudState;
  if (!plane) return;
  const toMM = unit.scale;

  const cells = [
    ['点数', `${fmtInt(cloudState.rawCount)}${cloudState.rawCount > cloudState.points.length / 3 ? ` → ${fmtInt(cloudState.points.length / 3)}` : ''}`, '間引き後'],
    ['撮影距離', `${(plane.viewpointDistance * toMM / 1000).toFixed(2)} m`, '視点から面まで'],
    ['面の粗さ', `${(plane.rms * toMM).toFixed(1)} mm`, '平面からの RMS'],
    ['採用点', `${(plane.inlierRatio * 100).toFixed(0)} %`, '植生などを除外'],
  ];

  if (scale?.centre) {
    cells.push(['斜角', `${scale.centre.obliquityDeg.toFixed(1)}°`, '面と視線']);
    cells.push(['mm/px', `${scale.centre.mmPerPx.toFixed(4)}`, '画面中央']);
    cells.push(['異方性', `${scale.anisotropy.toFixed(3)}`, '縦横の比']);
    cells.push(['画面内の変動', `${scale.variation.toFixed(2)} 倍`, '端と中央']);
  }

  let warn = '';
  if (scale?.centre && scale.centre.obliquityDeg > 30) {
    const naive = scale.centre.distanceMM / (getIntrinsics()?.focalLengthPx ?? 1);
    const bias = (scale.centre.mmPerPxX - naive) / naive;
    warn += banner('warn', '斜めに構えています',
      `斜角 ${scale.centre.obliquityDeg.toFixed(0)}°。距離と焦点距離だけで mm/px を出すと`
      + ` <b>${(bias * 100).toFixed(0)}% 過小</b>に評価します。点群を使えばこの補正は入っています。`);
  }
  if (scale && scale.variation > 1.3) {
    warn += banner('warn', '画面内でスケールが一定でありません',
      `端と中央で ${scale.variation.toFixed(1)} 倍違います。き裂は画面中央付近に入れて撮ってください。`);
  }
  if (plane.inlierRatio < 0.6) {
    warn += banner('warn', '平面に乗らない点が多い',
      `採用点が ${(plane.inlierRatio * 100).toFixed(0)}% しかありません。`
      + '手前の植生や別の面を一緒に掴んでいる可能性があります。');
  }

  $('cloudSummary').innerHTML =
    `<div class="stats">${cells.map(([k, v, s]) => statCell(k, v, s)).join('')}</div>${warn}`;
}

function statCell(label, value, sub) {
  return `<div class="stat"><div class="k">${escapeHtml(label)}</div>`
    + `<div class="v">${value}</div>`
    + `<div class="k" style="margin-top:3px">${escapeHtml(sub)}</div></div>`;
}

function banner(kind, title, body) {
  return `<div class="banner ${kind}" style="margin-top:10px"><div><b>${title}</b><br>${body}</div></div>`;
}

/**
 * 面外マップを描く。
 *
 * 発散配色。手前（はらみ出し）をアンバー〜赤、奥をくすんだ青緑に振る。
 * 中央は地の色に溶かして、平らなところが目立たないようにしてある。
 */
function renderMap() {
  const map = cloudState.map;
  const canvas = $('bulgeCanvas');
  if (!map) return;

  const toMM = cloudState.unit.scale;
  const base = cloudState.bulges.base;

  // 色域の上端は「検出したはらみ出しの最大値」。ノイズの分布に合わせると
  // ±1.8mm のばらつきが全面フルカラーになり、本命の 20mm と同じ強さで描かれてしまう。
  const threshold = cloudState.threshold;
  const peak = cloudState.bulges.regions[0]?.peak ?? 0;
  const span = Math.max(peak, threshold * 2);

  const px = Math.max(2, Math.min(10, Math.floor(760 / map.cols)));
  canvas.width = map.cols * px;
  canvas.height = map.rows * px;
  canvas.style.width = '100%';
  canvas.style.maxWidth = `${map.cols * px}px`;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0f1512';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let row = 0; row < map.rows; row += 1) {
    for (let col = 0; col < map.cols; col += 1) {
      const v = map.values[row * map.cols + col];
      if (!Number.isFinite(v)) continue;
      ctx.fillStyle = cellColor(v - base, threshold, span);
      // e2 は上向きなので、row を反転して描かないと図が上下逆になる
      ctx.fillRect(col * px, (map.rows - 1 - row) * px, px, px);
    }
  }

  // 検出したはらみ出しを囲む
  ctx.strokeStyle = '#f0f4f1';
  ctx.lineWidth = 1.5;
  for (const r of cloudState.bulges.regions) {
    let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    for (const c of r.cells) {
      const col = c % map.cols, row = Math.floor(c / map.cols);
      minC = Math.min(minC, col); maxC = Math.max(maxC, col);
      minR = Math.min(minR, row); maxR = Math.max(maxR, row);
    }
    ctx.strokeRect(
      minC * px - 1,
      (map.rows - 1 - maxR) * px - 1,
      (maxC - minC + 1) * px + 2,
      (maxR - minR + 1) * px + 2
    );
  }

  $('bulgeLegend').innerHTML =
    `<span style="color:var(--critical)">■</span> 手前 +${(span * toMM).toFixed(0)}mm`
    + ` &nbsp;·&nbsp; <span style="color:var(--ink-dim)">■</span> 検出限界 ±${(threshold * toMM).toFixed(1)}mm 以内`
    + ` &nbsp;·&nbsp; <span style="color:#4a7d9d">■</span> 奥 −${(span * toMM).toFixed(0)}mm`
    + ` &nbsp;·&nbsp; 1セル ${(map.cellSize * toMM).toFixed(0)}mm`;
}

const FLAT = [38, 48, 42];      // 面上（地の色に近い）
const AMBER = [217, 154, 43];
const RED = [201, 86, 78];
const DEEP = [74, 125, 157];    // 奥へ引っ込んでいる

// 検出限界以下の帯をどこまで色づけるか。0 にすると面の肌が全く見えなくなるので、
// 「あることは分かるが主張はしない」程度に留める
const NOISE_TINT = 0.18;

/**
 * セルの色。**検出限界を境に配色を切り替える**のが要点。
 *
 * ノイズの分布に色域を合わせると、測れていないばらつきが全面フルカラーになり、
 * 本物のはらみ出しと同じ強さで描かれてしまう。σ実測ツール全体の考え方
 * （3σ 以下は「無い」と扱う）と揃えて、限界以下は淡く潰す。
 */
function cellColor(delta, threshold, span) {
  const magnitude = Math.abs(delta);
  const hue = delta >= 0 ? AMBER : DEEP;

  if (magnitude < threshold) {
    return rgb(lerp(FLAT, hue, (magnitude / threshold) * NOISE_TINT));
  }

  const foot = lerp(FLAT, hue, NOISE_TINT);
  const t = Math.min(1, (magnitude - threshold) / Math.max(span - threshold, 1e-12));
  if (delta < 0) return rgb(lerp(foot, DEEP, t));
  // 手前側だけ、上端で赤へ抜けるようにして「出ている」ことを目立たせる
  return t < 0.6 ? rgb(lerp(foot, AMBER, t / 0.6)) : rgb(lerp(AMBER, RED, (t - 0.6) / 0.4));
}

function lerp(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

function rgb(c) {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function renderBulgeTable() {
  const { bulges, map, unit, threshold } = cloudState;
  const toMM = unit.scale;

  if (!bulges.regions.length) {
    $('bulgeTable').innerHTML =
      `<p class="note">面の粗さ ${(cloudState.plane.rms * toMM).toFixed(1)}mm に対し、`
      + `その 3倍（${(threshold * toMM).toFixed(1)}mm）を超えるまとまったはらみ出しはありません。</p>`;
    return;
  }

  const rows = bulges.regions.slice(0, 12).map((r, i) => {
    const areaMM2 = r.areaSquared * toMM * toMM;
    return `<tr>
      <td>${i + 1}</td>
      <td class="num">${(r.peak * toMM).toFixed(1)}</td>
      <td class="num">${(areaMM2 / 1e6).toFixed(3)}</td>
      <td class="num">${r.cellCount}</td>
    </tr>`;
  }).join('');

  $('bulgeTable').innerHTML = `
    <p class="note">面の粗さ ${(cloudState.plane.rms * toMM).toFixed(1)}mm の 3倍
      （${(threshold * toMM).toFixed(1)}mm）を超えたまとまりだけを挙げています。
      LiDAR の面外精度はもともと 5〜15mm なので、これ以下は判定できません。</p>
    <table>
      <thead><tr><th>#</th><th>出っ張り (mm)</th><th>面積 (m²)</th><th>セル数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function fmtInt(n) {
  return Number(n).toLocaleString('ja-JP');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export { bounds };
