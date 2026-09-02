// 計測セッション（自動停止・フレーム合否・簡易σ）の検証。

import { shouldStop, frameGate, quickSigma, limitEstimate, estimateLensRatio, resample, SESSION_DEFAULTS } from '../src/capture.js';
import { makeBlobs, renderBlobs } from './synthetic.mjs';

export function runCaptureTests(check, near) {
  console.log('\n== 計測セッション: 自動停止の判断 ==');
  {
    const go = { frames: 3, consecutiveRejects: 0 };

    // 収束していても最少枚数までは止まらない
    const flat = [0.1, 0.1, 0.1];
    check('最少枚数までは止まらない',
      shouldStop(flat, { frames: 4, consecutiveRejects: 0 }).stop === false);

    // 最少枚数を超えて、限界が2回連続で動かなければ収束
    const converged = shouldStop([0.12, 0.105, 0.101, 0.1], { frames: 5, consecutiveRejects: 0 });
    check('収束で止まる', converged.stop === true && converged.reason === 'converged');

    // 直近1回だけ動かなくても、その前が大きく動いていれば続行
    const swing = shouldStop([0.2, 0.12, 0.1, 0.099], { frames: 5, consecutiveRejects: 0 });
    check('1回静止しただけでは止まらない', swing.stop === false, JSON.stringify(swing));

    // まだ揺れていれば続行
    const noisy = shouldStop([0.2, 0.1, 0.15, 0.1], { frames: 6, consecutiveRejects: 0 });
    check('揺れている間は続行', noisy.stop === false);

    // 上限で必ず止まる
    const capped = shouldStop(noisy ? [0.2, 0.1, 0.15, 0.1] : [], { frames: SESSION_DEFAULTS.maxFrames, consecutiveRejects: 0 });
    check('上限枚数で止まる', capped.stop === true && capped.reason === 'max');

    // 連続で弾かれたら条件が悪いと判断
    const bad = shouldStop([], { frames: 2, consecutiveRejects: 3 });
    check('連続不合格で止まる', bad.stop === true && bad.reason === 'quality');
    check('（前提の確認）通常は続行', shouldStop([], go).stop === false);
  }

  console.log('\n== 計測セッション: フレームの合否 ==');
  {
    check('模様が無ければ弾く',
      frameGate({ focus: 0.3, verdict: 'poor' }, []).ok === false);
    check('最初の2枚は模様さえあれば通す（比較相手がいない）',
      frameGate({ focus: 0.01, verdict: 'good' }, [0.3]).ok === true);
    const rejected = frameGate({ focus: 0.1, verdict: 'good' }, [0.3, 0.31, 0.29]);
    check('採用済みの6割未満のピントは弾く', rejected.ok === false, rejected.reason);
    check('6割以上なら通す',
      frameGate({ focus: 0.2, verdict: 'good' }, [0.3, 0.31, 0.29]).ok === true);
  }

  console.log('\n== 計測セッション: 簡易σと限界の見積もり ==');
  {
    const W = 260;
    const blobs = makeBlobs({ width: W, height: W, count: 900, seed: 8 });
    const reference = renderBlobs(blobs, W, W, { noise: 0.008, seed: 1 });
    const target = renderBlobs(blobs, W, W, { u: 1.3, v: -0.8, noise: 0.008, seed: 2 });
    const sigma = quickSigma(reference, target);
    check('簡易σが出る', Number.isFinite(sigma) && sigma > 0 && sigma < 0.1,
      `σ=${sigma?.toFixed(4)} px`);

    const flat = { width: W, height: W, data: new Float32Array(W * W).fill(0.5) };
    check('平坦画像では null（落ちない）', quickSigma(reference, flat) === null);

    const est = limitEstimate([0.02, 0.5, 0.021, 0.019], 0.5);
    check('限界の見積もりは中央値ベース（1組の外れに耐える）',
      est.sigmaPx < 0.03, `σ中央値=${est.sigmaPx.toFixed(4)} px`);
    check('mm 換算と枚数', near(est.mm, est.px * 0.5, 1e-12) && est.frames === 5);
    check('σ が全滅なら null', limitEstimate([NaN, null], 0.5) === null);
  }

  console.log('\n== レンズ倍率の実測（広角と望遠の画から） ==');
  {
    // 同じ壁を広角で撮った画と、中央を 3× に寄せて撮った画（光軸は少しずれる）
    const W = 420, H = 315;
    const blobs = makeBlobs({ width: W * 3, height: H * 3, count: 9000, seed: 21 });
    const wideBlobs = blobs.map((b) => ({ ...b, x: b.x / 3, y: b.y / 3, sigma: Math.max(0.9, b.sigma / 3) }));
    const wide = renderBlobs(wideBlobs, W, H, { noise: 0.01, seed: 1 });
    const cx = (W * 3) / 2, cy = (H * 3) / 2;
    const teleBlobs = blobs.map((b) => ({ ...b, x: b.x - cx + W / 2 + 6, y: b.y - cy + H / 2 - 4 }));
    const tele = renderBlobs(teleBlobs, W, H, { noise: 0.01, seed: 2, gain: 1.15 });
    const est = estimateLensRatio(wide, tele);
    check('望遠 3× を実測', est && near(est.ratio, 3, 0.06),
      `${est?.ratio.toFixed(3)}×（相関 ${est?.zncc.toFixed(2)}）`);

    // 逆に超広角（0.5×）: 広角の画をさらに縮めたもの
    const ultra = renderBlobs(wideBlobs.map((b) => ({ ...b, x: b.x / 2 + W / 4, y: b.y / 2 + H / 4, sigma: Math.max(0.9, b.sigma / 2) })),
      W, H, { noise: 0.01, seed: 3 });
    const estU = estimateLensRatio(wide, ultra);
    check('超広角 0.5× を実測', estU && near(estU.ratio, 0.5, 0.02),
      `${estU?.ratio.toFixed(3)}×（相関 ${estU?.zncc.toFixed(2)}）`);

    const flat = { width: W, height: H, data: new Float32Array(W * H).fill(0.5) };
    check('模様が無ければ null（当てずっぽうを返さない）', estimateLensRatio(wide, flat) === null);
    const rs = resample(wide, 0.5);
    check('再標本化の寸法', rs.width === 210 && rs.height === 158, `${rs.width}x${rs.height}`);
  }
}
