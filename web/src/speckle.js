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
/** sRGB 0.02 → 線形光（0.04045 未満は c/12.92） */
export const SATURATED_DARK_LINEAR = 0.02 / 12.92;
/** sRGB 0.98 → 線形光 ((c+0.055)/1.055)^2.4 */
export const SATURATED_BRIGHT_LINEAR = ((0.98 + 0.055) / 1.055) ** 2.4;

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

  // 飽和（白飛び・黒つぶれ）は符号化の現象なので sRGB の符号値で定義する。
  // ここへ来る画像は toGray で線形光に戻してあるため、sRGB 0.02 / 0.98 を
  // 線形光へ換算したしきい値を使う。線形光の 0.02 は sRGB の 39/255 で、
  // 黒つぶれではなくただの暗いグレー。実写（風化した大谷石・正しい露出）で
  // 12.6% が「黒つぶれ」と数えられ、模様が濃いのに fair と誤判定していた
  // （sRGB のまま数えると 1.96%）。
  let saturated = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] >= SATURATED_BRIGHT_LINEAR || data[i] <= SATURATED_DARK_LINEAR) saturated++;
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

/**
 * ピントの鋭さ（0〜1程度、大きいほど鋭い）。
 *
 * MIG だけでは「模様が無い」と「ピンボケ」を区別できません。どちらも
 * 勾配が小さくなるからです。そこで **わざと 3x3 で平滑化してから
 * MIG がどれだけ落ちるか** を見ます。
 *
 * - 鋭い画像: 細かい成分が多いので平滑化で大きく落ちる → 値が大きい
 * - 既にボケた画像: 落とす細かい成分が無いので変化しない → 値が小さい
 *
 * 露出や被写体の模様の濃さに依らない比の量なので、現場でのしきい値が安定します。
 */
export function focusScore(image) {
  const sharp = meanGradient(image);
  if (sharp < 1e-12) return 0;
  const blurred = meanGradient(blur3x3(image));
  return Math.max(0, 1 - blurred / sharp);
}

function meanGradient(image) {
  const { width: w, height: h, data } = image;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = (data[y * w + x + 1] - data[y * w + x - 1]) * 0.5;
      const gy = (data[(y + 1) * w + x] - data[(y - 1) * w + x]) * 0.5;
      sum += Math.hypot(gx, gy);
      count++;
    }
  }
  return count ? sum / count : 0;
}

function blur3x3(image) {
  const { width: w, height: h, data } = image;
  const out = new Float32Array(w * h);
  const at = (x, y) => data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] =
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) +
         2 * at(x - 1, y) + 4 * at(x, y) + 2 * at(x + 1, y) +
         at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) / 16;
    }
  }
  return { width: w, height: h, data: out };
}

/** DIC の期待精度の目安（px）。MIG に反比例する経験式。 */
export function expectedAccuracyPx({ mig, subsetHalf = 15, noiseLevel = 0.005 }) {
  const size = subsetHalf * 2 + 1;
  if (!(mig > 0)) return Infinity;
  // Pan et al. の σ_u ≈ σ_noise / (N * MIG) を単純化したもの
  return noiseLevel / (size * mig);
}
