// デジタル画像相関法（DIC）。
//
// き裂の「幅」ではなく「開口の変化量」を測るための中核です。
// 表面の模様（大谷石ならミソや粒状組織）を目印に、2枚の画像の間で
// 各点がどれだけ動いたかをサブピクセルで求めます。
//
// 手順:
//   1. ZNCC による整数変位の探索（大まかな当たり）
//   2. 逆合成 Gauss-Newton によるサブピクセル追い込み
//
// 相関の指標に ZNSSD（ゼロ平均正規化二乗差）を使うため、
// 撮影ごとの明るさ・コントラストの違いに影響されません。
// 屋外で日射条件が変わる用途では、ここが効きます。

/** @typedef {{width:number, height:number, data:Float32Array}} Gray */

/**
 * バイリニア補間。範囲外は端でクランプする。
 * @param {Gray} img
 */
export function sampleBilinear(img, x, y) {
  const { width: w, height: h, data } = img;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx0 = Math.min(Math.max(x0, 0), w - 1);
  const cy0 = Math.min(Math.max(y0, 0), h - 1);
  const cx1 = Math.min(Math.max(x0 + 1, 0), w - 1);
  const cy1 = Math.min(Math.max(y0 + 1, 0), h - 1);
  const v00 = data[cy0 * w + cx0];
  const v10 = data[cy0 * w + cx1];
  const v01 = data[cy1 * w + cx0];
  const v11 = data[cy1 * w + cx1];
  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

/**
 * サブセットを取り出し、ゼロ平均・正規化した配列を返す。
 * @returns {{values:Float64Array, mean:number, norm:number}}
 */
function extractSubset(img, cx, cy, half, dx = 0, dy = 0) {
  const size = half * 2 + 1;
  const values = new Float64Array(size * size);
  let sum = 0;
  let i = 0;
  for (let j = -half; j <= half; j++) {
    for (let k = -half; k <= half; k++) {
      const v = sampleBilinear(img, cx + k + dx, cy + j + dy);
      values[i++] = v;
      sum += v;
    }
  }
  const mean = sum / values.length;
  let sq = 0;
  for (let n = 0; n < values.length; n++) {
    values[n] -= mean;
    sq += values[n] * values[n];
  }
  return { values, mean, norm: Math.sqrt(sq) };
}

/**
 * ZNCC による整数変位探索。
 * @returns {{dx:number, dy:number, zncc:number}|null}
 */
export function integerSearch(reference, target, cx, cy, half, range) {
  return integerSearchAround(reference, target, cx, cy, half, range, 0, 0);
}

/** 中心を (offsetX, offsetY) だけずらした整数探索。 */
export function integerSearchAround(reference, target, cx, cy, half, range, offsetX, offsetY) {
  const ref = extractSubset(reference, cx, cy, half);
  if (ref.norm < 1e-9) return null; // 平坦すぎて手がかりがない

  const ox = Math.round(offsetX);
  const oy = Math.round(offsetY);
  let best = { dx: 0, dy: 0, zncc: -2 };
  for (let sy = -range; sy <= range; sy++) {
    for (let sx = -range; sx <= range; sx++) {
      const dx = ox + sx;
      const dy = oy + sy;
      const cur = extractSubset(target, cx, cy, half, dx, dy);
      if (cur.norm < 1e-9) continue;
      let dot = 0;
      for (let n = 0; n < ref.values.length; n++) {
        dot += ref.values[n] * cur.values[n];
      }
      const zncc = dot / (ref.norm * cur.norm);
      if (zncc > best.zncc) best = { dx, dy, zncc };
    }
  }
  return best.zncc > -2 ? best : null;
}

/**
 * 参照画像の中央差分による勾配。
 * @param {Gray} img
 */
function gradientAt(img, x, y) {
  const gx = (sampleBilinear(img, x + 1, y) - sampleBilinear(img, x - 1, y)) * 0.5;
  const gy = (sampleBilinear(img, x, y + 1) - sampleBilinear(img, x, y - 1)) * 0.5;
  return [gx, gy];
}

/**
 * 逆合成 Gauss-Newton によるサブピクセル追い込み（並進のみ）。
 *
 * ZNSSD を最小化します。参照側のヤコビアンとヘッセ行列は反復のあいだ
 * 変わらないので、一度だけ計算して使い回します（これが「逆合成」の利点）。
 *
 * @returns {{dx:number, dy:number, zncc:number, iterations:number, converged:boolean}|null}
 */
export function refineSubpixel(reference, target, cx, cy, half, dx0, dy0, options = {}) {
  const maxIterations = options.maxIterations ?? 30;
  const tolerance = options.tolerance ?? 1e-4;

  const ref = extractSubset(reference, cx, cy, half);
  if (ref.norm < 1e-9) return null;

  // 参照サブセットの勾配とヘッセ行列（反復中不変）
  const size = half * 2 + 1;
  const gradX = new Float64Array(size * size);
  const gradY = new Float64Array(size * size);
  let h00 = 0, h01 = 0, h11 = 0;
  let i = 0;
  for (let j = -half; j <= half; j++) {
    for (let k = -half; k <= half; k++) {
      const [gx, gy] = gradientAt(reference, cx + k, cy + j);
      gradX[i] = gx;
      gradY[i] = gy;
      h00 += gx * gx;
      h01 += gx * gy;
      h11 += gy * gy;
      i++;
    }
  }
  const det = h00 * h11 - h01 * h01;
  if (Math.abs(det) < 1e-12) return null; // 一方向にしか模様がない（開口部の縁など）

  let dx = dx0;
  let dy = dy0;
  let iterations = 0;
  let converged = false;
  let zncc = -2;

  for (; iterations < maxIterations; iterations++) {
    const cur = extractSubset(target, cx, cy, half, dx, dy);
    if (cur.norm < 1e-9) return null;

    // ZNSSD の残差。参照側のスケールに合わせてから差を取る。
    const scale = ref.norm / cur.norm;
    let b0 = 0, b1 = 0;
    let dot = 0;
    for (let n = 0; n < ref.values.length; n++) {
      const residual = scale * cur.values[n] - ref.values[n];
      b0 += gradX[n] * residual;
      b1 += gradY[n] * residual;
      dot += ref.values[n] * cur.values[n];
    }
    zncc = dot / (ref.norm * cur.norm);

    const stepX = (h11 * b0 - h01 * b1) / det;
    const stepY = (h00 * b1 - h01 * b0) / det;

    // 逆合成: 参照側で求めた増分を、目標側の変位から引く
    dx -= stepX;
    dy -= stepY;

    if (Math.abs(stepX) < tolerance && Math.abs(stepY) < tolerance) {
      converged = true;
      iterations++;
      break;
    }
    // 発散したら諦める（相関が付いていない領域）
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 1e4 || Math.abs(dy) > 1e4) {
      return null;
    }
  }

  return { dx, dy, zncc, iterations, converged };
}

/**
 * 画像全体のおおまかなずれを求める（階層的アライメントの1段目）。
 *
 * 三脚なら数 px ですが、手持ちだと数百 px ずれます。そのまま各測点で
 * 広範囲を全探索すると計算量が爆発するので、縮小画像で先に当たりを付けます。
 *
 * @param {Gray} reference
 * @param {Gray} target
 * @param {(img:Gray, factor:number)=>Gray} downsample 縮小関数（image.js のものを渡す）
 * @returns {{dx:number, dy:number, factor:number, confidence:number}}
 */
export function estimateGlobalShift(reference, target, downsample, options = {}) {
  const maxShift = options.maxShiftPx ?? 400;
  const factor = Math.max(1, Math.round((options.coarseSide ?? 400) > 0
    ? Math.max(1, Math.min(reference.width, reference.height) / (options.coarseSide ?? 400))
    : 1));

  const smallRef = downsample(reference, factor);
  const smallTgt = downsample(target, factor);
  const range = Math.max(2, Math.ceil(maxShift / factor));
  const half = Math.max(8, Math.floor(Math.min(smallRef.width, smallRef.height) / 6));

  // 中央と四隅寄りの5点で探索し、中央値を採る（局所的な動きに引きずられないため）
  const probes = [
    [0.5, 0.5],
    [0.3, 0.3],
    [0.7, 0.3],
    [0.3, 0.7],
    [0.7, 0.7],
  ];
  const results = [];
  for (const [fx, fy] of probes) {
    const cx = Math.round(smallRef.width * fx);
    const cy = Math.round(smallRef.height * fy);
    if (cx - half - range < 0 || cy - half - range < 0) continue;
    if (cx + half + range >= smallRef.width || cy + half + range >= smallRef.height) continue;
    const found = integerSearch(smallRef, smallTgt, cx, cy, half, range);
    if (found && found.zncc > 0.5) results.push(found);
  }
  if (!results.length) return { dx: 0, dy: 0, factor, confidence: 0 };

  const median = (values) => {
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return {
    dx: median(results.map((r) => r.dx)) * factor,
    dy: median(results.map((r) => r.dy)) * factor,
    factor,
    confidence: median(results.map((r) => r.zncc)),
  };
}

/**
 * 格子状に変位を計測する。
 *
 * @param {Gray} reference 基準画像
 * @param {Gray} target 比較画像
 * @param {object} options
 * @param {number} options.subsetHalf サブセット半径[px]（全体は 2h+1 角）
 * @param {number} options.step 測点の間隔[px]
 * @param {number} options.searchRange 整数探索の範囲[px]
 * @param {number} options.minZNCC これ未満の相関の測点は捨てる
 * @param {{dx:number,dy:number}} [options.initialShift] 粗いアライメントの結果
 * @param {{x:number,y:number,width:number,height:number}} [options.region] 解析範囲
 * @returns {{points:Array<{x:number,y:number,u:number,v:number,zncc:number}>, rejected:number}}
 */
export function measureDisplacementField(reference, target, options = {}) {
  const subsetHalf = options.subsetHalf ?? 15;
  const step = options.step ?? 20;
  const searchRange = options.searchRange ?? 4;
  const minZNCC = options.minZNCC ?? 0.8;
  const initial = options.initialShift ?? { dx: 0, dy: 0 };

  const margin = subsetHalf + searchRange + 2;
  const region = options.region ?? {
    x: 0,
    y: 0,
    width: reference.width,
    height: reference.height,
  };

  // 粗いアライメント分ずらした先が画像内に収まる範囲だけを解析する。
  // ここを忘れると、2枚が重なっていない縁の部分でも「相関が取れたふり」をして
  // （端でクランプされた画素を掴んで）もっともらしい外れ値を返す。
  // 手持ち撮影では必ず起きる。
  const shiftX = Math.round(initial.dx);
  const shiftY = Math.round(initial.dy);
  const x0 = Math.max(margin, region.x, margin - shiftX);
  const y0 = Math.max(margin, region.y, margin - shiftY);
  const x1 = Math.min(
    reference.width - margin,
    region.x + region.width,
    target.width - margin - shiftX
  );
  const y1 = Math.min(
    reference.height - margin,
    region.y + region.height,
    target.height - margin - shiftY
  );

  const points = [];
  let rejected = 0;

  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      // 粗いアライメントの分だけ探索窓をずらす（手持ち撮影で数百px ずれても追える）
      const coarse = integerSearchAround(
        reference, target, x, y, subsetHalf, searchRange, initial.dx, initial.dy
      );
      if (!coarse) {
        rejected++;
        continue;
      }
      const fine = refineSubpixel(reference, target, x, y, subsetHalf, coarse.dx, coarse.dy);
      if (!fine || fine.zncc < minZNCC) {
        rejected++;
        continue;
      }
      points.push({ x, y, u: fine.dx, v: fine.dy, zncc: fine.zncc });
    }
  }

  return { points, rejected };
}
