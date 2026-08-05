// 画像の読み込みと、解析用グレースケールへの変換。

/** sRGB 8bit → 線形光 のルックアップテーブル */
const SRGB_TO_LINEAR = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return table;
})();

/**
 * ファイルをデコードして ImageData にする。
 *
 * HEIC は Safari なら通りますが Chrome では失敗します。その場合は
 * 呼び出し側でユーザーに JPEG 撮影を促してください
 * （設定 > カメラ > フォーマット > 互換性優先）。
 */
export async function decodeFile(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (error) {
    throw new Error(
      `${file.name} をデコードできません。HEIC の場合、この端末のブラウザは非対応です。` +
        `iPhone の「設定 > カメラ > フォーマット」を「互換性優先」にして JPEG で撮影してください。`
    );
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close?.();
  return imageData;
}

/**
 * ImageData の一部を切り出してグレースケール（Float32）にする。
 *
 * @param {ImageData} imageData
 * @param {{x:number,y:number,width:number,height:number}} [region]
 * @param {'luma'|'green'} [channel]
 *   luma: 線形光の輝度。SNR が良く、汎用。
 *   green: 緑チャンネルのみ。ベイヤー配列で標本数が2倍あり、
 *          デモザイクによる隣接画素の相関が最も小さい。サブピクセル精度重視ならこちら。
 * @param {boolean} [linearize] 線形光へ戻すか
 */
export function toGray(imageData, region, channel = 'luma', linearize = true) {
  const { width: iw, height: ih, data: src } = imageData;
  const r = clampRegion(region ?? { x: 0, y: 0, width: iw, height: ih }, iw, ih);
  const out = new Float32Array(r.width * r.height);

  for (let y = 0; y < r.height; y++) {
    let si = ((r.y + y) * iw + r.x) * 4;
    let di = y * r.width;
    for (let x = 0; x < r.width; x++, si += 4, di++) {
      if (channel === 'green') {
        out[di] = linearize ? SRGB_TO_LINEAR[src[si + 1]] : src[si + 1] / 255;
      } else if (linearize) {
        out[di] =
          0.2126 * SRGB_TO_LINEAR[src[si]] +
          0.7152 * SRGB_TO_LINEAR[src[si + 1]] +
          0.0722 * SRGB_TO_LINEAR[src[si + 2]];
      } else {
        out[di] = (0.2126 * src[si] + 0.7152 * src[si + 1] + 0.0722 * src[si + 2]) / 255;
      }
    }
  }
  return { width: r.width, height: r.height, data: out };
}

export function clampRegion(region, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.round(region.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(region.y)));
  const w = Math.max(1, Math.min(width - x, Math.round(region.width)));
  const h = Math.max(1, Math.min(height - y, Math.round(region.height)));
  return { x, y, width: w, height: h };
}

/** 面積平均による整数倍縮小。粗いアライメント用。 */
export function downsample(image, factor) {
  if (factor <= 1) return image;
  const w = Math.floor(image.width / factor);
  const h = Math.floor(image.height / factor);
  const out = new Float32Array(w * h);
  const inv = 1 / (factor * factor);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < factor; j++) {
        const row = (y * factor + j) * image.width + x * factor;
        for (let i = 0; i < factor; i++) sum += image.data[row + i];
      }
      out[y * w + x] = sum * inv;
    }
  }
  return { width: w, height: h, data: out };
}

/** プレビュー表示用に長辺を maxSide 以内へ縮めた canvas を返す。 */
export function makePreviewCanvas(imageData, maxSide = 900) {
  const scale = Math.min(1, maxSide / Math.max(imageData.width, imageData.height));
  const w = Math.max(1, Math.round(imageData.width * scale));
  const h = Math.max(1, Math.round(imageData.height * scale));

  const full = new OffscreenCanvas(imageData.width, imageData.height);
  full.getContext('2d').putImageData(imageData, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, w, h);
  return { canvas, scale };
}
