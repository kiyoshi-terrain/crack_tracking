// 点群2時期差分の検証。
// 時期Bは別の座標系（ヘディング回転＋並進）・別サンプリングで合成し、
// 「塗られたものは全部有意」「仕込んだ浮きの進行は塗られる」の両方向を確かめる。

import { compareEpochClouds, groupChangedCells } from '../src/cloudchange.js';

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
 * 目地の凹みが位置合わせの「模様」になる。段ごとに半個ずらした馬目地。
 */
function makeMasonryWall({
  count = 60000, seed = 7, noise = 0.003,
  bulge = null, jointDepth = 0.006, wallX = 5,
  missing = null, outlierRatio = 0,
} = {}) {
  const rnd = mulberry32(seed);
  const pts = [];
  const courseH = 0.30;   // 石1段の高さ
  const stoneW = 0.45;    // 石1個の幅
  const jointW = 0.02;    // 目地の半幅
  for (let i = 0; i < count; i += 1) {
    const y = -2 + rnd() * 4;
    const z = 0.2 + rnd() * 3.6;
    if (missing && (y - missing.y) ** 2 + (z - missing.z) ** 2 < missing.r ** 2) continue;
    let x = wallX + (rnd() - 0.5) * 2 * noise;
    const course = Math.floor(z / courseH);
    const yShift = course % 2 ? stoneW / 2 : 0;
    const distH = Math.abs(((z % courseH) + courseH) % courseH - courseH / 2);
    const distV = Math.abs((((y + yShift) % stoneW) + stoneW) % stoneW - stoneW / 2);
    // 目地は奥（+x）へ凹む
    if (distH > courseH / 2 - jointW || distV > stoneW / 2 - jointW) x += jointDepth;
    if (bulge) {
      const d2 = (y - bulge.y) ** 2 + (z - bulge.z) ** 2;
      // 手前（-x）へ膨らむ = 視点側に出る
      x -= bulge.height * Math.exp(-d2 / (2 * bulge.sigma ** 2));
    }
    if (outlierRatio > 0 && rnd() < outlierRatio) x = wallX - (0.5 + rnd());
    pts.push(x, y, z);
  }
  return Float64Array.from(pts);
}

/** 別日のスキャン相当: ヘディング（Z軸）回転＋並進で世界座標ごと写す。 */
function transformCloud(points, { headingDeg = 0, rollDeg = 0, t = [0, 0, 0] } = {}) {
  const h = (headingDeg * Math.PI) / 180;
  const r = (rollDeg * Math.PI) / 180;
  const out = new Float64Array(points.length);
  for (let p = 0; p < points.length; p += 3) {
    let x = points[p];
    let y = points[p + 1];
    let z = points[p + 2];
    if (rollDeg) {
      // 壁の法線（≈X軸）まわり ≈ 重力推定の誤差。面内でマップが回る
      const y2 = y * Math.cos(r) - z * Math.sin(r);
      const z2 = y * Math.sin(r) + z * Math.cos(r);
      y = y2; z = z2;
    }
    const x2 = x * Math.cos(h) - y * Math.sin(h);
    const y2 = x * Math.sin(h) + y * Math.cos(h);
    out[p] = x2 + t[0];
    out[p + 1] = y2 + t[1];
    out[p + 2] = z + t[2];
  }
  return out;
}

const OPTS = { cellSize: 0.05, up: [0, 0, 1], k: 3 };

export function runCloudChangeTests(check, near) {
  console.log('\n== 点群2時期差分: 動いていなければ塗らない ==');
  {
    const cloudA = makeMasonryWall({ seed: 7 });
    const cloudB = transformCloud(makeMasonryWall({ seed: 8 }),
      { headingDeg: 12, t: [0.25, -0.18, 0.12] });
    const r = compareEpochClouds(cloudA, cloudB, OPTS);
    check('解析が成立', r.ok === true, `評価 ${r.stats.evaluated} セル`);
    check('目地を模様に位置合わせできる', r.registration.mode === 'zncc',
      `zncc=${r.registration.zncc.toFixed(3)}`);
    check('回転は不要と判定', Math.abs(r.registration.thetaDeg) < 0.6,
      `θ=${r.registration.thetaDeg}°`);
    // 5700セル×3σ では単発の当たりくじが数件出るのは正常。
    // 主張になるのは「まとまり」だけで、単発は参考扱い（輪郭のみ）
    check('偽のまとまりが出ない', groupChangedCells(r, { minCells: 3 }).filter((g) => g.grouped).length === 0,
      `単発 ${r.stats.significant} セル`);
    check('単発の当たりくじも数件まで', r.stats.significant <= 5,
      `${r.stats.significant} / ${r.stats.evaluated} セル`);
    check('実測ばらつきが mm 級', r.sigmaEmp > 0 && r.sigmaEmp < 0.004,
      `σ=${(r.sigmaEmp * 1000).toFixed(2)} mm`);
  }

  console.log('\n== 点群2時期差分: 浮きの進行だけを当てる ==');
  {
    // 既存の浮き 8mm は両時期にあり、B で 20mm へ進行（差 +12mm）
    const bulgeAt = { y: 0.8, z: 2.1, sigma: 0.2 };
    const cloudA = makeMasonryWall({ seed: 11, bulge: { ...bulgeAt, height: 0.008 } });
    const cloudB = transformCloud(
      makeMasonryWall({ seed: 12, bulge: { ...bulgeAt, height: 0.020 } }),
      { headingDeg: -8, t: [-0.2, 0.3, -0.1] });
    const r = compareEpochClouds(cloudA, cloudB, OPTS);
    check('解析が成立', r.ok === true);

    const groups = groupChangedCells(r, { minCells: 3 }).filter((g) => g.grouped);
    check('進行した領域が1つだけ検出される', groups.length === 1, `${groups.length} 領域`);
    if (groups.length) {
      const g = groups[0];
      check('進行量 +12mm を復元（既存の8mmは差し引かれる）',
        near(g.magnitude, 0.012, 0.0025),
        `代表 ${(g.magnitude * 1000).toFixed(1)} mm（最大セル ${(g.peak * 1000).toFixed(1)} mm）`);
      check('向きは視点側（浮き）', g.peak > 0);
      const u = r.grid.originU + (g.peakAt.col + 0.5) * r.grid.cellSize;
      const v = r.grid.originV + (g.peakAt.row + 0.5) * r.grid.cellSize;
      const world = [0, 1, 2].map((kk) => u * r.e1[kk] + v * r.e2[kk]);
      const err = Math.hypot(world[1] - bulgeAt.y, world[2] - bulgeAt.z);
      check('位置が仕込みと一致', err < 0.12, `誤差 ${(err * 1000).toFixed(0)} mm`);
    }
  }

  console.log('\n== 点群2時期差分: 面内の回転ずれ（重力誤差）に耐える ==');
  {
    const cloudA = makeMasonryWall({ seed: 21 });
    const cloudB = transformCloud(makeMasonryWall({ seed: 22 }),
      { headingDeg: 5, rollDeg: 1, t: [0.1, 0.1, 0] });
    const r = compareEpochClouds(cloudA, cloudB, OPTS);
    check('回転を検出して合わせる', Math.abs(Math.abs(r.registration.thetaDeg) - 1) < 0.6,
      `θ=${r.registration.thetaDeg}°`);
    check('回転ずれでも偽陽性ゼロ', r.stats.significant === 0,
      `${r.stats.significant} セル`);
  }

  console.log('\n== 点群2時期差分: 模様が無ければ重心合わせに落ちる ==');
  {
    // 目地なし・浮きなしの平坦な壁。相関の根拠が無いことを自覚して返す
    const cloudA = makeMasonryWall({ seed: 31, jointDepth: 0 });
    const cloudB = transformCloud(makeMasonryWall({ seed: 32, jointDepth: 0 }),
      { headingDeg: 3, t: [0.1, -0.1, 0.05] });
    const r = compareEpochClouds(cloudA, cloudB, OPTS);
    check('重心合わせモードになる', r.registration.mode === 'centroid',
      `zncc=${r.registration.zncc.toFixed(3)}`);
    check('平坦なら位置ずれは差分に効かない（偽陽性ゼロ）', r.stats.significant === 0,
      `${r.stats.significant} セル`);
  }

  console.log('\n== 点群2時期差分: 欠測は欠測として返す ==');
  {
    const cloudA = makeMasonryWall({ seed: 41 });
    const cloudB = transformCloud(
      makeMasonryWall({ seed: 42, missing: { y: -0.5, z: 1.5, r: 0.3 } }),
      { headingDeg: 6, t: [0.15, 0.1, 0] });
    const r = compareEpochClouds(cloudA, cloudB, OPTS);
    check('B に無い領域は欠測になる', r.stats.missing > 50, `${r.stats.missing} セル`);
    check('欠測を変化として誤報しない', r.stats.significant === 0,
      `${r.stats.significant} セル`);
  }

  console.log('\n== 点群2時期差分: 片側だけの植生でも補正が引きずられない ==');
  {
    // B にだけ手前の植生 8%。平面フィットが偏っても、差分の平面補正で吸収される
    const cloudA = makeMasonryWall({ seed: 51 });
    const cloudB = transformCloud(makeMasonryWall({ seed: 52, outlierRatio: 0.08 }),
      { headingDeg: 4, t: [0.1, 0, 0.1] });
    const r = compareEpochClouds(cloudA, cloudB, OPTS);
    check('植生入りでも偽陽性ゼロ', r.stats.significant === 0,
      `${r.stats.significant} セル / σ=${(r.sigmaEmp * 1000).toFixed(2)} mm`);
  }

  console.log('\n== 点群2時期差分: 単発セルはまとまり扱いしない ==');
  {
    const cloudA = makeMasonryWall({ seed: 61 });
    const cloudB = transformCloud(
      makeMasonryWall({ seed: 62, bulge: { y: 1.2, z: 1.0, sigma: 0.15, height: 0.015 } }),
      { headingDeg: 2, t: [0, 0.1, 0] });
    const r = compareEpochClouds(cloudA, cloudB, OPTS);
    const regions = groupChangedCells(r, { minCells: 3 });
    const grouped = regions.filter((g) => g.grouped);
    const isolated = regions.filter((g) => !g.grouped);
    check('本命はまとまりとして出る', grouped.length === 1, `${grouped.length} 領域`);
    check('単発セルがあれば参考扱いになる',
      isolated.every((g) => g.cellCount < 3), `参考 ${isolated.length} 件`);
  }
}
