// DIC 適性の評価。
//
// DIC は表面の模様を手がかりに変位を求めるので、模様が乏しい面では
// 原理的に成立しません。撮ってから机で気づくのを避けるため、
// 画像から定量的に判定します。
//
// 指標は MIG（平均輝度勾配, Pan et al. 2010）。DIC の理論的な精度は
// おおむね MIG に反比例することが知られています。
//
// 大谷石のミソ（茶褐色の粘土鉱物斑）と粒状組織は、本来なら人工的に
// 吹き付けるスペックルパターンの役割をそのまま果たします。

/**
 * @param {{width:number, height:number, data:Float32Array}} image 0...1 の輝度
 */
export function speckleQuality(image, { subsetHalf = 15, sampleStep = 8 } = {}) {
  const { width: w, height: h, data } = image;
  if (w < 8 || h < 8) {
    return { mig: 0, contrast: 0, saturatedRatio: 0, verdict: 'poor', reason: '画像が小さすぎます' };
  }

  let gradSum = 0;
  let gradCount = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const gx = (data[y * w + x + 1] - data[y * w + x - 1]) * 0.5;
      const gy = (data[(y + 1) * w + x] - data[(y - 1) * w + x]) * 0.5;
      gradSum += Math.hypot(gx, gy);
      gradCount++;
    }
  }
  const mig = gradCount ? gradSum / gradCount : 0;

  // 局所コントラスト（サブセット内の標準偏差の中央値）
  const localSigmas = [];
  const size = subsetHalf * 2 + 1;
  for (let cy = subsetHalf; cy < h - subsetHalf; cy += sampleStep * 2) {
    for (let cx = subsetHalf; cx < w - subsetHalf; cx += sampleStep * 2) {
      let sum = 0;
      let sumSq = 0;
      for (let j = -subsetHalf; j <= subsetHalf; j += 2) {
        for (let i = -subsetHalf; i <= subsetHalf; i += 2) {
          const v = data[(cy + j) * w + (cx + i)];
          sum += v;
          sumSq += v * v;
        }
      }
      const n = Math.ceil(size / 2) ** 2;
      const mean = sum / n;
      localSigmas.push(Math.sqrt(Math.max(0, sumSq / n - mean * mean)));
    }
  }
  localSigmas.sort((a, b) => a - b);
  const contrast = localSigmas.length ? localSigmas[localSigmas.length >> 1] : 0;

  let saturated = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] >= 0.98 || data[i] <= 0.02) saturated++;
  }
  const saturatedRatio = saturated / data.length;

  // しきい値は合成テクスチャと実写での経験値。
  // 現物で校正できるよう、数値も一緒に返しています。
  let verdict;
  let reason;
  if (mig < 0.004 || contrast < 0.01) {
    verdict = 'poor';
    reason = '模様が乏しく、DIC では変位を追えません。ターゲット方式を使ってください';
  } else if (mig < 0.012 || contrast < 0.03) {
    verdict = 'fair';
    reason = '模様がやや乏しく、精度が落ちます。もう少し寄るか、斜光で陰影を出してください';
  } else {
    verdict = 'good';
    reason = 'DIC に十分な模様があります';
  }

  if (saturatedRatio > 0.1) {
    verdict = verdict === 'good' ? 'fair' : verdict;
    reason = `白飛び・黒つぶれが ${(saturatedRatio * 100).toFixed(0)}% あります。露出を見直してください`;
  }

  return { mig, contrast, saturatedRatio, verdict, reason };
}

/** DIC の期待精度の目安（px）。MIG に反比例する経験式。 */
export function expectedAccuracyPx({ mig, subsetHalf = 15, noiseLevel = 0.005 }) {
  const size = subsetHalf * 2 + 1;
  if (!(mig > 0)) return Infinity;
  // Pan et al. の σ_u ≈ σ_noise / (N * MIG) を単純化したもの
  return noiseLevel / (size * mig);
}
