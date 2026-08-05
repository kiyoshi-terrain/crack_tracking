// 変位場に「カメラが動いた分」を当てはめて取り除くための変換フィット。
//
// 三脚を据えていても、板バネのたわみや風で数十μrad は動きます。その一様な
// 成分を差し引いた残りが、純粋な測定ノイズです。
//
// - アフィン: 三脚＋短時間（連写）向け。並進・回転・スケール・せん断。
// - ホモグラフィ: 手持ちや別日撮影向け。平面を仮定した射影変換。

/** @typedef {{x:number, y:number, u:number, v:number}} Correspondence */

/**
 * アフィン変換 [a b c; d e f] を最小二乗で求める。
 *   X = a x + b y + c
 *   Y = d x + e y + f
 */
export function fitAffine(points) {
  if (points.length < 3) return null;

  // x, y の重心を引いて条件数を改善する
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;

  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0;
  let sxX = 0, syX = 0, sX = 0;
  let sxY = 0, syY = 0, sY = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    const X = p.x + p.u;
    const Y = p.y + p.v;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sx += dx;
    sy += dy;
    sxX += dx * X;
    syX += dy * X;
    sX += X;
    sxY += dx * Y;
    syY += dy * Y;
    sY += Y;
  }
  const n = points.length;

  // 重心を引いてあるので sx = sy = 0、正規方程式が 2x2 に分解される
  const det = sxx * syy - sxy * sxy;
  if (!(Math.abs(det) > 1e-12)) return null;

  const a = (syy * sxX - sxy * syX) / det;
  const b = (sxx * syX - sxy * sxX) / det;
  const d = (syy * sxY - sxy * syY) / det;
  const e = (sxx * syY - sxy * sxY) / det;
  const c = sX / n - a * mx - b * my;
  const f = sY / n - d * mx - e * my;

  return { a, b, c, d, e, f };
}

export function applyAffine(t, x, y) {
  return [t.a * x + t.b * y + t.c, t.d * x + t.e * y + t.f];
}

/**
 * ホモグラフィ（射影変換）を DLT で求める。
 * h33 = 1 に固定した 8 自由度の最小二乗。
 */
export function fitHomography(points) {
  if (points.length < 4) return null;

  // Hartley 正規化: 重心を原点、平均距離を √2 にする
  const norm = (pts, key) => {
    let mx = 0;
    let my = 0;
    for (const p of pts) {
      mx += key === 'src' ? p.x : p.x + p.u;
      my += key === 'src' ? p.y : p.y + p.v;
    }
    mx /= pts.length;
    my /= pts.length;
    let mean = 0;
    for (const p of pts) {
      const x = (key === 'src' ? p.x : p.x + p.u) - mx;
      const y = (key === 'src' ? p.y : p.y + p.v) - my;
      mean += Math.hypot(x, y);
    }
    mean /= pts.length;
    const s = mean > 1e-12 ? Math.SQRT2 / mean : 1;
    return { mx, my, s };
  };

  const ns = norm(points, 'src');
  const nd = norm(points, 'dst');

  const rows = [];
  const rhs = [];
  for (const p of points) {
    const x = (p.x - ns.mx) * ns.s;
    const y = (p.y - ns.my) * ns.s;
    const X = (p.x + p.u - nd.mx) * nd.s;
    const Y = (p.y + p.v - nd.my) * nd.s;
    rows.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    rhs.push(X);
    rows.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    rhs.push(Y);
  }

  const h = solveLeastSquares(rows, rhs, 8);
  if (!h) return null;

  // 正規化を戻す: H = Td^-1 * Hn * Ts
  const Hn = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
  const Ts = [
    [ns.s, 0, -ns.s * ns.mx],
    [0, ns.s, -ns.s * ns.my],
    [0, 0, 1],
  ];
  const TdInv = [
    [1 / nd.s, 0, nd.mx],
    [0, 1 / nd.s, nd.my],
    [0, 0, 1],
  ];
  const H = matMul(matMul(TdInv, Hn), Ts);
  const scale = H[2][2];
  if (Math.abs(scale) < 1e-12) return null;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) H[i][j] /= scale;
  }
  return H;
}

export function applyHomography(H, x, y) {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  if (Math.abs(w) < 1e-12) return [NaN, NaN];
  return [
    (H[0][0] * x + H[0][1] * y + H[0][2]) / w,
    (H[1][0] * x + H[1][1] * y + H[1][2]) / w,
  ];
}

/**
 * 当てはめた変換からの残差。これが測定ノイズそのものになります。
 * @returns {Array<{x:number,y:number,du:number,dv:number}>}
 */
export function residuals(transform, points) {
  const isHomography = Array.isArray(transform);
  return points.map((p) => {
    const [X, Y] = isHomography
      ? applyHomography(transform, p.x, p.y)
      : applyAffine(transform, p.x, p.y);
    return {
      x: p.x,
      y: p.y,
      du: p.x + p.u - X,
      dv: p.y + p.v - Y,
    };
  });
}

// --- 線形代数 -------------------------------------------------------

function matMul(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
      C[i][j] = s;
    }
  }
  return C;
}

/** 正規方程式 AᵀA x = Aᵀb をガウス消去（部分ピボット）で解く。 */
function solveLeastSquares(rows, rhs, unknowns) {
  const M = Array.from({ length: unknowns }, () => new Float64Array(unknowns + 1));
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const b = rhs[r];
    for (let i = 0; i < unknowns; i++) {
      for (let j = 0; j < unknowns; j++) M[i][j] += row[i] * row[j];
      M[i][unknowns] += row[i] * b;
    }
  }
  for (let col = 0; col < unknowns; col++) {
    let pivot = col;
    for (let r = col + 1; r < unknowns; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-14) return null;
    if (pivot !== col) {
      const t = M[pivot];
      M[pivot] = M[col];
      M[col] = t;
    }
    const p = M[col][col];
    for (let j = col; j <= unknowns; j++) M[col][j] /= p;
    for (let r = 0; r < unknowns; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let j = col; j <= unknowns; j++) M[r][j] -= factor * M[col][j];
    }
  }
  return Array.from({ length: unknowns }, (_, i) => M[i][unknowns]);
}
