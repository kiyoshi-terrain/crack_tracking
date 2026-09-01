// 点群の3D位置合わせ（ICP）と C2C 差分の検証。
// 座標系がずれた2スキャンを重ね、傾いたブロック（面外＋面内の動き）を当てる。

import {
  buildVoxelGrid, nearestNeighbor, alignICP, applyRigid, c2cDistances, c2cHeatmap, identityRigid,
} from '../src/cloudalign.js';

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
 * 目地のある組積造の壁（x=5、視点は原点、上は +Z）。
 * tiltBlock: 石1個ぶんの矩形が下端を蝶番に手前へ傾く（上端で height だけ出る）。
 * 面外の出っ張りと、傾きに伴う面内の微小ずれが同時に起きる、縁切れ相当の動き。
 */
function makeWall({ count = 90000, seed = 7, noise = 0.003, tiltBlock = null, wallX = 5 } = {}) {
  const rnd = mulberry32(seed);
  const pts = [];
  const courseH = 0.30, stoneW = 0.45, jointW = 0.02, jointDepth = 0.006;
  for (let i = 0; i < count; i += 1) {
    let y = -2 + rnd() * 4;
    let z = 0.2 + rnd() * 3.6;
    let x = wallX + (rnd() - 0.5) * 2 * noise;
    const course = Math.floor(z / courseH);
    const yShift = course % 2 ? stoneW / 2 : 0;
    const dH = Math.abs(((z % courseH) + courseH) % courseH - courseH / 2);
    const dV = Math.abs((((y + yShift) % stoneW) + stoneW) % stoneW - stoneW / 2);
    if (dH > courseH / 2 - jointW || dV > stoneW / 2 - jointW) x += jointDepth;
    if (tiltBlock && y >= tiltBlock.y0 && y <= tiltBlock.y1 && z >= tiltBlock.z0 && z <= tiltBlock.z1) {
      const f = (z - tiltBlock.z0) / (tiltBlock.z1 - tiltBlock.z0);
      x -= tiltBlock.height * f;          // 手前へ（視点側 = -x）
      z -= tiltBlock.height * f * 0.15;   // 傾きに伴う面内のわずかな下がり
    }
    pts.push(x, y, z);
  }
  return Float64Array.from(pts);
}

/** 別日のスキャン相当: ヘディング（Z軸）回転＋並進。 */
function transformCloud(points, { headingDeg = 0, t = [0, 0, 0] } = {}) {
  const h = (headingDeg * Math.PI) / 180;
  const out = new Float64Array(points.length);
  for (let p = 0; p < points.length; p += 3) {
    const x = points[p], y = points[p + 1];
    out[p] = x * Math.cos(h) - y * Math.sin(h) + t[0];
    out[p + 1] = x * Math.sin(h) + y * Math.cos(h) + t[1];
    out[p + 2] = points[p + 2] + t[2];
  }
  return out;
}

const median = (arr) => {
  const a = Float64Array.from(arr.filter(Number.isFinite)).sort();
  return a.length ? a[a.length >> 1] : NaN;
};

export function runCloudAlignTests(check, near) {
  console.log('\n== 点群3D: ボクセル最近傍 ==');
  {
    const pts = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0.1, 0.1, 0]);
    const vg = buildVoxelGrid(pts, 0.5);
    const nn = nearestNeighbor(vg, 0.12, 0.09, 0, 1);
    check('最近傍を当てる', nn && nn.index === 9, `index=${nn?.index}`);
    check('距離の2乗', nn && near(nn.dist2, 0.02 ** 2 + 0.01 ** 2, 1e-12));
    check('遠すぎれば null', nearestNeighbor(vg, 5, 5, 5, 0.5) === null);
  }

  console.log('\n== 点群3D: ICP が座標系のずれを解く ==');
  {
    const cloudA = makeWall({ seed: 7 });
    const truth = { headingDeg: 10, t: [0.25, -0.15, 0.10] };
    const cloudB = transformCloud(makeWall({ seed: 8 }), truth);

    const icp = alignICP(cloudA, cloudB, { cell: 0.03 });
    check('収束する', icp.iterations < 30, `${icp.iterations} 回`);

    // 位置合わせ後の B が A の面に乗っているか（残差 RMS がノイズ＋点間隔の桁）
    const c2c = c2cDistances(cloudA, cloudB, icp.transform, { cell: 0.03, normal: icp.planeA.normal });
    const medAlong = median(Array.from(c2c.along).map(Math.abs));
    const medMag = median(Array.from(c2c.magnitude));
    check('法線成分の残差はノイズの桁（3mm 未満）', medAlong < 0.003, `${(medAlong * 1000).toFixed(2)} mm`);
    check('3D 距離には点の間隔（サンプリング床）が乗る — これが C2C を主値にしない理由',
      medMag > medAlong * 2, `3D ${(medMag * 1000).toFixed(1)} mm vs 法線 ${(medAlong * 1000).toFixed(2)} mm`);

    // 真の変換の逆を当てられているか: B の点を戻して元の壁座標と比べる
    const h = (-truth.headingDeg * Math.PI) / 180;
    let errNormal = 0, errAll = 0;
    for (let k = 0; k < 200; k += 1) {
      const p = k * 3 * 400;
      const q = applyRigid(icp.transform, cloudB[p], cloudB[p + 1], cloudB[p + 2]);
      // 真の逆変換
      const x = cloudB[p] - truth.t[0], y = cloudB[p + 1] - truth.t[1], z = cloudB[p + 2] - truth.t[2];
      const tx = x * Math.cos(h) - y * Math.sin(h), ty = x * Math.sin(h) + y * Math.cos(h);
      errNormal = Math.max(errNormal, Math.abs(q[0] - tx));   // 壁法線 ≈ x
      errAll = Math.max(errAll, Math.hypot(q[0] - tx, q[1] - ty, q[2] - z));
    }
    check('面外（法線方向）は 2mm 以内で復元', errNormal < 0.002, `最大 ${(errNormal * 1000).toFixed(2)} mm`);
    // 平らな壁の面内は目地の凹み（6mm）しか拘束が無いので、cm 未満に収まれば十分
    check('面内は目地の拘束だけなので 15mm 以内', errAll < 0.015, `最大 ${(errAll * 1000).toFixed(1)} mm`);
  }

  console.log('\n== 点群3D: 傾いたブロックを C2C で当てる（安定域で位置合わせ） ==');
  {
    const block = { y0: 0.45, y1: 0.90, z0: 1.8, z1: 2.1 };
    const cloudA = makeWall({ seed: 11 });
    const bRaw = makeWall({ seed: 12, tiltBlock: { ...block, height: 0.020 } });
    const cloudB = transformCloud(bRaw, { headingDeg: -6, t: [-0.2, 0.3, -0.1] });

    // 安定域 = ブロックの外（元の壁座標で判定できるのは合成だから。実運用は UI で枠指定）
    const margin = 0.05;
    const inBlock = (i) => {
      const y = bRaw[i * 3 + 1], z = bRaw[i * 3 + 2];
      return y >= block.y0 - margin && y <= block.y1 + margin && z >= block.z0 - margin && z <= block.z1 + margin;
    };
    // 集計はマージン無しの正確なブロック範囲で（マージンを混ぜると変位ゼロの縁が入って中央値が下がる）
    const inBlockExact = (i) => {
      const y = bRaw[i * 3 + 1], z = bRaw[i * 3 + 2];
      return y >= block.y0 && y <= block.y1 && z >= block.z0 && z <= block.z1;
    };
    const icp = alignICP(cloudA, cloudB, { cell: 0.03, stableMask: (i) => !inBlock(i) });
    const c2c = c2cDistances(cloudA, cloudB, icp.transform, { cell: 0.03, normal: icp.planeA.normal });

    const inside = [], outside = [];
    for (let i = 0; i < c2c.along.length; i += 1) {
      if (!Number.isFinite(c2c.along[i])) continue;
      if (inBlockExact(i)) inside.push(c2c.along[i]);
      else if (!inBlock(i)) outside.push(c2c.along[i]);
    }
    const medIn = median(inside);
    const medOut = median(outside.map(Math.abs));
    check('ブロック外はノイズの桁（3mm 未満）', medOut < 0.003, `${(medOut * 1000).toFixed(2)} mm`);
    check('ブロック内は手前（＋）へ出る', medIn > 0.007, `${(medIn * 1000).toFixed(1)} mm`);
    // 上端ほど大きい（傾き）: 上 1/3 の中央値 > 下 1/3 の中央値
    const top = [], bottom = [];
    for (let i = 0; i < c2c.along.length; i += 1) {
      if (!Number.isFinite(c2c.along[i]) || !inBlockExact(i)) continue;
      const z = bRaw[i * 3 + 2];
      if (z > block.z1 - 0.1) top.push(c2c.along[i]);
      if (z < block.z0 + 0.1) bottom.push(c2c.along[i]);
    }
    check('上端ほど出ている（傾きの形を保つ）', median(top) > median(bottom) + 0.008,
      `上 ${(median(top) * 1000).toFixed(1)} / 下 ${(median(bottom) * 1000).toFixed(1)} mm`);
    check('上端の出っ張りが仕込み 20mm に近い（上 10cm の中央値 ≈ 17mm）', near(median(top), 0.017, 0.004),
      `${(median(top) * 1000).toFixed(1)} mm`);

    // ヒートマップに集約しても位置が合う
    const hm = c2cHeatmap(cloudB, c2c, icp.planeA, icp.transform, { cellSize: 0.05 });
    let peakK = -1, peakV = -Infinity;
    for (let k = 0; k < hm.values.length; k += 1) {
      if (Number.isFinite(hm.values[k]) && hm.values[k] > peakV) { peakV = hm.values[k]; peakK = k; }
    }
    const col = peakK % hm.grid.cols, row = Math.floor(peakK / hm.grid.cols);
    const u = hm.grid.originU + (col + 0.5) * hm.grid.cellSize;
    const v = hm.grid.originV + (row + 0.5) * hm.grid.cellSize;
    const world = [0, 1, 2].map((kk) => u * hm.e1[kk] + v * hm.e2[kk]);
    const okY = world[1] >= block.y0 - 0.1 && world[1] <= block.y1 + 0.1;
    const okZ = world[2] >= block.z0 - 0.1 && world[2] <= block.z1 + 0.15;
    check('ヒートマップのピークがブロックの位置', okY && okZ,
      `(y=${world[1].toFixed(2)}, z=${world[2].toFixed(2)})`);
  }

  console.log('\n== 点群3D: 安定域を指定しなくてもトリムで持ちこたえる ==');
  {
    const block = { y0: 0.45, y1: 0.90, z0: 1.8, z1: 2.1 };
    const cloudA = makeWall({ seed: 21 });
    const cloudB = transformCloud(makeWall({ seed: 22, tiltBlock: { ...block, height: 0.020 } }),
      { headingDeg: 4, t: [0.1, 0.1, 0] });
    const icp = alignICP(cloudA, cloudB, { cell: 0.03 });
    const c2c = c2cDistances(cloudA, cloudB, icp.transform, { cell: 0.03, normal: icp.planeA.normal });
    const all = Array.from(c2c.along).filter(Number.isFinite).map(Math.abs);
    check('全体の法線残差はノイズの桁（ブロック 3% に引きずられない）', median(all) < 0.003,
      `${(median(all) * 1000).toFixed(2)} mm`);
  }

  console.log('\n== 点群3D: 単位変換 ==');
  {
    const T = identityRigid();
    const p = applyRigid(T, 1, 2, 3);
    check('単位変換は恒等', p[0] === 1 && p[1] === 2 && p[2] === 3);
  }
}
