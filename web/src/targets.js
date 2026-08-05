// 円形ターゲットの検出とサブピクセル重心。
//
// 写真測量では古典的に、円形ターゲットの重心を輝度で重み付けして求めます。
// しきい値で2値化した図心ではなく **輝度加重重心** を使うのが要点で、
// しきい値の取り方に重心が引きずられません。これで 1/50 px 級が出ます。
//
// DIC と違い、照明が変わっても形状が二値的なので相関が落ちません。
// 一方でターゲットを貼る作業が要ります。両者は補完関係にあります。

/** @typedef {{width:number, height:number, data:Float32Array}} Gray */

/**
 * @typedef {object} Target
 * @property {number} x サブピクセル重心
 * @property {number} y
 * @property {number} radius 見かけの半径[px]
 * @property {number} contrast 背景に対する落ち込み（0〜1）
 * @property {number} fill 外接矩形に対する充填率（円なら約0.785）
 * @property {number} aspect 縦横比（1が真円、斜めから見ると増える）
 * @property {number} pixels 連結画素数
 */

export const defaultOptions = {
  /** 想定するターゲット半径の範囲[px] */
  minRadius: 4,
  maxRadius: 80,
  /** 背景推定に使うボックス半径。ターゲット径の3倍以上を推奨 */
  backgroundRadius: 60,
  /** 検出しきい値（背景との差の最大値に対する比） */
  relativeThreshold: 0.35,
  /** 形状フィルタ */
  minFill: 0.45,
  maxFill: 0.98,
  maxAspect: 2.6,
  /** 暗いターゲット（白地に黒丸）なら true */
  darkTargets: true,
};

/**
 * 画像からターゲットを検出する。
 * @param {Gray} image
 * @returns {Target[]}
 */
export function detectTargets(image, userOptions = {}) {
  const o = { ...defaultOptions, ...userOptions };
  const { width: w, height: h } = image;
  if (w < 16 || h < 16) return [];

  // 背景（大きめのボックス平均）との差をとる。照明ムラに強くなる。
  const background = boxBlur(image, Math.max(8, Math.round(o.backgroundRadius)));
  const response = new Float32Array(w * h);
  let maxResponse = 0;
  for (let i = 0; i < response.length; i++) {
    const diff = o.darkTargets
      ? background.data[i] - image.data[i]
      : image.data[i] - background.data[i];
    const v = diff > 0 ? diff : 0;
    response[i] = v;
    if (v > maxResponse) maxResponse = v;
  }
  if (maxResponse < 1e-6) return [];

  const threshold = maxResponse * o.relativeThreshold;
  const labels = new Int32Array(w * h).fill(-1);
  const targets = [];
  let label = 0;

  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (labels[idx] !== -1 || response[idx] < threshold) continue;

      // 連結成分を拾う
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      labels[idx] = label;
      stack.length = 0;
      stack.push(idx);
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % w;
        const cy = (cur / w) | 0;
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n = ny * w + nx;
            if (labels[n] === -1 && response[n] >= threshold) {
              labels[n] = label;
              stack.push(n);
            }
          }
        }
      }
      label++;

      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;
      const radius = Math.sqrt(count / Math.PI);
      if (radius < o.minRadius || radius > o.maxRadius) continue;

      const fill = count / (boxW * boxH);
      const aspect = Math.max(boxW, boxH) / Math.max(1, Math.min(boxW, boxH));
      if (fill < o.minFill || fill > o.maxFill) continue;
      if (aspect > o.maxAspect) continue;
      // 画像の縁に掛かっているものは重心が偏るので捨てる
      if (minX < 2 || minY < 2 || maxX > w - 3 || maxY > h - 3) continue;

      const seedX = (minX + maxX) / 2;
      const seedY = (minY + maxY) / 2;
      const refined = refineCentroid(image, seedX, seedY, radius, o.darkTargets);
      if (!refined) continue;

      targets.push({
        x: refined.x,
        y: refined.y,
        radius,
        contrast: refined.contrast,
        fill,
        aspect,
        pixels: count,
      });
    }
  }

  // 大きいものから返す（主要ターゲットが先頭に来る）
  targets.sort((a, b) => b.pixels - a.pixels);
  return targets;
}

/**
 * 輝度加重によるサブピクセル重心。
 *
 * 窓の外周から局所背景を推定し、`背景 - 輝度` を重みにします。
 * しきい値で切った図心と違い、しきい値の取り方で重心が動きません。
 */
export function refineCentroid(image, cx, cy, radius, darkTargets = true) {
  const { width: w, height: h, data } = image;
  const win = Math.max(3, Math.round(radius * 2.2));
  const x0 = Math.max(0, Math.round(cx) - win);
  const x1 = Math.min(w - 1, Math.round(cx) + win);
  const y0 = Math.max(0, Math.round(cy) - win);
  const y1 = Math.min(h - 1, Math.round(cy) + win);
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;

  // 局所背景: 窓の外周1画素の中央値
  const ring = [];
  for (let x = x0; x <= x1; x++) {
    ring.push(data[y0 * w + x], data[y1 * w + x]);
  }
  for (let y = y0 + 1; y < y1; y++) {
    ring.push(data[y * w + x0], data[y * w + x1]);
  }
  ring.sort((a, b) => a - b);
  const background = ring[ring.length >> 1];

  let sum = 0;
  let sumX = 0;
  let sumY = 0;
  let peak = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = data[y * w + x];
      const weight = darkTargets ? background - v : v - background;
      if (weight <= 0) continue;
      sum += weight;
      sumX += weight * x;
      sumY += weight * y;
      if (weight > peak) peak = weight;
    }
  }
  if (sum <= 1e-9) return null;

  return {
    x: sumX / sum,
    y: sumY / sum,
    contrast: background > 1e-9 ? peak / background : 0,
  };
}

/**
 * 2枚の画像で検出したターゲットを対応付ける。
 *
 * 同じ場所からの撮影が前提なので、粗いずれを補正したうえで
 * 最近傍かつ相互最近傍のものだけを採用します。
 *
 * @param {Target[]} a
 * @param {Target[]} b
 * @param {{dx:number, dy:number}} shift b 側のおおまかなずれ
 * @param {number} tolerance 対応とみなす最大距離[px]
 * @returns {Array<{a:Target, b:Target, index:number}>}
 */
export function matchTargets(a, b, shift = { dx: 0, dy: 0 }, tolerance = 30) {
  const pairs = [];
  for (let i = 0; i < a.length; i++) {
    const px = a[i].x + shift.dx;
    const py = a[i].y + shift.dy;
    let best = -1;
    let bestDistance = Infinity;
    for (let j = 0; j < b.length; j++) {
      const d = Math.hypot(b[j].x - px, b[j].y - py);
      if (d < bestDistance) {
        bestDistance = d;
        best = j;
      }
    }
    if (best < 0 || bestDistance > tolerance) continue;

    // 相互最近傍か確認（取り違えを防ぐ）
    let backBest = -1;
    let backDistance = Infinity;
    for (let k = 0; k < a.length; k++) {
      const d = Math.hypot(b[best].x - (a[k].x + shift.dx), b[best].y - (a[k].y + shift.dy));
      if (d < backDistance) {
        backDistance = d;
        backBest = k;
      }
    }
    if (backBest !== i) continue;

    pairs.push({ a: a[i], b: b[best], index: i });
  }
  return pairs;
}

/** すべてのターゲット対の距離（px）。追跡ではこの変化量を見ます。 */
export function pairwiseDistances(targets) {
  const out = [];
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      out.push({
        i,
        j,
        distance: Math.hypot(targets[i].x - targets[j].x, targets[i].y - targets[j].y),
      });
    }
  }
  return out;
}

function boxBlur(image, radius) {
  const { width: w, height: h, data } = image;
  const window = radius * 2 + 1;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += data[y * w + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / window;
      sum += data[y * w + clamp(x + radius + 1, 0, w - 1)] - data[y * w + clamp(x - radius, 0, w - 1)];
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / window;
      sum += tmp[clamp(y + radius + 1, 0, h - 1) * w + x] - tmp[clamp(y - radius, 0, h - 1) * w + x];
    }
  }
  return { width: w, height: h, data: out };
}
