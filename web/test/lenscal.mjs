// レンズ歪み推定の検証。
// 既知の係数で格子を歪ませ、それを復元できるかを見る。
// 生成は「理想 → 観測」、推定は「観測 → 理想」なので、生成側は補正多項式の逆を解く。

import {
  estimateDistortion, undistortPoint, normRadius, orderGrid, gridWorld, isIdentity,
} from '../src/lenscal.js';

const FRAME = { width: 4032, height: 3024 };

/** 補正多項式の逆。undistort(distort(p)) = p になる点を反復で求める */
function distortPoint(x, y, k, frame) {
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  const R = normRadius(frame.width, frame.height);
  let px = x;
  let py = y;
  for (let i = 0; i < 40; i += 1) {
    const r2 = ((px - cx) ** 2 + (py - cy) ** 2) / (R * R);
    const f = 1 + (k.k1 ?? 0) * r2 + (k.k2 ?? 0) * r2 * r2;
    px = cx + (x - cx) / f;
    py = cy + (y - cy) / f;
  }
  return [px, py];
}

/** 平面格子を、ある姿勢（射影）で撮って歪ませた観測点を作る */
function makeView(cols, rows, k, { tilt = 0, rot = 0, noise = 0, seed = 1 } = {}) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const world = gridWorld(cols, rows);
  const cx = FRAME.width / 2;
  const cy = FRAME.height / 2;
  const span = FRAME.height * 0.82;           // 用紙が画面いっぱいに写る想定
  const observed = world.map((w) => {
    // 設計座標を中心化して並べる
    let X = (w.x - (cols - 1) / 2) / Math.max(1, cols - 1) * span * (FRAME.width / FRAME.height) * 0.9;
    let Y = (w.y - (rows - 1) / 2) / Math.max(1, rows - 1) * span;
    // 面内回転
    const c = Math.cos(rot), sn = Math.sin(rot);
    [X, Y] = [X * c - Y * sn, X * sn + Y * c];
    // 傾き（射影）。奥行きで縮む
    const wz = 1 + tilt * (X / span);
    const px = cx + X / wz;
    const py = cy + Y / wz;
    const [dx, dy] = distortPoint(px, py, k, FRAME);
    return { x: dx + (rnd() - 0.5) * noise, y: dy + (rnd() - 0.5) * noise };
  });
  return { observed, world };
}

export function runLensCalTests(check, near) {
  console.log('\n== レンズ歪み: 既知の係数を復元する ==');
  {
    const truth = { k1: 0.02, k2: 0 };          // 隅で 2%（実験で偽陽性が出た量）
    const view = makeView(7, 5, truth, { tilt: 0.12, rot: 0.03 });
    const est = estimateDistortion([view], FRAME, { useK2: false });
    check('k1 を復元する', est && near(est.k1, truth.k1, 0.002),
      `${est?.k1.toFixed(4)}（真値 ${truth.k1}）`);
    check('残差が桁で下がる', est && est.rmsPx < est.rmsBeforePx / 10,
      `${est?.rmsBeforePx.toFixed(2)} → ${est?.rmsPx.toFixed(3)} px`);
  }
  {
    const truth = { k1: -0.05, k2: 0.012 };     // 糸巻き＋高次
    const view = makeView(9, 7, truth, { tilt: -0.08, rot: -0.02 });
    const est = estimateDistortion([view], FRAME);
    check('k1 と k2 を同時に復元する',
      est && near(est.k1, truth.k1, 0.004) && near(est.k2, truth.k2, 0.006),
      `k1 ${est?.k1.toFixed(4)} / k2 ${est?.k2.toFixed(4)}（真値 ${truth.k1} / ${truth.k2}）`);
  }
  {
    // 歪みが無ければ係数を付けない。無理に当てて偽の補正を入れないこと
    const view = makeView(7, 5, { k1: 0, k2: 0 }, { tilt: 0.1 });
    const est = estimateDistortion([view], FRAME);
    check('歪みが無ければ係数はほぼゼロ', est && Math.abs(est.k1) < 0.002,
      `k1 ${est?.k1.toFixed(5)}`);
  }
  {
    // 実際の検出は 0.1px 級の誤差を持つ。それでも使える値が出るか
    const truth = { k1: 0.02, k2: 0 };
    const view = makeView(7, 5, truth, { tilt: 0.12, noise: 0.4, seed: 9 });
    const est = estimateDistortion([view], FRAME, { useK2: false });
    check('検出誤差 0.4px でも実用域で復元', est && near(est.k1, truth.k1, 0.004),
      `${est?.k1.toFixed(4)}（真値 ${truth.k1}）`);
  }
  {
    // 複数枚を束ねると安定するか
    const truth = { k1: 0.025, k2: 0 };
    const views = [
      makeView(7, 5, truth, { tilt: 0.15, rot: 0.05, noise: 0.4, seed: 2 }),
      makeView(7, 5, truth, { tilt: -0.15, rot: -0.04, noise: 0.4, seed: 3 }),
      makeView(7, 5, truth, { tilt: 0.02, rot: 0.3, noise: 0.4, seed: 4 }),
    ];
    const one = estimateDistortion([views[0]], FRAME, { useK2: false });
    const all = estimateDistortion(views, FRAME, { useK2: false });
    check('3枚束ねても正しい値に収まる', all && near(all.k1, truth.k1, 0.003),
      `1枚 ${one?.k1.toFixed(4)} / 3枚 ${all?.k1.toFixed(4)}（真値 ${truth.k1}）`);
    check('点数が合算される', all?.points === 105, `${all?.points} 点`);
  }

  console.log('\n== レンズ歪み: 補正の当てはめ ==');
  {
    const k = { k1: 0.02, k2: 0 };
    const R = normRadius(FRAME.width, FRAME.height);
    // 隅の点は k1 × R ぶん動く（定義どおりか）
    const [ux, uy] = undistortPoint(FRAME.width, FRAME.height, k, FRAME);
    const moved = Math.hypot(ux - FRAME.width, uy - FRAME.height);
    check('隅での補正量が定義どおり', near(moved, k.k1 * R, R * 0.001),
      `${moved.toFixed(1)} px（k1×R = ${(k.k1 * R).toFixed(1)}）`);
    check('中心は動かない',
      near(undistortPoint(FRAME.width / 2, FRAME.height / 2, k, FRAME)[0], FRAME.width / 2, 1e-9));
    check('係数ゼロは恒等と判定', isIdentity({ k1: 0, k2: 0 }) && !isIdentity({ k1: 0.01 }));
  }

  console.log('\n== レンズ歪み: 格子の並べ直し ==');
  {
    const view = makeView(5, 4, { k1: 0.02 }, { tilt: 0.05 });
    const shuffled = [...view.observed].sort(() => 0.5 - Math.random()).map((p) => ({ ...p }));
    const ord = orderGrid(shuffled, 5, 4);
    check('ばらばらでも格子順に戻る', ord.ok
      && ord.points.every((p, i) => Math.abs(p.x - view.observed[i].x) < 1e-9), ord.reason ?? '');
    check('数が合わなければ断る', orderGrid(shuffled.slice(0, 19), 5, 4).ok === false);
    // 90° 回して撮ると行が判別できない。黙って間違えず、断ること
    const rotated = view.observed.map((p) => ({ x: p.y, y: p.x }));
    const bad = orderGrid(rotated, 5, 4);
    check('正立でなければ断る（黙って間違えない）', bad.ok === false, bad.reason ?? '');
  }
}
