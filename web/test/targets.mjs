// ターゲット検出の検証。既知のサブピクセル位置に円を描いて復元精度を測る。

import { detectTargets, refineCentroid, matchTargets, pairwiseDistances } from '../src/targets.js';

/**
 * アンチエイリアスした暗い円を描く。
 * 中心は連続値で指定でき、これが真値になる。
 */
export function renderTargets(width, height, circles, {
  background = 0.85,
  ink = 0.12,
  supersample = 8,
  noise = 0,
  seed = 3,
  gain = 1,
  offset = 0,
} = {}) {
  const data = new Float32Array(width * height).fill(background);
  const sub = supersample;
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };

  for (const c of circles) {
    const r = c.r;
    const x0 = Math.max(0, Math.floor(c.x - r - 2));
    const x1 = Math.min(width - 1, Math.ceil(c.x + r + 2));
    const y0 = Math.max(0, Math.floor(c.y - r - 2));
    const y1 = Math.min(height - 1, Math.ceil(c.y + r + 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let inside = 0;
        for (let sy = 0; sy < sub; sy++) {
          for (let sx = 0; sx < sub; sx++) {
            const px = x + (sx + 0.5) / sub - 0.5;
            const py = y + (sy + 0.5) / sub - 0.5;
            // 斜めから見た楕円も扱えるように x/y で半径を分ける
            const rx = c.rx ?? r;
            const ry = c.ry ?? r;
            const dx = (px - c.x) / rx;
            const dy = (py - c.y) / ry;
            if (dx * dx + dy * dy <= 1) inside++;
          }
        }
        if (!inside) continue;
        const coverage = inside / (sub * sub);
        const i = y * width + x;
        data[i] = data[i] * (1 - coverage) + ink * coverage;
      }
    }
  }

  for (let i = 0; i < data.length; i++) {
    data[i] = data[i] * gain + offset;
    if (noise > 0) data[i] += (rnd() - 0.5) * noise;
  }
  return { width, height, data };
}

export function runTargetTests(check, near) {
  const W = 480;
  const H = 360;

  console.log('\n== ターゲットのサブピクセル重心 ==');
  {
    // 端数を持たせた真値
    const truth = [
      { x: 100.37, y: 90.62, r: 12 },
      { x: 300.19, y: 90.83, r: 12 },
      { x: 100.71, y: 260.26, r: 12 },
      { x: 300.44, y: 260.55, r: 12 },
      { x: 200.5, y: 175.5, r: 12 },
    ];
    const image = renderTargets(W, H, truth);
    const found = detectTargets(image, { backgroundRadius: 50 });

    check('5点すべて検出', found.length === 5, `検出 ${found.length} 点`);

    let worst = 0;
    for (const t of truth) {
      const match = found.reduce(
        (best, f) => (Math.hypot(f.x - t.x, f.y - t.y) < Math.hypot(best.x - t.x, best.y - t.y) ? f : best),
        found[0]
      );
      worst = Math.max(worst, Math.hypot(match.x - t.x, match.y - t.y));
    }
    check('重心誤差 < 0.05px', worst < 0.05, `最大誤差 ${worst.toFixed(4)} px`);
  }

  console.log('\n== 照明が変わっても重心が動かないこと ==');
  {
    const truth = [{ x: 240.33, y: 180.67, r: 14 }];
    const a = detectTargets(renderTargets(W, H, truth), { backgroundRadius: 50 })[0];
    const b = detectTargets(renderTargets(W, H, truth, { gain: 1.4, offset: 0.05 }), { backgroundRadius: 50 })[0];
    check(
      '露出+40%・オフセット+0.05',
      a && b && Math.hypot(a.x - b.x, a.y - b.y) < 0.01,
      a && b ? `ずれ ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(5)} px` : '検出失敗'
    );
  }

  console.log('\n== ノイズ耐性 ==');
  {
    const truth = [{ x: 240.41, y: 180.28, r: 14 }];
    const found = detectTargets(renderTargets(W, H, truth, { noise: 0.02, seed: 9 }), { backgroundRadius: 50 })[0];
    check(
      'ノイズ振幅2%（8bitで±2.6階調）',
      found && Math.hypot(found.x - truth[0].x, found.y - truth[0].y) < 0.05,
      found ? `誤差 ${Math.hypot(found.x - truth[0].x, found.y - truth[0].y).toFixed(4)} px` : '検出失敗'
    );
  }

  console.log('\n== 斜めから見た楕円 ==');
  {
    // 見上げ角45°相当（縦が cos45 = 0.707 に圧縮）
    const truth = [{ x: 240.35, y: 180.45, r: 16, rx: 16, ry: 11.3 }];
    const found = detectTargets(renderTargets(W, H, truth), { backgroundRadius: 50 })[0];
    check(
      '楕円でも検出し重心が合う',
      found && Math.hypot(found.x - truth[0].x, found.y - truth[0].y) < 0.05,
      found ? `誤差 ${Math.hypot(found.x - truth[0].x, found.y - truth[0].y).toFixed(4)} px  縦横比 ${found.aspect.toFixed(2)}` : '検出失敗'
    );
  }

  console.log('\n== 既知量を動かして当てられるか（模擬き裂の開口） ==');
  {
    // 左2点＝固定側（岩塊）、右2点＝可動側（き裂の向こう）
    const fixed = [
      { x: 90.0, y: 120.0, r: 12 },
      { x: 90.0, y: 240.0, r: 12 },
    ];
    const movableBefore = [
      { x: 330.0, y: 120.0, r: 12 },
      { x: 330.0, y: 240.0, r: 12 },
    ];
    const opening = 0.37; // px。GSD 0.5mm/px なら 0.185mm 相当
    const movableAfter = movableBefore.map((c) => ({ ...c, x: c.x + opening }));

    const before = detectTargets(renderTargets(W, H, [...fixed, ...movableBefore]), { backgroundRadius: 50 });
    const after = detectTargets(renderTargets(W, H, [...fixed, ...movableAfter]), { backgroundRadius: 50 });

    check('前後とも4点検出', before.length === 4 && after.length === 4, `${before.length} / ${after.length}`);

    const pairs = matchTargets(before, after);
    check('4点とも対応付く', pairs.length === 4, `${pairs.length} 組`);

    // 固定側の重心移動（＝計測系のドリフト）を差し引いてから開口量を出す
    const fixedPairs = pairs.filter((p) => p.a.x < 200);
    const movablePairs = pairs.filter((p) => p.a.x >= 200);
    const meanShift = (list, key) =>
      list.reduce((s, p) => s + (p.b[key] - p.a[key]), 0) / Math.max(1, list.length);
    const drift = meanShift(fixedPairs, 'x');
    const moved = meanShift(movablePairs, 'x');
    const measured = moved - drift;

    check(
      `開口 ${opening}px を復元`,
      near(measured, opening, 0.02),
      `計測 ${measured.toFixed(4)} px  誤差 ${(measured - opening).toFixed(4)} px（固定側ドリフト ${drift.toFixed(4)}）`
    );
  }

  console.log('\n== 対応付けの取り違え耐性 ==');
  {
    const circles = [
      { x: 100.2, y: 100.4, r: 11 },
      { x: 160.6, y: 100.1, r: 11 },
      { x: 220.3, y: 100.8, r: 11 },
    ];
    const a = detectTargets(renderTargets(W, H, circles), { backgroundRadius: 50 });
    // 全体が 45px ずれた（手持ち相当）
    const shifted = circles.map((c) => ({ ...c, x: c.x + 45, y: c.y + 12 }));
    const b = detectTargets(renderTargets(W, H, shifted), { backgroundRadius: 50 });

    const naive = matchTargets(a, b, { dx: 0, dy: 0 }, 30);
    check('ずれを補正しないと対応が壊れる', naive.length < 3, `${naive.length} / 3 組`);

    const corrected = matchTargets(a, b, { dx: 45, dy: 12 }, 30);
    check('ずれを与えれば正しく対応', corrected.length === 3, `${corrected.length} / 3 組`);
    if (corrected.length === 3) {
      const ok = corrected.every((p) => Math.abs(p.b.x - p.a.x - 45) < 0.1);
      check('対応先が正しい', ok);
    }
  }

  console.log('\n== 対間距離 ==');
  {
    const circles = [
      { x: 100, y: 100, r: 12 },
      { x: 300, y: 100, r: 12 },
      { x: 100, y: 250, r: 12 },
    ];
    const found = detectTargets(renderTargets(W, H, circles), { backgroundRadius: 50 });
    const distances = pairwiseDistances(found).map((d) => d.distance).sort((a, b) => a - b);
    check('3点なら3対', distances.length === 3);
    check(
      '150 / 200 / 250 px を復元',
      near(distances[0], 150, 0.05) && near(distances[1], 200, 0.05) && near(distances[2], 250, 0.05),
      distances.map((d) => d.toFixed(3)).join(' / ')
    );
  }
}
