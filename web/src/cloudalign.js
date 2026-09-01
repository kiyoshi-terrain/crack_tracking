/**
 * 点群の3D位置合わせ（ICP）と C2C 差分。
 *
 * 昨日の cloudchange.js は「壁を平面と見て、平面からの高さの差」を測る。
 * これは面外（はらみ出し）には最適だが、ブロックが**面に沿ってずれる・傾く**
 * 動きは高さがほぼ変わらないので取りこぼす。縁切れ→ブロック化はまさに
 * 面内のずれを伴うので、CloudCompare と同じ **C2C（点群間の最近傍距離）** を足す。
 *
 * ## 位置合わせに構造物の特徴を使うときの鉄則
 *
 * 「構造物の特徴点を基準点マーカーに流用する」のは正しい。ただし
 * **変状しているブロック自身を位置合わせに使ってはいけない**。
 * ICP は対応点の残差を最小化するので、動いた領域まで含めて合わせると、
 * 検出したい変位が全体の変換に吸われて過小評価される（写真の比較モードで
 * 「安定域で補正する」と言っているのと同じ罠）。
 * だから ICP は **安定域（動いていないと見なす本体）だけ**で解き、
 * 差分は全体で測る。stableMask がその指定。
 *
 * 依存: fitWallPlane（粗い初期姿勢と符号用の壁法線）。入出力は数値だけ。
 */

import { fitWallPlane } from './pointcloud.js';

// ---------------------------------------------------------------- ボクセルグリッド

/**
 * 最近傍探索を O(1) 近傍に落とすための空間ハッシュ。
 * 全点総当たり（O(N×M)）は25万点で回らないので必須。
 */
export function buildVoxelGrid(points, cell) {
  if (!(cell > 0)) throw new Error('cell を指定してください');
  const grid = new Map();
  const n = points.length / 3;
  const inv = 1 / cell;
  for (let i = 0, p = 0; i < n; i += 1, p += 3) {
    const kx = Math.floor(points[p] * inv);
    const ky = Math.floor(points[p + 1] * inv);
    const kz = Math.floor(points[p + 2] * inv);
    const key = `${kx},${ky},${kz}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(p); else grid.set(key, [p]);
  }
  return { grid, cell, inv, points };
}

/**
 * (x,y,z) の最近傍点を、自セルと 26 近傍セルから探す。
 * @returns {{index: number, dist2: number} | null} maxDist 内に無ければ null
 */
export function nearestNeighbor(vg, x, y, z, maxDist) {
  const { grid, inv, points, cell } = vg;
  const kx = Math.floor(x * inv);
  const ky = Math.floor(y * inv);
  const kz = Math.floor(z * inv);
  const maxReach = maxDist ? Math.max(1, Math.ceil(maxDist / cell)) : 1;
  let bestP = -1;
  let bestD2 = maxDist ? maxDist * maxDist : Infinity;

  // 殻を内側から広げる。半径 r の殻より外の点は少なくとも (r−1)·cell 離れているので、
  // それより近い点が既に見つかっていれば打ち切れる。密な点群では殻1（27バケット）で
  // ほぼ決まり、全殻総当たり（729バケット）より1桁速い
  for (let r = 1; r <= maxReach; r += 1) {
    for (let dz = -r; dz <= r; dz += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          // 殻の表面だけ（内側は前の周で見た）
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const bucket = grid.get(`${kx + dx},${ky + dy},${kz + dz}`);
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b += 1) {
            const p = bucket[b];
            const ex = points[p] - x;
            const ey = points[p + 1] - y;
            const ez = points[p + 2] - z;
            const d2 = ex * ex + ey * ey + ez * ez;
            if (d2 < bestD2) { bestD2 = d2; bestP = p; }
          }
        }
      }
    }
    // 自セル（r=0 相当）は殻1の周で見ていないので最初に見る
    if (r === 1) {
      const bucket = grid.get(`${kx},${ky},${kz}`);
      if (bucket) {
        for (let b = 0; b < bucket.length; b += 1) {
          const p = bucket[b];
          const ex = points[p] - x;
          const ey = points[p + 1] - y;
          const ez = points[p + 2] - z;
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 < bestD2) { bestD2 = d2; bestP = p; }
        }
      }
    }
    const bound = (r) * cell;   // 次の殻以降の点はこれ以上離れている
    if (bestP >= 0 && bestD2 <= bound * bound) break;
  }
  return bestP < 0 ? null : { index: bestP, dist2: bestD2 };
}

// ---------------------------------------------------------------- 剛体変換

/** 単位変換。 */
export function identityRigid() {
  return { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
}

export function applyRigid(T, x, y, z) {
  const { r, t } = T;
  return [
    r[0] * x + r[1] * y + r[2] * z + t[0],
    r[3] * x + r[4] * y + r[5] * z + t[1],
    r[6] * x + r[7] * y + r[8] * z + t[2],
  ];
}

/** Δ（微小回転ω＋並進τ）を左から合成: T' = Δ∘T。回転は再正規化する。 */
function composeDelta(omega, tau, T) {
  const dR = rodrigues(omega);
  const r = mul3(dR, [T.r[0], T.r[1], T.r[2], T.r[3], T.r[4], T.r[5], T.r[6], T.r[7], T.r[8]]);
  const t = [
    dR[0] * T.t[0] + dR[1] * T.t[1] + dR[2] * T.t[2] + tau[0],
    dR[3] * T.t[0] + dR[4] * T.t[1] + dR[5] * T.t[2] + tau[1],
    dR[6] * T.t[0] + dR[7] * T.t[1] + dR[8] * T.t[2] + tau[2],
  ];
  return { r: orthonormalize(r), t };
}

function rodrigues(w) {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = [w[0] / th, w[1] / th, w[2] / th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const v = 1 - c;
  return [
    c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s,
    k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s,
    k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v,
  ];
}

function mul3(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return o;
}

/** Gram-Schmidt で回転行列を綺麗にする（数値誤差で直交性が崩れるのを防ぐ）。 */
function orthonormalize(r) {
  let x = [r[0], r[3], r[6]];
  let y = [r[1], r[4], r[7]];
  const nx = Math.hypot(...x);
  x = x.map((v) => v / nx);
  const d = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  y = [y[0] - d * x[0], y[1] - d * x[1], y[2] - d * x[2]];
  const ny = Math.hypot(...y);
  y = y.map((v) => v / ny);
  const z = [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0],
  ];
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

// ---------------------------------------------------------------- 粗い初期姿勢

/** 単位ベクトル a を b に重ねる最小回転。 */
function rotationBetween(a, b) {
  const v = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const s = Math.hypot(...v);
  if (s < 1e-9) return c > 0 ? identityRigid().r : [1, 0, 0, 0, -1, 0, 0, 0, -1];
  return rodrigues([v[0] / s * Math.acos(Math.max(-1, Math.min(1, c))),
    v[1] / s * Math.acos(Math.max(-1, Math.min(1, c))),
    v[2] / s * Math.acos(Math.max(-1, Math.min(1, c)))]);
}

function centroid(points) {
  const c = [0, 0, 0];
  const n = points.length / 3;
  for (let p = 0; p < points.length; p += 3) { c[0] += points[p]; c[1] += points[p + 1]; c[2] += points[p + 2]; }
  return [c[0] / n, c[1] / n, c[2] / n];
}

/** 壁法線と重心から、B を A のだいたいの姿勢へ持ち込む粗い変換。ICP の初期値。 */
function coarseFromPlanes(refPoints, movPoints, planeA, planeB) {
  const R = rotationBetween(planeB.normal, planeA.normal);
  const cB = centroid(movPoints);
  const cA = centroid(refPoints);
  const RcB = [
    R[0] * cB[0] + R[1] * cB[1] + R[2] * cB[2],
    R[3] * cB[0] + R[4] * cB[1] + R[5] * cB[2],
    R[6] * cB[0] + R[7] * cB[1] + R[8] * cB[2],
  ];
  return { r: R, t: [cA[0] - RcB[0], cA[1] - RcB[1], cA[2] - RcB[2]] };
}

// ---------------------------------------------------------------- ICP

/**
 * トリム付き線形化 ICP（点対点）。
 *
 * 座標系がずれた2スキャンを重ねる。粗い初期姿勢から出発し、対応点の残差を
 * 減らす微小な剛体増分を毎回1回の線形解で求める。トリム（残差の大きい側を
 * 捨てる）で、部分的な重なり・植生・動いた領域に強い。
 *
 * @param {Float64Array} refPoints 基準（動かさない側）
 * @param {Float64Array} movPoints 合わせる側
 * @param {object} options
 *   cell         ボクセルの一辺（点群と同じ単位）。点間隔の2〜4倍が目安
 *   maxDist      対応と見なす最大距離（外れ対応を弾く）
 *   trimRatio    残差の小さい側から採る割合（0.6 = 上位60%だけで解く）
 *   maxIterations 反復上限
 *   tol          収束（増分の並進がこの値以下）
 *   initial      初期変換（省略時は平面から作る）
 *   stableMask   (i)=>bool。位置合わせに使う mov 点の添字（動いた領域を外す）
 */
export function alignICP(refPoints, movPoints, options = {}) {
  const {
    cell,
    maxDist = cell * 3,
    trimRatio = 0.7,
    maxIterations = 30,
    tol = cell * 0.01,
    initial = null,
    stableMask = null,
    planeA: planeAIn = null,
    planeB: planeBIn = null,
  } = options;
  if (!(cell > 0)) throw new Error('cell を指定してください');

  const planeA = planeAIn ?? fitWallPlane(refPoints);
  const planeB = planeBIn ?? fitWallPlane(movPoints);
  let T = initial ?? coarseFromPlanes(refPoints, movPoints, planeA, planeB);

  const vg = buildVoxelGrid(refPoints, cell);

  // 位置合わせに使う mov 点の添字
  const idx = [];
  const m = movPoints.length / 3;
  for (let i = 0; i < m; i += 1) {
    if (!stableMask || stableMask(i)) idx.push(i);
  }

  let rms = Infinity;
  let inlierCount = 0;
  let iter = 0;
  // 最初の対応付けは粗い姿勢で取っているので、最低2回は回して対応を組み直す
  const minIterations = 2;
  for (; iter < maxIterations; iter += 1) {
    // 対応付け
    const corr = [];
    for (const i of idx) {
      const p = applyRigid(T, movPoints[i * 3], movPoints[i * 3 + 1], movPoints[i * 3 + 2]);
      const nn = nearestNeighbor(vg, p[0], p[1], p[2], maxDist);
      if (nn) {
        corr.push({
          px: p[0], py: p[1], pz: p[2],
          ax: refPoints[nn.index], ay: refPoints[nn.index + 1], az: refPoints[nn.index + 2],
          d2: nn.dist2,
        });
      }
    }
    if (corr.length < 20) break;

    // トリム: 残差の小さい側から trimRatio ぶんだけ採る
    corr.sort((a, b) => a.d2 - b.d2);
    const keep = Math.max(20, Math.floor(corr.length * trimRatio));
    const used = corr.slice(0, keep);
    inlierCount = used.length;

    // 線形化点対点: 各対応で τ + ω×p ≈ (a - p)。6×6 正規方程式を解く
    const step = solvePointToPoint(used);
    if (!step) break;

    T = composeDelta([step[0], step[1], step[2]], [step[3], step[4], step[5]], T);

    // RMS は更新前の対応で測る（次の反復で改善したかを見るには十分）
    rms = Math.sqrt(used.reduce((acc, c) => acc + c.d2, 0) / used.length);
    // 収束: 並進の増分が tol 以下、回転の増分が 1e-4 rad（2.5m 先で 0.25mm）以下
    if (iter + 1 >= minIterations
        && Math.hypot(step[3], step[4], step[5]) < tol
        && Math.hypot(step[0], step[1], step[2]) < 1e-4) {
      iter += 1;
      break;
    }
  }

  return { transform: T, rms, inlierCount, iterations: iter, planeA, planeB };
}

/**
 * Σ|τ + ω×p - r|² を最小化する (ω, τ)。r = a - p。
 * ∂/∂τ, ∂/∂ω = 0 の 6×6 を組んで解く。
 * ω×p = -p×ω なので、p の歪対称行列 P で ω×p = P·ω、P = [[0,pz,-py],[-pz,0,px],[py,-px,0]]。
 */
function solvePointToPoint(corr) {
  // 未知 x = [ωx, ωy, ωz, τx, τy, τz]
  const A = Array.from({ length: 6 }, () => new Float64Array(6));
  const bvec = new Float64Array(6);

  for (const c of corr) {
    const px = c.px, py = c.py, pz = c.pz;
    const rx = c.ax - c.px, ry = c.ay - c.py, rz = c.az - c.pz;
    // 各点の J（3×6）。ω×p = (ωy·pz − ωz·py, ωz·px − ωx·pz, ωx·py − ωy·px)
    const J = [
      // ωx, ωy, ωz, τx, τy, τz
      [0, pz, -py, 1, 0, 0],
      [-pz, 0, px, 0, 1, 0],
      [py, -px, 0, 0, 0, 1],
    ];
    const res = [rx, ry, rz];
    for (let a = 0; a < 6; a += 1) {
      for (let b = 0; b < 6; b += 1) {
        A[a][b] += J[0][a] * J[0][b] + J[1][a] * J[1][b] + J[2][a] * J[2][b];
      }
      bvec[a] += J[0][a] * res[0] + J[1][a] * res[1] + J[2][a] * res[2];
    }
  }
  return solveLinear(A, bvec, 6);
}

/** ピボット付きガウス消去で A x = b を解く（N×N）。 */
function solveLinear(A, b, n) {
  const M = A.map((row, i) => Float64Array.from([...row, b[i]]));
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    if (piv !== col) { const tmp = M[piv]; M[piv] = M[col]; M[col] = tmp; }
    const d = M[col][col];
    for (let k = col; k <= n; k += 1) M[col][k] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k += 1) M[r][k] -= f * M[col][k];
    }
  }
  return Array.from({ length: n }, (_, i) => M[i][n]);
}

// ---------------------------------------------------------------- C2C 差分

/**
 * C2C（点群間）差分。位置合わせ後の mov 各点について ref の最近傍を取り、
 * 2つの量に分けて返す。
 *
 * - **along**: 最近傍への差の壁法線成分（符号付き。＋=手前=浮き・はらみ出し）。
 *   面外変化の主値。3D 距離をそのまま使うと点の間隔（サンプリング床、
 *   9万点/14m² で約6mm）が全部乗ってしまうが、法線成分にはそれが乗らない。
 *   CloudCompare で C2C ではなく C2M/M3C2 が勧められるのと同じ理由
 * - **magnitude**: 最近傍までの 3D 距離。面に沿ったずれ・回転で膨らむ。
 *   平面法では見えない「形が変わった」の副指標。サンプリング床が乗るので
 *   絶対値は控えめに読む
 *
 * @returns {{along: Float64Array, magnitude: Float64Array, missing: number}}
 *   mov の点ごと。maxDist 内に対応が無ければ NaN（欠測・遮蔽・新規）
 */
export function c2cDistances(refPoints, movPoints, transform, options = {}) {
  const { cell, maxDist = cell * 4, normal } = options;
  if (!(cell > 0)) throw new Error('cell を指定してください');
  const n = normal ?? fitWallPlane(refPoints).normal;
  const vg = buildVoxelGrid(refPoints, cell);

  const m = movPoints.length / 3;
  const along = new Float64Array(m).fill(NaN);
  const magnitude = new Float64Array(m).fill(NaN);
  let missing = 0;

  for (let i = 0; i < m; i += 1) {
    const p = applyRigid(transform, movPoints[i * 3], movPoints[i * 3 + 1], movPoints[i * 3 + 2]);
    const nn = nearestNeighbor(vg, p[0], p[1], p[2], maxDist);
    if (!nn) { missing += 1; continue; }
    const ex = p[0] - refPoints[nn.index];
    const ey = p[1] - refPoints[nn.index + 1];
    const ez = p[2] - refPoints[nn.index + 2];
    magnitude[i] = Math.sqrt(nn.dist2);
    along[i] = ex * n[0] + ey * n[1] + ez * n[2];
  }
  return { along, magnitude, missing, transformedCount: m };
}

/**
 * C2C の点ごとの値を壁面グリッドのヒートマップに集約する。
 * cloudchange と同じセル表現に載せるので、既存のヒートマップ描画を使い回せる。
 *
 * @param {Float64Array} movPoints
 * @param {object} c2c c2cDistances の戻り値（signed）
 * @param {object} plane 壁面（基底に使う）
 * @param {object} transform 位置合わせ変換（mov を ref 系へ）
 */
export function c2cHeatmap(movPoints, c2c, plane, transform, options = {}) {
  const { cellSize, minPointsPerCell = 2 } = options;
  if (!(cellSize > 0)) throw new Error('cellSize を指定してください');
  const { e1, e2 } = planeBasisLocal(plane.normal);

  const m = movPoints.length / 3;
  const us = new Float64Array(m);
  const vs = new Float64Array(m);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < m; i += 1) {
    const p = applyRigid(transform, movPoints[i * 3], movPoints[i * 3 + 1], movPoints[i * 3 + 2]);
    const u = p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2];
    const v = p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2];
    us[i] = u; vs[i] = v;
    if (Number.isFinite(c2c.along[i])) {
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
  }
  const cols = Math.max(1, Math.ceil((maxU - minU) / cellSize));
  const rows = Math.max(1, Math.ceil((maxV - minV) / cellSize));
  const buckets = new Array(cols * rows);
  for (let i = 0; i < m; i += 1) {
    if (!Number.isFinite(c2c.along[i])) continue;
    const cx = Math.floor((us[i] - minU) / cellSize);
    const cy = Math.floor((vs[i] - minV) / cellSize);
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
    const k = cy * cols + cx;
    (buckets[k] || (buckets[k] = [])).push(c2c.along[i]);
  }
  const values = new Float64Array(cols * rows).fill(NaN);
  const counts = new Int32Array(cols * rows);
  for (let k = 0; k < buckets.length; k += 1) {
    const b = buckets[k];
    if (!b || b.length < minPointsPerCell) continue;
    counts[k] = b.length;
    values[k] = median(b);
  }
  return {
    grid: { originU: minU, originV: minV, cellSize, cols, rows },
    e1, e2, values, counts,
  };
}

function planeBasisLocal(normal, up = [0, 0, 1]) {
  let seed = up;
  if (Math.abs(normal[0] * seed[0] + normal[1] * seed[1] + normal[2] * seed[2]) > 0.9) seed = [1, 0, 0];
  let e1 = [
    seed[1] * normal[2] - seed[2] * normal[1],
    seed[2] * normal[0] - seed[0] * normal[2],
    seed[0] * normal[1] - seed[1] * normal[0],
  ];
  const l = Math.hypot(...e1);
  e1 = e1.map((v) => v / l);
  const e2 = [
    normal[1] * e1[2] - normal[2] * e1[1],
    normal[2] * e1[0] - normal[0] * e1[2],
    normal[0] * e1[1] - normal[1] * e1[0],
  ];
  return { e1, e2 };
}

function median(values) {
  if (!values.length) return 0;
  const a = Float64Array.from(values).sort();
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
