// 点群まわりの検証。合成点群に既知の平面・既知のはらみ出しを与えて誤差を数値で出す。

import {
  parsePLY, parseLAS, parsePointCloud,
  fitWallPlane, signedDistance, outOfPlaneMap, findBulges,
  decimate, estimateUnitScaleToMM, planeBasis, bounds,
} from '../src/pointcloud.js';

// ---------------------------------------------------------------- 合成データ

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * x = 5 の位置に立つ壁面（Y-Z 平面に平行）。
 * 視点は原点なので、正しく向けた法線は (-1, 0, 0) になるはず。
 */
function makeWall({
  count = 20000, seed = 7, noise = 0.005,
  bulge = null, outlierRatio = 0, wallX = 5,
} = {}) {
  const rnd = mulberry32(seed);
  const pts = new Float64Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const y = -2 + rnd() * 4;
    const z = rnd() * 4;
    let x = wallX + (rnd() - 0.5) * 2 * noise;
    if (bulge) {
      const d2 = (y - bulge.y) ** 2 + (z - bulge.z) ** 2;
      // 手前（-x 方向）に膨らませる = 法線方向に出る
      x -= bulge.height * Math.exp(-d2 / (2 * bulge.sigma ** 2));
    }
    if (outlierRatio > 0 && rnd() < outlierRatio) {
      // 手前の植生。壁から 0.5〜1.5m 手前にばらける
      x = wallX - (0.5 + rnd());
    }
    pts[i * 3] = x; pts[i * 3 + 1] = y; pts[i * 3 + 2] = z;
  }
  return pts;
}

// ---------------------------------------------------------------- PLY を組み立てる

function buildAsciiPLY(points) {
  const n = points.length / 3;
  let s = `ply\nformat ascii 1.0\nelement vertex ${n}\n`
    + 'property float x\nproperty float y\nproperty float z\nend_header\n';
  for (let i = 0; i < n; i += 1) {
    s += `${points[i * 3]} ${points[i * 3 + 1]} ${points[i * 3 + 2]}\n`;
  }
  return new TextEncoder().encode(s).buffer;
}

/** x,y,z のあとに法線と色が並ぶ、Scaniverse 相当のレイアウト。 */
function buildBinaryPLY(points) {
  const n = points.length / 3;
  const header = 'ply\nformat binary_little_endian 1.0\n'
    + `element vertex ${n}\n`
    + 'property float x\nproperty float y\nproperty float z\n'
    + 'property float nx\nproperty float ny\nproperty float nz\n'
    + 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
    + 'end_header\n';
  const headerBytes = new TextEncoder().encode(header);
  const stride = 4 * 6 + 3;
  const buf = new ArrayBuffer(headerBytes.length + stride * n);
  new Uint8Array(buf).set(headerBytes, 0);
  const view = new DataView(buf);
  for (let i = 0; i < n; i += 1) {
    const base = headerBytes.length + i * stride;
    view.setFloat32(base, points[i * 3], true);
    view.setFloat32(base + 4, points[i * 3 + 1], true);
    view.setFloat32(base + 8, points[i * 3 + 2], true);
    view.setFloat32(base + 12, -1, true);
    view.setFloat32(base + 16, 0, true);
    view.setFloat32(base + 20, 0, true);
    view.setUint8(base + 24, 128);
    view.setUint8(base + 25, 120);
    view.setUint8(base + 26, 110);
  }
  return buf;
}

/** LAS 1.2 / point data record format 0。 */
function buildLAS(points, { compressed = false } = {}) {
  const n = points.length / 3;
  const headerSize = 227;
  const pointLength = 20;
  const buf = new ArrayBuffer(headerSize + pointLength * n);
  const view = new DataView(buf);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, 'LASF'.charCodeAt(i));
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  view.setUint8(104, compressed ? 0x80 : 0);
  view.setUint16(105, pointLength, true);
  view.setUint32(107, n, true);
  const scale = 0.001;
  view.setFloat64(131, scale, true);
  view.setFloat64(139, scale, true);
  view.setFloat64(147, scale, true);
  view.setFloat64(155, 0, true);
  view.setFloat64(163, 0, true);
  view.setFloat64(171, 0, true);
  for (let i = 0; i < n; i += 1) {
    const base = headerSize + i * pointLength;
    view.setInt32(base, Math.round(points[i * 3] / scale), true);
    view.setInt32(base + 4, Math.round(points[i * 3 + 1] / scale), true);
    view.setInt32(base + 8, Math.round(points[i * 3 + 2] / scale), true);
  }
  return buf;
}

// ---------------------------------------------------------------- 検証

export function runPointCloudTests(check, near) {
  console.log('\n== 点群の読み込み ==');
  {
    const truth = makeWall({ count: 300, seed: 11 });

    const ascii = parsePLY(buildAsciiPLY(truth));
    check('PLY (ascii) の点数', ascii.count === 300, `${ascii.count}`);
    let maxErr = 0;
    for (let i = 0; i < truth.length; i += 1) {
      maxErr = Math.max(maxErr, Math.abs(ascii.points[i] - truth[i]));
    }
    check('PLY (ascii) の座標', maxErr < 1e-6, `最大誤差 ${maxErr.toExponential(2)}`);

    // 余分なプロパティ（法線・色）を跨いで x,y,z を拾えるか
    const bin = parsePointCloud(buildBinaryPLY(truth));
    check('PLY (binary) の点数', bin.count === 300, `${bin.count}`);
    let binErr = 0;
    for (let i = 0; i < truth.length; i += 1) {
      binErr = Math.max(binErr, Math.abs(bin.points[i] - truth[i]));
    }
    // float32 で書いたので 1e-6 相対まで
    check('PLY (binary) の座標', binErr < 1e-5, `最大誤差 ${binErr.toExponential(2)}`);

    const las = parsePointCloud(buildLAS(truth));
    check('LAS 1.2 の点数', las.count === 300, `${las.count}`);
    let lasErr = 0;
    for (let i = 0; i < truth.length; i += 1) {
      lasErr = Math.max(lasErr, Math.abs(las.points[i] - truth[i]));
    }
    // scale 0.001 の量子化ぶん
    check('LAS 1.2 の座標', lasErr <= 0.0005 + 1e-9, `最大誤差 ${lasErr.toExponential(2)}`);

    let rejected = false;
    try { parseLAS(buildLAS(truth, { compressed: true })); } catch (e) {
      rejected = /LAZ/.test(e.message);
    }
    check('LAZ は明示的に弾く', rejected);

    let badFormat = false;
    try { parsePointCloud(new TextEncoder().encode('not a cloud').buffer); } catch { badFormat = true; }
    check('中身で判定して弾く', badFormat);
  }

  console.log('\n== 平面フィット ==');
  {
    const pts = makeWall({ count: 20000, noise: 0.004, seed: 3 });
    const plane = fitWallPlane(pts);
    const dotX = Math.abs(plane.normal[0]);
    check(
      '鉛直壁の法線を復元',
      dotX > 0.9999,
      `n=(${plane.normal.map((v) => v.toFixed(5)).join(', ')})`
    );
    check(
      '法線が視点（原点）側を向く',
      plane.normal[0] < 0,
      `nx=${plane.normal[0].toFixed(5)}`
    );
    // ±0.004 の一様乱数 → 標準偏差 0.004/√3 = 0.00231
    check('残差 RMS が真のノイズと一致', near(plane.rms, 0.00231, 0.0004), `${plane.rms.toFixed(5)} m`);
    check('視点から壁面までの距離', near(plane.viewpointDistance, 5, 0.001), `${plane.viewpointDistance.toFixed(4)} m`);
  }

  console.log('\n== 平面フィットのロバスト性 ==');
  {
    // 手前の植生が 12%。主成分分析だとここで法線が 90° 飛ぶ（Swift 側で実際に踏んだ）
    const pts = makeWall({ count: 20000, noise: 0.004, seed: 5, outlierRatio: 0.12 });
    const plane = fitWallPlane(pts);
    check(
      '外れ値 12% でも法線が飛ばない',
      Math.abs(plane.normal[0]) > 0.999,
      `n=(${plane.normal.map((v) => v.toFixed(4)).join(', ')})`
    );
    check('外れ値を除いた距離', near(plane.viewpointDistance, 5, 0.005), `${plane.viewpointDistance.toFixed(4)} m`);
    check(
      '外れ値ぶんが除外されている',
      plane.inlierRatio > 0.85 && plane.inlierRatio < 0.92,
      `インライア ${(plane.inlierRatio * 100).toFixed(1)}%`
    );
  }

  console.log('\n== 傾いた壁面 ==');
  {
    // 視線に対して 30° 振った壁。法線の向きの決め方が効く
    const angle = (30 * Math.PI) / 180;
    const src = makeWall({ count: 20000, noise: 0.003, seed: 9 });
    const rotated = new Float64Array(src.length);
    for (let p = 0; p < src.length; p += 3) {
      const x = src[p], y = src[p + 1];
      rotated[p] = x * Math.cos(angle) - y * Math.sin(angle);
      rotated[p + 1] = x * Math.sin(angle) + y * Math.cos(angle);
      rotated[p + 2] = src[p + 2];
    }
    const plane = fitWallPlane(rotated);
    const expected = [-Math.cos(angle), -Math.sin(angle), 0];
    const agreement = plane.normal[0] * expected[0] + plane.normal[1] * expected[1];
    check('30° 振った壁の法線', agreement > 0.9999, `一致度 ${agreement.toFixed(6)}`);
  }

  console.log('\n== 面外のはらみ出し ==');
  {
    // 20mm の膨らみ（σ=0.15m）を 1点だけ仕込む
    const pts = makeWall({
      count: 60000, noise: 0.003, seed: 13,
      bulge: { y: 1.0, z: 2.0, sigma: 0.15, height: 0.020 },
    });
    const plane = fitWallPlane(pts);
    const map = outOfPlaneMap(pts, plane, { cellSize: 0.05 });

    check('マップの格子', map.cols > 60 && map.rows > 60, `${map.cols} x ${map.rows}`);
    check(
      'はらみ出し量 20mm を復元',
      near(map.maxBulge, 0.020, 0.003),
      `${(map.maxBulge * 1000).toFixed(1)} mm`
    );

    const { base, regions } = findBulges(map, { threshold: 0.008, minCells: 3 });
    check('基準面がほぼ 0', Math.abs(base) < 0.002, `${(base * 1000).toFixed(2)} mm`);
    check('はらみ出しは1箇所だけ検出', regions.length === 1, `${regions.length} 箇所`);

    if (regions.length) {
      const r = regions[0];
      // セル座標を 3D に戻して、仕込んだ位置と一致するか見る
      const u = map.originU + (r.peakAt.col + 0.5) * map.cellSize;
      const v = map.originV + (r.peakAt.row + 0.5) * map.cellSize;
      const world = [0, 1, 2].map((k) => u * map.e1[k] + v * map.e2[k] - map.offset * map.normal[k]);
      const dy = world[1] - 1.0;
      const dz = world[2] - 2.0;
      check(
        'はらみ出しの位置',
        Math.hypot(dy, dz) < 0.08,
        `(y=${world[1].toFixed(3)}, z=${world[2].toFixed(3)}) 誤差 ${(Math.hypot(dy, dz) * 1000).toFixed(0)} mm`
      );
      check(
        'はらみ出しの面積',
        r.areaSquared > 0.02 && r.areaSquared < 0.5,
        `${r.areaSquared.toFixed(3)} m²`
      );
    }
  }

  console.log('\n== 平坦な壁では検出しない ==');
  {
    // ノイズだけの壁。しきい値を下回るので何も出てはいけない（偽陽性の確認）
    const pts = makeWall({ count: 60000, noise: 0.003, seed: 21 });
    const plane = fitWallPlane(pts);
    const map = outOfPlaneMap(pts, plane, { cellSize: 0.05 });
    const { regions } = findBulges(map, { threshold: 0.008, minCells: 3 });
    check('偽陽性なし', regions.length === 0, `${regions.length} 箇所`);
  }

  console.log('\n== 単位と間引き ==');
  {
    const meters = makeWall({ count: 500, seed: 31 });
    const est = estimateUnitScaleToMM(meters);
    check('メートルと判定', est.scale === 1000 && est.unit === 'm', `広がり ${est.extent.toFixed(2)}`);

    const mm = Float64Array.from(meters, (v) => v * 1000);
    const estMM = estimateUnitScaleToMM(mm);
    check('ミリメートルと判定', estMM.scale === 1 && estMM.unit === 'mm', `広がり ${estMM.extent.toFixed(0)}`);

    const big = makeWall({ count: 5000, seed: 41 });
    const small = decimate(big, 1000);
    check('間引き後の点数', small.length / 3 === 1000, `${small.length / 3}`);
    const again = decimate(big, 1000);
    let same = true;
    for (let i = 0; i < small.length; i += 1) if (small[i] !== again[i]) same = false;
    check('間引きは何度やっても同じ結果', same);
    check('間引いても平面は変わらない', (() => {
      const a = fitWallPlane(big);
      const b = fitWallPlane(small);
      return Math.abs(a.viewpointDistance - b.viewpointDistance) < 0.002;
    })());
  }

  console.log('\n== 平面上の基底 ==');
  {
    const n = [-1, 0, 0];
    const { e1, e2 } = planeBasis(n);
    const orth = Math.abs(e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]);
    check('基底が直交', orth < 1e-12, `内積 ${orth.toExponential(2)}`);
    check('基底が単位長', near(Math.hypot(...e1), 1, 1e-12) && near(Math.hypot(...e2), 1, 1e-12));
    const cn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const agree = cn[0] * n[0] + cn[1] * n[1] + cn[2] * n[2];
    check('基底が法線と右手系をなす', agree > 0.9999, `${agree.toFixed(6)}`);
  }

  console.log('\n== 符号付き距離 ==');
  {
    const pts = makeWall({ count: 2000, noise: 0, seed: 51 });
    const plane = fitWallPlane(pts);
    // 壁より手前（視点寄り）の点は正
    const front = signedDistance(plane, 4.9, 0, 2);
    const back = signedDistance(plane, 5.1, 0, 2);
    check('手前が正', front > 0.09 && front < 0.11, `${front.toFixed(4)}`);
    check('奥が負', back < -0.09 && back > -0.11, `${back.toFixed(4)}`);
  }

  console.log('\n== 境界 ==');
  {
    const pts = makeWall({ count: 100, seed: 61 });
    const b = bounds(pts);
    check('X の幅がノイズぶん', b.max[0] - b.min[0] < 0.02, `${(b.max[0] - b.min[0]).toFixed(4)}`);
    check('Z の範囲', b.min[2] >= 0 && b.max[2] <= 4);

    let tooFew = false;
    try { fitWallPlane(new Float64Array([0, 0, 0, 1, 1, 1])); } catch { tooFew = true; }
    check('点が足りなければエラー', tooFew);
  }
}
