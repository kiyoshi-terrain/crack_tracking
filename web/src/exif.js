// 最小限の EXIF パーサ（JPEG の APP1 セグメント）。
//
// 焦点距離が読めれば GSD が計算でき、撮影日時と機種で撮り分けの管理ができます。
// もう一つ重要な用途があって、**複数枚の焦点距離が揃っているかの検証**です。
// iPhone で「5x」を選んでも、条件によってはデジタルズームが混ざって
// 焦点距離が変わることがあります。そうなるとスケールが枚ごとに変わり、
// 追跡測定が静かに壊れます。

const TAGS = {
  0x010f: 'make',
  0x0110: 'model',
  0x0112: 'orientation',
  0x829a: 'exposureTime',
  0x829d: 'fNumber',
  0x8827: 'iso',
  0x9003: 'dateTimeOriginal',
  0x920a: 'focalLength',
  0xa002: 'pixelXDimension',
  0xa003: 'pixelYDimension',
  0xa405: 'focalLength35mm',
};

const EXIF_IFD_POINTER = 0x8769;

/**
 * @param {ArrayBuffer} buffer 画像ファイル全体
 * @returns {object|null} 取得できたタグ。JPEG 以外や EXIF 無しなら null。
 */
export function parseExif(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4) return null;
  // SOI
  if (view.getUint16(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xda) break; // SOS 以降は画像データ
    const length = view.getUint16(offset + 2);
    if (marker === 0xe1) {
      const start = offset + 4;
      // "Exif\0\0"
      if (
        view.getUint32(start) === 0x45786966 &&
        view.getUint16(start + 4) === 0x0000
      ) {
        return parseTiff(view, start + 6);
      }
    }
    offset += 2 + length;
  }
  return null;
}

function parseTiff(view, tiffStart) {
  const byteOrder = view.getUint16(tiffStart);
  const little = byteOrder === 0x4949;
  if (!little && byteOrder !== 0x4d4d) return null;
  if (view.getUint16(tiffStart + 2, little) !== 42) return null;

  const ifd0 = view.getUint32(tiffStart + 4, little);
  const result = {};
  readIFD(view, tiffStart, tiffStart + ifd0, little, result);

  if (result.__exifIFD) {
    readIFD(view, tiffStart, tiffStart + result.__exifIFD, little, result);
    delete result.__exifIFD;
  }
  return result;
}

function readIFD(view, tiffStart, ifdOffset, little, out) {
  if (ifdOffset + 2 > view.byteLength) return;
  const count = view.getUint16(ifdOffset, little);
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > view.byteLength) return;
    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const num = view.getUint32(entry + 4, little);

    if (tag === EXIF_IFD_POINTER) {
      out.__exifIFD = view.getUint32(entry + 8, little);
      continue;
    }
    const name = TAGS[tag];
    if (!name) continue;

    const value = readValue(view, tiffStart, entry + 8, type, num, little);
    if (value !== undefined) out[name] = value;
  }
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readValue(view, tiffStart, valueOffset, type, count, little) {
  const size = TYPE_SIZE[type];
  if (!size) return undefined;
  const total = size * count;
  let base = valueOffset;
  if (total > 4) {
    base = tiffStart + view.getUint32(valueOffset, little);
  }
  if (base + total > view.byteLength) return undefined;

  switch (type) {
    case 2: {
      // ASCII
      let s = '';
      for (let i = 0; i < count; i++) {
        const c = view.getUint8(base + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    }
    case 3:
      return view.getUint16(base, little);
    case 4:
      return view.getUint32(base, little);
    case 5: {
      const numerator = view.getUint32(base, little);
      const denominator = view.getUint32(base + 4, little);
      return denominator ? numerator / denominator : 0;
    }
    case 9:
      return view.getInt32(base, little);
    case 10: {
      const numerator = view.getInt32(base, little);
      const denominator = view.getInt32(base + 4, little);
      return denominator ? numerator / denominator : 0;
    }
    default:
      return view.getUint8(base);
  }
}

/**
 * 複数枚の EXIF を比較して、追跡測定を壊す不一致を洗い出す。
 */
export function checkConsistency(exifList) {
  const warnings = [];
  const present = exifList.filter(Boolean);
  if (present.length < 2) return warnings;

  const focals = present.map((e) => e.focalLength35mm ?? e.focalLength).filter((v) => v != null);
  if (focals.length >= 2) {
    const min = Math.min(...focals);
    const max = Math.max(...focals);
    if (max - min > 1e-6) {
      warnings.push(
        `焦点距離が揃っていません（${min} 〜 ${max}）。ズーム倍率が枚ごとに変わると` +
          `スケールも変わります。倍率を固定して撮り直してください。`
      );
    }
  }

  const models = new Set(present.map((e) => e.model).filter(Boolean));
  if (models.size > 1) {
    warnings.push(`複数の機種が混在しています（${[...models].join(', ')}）。校正値が異なります。`);
  }

  const sizes = new Set(
    present.map((e) => `${e.pixelXDimension ?? '?'}x${e.pixelYDimension ?? '?'}`)
  );
  if (sizes.size > 1) {
    warnings.push(`画像サイズが揃っていません（${[...sizes].join(', ')}）。`);
  }

  return warnings;
}
