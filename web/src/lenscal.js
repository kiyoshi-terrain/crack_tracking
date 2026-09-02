/**
 * レンズ歪みの推定と補正。
 *
 * 完全なカメラ校正（Zhang 法）はしない。焦点距離はメーカーの仕様値で分かっており、
 * 主点は中心に置いてよい。実験で問題になったのは
 * **2時期の姿勢差があるときにホモグラフィで吸い切れない放射歪みの残り**だけなので、
 * そこだけを狙う。
 *
 * 合成検証（歪み 2%）:
 *   再訪が良好（0.4°・画面幅の 1%）なら偽陽性 0 / 79 セル
 *   姿勢差が中程度（2°・7%）で 44 / 71 セルが偽陽性
 * つまり効くのは「歪み × 姿勢差」で、歪みだけでは害が出ない。
 *
 * ## 解き方
 *
 * 平面の格子を撮ると、像は「ホモグラフィ → 歪み」の合成になる。
 * ホモグラフィは直線を直線に写すので、**格子が曲がって写っていれば
 * その曲がりは歪みしかない**。1枚でも係数は決まる（プラムライン法）。
 *
 * 係数を振り、その都度ホモグラフィを**厳密に**解いて残差を測り、最小の係数を採る。
 * 内側が線形解なので素直に決まる。相関の最大点を探す方式（レンズ倍率の実測でやって
 * 実機で誤った値を出した）とは性質が違う。
 *
 * ## 係数の向き
 *
 * 観測画素 → 理想画素 の**補正**多項式として持つ。逆向き（理想→観測）で持つと
 * 使うたびに反復が要る。ここでは常に補正の向きにしか使わないので、この形が素直。
 *
 *   ideal = centre + (observed − centre) × (1 + k1·r² + k2·r⁴)
 *   r = |observed − centre| / R,  R = 半対角（画面の隅で r = 1）
 */

import { fitHomography, applyHomography } from './transform.js';

/** 正規化半径。画面の隅で r = 1 になるように半対角を採る。 */
export function normRadius(width, height) {
  return Math.hypot(width, height) / 2;
}

/** 観測画素 → 理想画素。k1 > 0 が樽型の補正。 */
export function undistortPoint(x, y, k, frame) {
  const cx = frame.cx ?? frame.width / 2;
  const cy = frame.cy ?? frame.height / 2;
  const R = frame.R ?? normRadius(frame.width, frame.height);
  const dx = x - cx;
  const dy = y - cy;
  const r2 = (dx * dx + dy * dy) / (R * R);
  const f = 1 + (k.k1 ?? 0) * r2 + (k.k2 ?? 0) * r2 * r2;
  return [cx + dx * f, cy + dy * f];
}

/** 係数が実質ゼロなら補正しない（呼び出し側の分岐を減らす） */
export function isIdentity(k) {
  return !k || (!(Math.abs(k.k1 ?? 0) > 1e-9) && !(Math.abs(k.k2 ?? 0) > 1e-9));
}

/** ある係数のときの残差 RMS と、そのときのホモグラフィ */
function fitOne(observed, world, k, frame) {
  const pts = [];
  for (let i = 0; i < observed.length; i += 1) {
    const [ux, uy] = undistortPoint(observed[i].x, observed[i].y, k, frame);
    pts.push({ x: world[i].x, y: world[i].y, u: ux - world[i].x, v: uy - world[i].y });
  }
  const H = fitHomography(pts);
  if (!H) return { rms: Infinity, H: null };
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [px, py] = applyHomography(H, world[i].x, world[i].y);
    const [ux, uy] = undistortPoint(observed[i].x, observed[i].y, k, frame);
    sum += (px - ux) ** 2 + (py - uy) ** 2;
  }
  return { rms: Math.sqrt(sum / pts.length), H };
}

/** 1次元の走査＋放物線内挿。ホモグラフィを内側で厳密に解くので、素直な谷になる */
function search1d(evalAt, lo, hi, steps) {
  let best = { v: lo, r: Infinity };
  const grid = [];
  for (let i = 0; i <= steps; i += 1) {
    const v = lo + (hi - lo) * (i / steps);
    const r = evalAt(v);
    grid.push({ v, r });
    if (r < best.r) best = { v, r };
  }
  const k = grid.findIndex((g) => g.v === best.v);
  if (k > 0 && k < grid.length - 1) {
    const a = grid[k - 1].r, b = grid[k].r, c = grid[k + 1].r;
    const den = a - 2 * b + c;
    if (Math.abs(den) > 1e-15) {
      const d = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
      const v = best.v + d * (hi - lo) / steps;
      const r = evalAt(v);
      if (r < best.r) best = { v, r };
    }
  }
  return best.v;
}

/**
 * 2次元の直接探索（Nelder–Mead）。
 * r² と r⁴ は形が似ていて残差の谷が斜めに伸びるので、係数を1次元ずつ動かすと
 * 谷を這い上がれない（実際に k1 −0.05 を −0.042 と誤った）。
 * 斜めに進める方法が要る。微分は不要なのでこれで足りる。
 */
function nelderMead(f, start, step, iterations = 200) {
  let simplex = [
    start,
    [start[0] + step[0], start[1]],
    [start[0], start[1] + step[1]],
  ].map((p) => ({ p, v: f(p) }));
  const add = (a, b, t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  for (let it = 0; it < iterations; it += 1) {
    simplex.sort((a, b) => a.v - b.v);
    const [best, mid, worst] = simplex;
    if (Math.abs(worst.v - best.v) < 1e-14) break;
    const centroid = [(best.p[0] + mid.p[0]) / 2, (best.p[1] + mid.p[1]) / 2];
    const refl = { p: add(centroid, worst.p, -1), v: 0 };
    refl.v = f(refl.p);
    if (refl.v < best.v) {
      const exp = { p: add(centroid, worst.p, -2), v: 0 };
      exp.v = f(exp.p);
      simplex[2] = exp.v < refl.v ? exp : refl;
    } else if (refl.v < mid.v) {
      simplex[2] = refl;
    } else {
      const con = { p: add(centroid, worst.p, 0.5), v: 0 };
      con.v = f(con.p);
      if (con.v < worst.v) simplex[2] = con;
      else {
        simplex = simplex.map((s2, i) => (i === 0 ? s2
          : { p: add(best.p, s2.p, 0.5), v: f(add(best.p, s2.p, 0.5)) }));
      }
    }
  }
  simplex.sort((a, b) => a.v - b.v);
  return simplex[0];
}

/**
 * 平面格子の1枚（または複数枚）から歪み係数を推定する。
 *
 * 係数を仮に置けばホモグラフィは線形に厳密に解けるので、残差は係数だけの関数になる。
 * その関数の谷を探す。まず k1 だけを走査で決め、k2 も使うならそこを起点に
 * 2次元で詰める。
 *
 * @param {Array<{observed: Array<{x,y}>, world: Array<{x,y}>}>} views
 *        観測点と設計座標の組。設計座標の単位は任意（ホモグラフィが吸う）
 * @param {{width:number, height:number, cx?:number, cy?:number}} frame
 * @param {{useK2?: boolean}} options
 * @returns {{k1:number, k2:number, rmsPx:number, rmsBeforePx:number, points:number}|null}
 */
export function estimateDistortion(views, frame, options = {}) {
  const useK2 = options.useK2 ?? true;
  const list = (Array.isArray(views) ? views : [views])
    .filter((v) => v && v.observed?.length >= 6 && v.observed.length === v.world.length);
  if (!list.length) return null;
  const points = list.reduce((s, v) => s + v.observed.length, 0);

  const totalRms = (k) => {
    let sum = 0;
    let n = 0;
    for (const v of list) {
      const { rms } = fitOne(v.observed, v.world, k, frame);
      if (!Number.isFinite(rms)) return Infinity;
      sum += rms * rms * v.observed.length;
      n += v.observed.length;
    }
    return n ? Math.sqrt(sum / n) : Infinity;
  };

  const before = totalRms({ k1: 0, k2: 0 });
  // iPhone 級は |k1| < 0.1 に収まるが、広角アダプタ等も想定して広めに取る
  let k1 = search1d((v) => totalRms({ k1: v, k2: 0 }), -0.35, 0.35, 70);
  k1 = search1d((v) => totalRms({ k1: v, k2: 0 }), k1 - 0.012, k1 + 0.012, 48);
  let k = { k1, k2: 0 };
  if (useK2) {
    const found = nelderMead(
      ([a, b]) => totalRms({ k1: a, k2: b }), [k1, 0], [0.004, 0.004]
    );
    if (found.v < totalRms(k)) k = { k1: found.p[0], k2: found.p[1] };
  }
  const after = totalRms(k);
  // 改善しないなら係数を付けない。無理に当てて偽の補正を入れない
  if (!(after < before)) {
    return { k1: 0, k2: 0, rmsPx: before, rmsBeforePx: before, points };
  }
  return { k1: k.k1, k2: k.k2, rmsPx: after, rmsBeforePx: before, points };
}

/**
 * 検出した点を格子の並びに直す。
 *
 * 用紙をだいたい正対・正立で撮ってもらう前提。行ごとに切って左から並べる。
 * 期待した数に合わなければ null を返す（黙って間違った対応を作らない）。
 */
export function orderGrid(targets, cols, rows) {
  if (!Array.isArray(targets) || targets.length !== cols * rows) {
    return { ok: false, reason: `点が ${targets?.length ?? 0} 個です（${cols}×${rows}=${cols * rows} 個必要）` };
  }
  const byY = [...targets].sort((a, b) => a.y - b.y);
  const ordered = [];
  for (let r = 0; r < rows; r += 1) {
    const row = byY.slice(r * cols, (r + 1) * cols).sort((a, b) => a.x - b.x);
    // 行の中で y がばらつきすぎていたら、行の切り方を間違えている
    const ys = row.map((p) => p.y);
    const spread = Math.max(...ys) - Math.min(...ys);
    const rowGap = rows > 1 ? (byY[byY.length - 1].y - byY[0].y) / (rows - 1) : Infinity;
    if (spread > rowGap * 0.7) {
      return { ok: false, reason: '格子の行を判別できません。用紙を正対・正立で撮り直してください' };
    }
    ordered.push(...row);
  }
  return { ok: true, points: ordered };
}

/**
 * 設計座標（列・行の番号）を作る。単位は任意でよく、ホモグラフィが吸う。
 */
export function gridWorld(cols, rows) {
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) out.push({ x: c, y: r });
  }
  return out;
}
