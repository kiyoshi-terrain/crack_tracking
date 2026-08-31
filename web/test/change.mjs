// 2時期変化抽出の検証。
// 基準時期の画像に対し、カメラの動き＋既知のブロック変位＋既知の変質を仕込み、
// 「塗られたものは全部有意」「仕込んだものは全部塗られる」の両方向を確かめる。

import { makeBlobs, renderBlobs } from './synthetic.mjs';
import { measureEpochChange, groupSignificant, fitTransformRobust } from '../src/change.js';
import { fitAffine, applyAffine } from '../src/transform.js';

const W = 340;
const H = 340;

function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 斑点の中心を「カメラの動き（回転＋並進）＋ブロックの追加変位」で写す。
 * 斑点は等方ガウシアンなので、中心を写せば小回転の画像変形とほぼ等価になる。
 */
function warpBlobs(blobs, { rotateDeg = 0, dx = 0, dy = 0, block = null }) {
  const a = (rotateDeg * Math.PI) / 180;
  const cx = W / 2;
  const cy = H / 2;
  return blobs.map((b) => {
    let x = cx + (b.x - cx) * Math.cos(a) - (b.y - cy) * Math.sin(a) + dx;
    let y = cy + (b.x - cx) * Math.sin(a) + (b.y - cy) * Math.cos(a) + dy;
    if (block && b.x >= block.x0 && b.x <= block.x1 && b.y >= block.y0 && b.y <= block.y1) {
      x += block.du;
      y += block.dv;
    }
    return { ...b, x, y };
  });
}

/** 帯の中の斑点を別の乱数で置き換える（風化・き裂進展で表面が変質した想定）。 */
function decorrelateBand(blobs, band, seed) {
  const rnd = makeRandom(seed);
  return blobs.map((b) => {
    if (b.x >= band.x0 && b.x <= band.x1 && b.y >= band.y0 && b.y <= band.y1) {
      return {
        x: band.x0 + rnd() * (band.x1 - band.x0),
        y: band.y0 + rnd() * (band.y1 - band.y0),
        sigma: 1.2 + rnd() * 2.6,
        amp: (rnd() - 0.5) * 0.9,
      };
    }
    return b;
  });
}

const inRect = (r) => (x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
const outRect = (r) => (x, y) => !inRect(r)(x, y);

export function runChangeTests(check, near) {
  const blobs = makeBlobs({ width: W, height: H, count: 1500, seed: 5 });
  const referenceA = renderBlobs(blobs, W, H, { noise: 0.01, seed: 11 });
  const OPTS = { step: 22, subsetHalf: 13, useHomography: false, k: 3 };

  console.log('\n== 2時期比較: 動いていなければ塗らない ==');
  {
    // カメラだけ動いた別日相当（回転1.5°＋並進＋露出変化）。ブロックは動かさない
    const framesB = [0, 1, 2, 3].map((i) =>
      renderBlobs(warpBlobs(blobs, { rotateDeg: 1.5, dx: 6.3, dy: -4.1 }), W, H,
        { noise: 0.01, seed: 20 + i, gain: 1.2, offset: 0.03 }));

    const r = measureEpochChange(referenceA, framesB, OPTS);
    check('解析が成立', r.ok === true, `評価 ${r.stats.evaluated} セル`);
    check('回転1.5°でも角の測点が全滅しない（2段階探索）',
      r.stats.evaluated > 100, `${r.stats.evaluated} セル`);
    check('有意セルなし（偽陽性ゼロ）', r.stats.significant === 0, `${r.stats.significant} セル`);
    check('相関低下もなし', r.stats.decorrelated === 0, `${r.stats.decorrelated} セル`);
    check('時期またぎ σ が実測される', r.sigmaCrossPx > 0 && r.sigmaCrossPx < 0.1,
      `${r.sigmaCrossPx?.toFixed(4)} px`);
  }

  console.log('\n== 2時期比較: ブロックの変位を当てる ==');
  {
    const block = { x0: 60, y0: 120, x1: 150, y1: 220, du: 0.8, dv: -0.5 };
    const framesB = [0, 1, 2, 3].map((i) =>
      renderBlobs(warpBlobs(blobs, { rotateDeg: 1.0, dx: -4.2, dy: 3.5, block }), W, H,
        { noise: 0.01, seed: 30 + i, gain: 0.9 }));

    // 安定域 = ブロックの外（測点の枠をブロックに合わせる運用と同じ）
    const margin = 26;
    const guard = { x0: block.x0 - margin, y0: block.y0 - margin, x1: block.x1 + margin, y1: block.y1 + margin };
    const r = measureEpochChange(referenceA, framesB, { ...OPTS, stableRegion: outRect(guard) });
    check('解析が成立', r.ok === true);

    const groups = groupSignificant(r, { minCells: 3 });
    check('動いた領域が1つだけ検出される', groups.length === 1, `${groups.length} 領域`);
    if (groups.length) {
      const g = groups[0];
      check('変位の向きと大きさを復元', near(g.du, 0.8, 0.06) && near(g.dv, -0.5, 0.06),
        `(${g.du.toFixed(3)}, ${g.dv.toFixed(3)}) px 真値 (0.8, -0.5)`);
      const inside = inRect({ x0: block.x0 - 22, y0: block.y0 - 22, x1: block.x1 + 22, y1: block.y1 + 22 });
      check('検出位置がブロックと一致',
        inside(g.bounds.x0, g.bounds.y0) && inside(g.bounds.x1, g.bounds.y1),
        `[${g.bounds.x0},${g.bounds.y0}]〜[${g.bounds.x1},${g.bounds.y1}]`);
    }

    // ブロックの外に有意セルが漏れていないか
    const leak = r.cells.filter((c) => c.significant && outRect(guard)(c.x, c.y)).length;
    check('安定域に偽の変位が出ない', leak === 0, `${leak} セル`);
  }

  console.log('\n== 2時期比較: 表面の変質は相関低下として出る ==');
  {
    // き裂進展の代役: 幅30pxの帯のテクスチャを置き換える
    const band = { x0: 190, y0: 60, x1: 220, y1: 280 };
    const changed = decorrelateBand(warpBlobs(blobs, { rotateDeg: 0.8, dx: 3.0, dy: 2.0 }), band, 99);
    const framesB = [0, 1, 2].map((i) =>
      renderBlobs(changed, W, H, { noise: 0.01, seed: 40 + i }));

    const r = measureEpochChange(referenceA, framesB, OPTS);
    check('解析が成立', r.ok === true);
    check('相関低下が検出される', r.stats.decorrelated >= 4, `${r.stats.decorrelated} セル`);

    // テクスチャの薄い行は原理的に検出できない（元も新も平坦なら相関は落ちない）
    // ので、領域の数ではなく全相関低下セルの広がりで見る
    const groups = groupSignificant(r, { minCells: 2, which: 'decorrelated' });
    check('数個の領域にまとまる', groups.length >= 1 && groups.length <= 3, `${groups.length} 領域`);
    const dec = r.cells.filter((c) => c.decorrelated);
    const xs = dec.map((c) => c.x);
    const ys = dec.map((c) => c.y);
    check('位置が帯と合う（横）',
      Math.min(...xs) >= band.x0 - 30 && Math.max(...xs) <= band.x1 + 30,
      `x [${Math.min(...xs)}, ${Math.max(...xs)}] 真値 [${band.x0}, ${band.x1}]`);
    check('帯の長さの過半を捉える',
      Math.max(...ys) - Math.min(...ys) > (band.y1 - band.y0) * 0.5,
      `${Math.max(...ys) - Math.min(...ys)} px / 真値 ${band.y1 - band.y0} px`);

    // 変質した場所の「変位」を信用して有意と言っていないか
    const fake = r.cells.filter((c) => c.significant && inRect(band)(c.x, c.y)).length;
    check('変質セルを変位として誤報しない', fake === 0, `${fake} セル`);
  }

  console.log('\n== 2時期比較: 基準側の σ が限界に効く ==');
  {
    const block = { x0: 100, y0: 100, x1: 180, y1: 180, du: 0.12, dv: 0 };
    const framesB = [0, 1, 2, 3].map((i) =>
      renderBlobs(warpBlobs(blobs, { dx: 2.0, dy: 1.0, block }), W, H, { noise: 0.01, seed: 50 + i }));

    const strict = measureEpochChange(referenceA, framesB,
      { ...OPTS, stableRegion: outRect({ x0: 74, y0: 74, x1: 206, y1: 206 }) });
    const withA = measureEpochChange(referenceA, framesB,
      { ...OPTS, sigmaAPx: 0.2, stableRegion: outRect({ x0: 74, y0: 74, x1: 206, y1: 206 }) });

    check('小さな変位は σ_A なしなら拾える', strict.stats.significant > 0,
      `${strict.stats.significant} セル`);
    check('σ_A を渡すと限界が広がり慎重になる',
      withA.stats.significant < strict.stats.significant,
      `${withA.stats.significant} < ${strict.stats.significant} セル`);
  }

  console.log('\n== ロバストな変換フィット ==');
  {
    // 3割の点に大きな外れ値。最小二乗のままなら変換ごと引きずられる
    const rnd = makeRandom(3);
    const points = [];
    for (let i = 0; i < 200; i += 1) {
      const x = rnd() * 300;
      const y = rnd() * 300;
      const outlier = i % 3 === 0;
      points.push({ x, y, u: 2 + (outlier ? 5 : 0) + (rnd() - 0.5) * 0.02, v: -1 + (rnd() - 0.5) * 0.02 });
    }
    const naive = fitAffine(points);
    const robust = fitTransformRobust(points, false);
    // 表現形式に依存しないよう、代表点での予測変位で比べる
    const probeU = (t) => applyAffine(t, 150, 150)[0] - 150;
    check('最小二乗は外れ値に引きずられる（前提の確認）', Math.abs(probeU(naive) - 2) > 0.5,
      `u=${probeU(naive).toFixed(3)}`);
    check('ロバスト版は引きずられない', near(probeU(robust.transform), 2, 0.05),
      `u=${probeU(robust.transform).toFixed(3)}`);
    check('外れ値が除外されている', robust.inlierCount < 200 && robust.inlierCount > 100,
      `${robust.inlierCount} / 200`);
  }
}
