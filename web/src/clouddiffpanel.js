/**
 * 点群差分パネル（2時期の面外変化）。
 *
 * 比較シートの後半。写真の比較が面内（き裂の開き・進展）を受け持つのに対し、
 * こちらは基準時期と今回の点群を比べて、**面外**（ブロックの浮き・
 * はらみ出しの進行）だけを抽出する。判定はすべて cloudchange.js
 * （純粋ロジック・検証済み）に任せ、ここは入出力と描画だけを持つ。
 *
 * 点群はツールに保存しない。前回のスキャンをファイルで取っておいて、
 * 毎回ここへ読み込む運用（写真の基準セットと同じ）。
 */

import { parsePointCloud, decimate, estimateUnitScaleToMM } from './pointcloud.js';
import { compareEpochClouds, groupChangedCells } from './cloudchange.js';
import { alignICP, c2cDistances, c2cHeatmap } from './cloudalign.js';

const $ = (id) => document.getElementById(id);

const MAX_POINTS = 250000;

// 位置合わせの残差など、ばらつきに出ない系統誤差の床。
// 写真側の 0.02px と同じ役割。LiDAR の面外なので mm 単位
const FLOOR_MM = 1;

let cloudA = null;   // { points(mm), name, count, format }
let cloudB = null;
let lastOutcome = null;   // 'changed' | 'quiet' | null
let onChange = () => {};

export function initCloudDiffPanel(options = {}) {
  onChange = options.onChange ?? (() => {});

  $('cloudDiffLoadA').addEventListener('click', () => $('cloudDiffInputA').click());
  $('cloudDiffLoadB').addEventListener('click', () => $('cloudDiffInputB').click());
  $('cloudDiffInputA').addEventListener('change', (e) => loadCloud(e, 'A'));
  $('cloudDiffInputB').addEventListener('change', (e) => loadCloud(e, 'B'));
  $('cloudDiffUp').addEventListener('change', (e) => { e.target.dataset.touched = '1'; });
  $('cloudDiffRun').addEventListener('click', run);
}

/** レールのドット用。面外の有意変化=赤 / 変化なし=緑 / 未実行=灰 */
export function cloudDiffLamp() {
  if (lastOutcome === 'changed') return 'bad';
  if (lastOutcome === 'quiet') return 'good';
  return null;
}

async function loadCloud(e, which) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const info = $(which === 'A' ? 'cloudDiffInfoA' : 'cloudDiffInfoB');
  info.textContent = '読み込み中…';
  try {
    const parsed = parsePointCloud(await file.arrayBuffer());
    const points = decimate(parsed.points, MAX_POINTS);
    const unit = estimateUnitScaleToMM(points);
    // 以降の計算は全部 mm に揃える（2つの点群で単位が違っても比べられるように）
    const mm = unit.scale === 1 ? points : Float64Array.from(points, (v) => v * unit.scale);
    const cloud = { points: mm, name: file.name, count: parsed.count, format: parsed.format ?? null };
    if (which === 'A') cloudA = cloud; else cloudB = cloud;
    info.textContent = `${file.name}（${Number(parsed.count).toLocaleString('ja-JP')} 点・${unit.unit}）`;
    // Scaniverse など ARKit 由来の PLY は Y が上、LAS は Z が上のことが多い
    if (!$('cloudDiffUp').dataset.touched) $('cloudDiffUp').value = cloud.format ? 'y' : 'z';
  } catch (err) {
    if (which === 'A') cloudA = null; else cloudB = null;
    info.textContent = `読めませんでした: ${err.message}`;
  }
  onChange();
}

function status(html) {
  $('cloudDiffStatus').innerHTML = html;
}

function banner(kind, title, body) {
  return `<div class="banner ${kind}"><div><b>${title}</b><br>${body}</div></div>`;
}

async function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function run() {
  if (!cloudA || !cloudB) {
    status(banner('warn', '点群が足りません',
      '基準時期（前回）と今回、両方の点群を読み込んでください。'));
    return;
  }

  const cellMM = Math.max(20, parseFloat($('cloudDiffCell').value) || 50);
  const up = $('cloudDiffUp').value === 'y' ? [0, 1, 0] : [0, 0, 1];
  $('cloudDiffRun').disabled = true;
  status('<p class="note">位置合わせと差分を計算中…</p>');
  await tick();

  try {
    const mode = $('cloudDiffMode')?.value ?? 'plane';
    const result = mode === 'c2c'
      ? runC2C(cloudA.points, cloudB.points, cellMM)
      : compareEpochClouds(cloudA.points, cloudB.points, {
        cellSize: cellMM,
        up,
        floor: FLOOR_MM,
        k: 3,
      });
    if (!result.ok) {
      lastOutcome = null;
      status(banner('bad', '比較できませんでした',
        '重なるセルがありません。同じ壁面を同じ側からスキャンしているか確認してください。'));
      return;
    }
    render(result);
  } catch (err) {
    lastOutcome = null;
    status(banner('bad', 'エラー', escapeHtml(err.message)));
    console.error(err);
  } finally {
    $('cloudDiffRun').disabled = false;
    onChange();
  }
}

function render(result) {
  const regions = groupChangedCells(result, { minCells: 3 });
  const grouped = regions.filter((g) => g.grouped);
  const isolated = regions.length - grouped.length;

  lastOutcome = grouped.length ? 'changed' : 'quiet';

  // ── 判定の一枚看板
  let verdict;
  if (grouped.length) {
    const g = grouped[0];
    const dir = g.magnitude >= 0 ? '手前へ（浮き・はらみ出しの進行）' : '奥へ（後退・欠損）';
    verdict = banner('bad', '面外の有意な変化があります',
      `最大の領域: ${(Math.abs(g.magnitude)).toFixed(1)} mm ${dir}、`
      + `${(g.areaSquared / 1e6).toFixed(2)} m²（${g.cellCount} セル）。図で位置を確認してください。`);
  } else {
    verdict = banner('good', '面外の有意な変化はありません',
      `検出限界（平坦部でおよそ ${flatLimitMM(result).toFixed(1)} mm）を超えたまとまりはありません。`
      + (isolated ? `単独セルが ${isolated} 件ありますが、まとまりが無いので参考扱いです。` : ''));
  }

  // 位置合わせの根拠が弱いときは、その前提を明示する
  if (result.registration.mode === 'centroid') {
    verdict += banner('warn', '位置合わせの根拠が弱い',
      '目地や凹凸の模様が足りず、重心合わせで比べています。壁が平坦なら差分への影響は'
      + 'ほぼありませんが、スキャン範囲が2回で大きく違うと差分がずれます。'
      + '毎回同じ範囲をスキャンしてください。');
  }
  if (result.stats.missing > result.stats.evaluated * 0.2) {
    verdict += banner('warn', '欠測が多い',
      `基準にあって今回に無いセルが ${result.stats.missing} 件あります。`
      + 'スキャン範囲のずれか、手前の遮蔽です。判定できていない領域が広いことに注意してください。');
  }

  // ── 数値
  const cells = [
    ['時期またぎ σ', `${(result.sigmaEmp).toFixed(1)} mm`, 'セル差分の実測'],
    ['検出限界の目安', `${flatLimitMM(result).toFixed(1)} mm`, `3σ・平坦部（目地の上は広がる）`],
    ['評価セル', String(result.stats.evaluated), `欠測 ${result.stats.missing}`],
    ['有意な変化', `${grouped.length} 領域`, `単独 ${isolated} 件は参考`],
    ['位置合わせ', result.registration.mode === 'zncc'
      ? `相関 ${result.registration.zncc.toFixed(2)}`
      : result.registration.mode === 'icp'
        ? `ICP 残差 ${result.registration.rms.toFixed(1)} mm`
        : '重心合わせ',
      result.registration.mode === 'icp'
        ? `${result.registration.iterations} 回反復・${result.registration.inlierCount} 点`
        : result.registration.thetaDeg ? `回転 ${result.registration.thetaDeg}°` : '回転なし'],
    ['距離', `${(result.planeA.viewpointDistance / 1000).toFixed(1)} / ${(result.planeB.viewpointDistance / 1000).toFixed(1)} m`,
      '基準 / 今回'],
  ];
  $('cloudDiffStats').innerHTML =
    `<div class="stats">${cells.map(([k, v, sub]) =>
      `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>`
      + `<div class="k" style="margin-top:3px">${sub}</div></div>`).join('')}</div>`
    + regionTable(grouped);

  status(verdict);
  drawMap(result, regions);
}

/**
 * 3D 差分（ICP＋C2C）。平面法と同じ結果の形に整えて、描画・判定を共用する。
 *
 * - 位置合わせは ICP。全点で回すと重いので B は 4万点に間引いて解く
 *   （対応点は全点要らない）。差分は全点で測る
 * - セルの値は最近傍差の**法線成分**の中央値。3D 距離を主値にすると点の間隔
 *   （サンプリング床）が全部乗る
 * - 限界は平面法と同じ: セル値の実測ばらつき ＋ 床 ＋ 段差ぶん
 */
function runC2C(pointsA, pointsB, cellMM) {
  const voxel = Math.max(10, cellMM / 3);
  const icp = alignICP(pointsA, decimate(pointsB, 40000), { cell: voxel, maxDist: voxel * 3 });
  const c2c = c2cDistances(pointsA, pointsB, icp.transform, {
    cell: voxel, maxDist: voxel * 4, normal: icp.planeA.normal,
  });
  const hm = c2cHeatmap(pointsB, c2c, icp.planeA, icp.transform, { cellSize: cellMM });
  const { cols, rows } = hm.grid;

  const finite = [];
  for (const v of hm.values) if (Number.isFinite(v)) finite.push(v);
  if (!finite.length) return { ok: false };
  const med = medianOf(finite);
  const sigmaEmp = 1.4826 * medianOf(finite.map((v) => Math.abs(v - med)));

  // 段差をまたぐセルの限界拡大（平面法と同じ理由）
  const edgeRange = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const idx = r * cols + c;
      let m = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dx, nr = r + dy;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const nb = nr * cols + nc;
        if (Number.isFinite(hm.values[idx]) && Number.isFinite(hm.values[nb])) {
          m = Math.max(m, Math.abs(hm.values[nb] - hm.values[idx]));
        }
      }
      edgeRange[idx] = m;
    }
  }

  const k = 3;
  const dz = new Float64Array(cols * rows).fill(NaN);
  const limit = new Float64Array(cols * rows).fill(NaN);
  const significant = new Uint8Array(cols * rows);
  let evaluated = 0;
  let signif = 0;
  for (let i = 0; i < dz.length; i += 1) {
    if (!Number.isFinite(hm.values[i])) continue;
    evaluated += 1;
    dz[i] = hm.values[i] - med;
    limit[i] = k * Math.sqrt(sigmaEmp ** 2 + FLOOR_MM ** 2) + 0.6 * edgeRange[i];
    if (Math.abs(dz[i]) > limit[i]) { significant[i] = 1; signif += 1; }
  }

  const summary = (p) => ({ rms: p.rms, viewpointDistance: p.viewpointDistance, inlierRatio: p.inlierRatio });
  return {
    ok: true,
    grid: hm.grid,
    e1: hm.e1,
    e2: hm.e2,
    planeA: summary(icp.planeA),
    planeB: summary(icp.planeB),
    registration: { mode: 'icp', rms: icp.rms, iterations: icp.iterations, inlierCount: icp.inlierCount },
    dz, limit, significant,
    sigmaEmp, k, floor: FLOOR_MM,
    stats: { evaluated, significant: signif, missing: c2c.missing },
  };
}

function medianOf(values) {
  const a = Float64Array.from(values).sort();
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** 平坦部の検出限界（mm）。目地・稜線の上はセルごとにさらに広がる。 */
function flatLimitMM(result) {
  return result.k * Math.sqrt(result.sigmaEmp ** 2 + result.floor ** 2);
}

function regionTable(grouped) {
  if (!grouped.length) return '';
  const rows = grouped.slice(0, 12).map((g, i) => `<tr>
    <td>${i + 1}</td>
    <td class="num">${g.magnitude >= 0 ? '+' : '−'}${Math.abs(g.magnitude).toFixed(1)}</td>
    <td>${g.magnitude >= 0 ? '手前' : '奥'}</td>
    <td class="num">${(g.areaSquared / 1e6).toFixed(2)}</td>
    <td class="num">${g.cellCount}</td>
  </tr>`).join('');
  return `<table style="margin-top:10px">
    <thead><tr><th>#</th><th>変化 (mm)</th><th>向き</th><th>面積 (m²)</th><th>セル数</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="note">変化量はピーク周辺 3×3 の平均です。最大セルの値はノイズの上振れを必ず拾うので使いません。</p>`;
}

// 配色は点群シートの面外マップと同じ系統（手前=アンバー〜赤 / 奥=青 / 限界内=地の色）
const FLAT = [38, 48, 42];
const AMBER = [217, 154, 43];
const RED = [201, 86, 78];
const DEEP = [74, 125, 157];
const NOISE_TINT = 0.18;

function drawMap(result, regions) {
  const { cols, rows, cellSize } = result.grid;
  const canvas = $('cloudDiffCanvas');
  canvas.classList.remove('hidden');

  const px = Math.max(2, Math.min(10, Math.floor(760 / cols)));
  canvas.width = cols * px;
  canvas.height = rows * px;
  canvas.style.width = '100%';
  canvas.style.maxWidth = `${cols * px}px`;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0f1512';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 色域は検出限界に合わせる（ノイズの分布に合わせない）
  const flatLimit = flatLimitMM(result);
  const peak = Math.max(...regions.filter((g) => g.grouped).map((g) => Math.abs(g.peak)), 0);
  const span = Math.max(peak, flatLimit * 2);

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c;
      const v = result.dz[i];
      if (!Number.isFinite(v)) continue;   // 未評価・欠測は地のまま（良好と混ぜない）
      const magnitude = Math.abs(v);
      const hue = v >= 0 ? AMBER : DEEP;
      let colour;
      if (!result.significant[i]) {
        colour = lerp(FLAT, hue, Math.min(1, magnitude / flatLimit) * NOISE_TINT);
      } else {
        const foot = lerp(FLAT, hue, NOISE_TINT);
        const t = Math.min(1, (magnitude - flatLimit) / Math.max(span - flatLimit, 1e-9));
        colour = v < 0 ? lerp(foot, DEEP, t)
          : t < 0.6 ? lerp(foot, AMBER, t / 0.6) : lerp(AMBER, RED, (t - 0.6) / 0.4);
      }
      // e2 は上向きなので row を反転して描く
      const y = (rows - 1 - r) * px;
      if (result.significant[i] && !inGroupedRegion(regions, i)) {
        // 単独セルは枠だけ。まとまった領域と格を分ける
        ctx.strokeStyle = `rgb(${colour[0]},${colour[1]},${colour[2]})`;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(c * px + 0.5, y + 0.5, px - 1, px - 1);
      } else {
        ctx.fillStyle = `rgb(${colour[0]},${colour[1]},${colour[2]})`;
        ctx.fillRect(c * px, y, px, px);
      }
    }
  }

  // まとまった領域を囲む
  ctx.strokeStyle = '#f0f4f1';
  ctx.lineWidth = 1.5;
  for (const g of regions.filter((x) => x.grouped)) {
    let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    for (const i of g.cells) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    }
    ctx.strokeRect(minC * px - 1, (rows - 1 - maxR) * px - 1,
      (maxC - minC + 1) * px + 2, (maxR - minR + 1) * px + 2);
  }

  $('cloudDiffLegend').innerHTML =
    `<span style="color:var(--amber)">■</span>→<span style="color:var(--critical)">■</span> 手前へ +${span.toFixed(0)}mm（浮きの進行）`
    + ` &nbsp;·&nbsp; <span style="color:#4a7d9d">■</span> 奥へ −${span.toFixed(0)}mm`
    + ` &nbsp;·&nbsp; 限界 ±${flatLimit.toFixed(1)}mm 以内は淡色`
    + ' &nbsp;·&nbsp; 枠だけ = 単独セル（弱い根拠）'
    + ` &nbsp;·&nbsp; 1セル ${cellSize.toFixed(0)}mm`;
}

function inGroupedRegion(regions, cellIndex) {
  for (const g of regions) {
    if (g.grouped && g.cells.includes(cellIndex)) return true;
  }
  return false;
}

function lerp(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
