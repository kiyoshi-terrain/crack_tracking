// 標点間距離。番号は検出順ではなく、利用者が写真で照合した現地IDを使う。
import { robustSigma } from './sigma.js';

export function validateTargetIds(assignments) {
  const ids = assignments.map((a) => a.id.trim());
  if (ids.some((id) => !id)) return '図の番号を現地IDに対応させてください';
  if (new Set(ids).size !== ids.length) return '現地IDが重複しています';
  return null;
}

export function targetScalePair(pairs, assignments, key, lengthMM) {
  const pair = pairs.find((p) => `${p.i}-${p.j}` === key);
  if (!pair || !(lengthMM > 0) || !Number.isFinite(lengthMM)) return null;
  const a = assignments[pair.i], b = assignments[pair.j];
  // 「同じ側」だけでは、別々の石が動く場合を除外できない。
  if (!a?.member.trim() || a.member.trim() !== b?.member.trim()) return null;
  return pair;
}

export function summarizeTargetSeries(values) {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0);
  const mean = valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : null;
  return { mean, sigma: valid.length >= 2 ? robustSigma(valid) : null, frames: valid.length };
}

/**
 * 同じフレーム内の計測距離 / 基準距離を平均する。
 * 一様な撮影倍率の変動は相殺するが、斜め撮影・奥行き差は補正しない。
 * σは繰返し成分だけ。基準距離の実測誤差・取付け・姿勢誤差を保証しない。
 */
export function calibratedTargetPairs(pairs, series, assignments, scaleKey, lengthMM, floorPx = 0.02) {
  if (validateTargetIds(assignments)) return [];
  const scale = targetScalePair(pairs, assignments, scaleKey, lengthMM);
  if (!scale) return [];
  const scaleIndex = pairs.indexOf(scale);
  const scaleValues = series[scaleIndex];
  const scaleMean = summarizeTargetSeries(scaleValues).mean;
  if (!(scaleMean > 0)) return [];
  const scaleIds = [assignments[scale.i].id.trim(), assignments[scale.j].id.trim()].sort();
  return pairs.flatMap((pair, i) => {
    // 基準対は定数に正規化されるので、変位の計測点としては提供しない。
    if (i === scaleIndex) return [];
    const values = series[i].map((d, f) => d > 0 && scaleValues[f] > 0
      ? d / scaleValues[f] * lengthMM : NaN);
    const stats = summarizeTargetSeries(values);
    if (stats.frames < 2) return [];
    const ids = [assignments[pair.i].id.trim(), assignments[pair.j].id.trim()].sort();
    const sourceKey = JSON.stringify({ kind: 'target-distance', ids, scaleIds, lengthMM });
    // 比の分子と分母それぞれの固定誤差床を合成。フレーム数では縮めない。
    const floorMM = floorPx * lengthMM / scaleMean * Math.hypot(1, stats.mean / lengthMM);
    return [{
      label: ids.join(' ↔ '), kind: 'target', sourceKey,
      method: '標点間距離（現地ID照合・同一フレーム内縮尺）',
      meanMM: stats.mean, sigmaMM: Math.hypot(stats.sigma / Math.sqrt(stats.frames), floorMM),
      repeatSigmaMM: stats.sigma, frames: stats.frames,
      scaleIds, referenceLengthMM: lengthMM,
    }];
  });
}
