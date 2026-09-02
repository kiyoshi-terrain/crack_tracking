// node test/parallax-e2e.mjs
//
// 視差補正を、画像を通した端から端までで検証する。
// 合成画像を4枚×2時期ぶん描いて DIC を回すので数分かかる。
// 通常の検証（test/run.mjs）には入れていない。数式だけの検証は test/parallax.mjs。
//
// 面は全面がざらついた大谷石を想定（石材 300mm 角ごとの不陸 ±20mm ＋ うねり）。
// 動くのはそのうち石1個だけ。
//
// 実測（2026-09、距離5m・7.14mm/px）:
//   ① 同じ位置          偽陽性 0/53 → 0/53   推定ずれ 0mm（真値 0）
//   ③ 横に 20cm ずれ    偽陽性 12/47 → 0/47  推定ずれ 170mm（真値 200）
//   ⑥ 石が 1.0mm 動いた 本物 1/1 → 1/1 のまま（0.61mm → 0.62mm）
//   ⑦ ③＋⑥            偽陽性 14/47 → 0/47、本物は残る（0.50mm）
import { makeBlobs, renderBlobs } from './synthetic.mjs';
import { measureEpochChange } from '../src/change.js';
import { downsample } from '../src/image.js';
import { fitWallPlane, outOfPlaneMap, sampleOutOfPlane } from '../src/pointcloud.js';
import { cameraFromPlane } from '../src/surface.js';
import { cellGeometry, correctParallax, leverageQuality } from '../src/parallax.js';

const W = 440, H = 330, F = 700, D0 = 5000;
const MM_PER_TEX = 5, TW = 900, TH = 720;
const blobs = makeBlobs({ width: TW, height: TH, count: 15000, seed: 77 });
const wall = renderBlobs(blobs, TW, TH, { noise: 0.004, seed: 4 });
const sample = (img, x, y) => {
  const x0 = Math.max(0, Math.min(img.width - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(img.height - 2, Math.floor(y)));
  const tx = x - x0, ty = y - y0, i = y0 * img.width + x0;
  return (img.data[i] * (1 - tx) + img.data[i + 1] * tx) * (1 - ty)
    + (img.data[i + img.width] * (1 - tx) + img.data[i + img.width + 1] * tx) * ty;
};

// 面の形。石材 300mm 角ごとの不陸 + うねり。手前が正[mm]
const hash = (i, j) => {
  let s = (Math.imul(i + 1000, 374761393) ^ Math.imul(j + 1000, 668265263)) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 1274126177) >>> 0;
  return (s >>> 8) / 16777216;
};
const STONE = 300;
function height(x, y, amp) {
  const i = Math.floor(x / STONE), j = Math.floor(y / STONE);
  const step = (hash(i, j) - 0.5) * 2 * amp;                   // 石ごとの段差
  const wave = Math.sin(x / 900) * Math.cos(y / 700) * amp * 0.5; // 壁全体のうねり
  return step + wave + amp;
}
const MOVED = { x0: 0, x1: 300, y0: -300, y1: 0 };   // 石1個が動く
const inMoved = (x, y) => x >= MOVED.x0 && x < MOVED.x1 && y >= MOVED.y0 && y < MOVED.y1;

function shoot(cx, cy, amp, seed, move = 0) {
  const data = new Float32Array(W * H);
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let py = 0; py < H; py += 1) {
    for (let px = 0; px < W; px += 1) {
      const ax = (px - W / 2) / F, ay = (py - H / 2) / F;
      // 光線と凹凸面の交点を反復で求める（h << D なので数回で収束）
      let x = cx + ax * D0, y = cy + ay * D0;
      for (let k = 0; k < 3; k += 1) {
        const d = D0 - height(x, y, amp);
        x = cx + ax * d; y = cy + ay * d;
      }
      const tx2 = (move && inMoved(x, y)) ? x - move : x;
      data[py * W + px] = sample(wall, tx2 / MM_PER_TEX + TW / 2, y / MM_PER_TEX + TH / 2) + (rnd() - 0.5) * 0.004;
    }
  }
  return { width: W, height: H, data };
}

function buildCloud(amp) {
  const pts = [];
  let s = 9 >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let y = -1300; y <= 1300; y += 10) {
    for (let x = -1700; x <= 1700; x += 10) {
      pts.push(x, y, D0 - height(x, y, amp) + (rnd() - 0.5) * 4);
    }
  }
  return Float64Array.from(pts);
}

async function run(label, { shift, amp, move = 0 }) {
  const A = shoot(0, 0, amp, 5);
  const Bs = [0, 1, 2, 3].map((i) => shoot(shift + (i - 1.5) * 2, 0, amp, 20 + i, move));
  const r = await measureEpochChange(A, Bs, {
    subsetHalf: 15, step: 45, minZNCC: 0.6, useHomography: true, downsample, coarseScale: 1,
  });
  console.log(label);
  if (!r.ok) { console.log('  解析できず'); return; }

  const cloud = buildCloud(amp);
  const plane = fitWallPlane(cloud, { viewpoint: [0, 0, 0] });
  const map = outOfPlaneMap(cloud, plane, { cellSize: 50, up: [0, -1, 0], minPointsPerCell: 3 });
  const camera = cameraFromPlane(plane, [0, 0, D0], { worldUp: [0, -1, 0] });
  const geo = cellGeometry(r.cells, {
    camera, plane, intrinsics: { focalLengthPx: F, cx: W / 2, cy: H / 2 }, unitScaleToMM: 1,
    heightAt: (p) => sampleOutOfPlane(map, p[0], p[1], p[2]),
  });

  const gsd = D0 / F, mm = (px) => px * gsd;
  const wx = (c) => (c.x - W / 2) / F * D0, wy = (c) => (c.y - H / 2) / F * D0;
  const onMoved = (c) => inMoved(wx(c), wy(c));
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
  const report = (tag) => {
    const cells = r.cells.filter((c) => c.du != null);
    const mov = cells.filter(onMoved), rest = cells.filter((c) => !onMoved(c));
    const sig = (arr) => arr.filter((c) => c.significant).length;
    console.log(`  ${tag}  動いた石 ${sig(mov)}/${mov.length} 有意 中央 ${mm(med(mov.map((c) => c.magnitudePx ?? 0))).toFixed(2)}mm`
      + ` | その他 ${sig(rest)}/${rest.length} 有意 中央 ${mm(med(rest.map((c) => c.magnitudePx ?? 0))).toFixed(3)}mm`
      + ` 最大 ${mm(Math.max(0, ...rest.map((c) => c.magnitudePx ?? 0))).toFixed(2)}mm`);
  };
  report('補正なし');
  const q = leverageQuality(geo, r.cells);
  console.log(`  視差の効き: coverage ${q.coverage.toFixed(2)} spread ${q.spread.toFixed(2)} 効くセル ${q.carrying}/${q.total} 感度 ${(q.maxLeverage*1000).toFixed(2)}px/m`);
  const fix = correctParallax(r.cells, geo, { useHomography: true });
  if (!fix.ok) { console.log(`  補正できず: ${fix.reason}`); return; }
  for (const c of r.cells) {
    if (c.du == null) continue;
    const se = Math.hypot(c.sePx, c.parallaxSePx ?? 0);
    c.significant = !c.decorrelated && !c.illuminationChanged && se > 0 && c.magnitudePx > r.k * se;
  }
  report('補正あり');
  console.log(`  推定ずれ x ${fix.shiftMM.x.toFixed(0)} y ${fix.shiftMM.y.toFixed(0)} z ${fix.shiftMM.z.toFixed(0)} mm`
    + `（真値 x ${shift}）  場のRMS ${mm(fix.beforeRmsPx).toFixed(3)}→${mm(fix.afterRmsPx).toFixed(3)}mm`);
}

console.log(`距離 5m・${(D0 / F).toFixed(2)} mm/px・全面が凹凸（振幅 ±20mm）\n`);
await run('① 同じ位置（対照）', { shift: 0, amp: 20 });
await run('③ 横に 20cm ずれ', { shift: 200, amp: 20 });
await run('⑥ 同じ位置 + 石が 1.0mm 動いた', { shift: 0, amp: 20, move: 1.0 });
await run('⑦ 横 20cm + 石が 1.0mm 動いた', { shift: 200, amp: 20, move: 1.0 });
