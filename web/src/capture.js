/**
 * 計測セッションの判断ロジック。
 *
 * 3Dスキャンアプリの「塗り終わったら完了」と同じ考え方で、
 * 「何枚撮るか」の判断をユーザーから取り上げる。
 * シャッターを押したら撮り続け、検出限界の見積もりが収束したら
 * アプリの側から「もう十分」と言う。
 *
 * カメラや DOM には触らない。ここにあるのは判断だけで、
 * 全部 node の合成データで検証できる。
 */

import { estimateGlobalShift, measureDisplacementField } from './dic.js';
import { fitAffine, residuals } from './transform.js';
import { summarize } from './sigma.js';
import { downsample } from './image.js';

/** セッションの既定値。 */
export const SESSION_DEFAULTS = {
  minFrames: 5,        // これ未満では σ の見積もり自体が不安定
  maxFrames: 15,       // √N の利得は 10枚超でほぼ頭打ち（15枚で1.2倍しか変わらない）
  convergenceTol: 0.08, // 限界の見積もりの変化がこれ以下に2回続いたら収束
  maxRejects: 3,       // 連続でこの枚数弾かれたら、条件が悪いと判断して止める
};

/**
 * セッションを続けるか止めるかの判断。
 *
 * @param {number[]} limits 各フレーム追加後の検出限界の見積もり（単位は問わない）
 * @param {{frames: number, consecutiveRejects: number}} status
 * @returns {{stop: boolean, reason: 'converged'|'max'|'quality'|null}}
 */
export function shouldStop(limits, status, options = {}) {
  const { minFrames, maxFrames, convergenceTol, maxRejects } =
    { ...SESSION_DEFAULTS, ...options };

  if (status.consecutiveRejects >= maxRejects) return { stop: true, reason: 'quality' };
  if (status.frames >= maxFrames) return { stop: true, reason: 'max' };
  if (status.frames < minFrames || limits.length < 3) return { stop: false, reason: null };

  // 直近2回の追加で、限界の見積もりがどちらも tol 以内しか動かなければ収束。
  // 1回だけだと「たまたま動かなかった」を拾う
  const n = limits.length;
  const settled = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b > 0
    && Math.abs(a - b) / b <= convergenceTol;
  if (settled(limits[n - 1], limits[n - 2]) && settled(limits[n - 2], limits[n - 3])) {
    return { stop: true, reason: 'converged' };
  }
  return { stop: false, reason: null };
}

/**
 * ライブフレームの合否。撮影中にその場で弾く。
 *
 * ボケの基準は絶対値ではなく採用済みフレームとの相対比較
 * （絶対値はレンズ・被写体で変わる。セッション内なら同条件なので比べられる）。
 *
 * @param {{focus: number, verdict: string}} candidate
 * @param {number[]} acceptedFocuses 採用済みフレームのピント値
 * @returns {{ok: boolean, reason: string|null}}
 */
export function frameGate(candidate, acceptedFocuses) {
  if (candidate.verdict === 'poor') {
    return { ok: false, reason: '模様が足りません' };
  }
  if (acceptedFocuses.length >= 2) {
    const sorted = [...acceptedFocuses].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (median > 0 && candidate.focus < median * 0.6) {
      return { ok: false, reason: 'ブレています' };
    }
  }
  return { ok: true, reason: null };
}

/**
 * 撮影中の簡易 σ。基準（1枚目）と最新フレームの1組だけを、
 * 荒い設定で素早く測る。収束判定に使うのはこの見積もりで、
 * 最終結果は従来どおり全組・本設定で出し直す。
 *
 * @param {object} reference グレースケール（縮小済みを渡すこと）
 * @param {object} target 同上
 * @returns {number|null} σ [px・縮小前スケールではない]
 */
export function quickSigma(reference, target, options = {}) {
  const { subsetHalf = 10, step = 40, minPoints = 10 } = options;
  const shift = estimateGlobalShift(reference, target, downsample, { maxShiftPx: 200 });
  const field = measureDisplacementField(reference, target, {
    subsetHalf, step, searchRange: 3, minZNCC: 0.7, initialShift: shift,
  });
  if (field.points.length < minPoints) return null;
  const transform = fitAffine(field.points);
  if (!transform) return null;
  return summarize(residuals(transform, field.points)).sigma;
}

/**
 * σ の系列から検出限界の見積もりを出す。
 *
 * 系列の中央値を σ とし、対（√2）と N 枚平均（1/√N）を織り込む。
 * 単発の σ を使うと1組の外れで収束判定が暴れるので、必ず中央値で。
 *
 * @param {number[]} sigmas 各フレームの簡易 σ [px]
 * @param {number|null} gsd mm/px（無ければ px のまま）
 */
export function limitEstimate(sigmas, gsd) {
  const valid = sigmas.filter((s) => Number.isFinite(s) && s > 0);
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const frames = sigmas.length + 1;   // 基準1枚 + 比較枚数
  const px = 3 * Math.SQRT2 * median / Math.sqrt(frames);
  return { px, mm: gsd ? px * gsd : null, frames, sigmaPx: median };
}

// ---------------------------------------------------------------- レンズ倍率の実測

/** バイリニアで任意倍率に再標本化する（scale<1 で縮小）。 */
export function resample(image, scale) {
  const w = Math.max(2, Math.round(image.width * scale));
  const h = Math.max(2, Math.round(image.height * scale));
  const out = new Float32Array(w * h);
  const sx = (image.width - 1) / Math.max(1, w - 1);
  const sy = (image.height - 1) / Math.max(1, h - 1);
  for (let y = 0; y < h; y += 1) {
    const fy = y * sy;
    const y0 = Math.min(image.height - 2, Math.floor(fy));
    const ty = fy - y0;
    for (let x = 0; x < w; x += 1) {
      const fx = x * sx;
      const x0 = Math.min(image.width - 2, Math.floor(fx));
      const tx = fx - x0;
      const i = y0 * image.width + x0;
      const a = image.data[i], b = image.data[i + 1];
      const cc = image.data[i + image.width], d = image.data[i + image.width + 1];
      out[y * w + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
    }
  }
  return { width: w, height: h, data: out };
}

function centerCrop(image, w, h) {
  const x0 = Math.max(0, Math.floor((image.width - w) / 2));
  const y0 = Math.max(0, Math.floor((image.height - h) / 2));
  const cw = Math.min(w, image.width - x0);
  const ch = Math.min(h, image.height - y0);
  const out = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y += 1) {
    out.set(image.data.subarray((y0 + y) * image.width + x0, (y0 + y) * image.width + x0 + cw), y * cw);
  }
  return { width: cw, height: ch, data: out };
}

/**
 * 2つのレンズで同じ壁を撮った画から、焦点距離の比（other / wide）を実測する。
 *
 * 望遠の倍率は API から取れず、機種名も Web からは読めない。だが同じ壁を
 * 広角と望遠で撮れば、倍率は「どれだけ縮めると重なるか」として測れる。
 * 対数格子で比を振り、共通スケールに揃えた2枚の相関が最大になる比を採る。
 * 光軸のずれ（レンズ間の物理距離）は並進探索で吸収する。
 *
 * @returns {{ratio: number, zncc: number}|null}
 */
export function estimateLensRatio(wide, other, options = {}) {
  const { minRatio = 0.3, maxRatio = 8, steps = 90 } = options;
  const evalAt = (r) => {
    let a, b;
    if (r >= 1) {
      // other が寄っている: other を 1/r に縮めて、wide の中央を同じ大きさで切る
      b = resample(other, 1 / r);
      a = centerCrop(wide, b.width, b.height);
    } else {
      a = resample(wide, r);
      b = centerCrop(other, a.width, a.height);
    }
    if (Math.min(a.width, a.height, b.width, b.height) < 40) return -1;
    const s = estimateGlobalShift(a, b, downsample,
      { maxShiftPx: Math.floor(Math.min(a.width, a.height) / 8) });
    return s.confidence;
  };

  const logMin = Math.log(minRatio);
  const logMax = Math.log(maxRatio);
  let best = { r: 1, z: -2 };
  const grid = [];
  for (let i = 0; i <= steps; i += 1) {
    const r = Math.exp(logMin + (logMax - logMin) * (i / steps));
    const z = evalAt(r);
    grid.push({ r, z });
    if (z > best.z) best = { r, z };
  }
  if (best.z < 0.35) return null;

  // 最良点の両隣で放物線内挿（対数比で）
  const k = grid.findIndex((g) => g.r === best.r);
  if (k > 0 && k < grid.length - 1) {
    const l = grid[k - 1].z, m = grid[k].z, rr = grid[k + 1].z;
    const denom = l - 2 * m + rr;
    if (Math.abs(denom) > 1e-9) {
      const d = Math.max(-0.5, Math.min(0.5, 0.5 * (l - rr) / denom));
      const step = (logMax - logMin) / steps;
      best.r = Math.exp(Math.log(best.r) + d * step);
    }
  }
  return { ratio: best.r, zncc: best.z };
}
