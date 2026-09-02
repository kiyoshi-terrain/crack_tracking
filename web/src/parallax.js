/**
 * 立ち位置のずれが作る「見かけの変位」を、点群の凹凸から計算して差し引く。
 *
 * ## なぜ要るか
 *
 * 段階1のホモグラフィは**平面を厳密に合わせられる**。カメラがどれだけ動いても、
 * 平らな壁なら 1枚の射影変換でぴったり重なる。ところが面から出っ張った部分は
 * 合わない。出っ張りの上の点は、平面上の点とは違う速さで画面を動くからです。
 *
 *     見かけの変位 ≒ 立ち位置のずれ × 凹凸の高さ ÷ 撮影距離
 *
 * 5m・凹凸 20mm・横 20cm のずれで 0.54mm（合成検証の実測値）。
 * 面内の検出限界 0.1mm の 5倍で、**本物の進行と区別がつきません**。
 * 再訪ガイドは画像の一致しか見ないので、これを止められない（並進と回転は
 * 小角度でほぼ縮退するため、画像が合っていても横にずれていることがある）。
 *
 * ## どう消すか
 *
 * 消すのに必要なのは面の形です。カメラが T だけ動いたとき、奥行き Z の点の
 * 画像上の動きは
 *
 *     d(Z) = (1/Z)·( −f·Tx + x·Tz ,  −f·Ty + y·Tz )
 *
 * 平面は段階1が吸うので、残るのは平面との差だけ：
 *
 *     残差 = d(Z) − d(Z0) = g·( −f·Tx + x·Tz ,  −f·Ty + y·Tz ),   g = 1/Z − 1/Z0
 *
 * g は点群から決まる**既知量**（Z0 は平面までの奥行き、Z は凹凸の分だけ手前）。
 * つまり残差は T について**線形**で、未知数はたった3つ。セルは数十あるので
 * 最小二乗で T が解ける。**立ち位置を測る機材が要らない**のはここです。
 * 視差そのものが「どれだけ横にずれたか」を語っている。
 *
 * ## 段階1が吸った分を二重に引かない
 *
 * 段階1のホモグラフィは、視差のうち**射影で表せる成分も一緒に吸っています**。
 * 素朴に g·A を引くと、その分を二重に引いてしまう。なので補正量は
 * 「視差モデルから、段階1と同じ変換モデルで表せる成分を落としたもの」にします。
 * 当てはめの側にも同じ自由度をダミーとして入れておく（そうしないと T が偏る）。
 *
 * ## 補正の誤差は限界に足す
 *
 * 引き算した以上、その推定誤差は判定の限界に乗ります。文献の係数を借りずに
 * 測点自身のデータから温度係数を出して標準誤差を足すのと同じ扱いで、
 * ここでもモデルの標準誤差をセルごとに返します。
 */

import { rayThroughPixel, intersectPlane } from './surface.js';

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/**
 * 連立一次方程式（正規方程式）を列スケーリング付きで解く。
 *
 * 列の大きさが桁違い（g は 1e-6 級、画素座標は 1e3 級）なので、
 * 素のまま正規方程式を作ると条件数が 1e18 になって解けない。
 * 対角で正規化してから解き、最後に戻す。
 *
 * @returns {{x: number[], inv: number[][], scale: number[]}|null}
 *          inv は正規化後の (XᵀWX)⁻¹（標準誤差に使う）
 */
function solveNormal(rows, m, ridge = 1e-12) {
  const N = Array.from({ length: m }, () => new Float64Array(m));
  const b = new Float64Array(m);
  for (const r of rows) {
    const w = r.w;
    if (!(w > 0)) continue;
    for (let i = 0; i < m; i += 1) {
      const ai = r.a[i];
      if (ai === 0) continue;
      b[i] += w * ai * r.y;
      for (let j = i; j < m; j += 1) N[i][j] += w * ai * r.a[j];
    }
  }
  for (let i = 0; i < m; i += 1) for (let j = 0; j < i; j += 1) N[i][j] = N[j][i];

  const scale = new Float64Array(m);
  for (let i = 0; i < m; i += 1) scale[i] = Math.sqrt(N[i][i]) || 1;

  // 正規化した行列に単位行列を並べて Gauss-Jordan（逆行列も同時に得る）
  const aug = Array.from({ length: m }, (_, i) => {
    const row = new Float64Array(m * 2);
    for (let j = 0; j < m; j += 1) row[j] = N[i][j] / (scale[i] * scale[j]);
    row[i] += ridge;
    row[m + i] = 1;
    return row;
  });
  const rhs = new Float64Array(m);
  for (let i = 0; i < m; i += 1) rhs[i] = b[i] / scale[i];

  for (let col = 0; col < m; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < m; r += 1) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r;
    }
    if (Math.abs(aug[pivot][col]) < 1e-11) return null;
    if (pivot !== col) {
      const t = aug[pivot]; aug[pivot] = aug[col]; aug[col] = t;
      const tv = rhs[pivot]; rhs[pivot] = rhs[col]; rhs[col] = tv;
    }
    const d = aug[col][col];
    for (let k = 0; k < m * 2; k += 1) aug[col][k] /= d;
    rhs[col] /= d;
    for (let r = 0; r < m; r += 1) {
      if (r === col) continue;
      const f = aug[r][col];
      if (f === 0) continue;
      for (let k = 0; k < m * 2; k += 1) aug[r][k] -= f * aug[col][k];
      rhs[r] -= f * rhs[col];
    }
  }

  const x = new Array(m);
  for (let i = 0; i < m; i += 1) x[i] = rhs[i] / scale[i];
  const inv = Array.from({ length: m }, (_, i) => {
    const row = new Float64Array(m);
    for (let j = 0; j < m; j += 1) row[j] = aug[i][m + j];
    return row;
  });
  return { x, inv, scale };
}

/**
 * セルごとの視差の幾何を組み立てる。
 *
 * @param {Array<{x:number,y:number}>} cells 画像座標のセル
 * @param {object} options
 *   - camera      cameraFromPlane の戻り値（eye/forward/right/down）
 *   - plane       fitWallPlane の戻り値（法線は視点側を向いていること）
 *   - intrinsics  {focalLengthPx, cx, cy}
 *   - heightAt    (worldPoint) => 面外の高さ[点群の単位]（手前が正）。null 可
 *   - unitScaleToMM 点群の単位 → mm
 * @returns {Array<{index:number,g:number,xc:number,yc:number,heightMM:number,distanceMM:number}|null>}
 */
export function cellGeometry(cells, {
  camera, plane, intrinsics, heightAt, unitScaleToMM = 1000,
} = {}) {
  const { focalLengthPx: f, cx, cy } = intrinsics;
  const n = plane.normal;
  return cells.map((c, index) => {
    const ray = rayThroughPixel(camera, intrinsics, c.x, c.y);
    const hit = intersectPlane(plane, camera.eye, ray);
    if (!hit) return null;
    const h = heightAt(hit.point);
    if (!Number.isFinite(h)) return null;

    const nr = dot(n, ray);
    if (!(Math.abs(nr) > 1e-9)) return null;
    // 光線に沿った進み。法線は視点側 → nr < 0 なので h>0（手前）で dt<0
    const dt = h / nr;
    const cosPhi = dot(ray, camera.forward);
    if (!(cosPhi > 1e-6)) return null;

    const z0 = hit.distance * cosPhi * unitScaleToMM;
    const z = (hit.distance + dt) * cosPhi * unitScaleToMM;
    if (!(z0 > 0) || !(z > 0)) return null;

    return {
      index,
      g: 1 / z - 1 / z0,
      xc: c.x - cx,
      yc: c.y - cy,
      f,
      heightMM: h * unitScaleToMM,
      distanceMM: z0,
    };
  });
}

// 段階1の変換が吸える成分。アフィン6 / ホモグラフィの一次近似8。
function nuisanceRow(xc, yc, useHomography, axis) {
  // [a0,a1,a2, b0,b1,b2, c1,c2]
  const row = new Float64Array(useHomography ? 8 : 6);
  if (axis === 0) { row[0] = 1; row[1] = xc; row[2] = yc; } else { row[3] = 1; row[4] = xc; row[5] = yc; }
  if (useHomography) {
    const s = axis === 0 ? xc : yc;
    row[6] = s * xc;
    row[7] = s * yc;
  }
  return row;
}

/**
 * 視差を分離できる面かどうかを測る。
 *
 * 凹凸が画面の一部にしか無いと、そこに載っているセルの大半が
 * 「本物に動いたブロック」だった場合に、当てはめが本物を視差と誤って
 * 説明してしまう（合成検証で実際に、1.0mm の本物の変位を丸ごと消した）。
 * ICP を安定域だけで解くのと同じ話で、**流用してよいのは動いていない側の
 * 特徴だけ**。動いた側しか手掛かりが無い状況では、断るのが正しい。
 *
 * - coverage … 視差の効くセルが全体に占める割合
 * - spread   … 効くセルの散らばり ÷ 全セルの散らばり（1 なら全面、0 なら一点集中）
 */
export function leverageQuality(geo, cells) {
  const usable = [];
  for (const g of geo) {
    if (!g) continue;
    const c = cells[g.index];
    if (!c || c.du == null) continue;
    usable.push({ g, lev: Math.abs(g.g) * g.f });
  }
  if (usable.length < 4) return { total: usable.length, carrying: 0, coverage: 0, spread: 0, maxLeverage: 0 };

  const maxLev = Math.max(...usable.map((u) => u.lev));
  const carrying = usable.filter((u) => u.lev >= 0.25 * maxLev);

  const spatial = (items, weighted) => {
    let sw = 0, sx = 0, sy = 0;
    for (const it of items) {
      const w = weighted ? it.lev : 1;
      sw += w; sx += w * it.g.xc; sy += w * it.g.yc;
    }
    if (!(sw > 0)) return 0;
    const mx = sx / sw, my = sy / sw;
    let v = 0;
    for (const it of items) {
      const w = weighted ? it.lev : 1;
      v += w * ((it.g.xc - mx) ** 2 + (it.g.yc - my) ** 2);
    }
    return Math.sqrt(v / sw);
  };
  const all = spatial(usable, false);
  const lev = spatial(usable, true);

  return {
    total: usable.length,
    carrying: carrying.length,
    coverage: carrying.length / usable.length,
    spread: all > 0 ? lev / all : 0,
    maxLeverage: maxLev,   // 立ち位置 1mm あたり何 px 動くか
  };
}

/**
 * 視差の場から立ち位置のずれ T[mm] を推定する。
 *
 * き裂の進行は局所、視差は全面に広がる滑らかな場なので、
 * ロバスト再重み付け（Tukey）で局所の本物に引きずられないようにする。
 *
 * @param {Array} geo cellGeometry の戻り値（null を含んでよい）
 * @param {Array<{du:number,dv:number}>} cells geo と同じ並びのセル
 */
export function estimateBaselineShift(geo, cells, {
  useHomography = true, rounds = 3, tukey = 4.685,
} = {}) {
  const nn = useHomography ? 8 : 6;
  const m = 3 + nn;
  const items = [];
  for (const g of geo) {
    if (!g) continue;
    const c = cells[g.index];
    if (!c || c.du == null || c.dv == null) continue;
    if (c.decorrelated || c.illuminationChanged) continue;
    for (let axis = 0; axis < 2; axis += 1) {
      const a = new Float64Array(m);
      if (axis === 0) { a[0] = -g.f * g.g; a[2] = g.g * g.xc; } else { a[1] = -g.f * g.g; a[2] = g.g * g.yc; }
      const nu = nuisanceRow(g.xc, g.yc, useHomography, axis);
      for (let i = 0; i < nn; i += 1) a[3 + i] = nu[i];
      items.push({ a, y: axis === 0 ? c.du : c.dv, w: 1, cell: g.index });
    }
  }
  // 未知数 m に対して観測が足りないと、当てはめが偽の T を作る
  if (items.length < m + 6) {
    return { ok: false, reason: `視差を解くにはセルが足りません（${items.length >> 1} / 必要 ${(m + 6) >> 1}）` };
  }

  let sol = null;
  for (let round = 0; round < rounds; round += 1) {
    sol = solveNormal(items, m);
    if (!sol) return { ok: false, reason: '視差の当てはめが解けませんでした（凹凸が足りない可能性）' };
    if (round === rounds - 1) break;
    const res = items.map((it) => {
      let p = 0;
      for (let i = 0; i < m; i += 1) p += it.a[i] * sol.x[i];
      return it.y - p;
    });
    const abs = res.map(Math.abs).sort((a, b) => a - b);
    const mad = abs[abs.length >> 1] || 1e-6;
    const s = Math.max(1.4826 * mad, 1e-4);
    for (let i = 0; i < items.length; i += 1) {
      const u = res[i] / (tukey * s);
      items[i].w = Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0;
    }
  }

  let sse = 0, wsum = 0;
  for (const it of items) {
    let p = 0;
    for (let i = 0; i < m; i += 1) p += it.a[i] * sol.x[i];
    sse += it.w * (it.y - p) ** 2;
    wsum += it.w;
  }
  const dof = Math.max(1, wsum - m);
  const sigma2 = sse / dof;

  return {
    ok: true,
    useHomography,
    m,
    solution: sol,
    sigma2,
    // 立ち位置のずれ（カメラ座標系・mm）。x=右, y=下, z=前
    shiftMM: { x: sol.x[0], y: sol.x[1], z: sol.x[2] },
    shiftMagnitudeMM: Math.hypot(sol.x[0], sol.x[1], sol.x[2]),
    usedCells: wsum / 2,
    residualPx: Math.sqrt(sigma2),
  };
}

/**
 * 推定した T から、セルごとの補正量と、その標準誤差を作る。
 *
 * 補正量は「視差モデルのうち段階1が吸えなかった成分」。
 * ダミーの自由度に入った分は段階1がすでに吸っているので引かない。
 */
export function parallaxField(geo, fit) {
  if (!fit.ok) return null;
  const { m, solution, sigma2, useHomography } = fit;
  const nn = m - 3;
  const out = new Map();

  // 視差モデル（3成分のみ）を全セルで作り、そこから段階1と同じ変換で
  // 表せる成分を落とす。落とさないと二重に引くことになる
  const rowsFor = (g, axis) => {
    const a = new Float64Array(m);
    if (axis === 0) { a[0] = -g.f * g.g; a[2] = g.g * g.xc; } else { a[1] = -g.f * g.g; a[2] = g.g * g.yc; }
    return a;
  };

  const model = [];
  for (const g of geo) {
    if (!g) continue;
    for (let axis = 0; axis < 2; axis += 1) {
      const a = rowsFor(g, axis);
      let p = 0;
      for (let i = 0; i < 3; i += 1) p += a[i] * solution.x[i];
      const nu = nuisanceRow(g.xc, g.yc, useHomography, axis);
      model.push({ g, axis, a, value: p, nu });
    }
  }
  // 視差モデルへの変換の当てはめ（重みは一様でよい。モデル自体は滑らか）
  const projRows = model.map((r) => ({ a: r.nu, y: r.value, w: 1 }));
  const proj = solveNormal(projRows, nn);

  for (const r of model) {
    let absorbed = 0;
    if (proj) for (let i = 0; i < nn; i += 1) absorbed += r.nu[i] * proj.x[i];
    const corr = r.value - absorbed;

    // 標準誤差: aᵀ Σ a（正規化された逆行列を使うのでスケールを戻す）
    let se2 = 0;
    for (let i = 0; i < m; i += 1) {
      for (let j = 0; j < m; j += 1) {
        se2 += (r.a[i] / solution.scale[i]) * solution.inv[i][j] * (r.a[j] / solution.scale[j]);
      }
    }
    se2 = Math.max(0, se2) * sigma2;

    const e = out.get(r.g.index) ?? { du: 0, dv: 0, seU: 0, seV: 0, heightMM: r.g.heightMM };
    if (r.axis === 0) { e.du = corr; e.seU = Math.sqrt(se2); } else { e.dv = corr; e.seV = Math.sqrt(se2); }
    out.set(r.g.index, e);
  }
  return out;
}

/**
 * セルの変位から視差を差し引く。
 *
 * 差し引いたセルには
 *  - parallaxDu / parallaxDv … 引いた量[px]
 *  - parallaxSePx            … その推定の標準誤差[px]（限界に足す）
 * を残す。引けなかったセル（点群が届いていない）は素通りさせ、
 * `parallaxCorrected: false` を立てる。**黙って未補正にしない**。
 *
 * @returns {{ok:boolean, reason?:string, shiftMM?:object, corrected?:number,
 *            beforeRmsPx?:number, afterRmsPx?:number}}
 */
export function correctParallax(cells, geo, options = {}) {
  const { minShiftMM = 0, ...fitOptions } = options;
  const fit = estimateBaselineShift(geo, cells, fitOptions);
  if (!fit.ok) return { ok: false, reason: fit.reason };

  const field = parallaxField(geo, fit);
  if (!field) return { ok: false, reason: '視差の場を作れませんでした' };

  let before = 0, after = 0, n = 0, corrected = 0;
  for (const c of cells) c.parallaxCorrected = false;

  for (const [index, e] of field) {
    const c = cells[index];
    if (!c || c.du == null) continue;
    before += c.du * c.du + c.dv * c.dv;
    n += 1;
    if (fit.shiftMagnitudeMM >= minShiftMM) {
      c.du -= e.du;
      c.dv -= e.dv;
      c.parallaxDu = e.du;
      c.parallaxDv = e.dv;
      c.parallaxSePx = Math.sqrt((e.seU * e.seU + e.seV * e.seV) / 2);
      c.parallaxCorrected = true;
      c.magnitudePx = Math.hypot(c.du, c.dv);
      corrected += 1;
    }
    after += c.du * c.du + c.dv * c.dv;
  }

  const beforeRms = n ? Math.sqrt(before / n) : null;
  const afterRms = n ? Math.sqrt(after / n) : null;
  // 引いたのに場が減っていないなら、それは補正ではなく無効化。
  // 点群と写真の位置合わせが取れていないとこうなる（撮影距離の入れ忘れ）
  const reduction = beforeRms > 0 && afterRms != null ? 1 - afterRms / beforeRms : 0;

  return {
    ok: true,
    applied: corrected > 0,
    reduction,
    ineffective: corrected > 0 && reduction < 0.1,
    shiftMM: fit.shiftMM,
    shiftMagnitudeMM: fit.shiftMagnitudeMM,
    usedCells: fit.usedCells,
    corrected,
    residualPx: fit.residualPx,
    beforeRmsPx: beforeRms,
    afterRmsPx: afterRms,
  };
}
