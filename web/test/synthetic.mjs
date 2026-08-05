// 既知の変位を持つ合成テクスチャ。
//
// 連続関数（ガウシアン斑点の重ね合わせ）を定義し、格子点で標本化することで
// 「補間誤差を含まない、厳密にずれた画像ペア」を作れます。
// 大谷石のミソや粒状組織を模したパターンでもあります。

function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function makeBlobs({ width, height, count = 500, seed = 1 }) {
  const rnd = makeRandom(seed);
  const blobs = [];
  for (let i = 0; i < count; i++) {
    blobs.push({
      x: rnd() * width,
      y: rnd() * height,
      sigma: 1.2 + rnd() * 2.6,
      amp: (rnd() - 0.5) * 0.9,
    });
  }
  return blobs;
}

/**
 * 斑点場を標本化して画像を作る。
 * `(u, v)` を指定すると、特徴が (u, v) だけ移動した画像になる。
 */
export function renderBlobs(blobs, width, height, { u = 0, v = 0, gain = 1, offset = 0, noise = 0, seed = 7 } = {}) {
  const rnd = makeRandom(seed);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // f(x - u, y - v) を標本化 → 特徴は +(u,v) 方向へ動く
      const px = x - u;
      const py = y - v;
      let value = 0.5;
      for (const b of blobs) {
        const dx = px - b.x;
        const dy = py - b.y;
        const r2 = dx * dx + dy * dy;
        const cut = 9 * b.sigma * b.sigma;
        if (r2 < cut) {
          value += b.amp * Math.exp(-r2 / (2 * b.sigma * b.sigma));
        }
      }
      value = value * gain + offset;
      if (noise > 0) value += (rnd() - 0.5) * noise;
      data[y * width + x] = value;
    }
  }
  return { width, height, data };
}
