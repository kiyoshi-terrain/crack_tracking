// 視差補正の検証。
//
// 画像は使わず、既知の立ち位置のずれと既知の凹凸から「段階1のあとに残るはずの
// 変位場」を作って、それを解き戻せるかを見る。画像を通した端から端までの検証は
// test/parallax-e2e.mjs（時間がかかるので通常の検証には入れない）。

import { cellGeometry, estimateBaselineShift, correctParallax, leverageQuality } from '../src/parallax.js';
import { sampleOutOfPlane } from '../src/pointcloud.js';
import { fitAffine, residuals } from '../src/transform.js';

const F = 700, W = 440, H = 330, D = 5000;
const INTR = { focalLengthPx: F, cx: W / 2, cy: H / 2 };
// カメラ座標系そのもの（x=右, y=下, z=前）。法線は視点側を向ける約束
const PLANE = { normal: [0, 0, -1], offset: D, viewpoint: [0, 0, 0] };
const CAMERA = { eye: [0, 0, 0], forward: [0, 0, 1], right: [1, 0, 0], down: [0, 1, 0] };

function grid(step = 40) {
  const cells = [];
  for (let y = 40; y < H - 40; y += step) for (let x = 40; x < W - 40; x += step) cells.push({ x, y });
  return cells;
}

// 石ごとの不陸。全面がざらついた面（大谷石を想定）
const hash = (i, j) => {
  let s = (Math.imul(i + 1000, 374761393) ^ Math.imul(j + 1000, 668265263)) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 1274126177) >>> 0;
  return (s >>> 8) / 16777216;
};
const roughHeight = (p) => (hash(Math.floor(p[0] / 300), Math.floor(p[1] / 300)) - 0.5) * 40 + 20;
// 画面の一部にだけ出っ張りがある面
const blockHeight = (p) => (p[0] > -700 && p[0] < 300 && p[1] > -600 && p[1] < 400 ? 20 : 0);

function geoFor(cells, heightAt) {
  return cellGeometry(cells, { camera: CAMERA, plane: PLANE, intrinsics: INTR, heightAt, unitScaleToMM: 1 });
}
/** 立ち位置のずれ T から、視差そのもの（段階1で吸われる前）を作る */
function trueField(geo, T) {
  const out = [];
  for (const g of geo) {
    out[g.index] = {
      du: g.g * (-g.f * T.x + g.xc * T.z),
      dv: g.g * (-g.f * T.y + g.yc * T.z),
    };
  }
  return out;
}
function cellsFrom(base, field, extra = () => ({ du: 0, dv: 0 })) {
  return base.map((c, i) => {
    const f = field[i] ?? { du: 0, dv: 0 };
    const e = extra(c, i);
    return { ...c, du: f.du + e.du, dv: f.dv + e.dv, sePx: 0.02, decorrelated: false, illuminationChanged: false };
  });
}
/**
 * 変位場からアフィン成分を落とす。段階1が済んだあとに残る場と同じ形。
 * @returns {Map<index, {du,dv}>}
 */
function nonAffine(cells) {
  const idx = [];
  const pts = [];
  cells.forEach((c, i) => {
    if (c.du == null) return;
    idx.push(i);
    pts.push({ x: c.x, y: c.y, u: c.du, v: c.dv });
  });
  const t = fitAffine(pts);
  const r = residuals(t, pts);
  const out = new Map();
  idx.forEach((i, j) => out.set(i, { du: r[j].du, dv: r[j].dv }));
  return out;
}
function rmsOf(field, keep) {
  let s = 0, n = 0;
  for (const [i, v] of field) {
    if (keep && !keep(i)) continue;
    s += v.du * v.du + v.dv * v.dv; n += 1;
  }
  return n ? Math.sqrt(s / n) : 0;
}

export function runParallaxTests(check, near) {
  console.log('\n== 視差の補正 ==');

  // 幾何。g = 1/Z − 1/Z0 を解析解と突き合わせる
  {
    const cells = [{ x: W / 2, y: H / 2 }];
    const g = geoFor(cells, () => 20)[0];
    // 正対の中心画素なので Z0 = D、Z = D − 20
    check('g が 1/Z − 1/Z0 に一致', near(g.g, 1 / (D - 20) - 1 / D, 1e-12),
      `g=${g.g.toExponential(3)}`);
    check('面外の高さを mm で返す', near(g.heightMM, 20, 1e-9));
    check('平面までの距離を mm で返す', near(g.distanceMM, D, 1e-6));
  }

  const base = grid();
  const geo = geoFor(base, roughHeight);

  // 立ち位置のずれを解き戻す（雑音なし）
  {
    const T = { x: 200, y: -30, z: 120 };
    const cells = cellsFrom(base, trueField(geo, T));
    const fit = estimateBaselineShift(geo, cells);
    check('立ち位置のずれを復元（雑音なし）',
      fit.ok && near(fit.shiftMM.x, T.x, 1) && near(fit.shiftMM.y, T.y, 1) && near(fit.shiftMM.z, T.z, 20),
      fit.ok ? `x ${fit.shiftMM.x.toFixed(1)} y ${fit.shiftMM.y.toFixed(1)} z ${fit.shiftMM.z.toFixed(0)}` : fit.reason);
  }

  // 段階1の当てはめ残り（アフィンのずれ）が乗っても T は動かない
  {
    const T = { x: 200, y: 0, z: 0 };
    const cells = cellsFrom(base, trueField(geo, T), (c) => ({
      du: 0.05 + 0.0002 * (c.x - W / 2), dv: -0.03 + 0.0001 * (c.y - H / 2),
    }));
    const fit = estimateBaselineShift(geo, cells);
    check('アフィンのずれが乗っても T は動かない',
      fit.ok && near(fit.shiftMM.x, T.x, 5),
      fit.ok ? `x ${fit.shiftMM.x.toFixed(1)}` : fit.reason);
  }

  // 雑音のなかで解ける
  {
    const T = { x: 200, y: 0, z: 0 };
    let s = 7 >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
    const cells = cellsFrom(base, trueField(geo, T), () => ({ du: rnd() * 0.06, dv: rnd() * 0.06 }));
    const fit = estimateBaselineShift(geo, cells);
    check('雑音 0.03px のなかで T を復元', fit.ok && near(fit.shiftMM.x, T.x, 25),
      fit.ok ? `x ${fit.shiftMM.x.toFixed(0)} / 真値 200` : fit.reason);
  }

  // 本物の変位を消さない
  {
    const T = { x: 200, y: 0, z: 0 };
    const MOVE = 0.15;   // px
    const moved = (c) => c.x > 240 && c.x < 330 && c.y > 120 && c.y < 210;
    const cells = cellsFrom(base, trueField(geo, T), (c) => (moved(c) ? { du: MOVE, dv: 0 } : { du: 0, dv: 0 }));
    const before = cells.map((c) => ({ ...c }));
    const fit = estimateBaselineShift(geo, cells);
    check('動いたブロックがあっても T を復元', fit.ok && near(fit.shiftMM.x, T.x, 25),
      fit.ok ? `x ${fit.shiftMM.x.toFixed(0)}` : fit.reason);

    const fixed = correctParallax(cells, geo, {});
    check('補正が効いた', fixed.ok && fixed.applied);

    // 段階1が済んだ形（アフィンを除いた場）で前後を比べる
    const isMoved = (i) => moved(base[i]);
    const fieldBefore = nonAffine(before);
    const fieldAfter = nonAffine(cells);
    const restBefore = rmsOf(fieldBefore, (i) => !isMoved(i));
    const restAfter = rmsOf(fieldAfter, (i) => !isMoved(i));
    check('動いていない側の視差が消える', restAfter < restBefore * 0.35,
      `${restBefore.toFixed(4)} → ${restAfter.toFixed(4)} px`);

    const movedAfter = rmsOf(fieldAfter, isMoved);
    check('動いたブロックの変位は残る', movedAfter > MOVE * 0.6,
      `${movedAfter.toFixed(3)} px / 仕込み ${MOVE}`);
    check('補正の標準誤差を返す', cells.filter(moved).every((c) => c.parallaxSePx > 0));
  }

  // 凹凸が一点に偏っていたら断る
  {
    const gBlock = geoFor(base, blockHeight);
    const cells = cellsFrom(base, trueField(gBlock, { x: 200, y: 0, z: 0 }));
    const qBlock = leverageQuality(gBlock, cells);
    const qRough = leverageQuality(geo, cells);
    check('偏った凹凸は coverage が低い', qBlock.coverage < 0.4,
      `coverage ${qBlock.coverage.toFixed(2)} spread ${qBlock.spread.toFixed(2)}`);
    check('全面の凹凸は coverage / spread とも十分', qRough.coverage > 0.4 && qRough.spread > 0.6,
      `coverage ${qRough.coverage.toFixed(2)} spread ${qRough.spread.toFixed(2)}`);
  }

  // 平らな壁では視差そのものが立たない
  {
    const gFlat = geoFor(base, () => 0);
    check('平面では g が 0', gFlat.every((g) => g && g.g === 0));
    const cells = cellsFrom(base, trueField(gFlat, { x: 200, y: 0, z: 0 }));
    const fit = estimateBaselineShift(gFlat, cells);
    check('平面では視差を解こうとしない', !fit.ok, fit.ok ? '解いてしまった' : fit.reason);
  }

  // 点群が届いていないセルは素通りさせる（黙って未補正にしない）
  {
    const cells = cellsFrom(base, trueField(geo, { x: 200, y: 0, z: 0 }));
    const partial = geoFor(base, (p) => (p[0] > 0 ? null : roughHeight(p)));
    const kept = cells.filter((c, i) => !partial[i]).map((c) => c.du);
    const fixed = correctParallax(cells, partial, {});
    const after = cells.filter((c, i) => !partial[i]).map((c) => c.du);
    check('点群の無いセルは触らない',
      fixed.ok && kept.every((v, i) => v === after[i])
      && cells.filter((c, i) => !partial[i]).every((c) => c.parallaxCorrected === false));
  }

  // 面外マップの読み出し
  {
    const map = {
      e1: [1, 0, 0], e2: [0, 1, 0], cols: 3, rows: 3, cellSize: 100,
      originU: 0, originV: 0,
      values: Float64Array.from([0, 10, 20, 0, 10, 20, 0, 10, 20]),
    };
    check('セル中心はその値', near(sampleOutOfPlane(map, 150, 150, 0), 10, 1e-9));
    check('セル間は線形に補間', near(sampleOutOfPlane(map, 200, 150, 0), 15, 1e-9));
    check('範囲外は null', sampleOutOfPlane(map, 900, 150, 0) === null);
    const holed = { ...map, values: Float64Array.from([0, NaN, 20, 0, NaN, 20, 0, NaN, 20]) };
    check('欠測セルは重みから外す', near(sampleOutOfPlane(holed, 200, 150, 0), 20, 1e-9));
  }
}
