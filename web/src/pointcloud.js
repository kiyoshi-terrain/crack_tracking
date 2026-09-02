/**
 * 点群（PLY / LAS）から壁面の平面を出し、面外の凹凸を測る。
 *
 * き裂の開き（面内）は写真の方が2桁精度が高いので、点群にそれは期待しない。
 * 点群にしか出せないのは**面外**、つまり石材が手前にはらみ出しているかどうか。
 * 剥落の前兆はここに出るので、平面からの残差を石材スケールで見るのが目的。
 *
 * 依存なし・入出力は数値だけ。合成点群で回帰テストできる。
 */

// ---------------------------------------------------------------- PLY

const PLY_TYPE_SIZE = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4,
  float: 4, float32: 4,
  double: 8, float64: 8,
};

function readPlyScalar(view, offset, type, littleEndian) {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    case 'short': case 'int16': return view.getInt16(offset, littleEndian);
    case 'ushort': case 'uint16': return view.getUint16(offset, littleEndian);
    case 'int': case 'int32': return view.getInt32(offset, littleEndian);
    case 'uint': case 'uint32': return view.getUint32(offset, littleEndian);
    case 'float': case 'float32': return view.getFloat32(offset, littleEndian);
    case 'double': case 'float64': return view.getFloat64(offset, littleEndian);
    default: throw new Error(`未知の PLY 型: ${type}`);
  }
}

/**
 * PLY を読む。ascii / binary_little_endian / binary_big_endian に対応。
 * vertex 要素の x,y,z だけを取り出す（面や色は捨てる）。
 * @param {ArrayBuffer} buffer
 * @returns {{points: Float64Array, count: number, format: string}}
 */
export function parsePLY(buffer) {
  const bytes = new Uint8Array(buffer);
  const headerEnd = findMarker(bytes, 'end_header');
  if (headerEnd < 0) throw new Error('PLY のヘッダが見つかりません');

  // end_header の行末まで進める（\r\n と \n の両方）
  let dataStart = headerEnd + 'end_header'.length;
  while (dataStart < bytes.length && bytes[dataStart] !== 0x0a) dataStart += 1;
  dataStart += 1;

  const header = new TextDecoder('ascii').decode(bytes.subarray(0, headerEnd));
  const lines = header.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (!lines[0] || !lines[0].startsWith('ply')) throw new Error('PLY ではありません');

  let format = null;
  const elements = [];
  let current = null;

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'format') {
      format = parts[1];
    } else if (parts[0] === 'element') {
      current = { name: parts[1], count: Number(parts[2]), properties: [] };
      elements.push(current);
    } else if (parts[0] === 'property' && current) {
      if (parts[1] === 'list') {
        current.properties.push({ list: true, countType: parts[2], itemType: parts[3], name: parts[4] });
      } else {
        current.properties.push({ list: false, type: parts[1], name: parts[2] });
      }
    }
  }

  if (!format) throw new Error('PLY の format 行がありません');
  const vertex = elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new Error('PLY に vertex 要素がありません');

  const nameIndex = new Map(vertex.properties.map((p, i) => [p.name, i]));
  for (const key of ['x', 'y', 'z']) {
    if (!nameIndex.has(key)) throw new Error(`PLY の vertex に ${key} がありません`);
  }

  const count = vertex.count;
  const out = new Float64Array(count * 3);

  if (format === 'ascii') {
    const text = new TextDecoder('ascii').decode(bytes.subarray(dataStart));
    const rows = text.split(/\r?\n/);
    const ix = nameIndex.get('x'), iy = nameIndex.get('y'), iz = nameIndex.get('z');
    let n = 0;
    for (const row of rows) {
      if (n >= count) break;
      const t = row.trim();
      if (!t) continue;
      const v = t.split(/\s+/);
      out[n * 3] = Number(v[ix]);
      out[n * 3 + 1] = Number(v[iy]);
      out[n * 3 + 2] = Number(v[iz]);
      n += 1;
    }
    if (n < count) throw new Error(`PLY の点数が足りません（${n}/${count}）`);
    return { points: out, count, format };
  }

  const littleEndian = format === 'binary_little_endian';
  if (!littleEndian && format !== 'binary_big_endian') {
    throw new Error(`未対応の PLY format: ${format}`);
  }

  // vertex 要素内でのバイト位置を先に確定させる（リスト型があると固定長でなくなる）
  let stride = 0;
  const offsets = [];
  for (const p of vertex.properties) {
    if (p.list) throw new Error('vertex にリスト型プロパティがある PLY は未対応です');
    const size = PLY_TYPE_SIZE[p.type];
    if (!size) throw new Error(`未知の PLY 型: ${p.type}`);
    offsets.push({ name: p.name, type: p.type, offset: stride });
    stride += size;
  }

  const view = new DataView(buffer);
  const px = offsets[nameIndex.get('x')];
  const py = offsets[nameIndex.get('y')];
  const pz = offsets[nameIndex.get('z')];

  const needed = dataStart + stride * count;
  if (needed > bytes.length) {
    throw new Error(`PLY の本体が短すぎます（${bytes.length - dataStart} / ${stride * count} バイト）`);
  }

  for (let i = 0; i < count; i += 1) {
    const base = dataStart + i * stride;
    out[i * 3] = readPlyScalar(view, base + px.offset, px.type, littleEndian);
    out[i * 3 + 1] = readPlyScalar(view, base + py.offset, py.type, littleEndian);
    out[i * 3 + 2] = readPlyScalar(view, base + pz.offset, pz.type, littleEndian);
  }
  return { points: out, count, format };
}

function findMarker(bytes, marker) {
  const m = [];
  for (let i = 0; i < marker.length; i += 1) m.push(marker.charCodeAt(i));
  const limit = Math.min(bytes.length, 1 << 20) - m.length;
  outer: for (let i = 0; i <= limit; i += 1) {
    for (let j = 0; j < m.length; j += 1) {
      if (bytes[i + j] !== m[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------- LAS

/**
 * LAS を読む。1.2〜1.4、point data record format 0〜10 に対応。
 * X/Y/Z は全フォーマットで先頭 12 バイトに int32 で入っているので扱いは共通。
 * LAZ（圧縮）は別物なので明示的に弾く。
 * @param {ArrayBuffer} buffer
 */
export function parseLAS(buffer) {
  const view = new DataView(buffer);
  const sig = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (sig !== 'LASF') throw new Error('LAS ではありません');

  const versionMajor = view.getUint8(24);
  const versionMinor = view.getUint8(25);
  const offsetToPointData = view.getUint32(96, true);
  let pointFormat = view.getUint8(104);
  const pointLength = view.getUint16(105, true);

  // 最上位ビットが立っていたら LAZ 圧縮
  if (pointFormat & 0x80) {
    throw new Error('LAZ（圧縮 LAS）は未対応です。LAS か PLY で書き出してください');
  }
  pointFormat &= 0x3f;

  const scaleX = view.getFloat64(131, true);
  const scaleY = view.getFloat64(139, true);
  const scaleZ = view.getFloat64(147, true);
  const offX = view.getFloat64(155, true);
  const offY = view.getFloat64(163, true);
  const offZ = view.getFloat64(171, true);

  let count = view.getUint32(107, true);
  if (versionMajor === 1 && versionMinor >= 4) {
    const extended = Number(view.getBigUint64(247, true));
    if (extended > 0) count = extended;
  }

  const available = Math.floor((buffer.byteLength - offsetToPointData) / pointLength);
  if (count > available) count = available;
  if (!(count > 0)) throw new Error('LAS に点がありません');

  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const base = offsetToPointData + i * pointLength;
    out[i * 3] = view.getInt32(base, true) * scaleX + offX;
    out[i * 3 + 1] = view.getInt32(base + 4, true) * scaleY + offY;
    out[i * 3 + 2] = view.getInt32(base + 8, true) * scaleZ + offZ;
  }
  return { points: out, count, version: `${versionMajor}.${versionMinor}`, pointFormat };
}

/** 拡張子ではなく中身で判定する。 */
export function parsePointCloud(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  const sig = String.fromCharCode(...head);
  if (sig === 'LASF') return parseLAS(buffer);
  if (sig.startsWith('ply')) return parsePLY(buffer);
  throw new Error('PLY でも LAS でもありません');
}

// ---------------------------------------------------------------- 単位

/**
 * 座標の単位を推定して mm 係数を返す。
 *
 * 壁面のスキャンなら広がりはせいぜい 30m。値の広がりが 300 を超えていたら
 * ミリメートル、そうでなければメートルと見なす。外したときに黙って 1000 倍
 * ずれるのが最悪なので、判定の根拠も一緒に返す。
 */
export function estimateUnitScaleToMM(points) {
  const b = bounds(points);
  const extent = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  if (extent > 300) return { scale: 1, unit: 'mm', extent };
  return { scale: 1000, unit: 'm', extent };
}

export function bounds(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      const v = points[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------- 平面フィット

/**
 * 従属軸を1つ選んで d = a·u + b·v + c を最小二乗で解く。
 * 重み付き。
 */
function solveAxis(points, depIndex, weights) {
  const u = (depIndex + 1) % 3;
  const v = (depIndex + 2) % 3;

  let Suu = 0, Suv = 0, Svv = 0, Su = 0, Sv = 0, S1 = 0;
  let Sud = 0, Svd = 0, Sd = 0;

  for (let i = 0, p = 0; p < points.length; i += 1, p += 3) {
    const w = weights ? weights[i] : 1;
    if (w <= 0) continue;
    const uu = points[p + u], vv = points[p + v], dd = points[p + depIndex];
    Suu += w * uu * uu; Suv += w * uu * vv; Svv += w * vv * vv;
    Su += w * uu; Sv += w * vv; S1 += w;
    Sud += w * uu * dd; Svd += w * vv * dd; Sd += w * dd;
  }
  if (S1 < 3) return null;

  // 3x3 の正規方程式を素直に解く
  const m = [
    [Suu, Suv, Su],
    [Suv, Svv, Sv],
    [Su, Sv, S1],
  ];
  const rhs = [Sud, Svd, Sd];
  const sol = solve3(m, rhs);
  if (!sol) return null;

  const [a, b, c] = sol;
  // 平面: a·u + b·v - d + c = 0 → 法線は (u:a, v:b, dep:-1)
  const n = [0, 0, 0];
  n[u] = a; n[v] = b; n[depIndex] = -1;
  const len = Math.hypot(n[0], n[1], n[2]);
  return {
    depIndex, a, b, c,
    normal: [n[0] / len, n[1] / len, n[2] / len],
    offset: c / len, // 符号付き距離 = (normal·p + offset)
  };
}

function solve3(m, rhs) {
  const a = [
    [m[0][0], m[0][1], m[0][2], rhs[0]],
    [m[1][0], m[1][1], m[1][2], rhs[1]],
    [m[2][0], m[2][1], m[2][2], rhs[2]],
  ];
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < 3; r += 1) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    if (pivot !== col) { const t = a[pivot]; a[pivot] = a[col]; a[col] = t; }
    const d = a[col][col];
    for (let k = col; k < 4; k += 1) a[col][k] /= d;
    for (let r = 0; r < 3; r += 1) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let k = col; k < 4; k += 1) a[r][k] -= f * a[col][k];
    }
  }
  return [a[0][3], a[1][3], a[2][3]];
}

/** 符号付き距離。正 = 法線の向き側。 */
export function signedDistance(plane, x, y, z) {
  return plane.normal[0] * x + plane.normal[1] * y + plane.normal[2] * z + plane.offset;
}

/**
 * 壁面の平面をロバストに当てはめる。
 *
 * 主成分分析の最小固有ベクトルは外れ値が数％入るだけで 90° 飛ぶ（Swift 側で
 * 実際に踏んだ）。ここでは従属軸を固定した回帰を3通り試して残差の小さいものを
 * 採り、MAD で外れ値を落としながら反復する。植生や手前の草を掴んでも壊れない。
 *
 * @param {Float64Array} points 3要素ずつ
 * @param {{viewpoint?: number[], iterations?: number, cutoff?: number}} options
 *        viewpoint — 法線をこちら向きに揃える基準点（既定は原点＝スキャン開始位置）
 */
export function fitWallPlane(points, options = {}) {
  const { viewpoint = [0, 0, 0], iterations = 5, cutoff = 2.5 } = options;
  const n = points.length / 3;
  if (n < 3) throw new Error('平面を出すには3点以上必要です');

  let weights = new Float64Array(n).fill(1);
  let best = null;

  for (let iter = 0; iter < iterations; iter += 1) {
    let candidate = null;
    for (let axis = 0; axis < 3; axis += 1) {
      const p = solveAxis(points, axis, weights);
      if (!p) continue;
      const r = weightedRMS(points, p, weights);
      if (!candidate || r < candidate.rms) candidate = { ...p, rms: r };
    }
    if (!candidate) break;
    best = candidate;

    // MAD で外れ値を落とす。中心は符号付き残差の**中央値**。
    // |残差| の中央値を中心にすると、片側に 3 割の外れ値（植生・隣の面）が
    // あるとき当てはめごと引きずられて二群が重なり、誰も刈れないまま
    // inlierRatio 1.0 で偏った面を返す
    const signed = [];
    for (let i = 0, p = 0; p < points.length; i += 1, p += 3) {
      signed.push(signedDistance(candidate, points[p], points[p + 1], points[p + 2]));
    }
    const centre = median(signed);
    const abs = signed.map((d) => Math.abs(d - centre));
    const mad = median(abs) * 1.4826;
    if (!(mad > 0)) break;
    const limit = cutoff * mad;
    const next = new Float64Array(n);
    let kept = 0;
    for (let i = 0; i < n; i += 1) {
      if (abs[i] <= limit) { next[i] = 1; kept += 1; }
    }
    if (kept < Math.max(3, n * 0.2)) break;
    weights = next;
  }

  if (!best) throw new Error('平面を当てはめられませんでした');

  // 法線を viewpoint 側へ向ける。これをやらないと「はらみ出し」の符号が
  // 点群ごとに反転する。CrackCore と同じで、向きの決定は一箇所に集約する。
  const dv = signedDistance(best, viewpoint[0], viewpoint[1], viewpoint[2]);
  if (dv < 0) {
    best.normal = best.normal.map((v) => -v);
    best.offset = -best.offset;
  }

  let inliers = 0;
  for (let i = 0; i < n; i += 1) if (weights[i] > 0) inliers += 1;

  return {
    normal: best.normal,
    offset: best.offset,
    rms: best.rms,
    inlierRatio: inliers / n,
    pointCount: n,
    viewpoint,
    // 視点から面までの垂直距離。法線を視点側へ向けてあるので必ず 0 以上。
    // レーザー距離計の実測値の代わりにそのまま使える。
    viewpointDistance: signedDistance(best, viewpoint[0], viewpoint[1], viewpoint[2]),
  };
}

function weightedRMS(points, plane, weights) {
  let s = 0, w = 0;
  for (let i = 0, p = 0; p < points.length; i += 1, p += 3) {
    const wi = weights[i];
    if (wi <= 0) continue;
    const d = signedDistance(plane, points[p], points[p + 1], points[p + 2]);
    s += wi * d * d;
    w += wi;
  }
  return w > 0 ? Math.sqrt(s / w) : Infinity;
}

function median(values) {
  if (!values.length) return 0;
  const a = Float64Array.from(values).sort();
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// ---------------------------------------------------------------- 面外マップ

/**
 * 平面上に正規直交基底を作る。
 * 「上」に最も近い軸を第2基底の種にすることで、出力される図の向きが
 * 点群ごとにひっくり返らないようにしている。
 */
export function planeBasis(normal, up = [0, 0, 1]) {
  let seed = up;
  if (Math.abs(dot(normal, seed)) > 0.9) seed = [1, 0, 0];
  let e1 = cross(seed, normal);
  const l1 = Math.hypot(...e1);
  e1 = e1.map((v) => v / l1);
  const e2 = cross(normal, e1);
  return { e1, e2 };
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * 平面からの面外変位をセルに集約する。
 *
 * セルの代表値は**中央値**。植生や電線を1本掴んだだけで平均は跳ねるが、
 * 中央値なら石材の面が残る。
 *
 * @param {Float64Array} points
 * @param {object} plane fitWallPlane の戻り値
 * @param {{cellSize?: number, minPointsPerCell?: number}} options
 *        cellSize — セルの一辺（点群と同じ単位）。大谷石は 1個 300〜900mm 程度なので
 *                   既定は 1/6 相当の 0.05（メートル前提）ではなく明示指定を推奨。
 */
export function outOfPlaneMap(points, plane, options = {}) {
  const { cellSize, minPointsPerCell = 3, up = [0, 0, 1] } = options;
  if (!(cellSize > 0)) throw new Error('cellSize を指定してください');

  // 「上」はパネルの選択（Z up / Y up）に従う。既定の Z up のままだと ARKit 系
  // （Y up）の点群で図が 90° 回り、選択を切り替えても何も変わらない
  const { e1, e2 } = planeBasis(plane.normal, up);

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  const n = points.length / 3;
  const us = new Float64Array(n);
  const vs = new Float64Array(n);
  const ds = new Float64Array(n);

  for (let i = 0, p = 0; i < n; i += 1, p += 3) {
    const x = points[p], y = points[p + 1], z = points[p + 2];
    const u = x * e1[0] + y * e1[1] + z * e1[2];
    const v = x * e2[0] + y * e2[1] + z * e2[2];
    us[i] = u; vs[i] = v;
    ds[i] = signedDistance(plane, x, y, z);
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }

  const cols = Math.max(1, Math.ceil((maxU - minU) / cellSize));
  const rows = Math.max(1, Math.ceil((maxV - minV) / cellSize));
  const buckets = new Array(cols * rows);

  for (let i = 0; i < n; i += 1) {
    const cx = Math.min(cols - 1, Math.floor((us[i] - minU) / cellSize));
    const cy = Math.min(rows - 1, Math.floor((vs[i] - minV) / cellSize));
    const idx = cy * cols + cx;
    (buckets[idx] || (buckets[idx] = [])).push(ds[i]);
  }

  const values = new Float64Array(cols * rows).fill(NaN);
  const counts = new Int32Array(cols * rows);
  let maxBulge = 0, maxBulgeCell = -1;

  for (let i = 0; i < buckets.length; i += 1) {
    const b = buckets[i];
    if (!b || b.length < minPointsPerCell) continue;
    counts[i] = b.length;
    const m = median(b);
    values[i] = m;
    if (m > maxBulge) { maxBulge = m; maxBulgeCell = i; }
  }

  return {
    cols, rows, cellSize,
    originU: minU, originV: minV,
    e1, e2, normal: plane.normal, offset: plane.offset,
    values, counts,
    maxBulge,
    maxBulgeCell,
    maxBulgeAt: maxBulgeCell >= 0
      ? { col: maxBulgeCell % cols, row: Math.floor(maxBulgeCell / cols) }
      : null,
  };
}

/**
 * 面外マップから「はらみ出し」を拾う。
 *
 * 全セルの中央値を基準面とし、そこから threshold 以上手前に出ているセルを
 * 連結成分にまとめる。単発のノイズセルではなく、石材ひとつぶんの
 * まとまった膨らみだけを残すのが狙い。
 */
export function findBulges(map, { threshold, minCells = 2 } = {}) {
  if (!(threshold > 0)) throw new Error('threshold を指定してください');

  const finite = [];
  for (let i = 0; i < map.values.length; i += 1) {
    if (Number.isFinite(map.values[i])) finite.push(map.values[i]);
  }
  const base = median(finite);

  const flagged = new Uint8Array(map.values.length);
  for (let i = 0; i < map.values.length; i += 1) {
    if (Number.isFinite(map.values[i]) && map.values[i] - base >= threshold) flagged[i] = 1;
  }

  const seen = new Uint8Array(map.values.length);
  const regions = [];
  for (let i = 0; i < flagged.length; i += 1) {
    if (!flagged[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    const cells = [];
    let peak = -Infinity, peakCell = i;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const val = map.values[c] - base;
      if (val > peak) { peak = val; peakCell = c; }
      const col = c % map.cols, row = Math.floor(c / map.cols);
      const neighbours = [
        col > 0 ? c - 1 : -1,
        col < map.cols - 1 ? c + 1 : -1,
        row > 0 ? c - map.cols : -1,
        row < map.rows - 1 ? c + map.cols : -1,
      ];
      for (const nb of neighbours) {
        if (nb >= 0 && flagged[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
      }
    }
    if (cells.length < minCells) continue;
    regions.push({
      cells,
      cellCount: cells.length,
      peak,
      peakAt: { col: peakCell % map.cols, row: Math.floor(peakCell / map.cols) },
      areaSquared: cells.length * map.cellSize * map.cellSize,
    });
  }

  regions.sort((a, b) => b.peak - a.peak);
  return { base, regions };
}

/**
 * 点群を間引く。100万点をそのままブラウザで回すと固まるので、
 * 平面フィットの前に等間隔で落とす。等間隔（ランダムでない）なのは
 * 同じ点群から同じ結果が出るようにするため。
 */
export function decimate(points, maxPoints) {
  const n = points.length / 3;
  if (n <= maxPoints) return points;
  const step = n / maxPoints;
  const out = new Float64Array(maxPoints * 3);
  for (let i = 0; i < maxPoints; i += 1) {
    const src = Math.floor(i * step) * 3;
    out[i * 3] = points[src];
    out[i * 3 + 1] = points[src + 1];
    out[i * 3 + 2] = points[src + 2];
  }
  return out;
}

/**
 * 視点を「面から指定した距離だけ手前」に置き直す。
 *
 * 既定では点群の原点を視点とみなしている（＝スキャンを開始した場所から写真を
 * 撮った、という手順の前提）。ところが LiDAR の実用距離は 3m 程度しかないので、
 * 高所・遠方の壁では**近づいてスキャンし、離れて撮る**ことになる。すると前提が
 * 崩れ、しかも**黙って崩れる**。
 *
 * 合成検証（距離 5m、1m の位置からスキャン）:
 *   mm/px 1.40（真値 7.14）・距離 0.98m（真値 5.00）
 *   視差補正は偽陽性 12→11 とほぼ無効化。画面には「ずれ 0cm を補正」と出る
 *
 * 効いているのは**奥行きの誤り**だけで、横方向には強い。同じ検証で、視点が
 * 横に 1m ずれていても（視線が 11° 傾く）補正は効いた（偽陽性 0/47・推定 173mm）。
 * だから「正対で、この距離」と置くだけで実用になる。歩測で足りる。
 *
 * @param {object} plane fitWallPlane の戻り値
 * @param {number[]} lookAt 見ている場所（点群の重心を渡す）
 * @param {number} distance 面から視点までの距離（点群と同じ単位）
 */
export function placeViewpoint(plane, lookAt, distance) {
  const n = plane.normal;
  // 重心はほぼ面上にあるが厳密ではないので、いったん面へ落としてから離す。
  // そうしないと「面からの距離」が重心の残差ぶんずれる
  const s = signedDistance(plane, lookAt[0], lookAt[1], lookAt[2]);
  const eye = [
    lookAt[0] + n[0] * (distance - s),
    lookAt[1] + n[1] * (distance - s),
    lookAt[2] + n[2] * (distance - s),
  ];
  return { ...plane, viewpoint: eye, viewpointDistance: distance, viewpointSource: 'manual' };
}

/**
 * 面外マップを世界座標で読む。
 *
 * 写真の画素から飛ばした光線が平面に当たった点で「そこは面からどれだけ
 * 手前か」を知りたい、という用途（視差補正）のための逆引き。
 * セル中心での双一次補間。欠測セルは重みから外し、四隅とも欠測なら null。
 *
 * @returns {number|null} 面外の高さ（点群と同じ単位・手前が正）
 */
export function sampleOutOfPlane(map, x, y, z) {
  const { e1, e2, cols, rows, cellSize, originU, originV, values } = map;
  const u = (x * e1[0] + y * e1[1] + z * e1[2] - originU) / cellSize - 0.5;
  const v = (x * e2[0] + y * e2[1] + z * e2[2] - originV) / cellSize - 0.5;
  const c0 = Math.floor(u), r0 = Math.floor(v);
  const tu = u - c0, tv = v - r0;

  let sum = 0, wsum = 0;
  for (let dr = 0; dr <= 1; dr += 1) {
    for (let dc = 0; dc <= 1; dc += 1) {
      const c = c0 + dc, r = r0 + dr;
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const val = values[r * cols + c];
      if (!Number.isFinite(val)) continue;
      const w = (dc ? tu : 1 - tu) * (dr ? tv : 1 - tv);
      if (!(w > 0)) continue;
      sum += w * val;
      wsum += w;
    }
  }
  // 四隅のうち一部しか無いときは残った重みで正規化する。端のセルで
  // 黙って 0 を返すと「出っ張っていない」と誤って補正が緩む
  return wsum > 0.2 ? sum / wsum : null;
}
