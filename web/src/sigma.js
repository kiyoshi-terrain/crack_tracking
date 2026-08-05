// 測定ノイズ σ の算出と、検出限界の判定。
//
// 構造物は数分では動きません。だから同じ位置から連続で撮った複数枚に対して
// 「変位」を計算すると、出るはずのない値が出ます。それが測定ノイズです。
//
// 目標精度を先に決めるのではなく、現物の σ を測ってから
// 「何 mm の変化なら有意と言えるか」を決める、という順序のためのものです。

/**
 * 残差からロバストに散らばりを求める。
 *
 * 外れ値（相関を誤った測点）に引きずられないよう、標準偏差ではなく
 * MAD から換算した σ を主指標にしています。
 *
 * @param {Array<{du:number, dv:number}>} residuals
 */
export function summarize(residuals) {
  const magnitudes = residuals.map((r) => Math.hypot(r.du, r.dv));
  const du = residuals.map((r) => r.du);
  const dv = residuals.map((r) => r.dv);

  const sigmaU = robustSigma(du);
  const sigmaV = robustSigma(dv);
  // 2成分を合わせた1軸あたりの代表値
  const sigma = Math.sqrt((sigmaU * sigmaU + sigmaV * sigmaV) / 2);

  return {
    count: residuals.length,
    sigma,
    sigmaU,
    sigmaV,
    rms: Math.sqrt(magnitudes.reduce((s, m) => s + m * m, 0) / Math.max(1, magnitudes.length)),
    p95: percentile(magnitudes, 0.95),
    max: magnitudes.length ? Math.max(...magnitudes) : 0,
  };
}

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function robustSigma(values) {
  if (values.length < 2) return 0;
  const m = median(values);
  const mad = median(values.map((v) => Math.abs(v - m)));
  const sigma = 1.4826 * mad;
  if (sigma > 0) return sigma;
  // 全点が同値（MAD=0）のときは通常の標準偏差にフォールバック
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

export function percentile(values, q) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.round((s.length - 1) * Math.min(Math.max(q, 0), 1));
  return s[i];
}

/**
 * 検出限界（3σ）を実寸に換算する。
 *
 * @param {object} input
 * @param {number} input.sigmaPx 1測点あたりのノイズ[px]
 * @param {number} input.millimetersPerPixel GSD
 * @param {number} [input.frames] 平均するフレーム数（√N で改善）
 * @param {number} [input.k] 何σを限界とみなすか
 */
export function detectionLimit({ sigmaPx, millimetersPerPixel, frames = 1, k = 3 }) {
  const effectiveSigmaPx = sigmaPx / Math.sqrt(Math.max(1, frames));
  // き裂を挟む2点の相対変位なので、独立なノイズが2つ乗る
  const pairSigmaPx = Math.SQRT2 * effectiveSigmaPx;
  return {
    sigmaPx: effectiveSigmaPx,
    sigmaMM: effectiveSigmaPx * millimetersPerPixel,
    pairSigmaMM: pairSigmaPx * millimetersPerPixel,
    detectionLimitMM: k * pairSigmaPx * millimetersPerPixel,
    k,
    frames,
  };
}

/**
 * 撮影距離と焦点距離から GSD を求める。
 * 焦点距離[px] = 35mm換算焦点距離 × 画像幅[px] / 36
 */
export function computeGSD({ distanceM, focalLengthPx }) {
  if (!(distanceM > 0) || !(focalLengthPx > 0)) return null;
  return (distanceM * 1000) / focalLengthPx;
}

export function focalLengthPxFrom35mm({ focal35mm, imageWidthPx }) {
  if (!(focal35mm > 0) || !(imageWidthPx > 0)) return null;
  return (focal35mm * imageWidthPx) / 36;
}

/**
 * 2時期の計測値の差が有意かを判定する。
 * @param {number} deltaMM 観測された変化量
 * @param {number} limitMM 検出限界（3σ）
 */
export function isSignificant(deltaMM, limitMM) {
  return Math.abs(deltaMM) > limitMM;
}
