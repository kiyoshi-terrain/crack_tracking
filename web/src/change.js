/**
 * 2時期の変化抽出。
 *
 * 出す層は2つで、役割が違います。
 *
 * 1. **変位マップ** — どこが・どちらへ・どれだけ動いたか。
 *    安定域で変換（カメラの動き）を当てはめて差し引き、残った変位だけを見る
 * 2. **相関低下マップ** — 表面が変質した場所。き裂の進展は「相関が切れる線」
 *    として現れるので、ノンターゲット運用ではこちらが先端監視の本命になる
 *
 * ## 塗られたものは全部有意、を守る
 *
 * 2時期比較ツールの典型的な失敗は差分をそのまま塗ることです。ノイズも位置ずれも
 * 全部「変化」として描かれ、本物が埋もれる。ここでは各セルの変位を今回セットの
 * 全フレームで測り直し、そのばらつき（＝その場の実測ノイズ）を超えたものだけを
 * 有意として返します。しきい値を外から与えないのは σ 実測ツールと同じ思想です。
 *
 * 依存なし・入出力は数値だけ。
 */

import { measureDisplacementField, estimateGlobalShift } from './dic.js';
import { fitAffine, fitHomography, applyAffine, applyHomography, residuals } from './transform.js';
import { undistortPoint, isIdentity } from './lenscal.js';
import { cellGeometry, correctParallax, leverageQuality } from './parallax.js';

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * 変換をロバストに当てはめる。
 *
 * 最小二乗のままだと、動いているブロックの点が「カメラの動き」に混ざって
 * 変換ごと引きずられ、本物の変位が消える。MAD で外れ値を落として2回引き直す。
 */
export function fitTransformRobust(points, useHomography = false, rounds = 2) {
  let inliers = points;
  let transform = null;

  for (let round = 0; round <= rounds; round += 1) {
    if (inliers.length < (useHomography ? 8 : 6)) break;
    transform = useHomography ? fitHomography(inliers) : fitAffine(inliers);
    if (!transform) break;

    const res = residuals(transform, inliers);
    // 外れ値が混ざると当てはめ自体が引きずられ、多数派の残差もゼロから浮く。
    // そのため残差の「大きさ」では二群が重なって刈れない（実際に刈れなかった）。
    // 残差ベクトルの中央値＝多数派の中心を先に掴み、そこからの距離で刈る
    const medDu = median(res.map((r) => r.du));
    const medDv = median(res.map((r) => r.dv));
    const distances = res.map((r) => Math.hypot(r.du - medDu, r.dv - medDv));
    const mad = median(distances) * 1.4826;
    const limit = 3 * Math.max(mad, 1e-6);
    const next = inliers.filter((p, i) => distances[i] <= limit);
    if (next.length === inliers.length) break;
    inliers = next;
  }

  return { transform, inlierCount: inliers.length };
}

/**
 * フレームを基準画像の幾何へワープする（双一次補間）。
 *
 * ## なぜ予測付き照合ではなくワープか
 * 並進のみのサブセット照合は、サブセット内で変位が一定であることを仮定する。
 * 回転が 1.5° あるだけでサブセット（半径13px）内の変位差は ±0.34px になり、
 * 模様の偏りに応じて場所ごとに 0.1px 級の**安定した**バイアスが出る
 * （実測した。しかも全フレーム同じ構図なのでばらつきにも出ない）。
 * 変換で画像ごと戻してしまえば、残るのはほぼ並進だけになり、この仮定が成立する。
 *
 * @returns {{image: object, region: {x,y,width,height}}}
 *          region はワープ元が画像内に収まっている範囲（余白ぶん縮めてある）
 */
export function warpToReference(frame, apply, refWidth, refHeight, shrink) {
  const out = new Float32Array(refWidth * refHeight).fill(0.5);
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;

  for (let y = 0; y < refHeight; y += 1) {
    for (let x = 0; x < refWidth; x += 1) {
      const [sx, sy] = apply(x, y);
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= frame.width - 1 || y0 >= frame.height - 1) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * frame.width + x0;
      out[y * refWidth + x] =
        frame.data[i] * (1 - fx) * (1 - fy) +
        frame.data[i + 1] * fx * (1 - fy) +
        frame.data[i + frame.width] * (1 - fx) * fy +
        frame.data[i + frame.width + 1] * fx * fy;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // 有効域を余白ぶん縮める。埋め草（0.5）にサブセットが触れると
  // 端のセルが偽の相関低下として並んでしまう
  const region = {
    x: minX + shrink,
    y: minY + shrink,
    width: Math.max(0, maxX - minX - 2 * shrink),
    height: Math.max(0, maxY - minY - 2 * shrink),
  };
  return { image: { width: refWidth, height: refHeight, data: out }, region };
}

/**
 * 解析範囲を共通の格子に吸着させる。フレームごとにワープ後の有効域が微妙に
 * 違うので、そのまま渡すと格子の原点がずれてセルの集計が噛み合わなくなる。
 */
function alignRegion(region, anchor, step) {
  const x = anchor.x + Math.ceil((region.x - anchor.x) / step) * step;
  const y = anchor.y + Math.ceil((region.y - anchor.y) / step) * step;
  return {
    x, y,
    width: region.x + region.width - x,
    height: region.y + region.height - y,
  };
}

function intersectRegion(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x, y,
    width: Math.min(a.x + a.width, b.x + b.width) - x,
    height: Math.min(a.y + a.height, b.y + b.height) - y,
  };
}



/**
 * 基準時期の1枚に対して、今回セットの全フレームで変化を測る。
 *
 * ## 2段階で追う理由
 * 別日の撮影では立ち位置と構図が完全には再現できず、画面の場所ごとに
 * 初期ずれが違う（回転だけで画面の角は数〜十数px 動く）。一定の粗シフトでは
 * 角の測点が探索窓から外れて全滅するので、まず粗い格子＋広い探索窓で
 * 変換を掴み、それを予測に使って全点を狭い窓で精密に測り直す。
 *
 * @param {object} referenceA 基準時期の代表画像（グレースケール）
 * @param {Array} framesB 今回セットの画像たち（2枚以上を推奨）
 * @param {object} options
 *   subsetHalf/step/minZNCC — DIC と同じ
 *   useHomography — 別日撮影なら true 推奨
 *   region — 評価する範囲
 *   stableRegion — 変換のフィットに使う点の選別関数 (x, y) => boolean。
 *                  無指定なら全点からロバストにフィット
 *   sigmaAPx — 基準時期セット内で実測した1測点 σ[px]。基準画像自身のノイズは
 *              フレーム間ばらつきに出ない（全フレーム共通のバイアスになる）ので、
 *              ここで足してやらないと限界を過小評価する
 *   k — 何σで有意とするか（既定 3）
 */
/**
 * 2時期の局所的な明るさの比が、サブセット内でどれだけ不均一かを返す。
 *
 * ZNSSD はサブセット内の明るさが**一様に**変わるぶんには影響されない。
 * だが影の縁のように**場所によって違う**変わり方には効かない。縁をまたぐ
 * サブセットは時期間で明暗の配り方が変わり、偽の変位として出る
 *（合成検証で σ の 400 倍・1.1px 級が出た）。
 *
 * 3x3 の小ブロックごとに比 B/A を取り、（最大 − 最小）/ 中央値 を返す。
 * 一様な変化なら 0 に近く、縁をまたぐと大きくなる。幾何ではなく局所量なので、
 * 縁が画面外へ抜けたあとの取り残しも拾える。
 *
 * **測った変位ぶんずらした位置で比べること。** 同じ座標で比べると、模様が
 * 1px 動いただけで小ブロックの平均が変わり、本物の変位を影と誤認する
 *（実際に誤認し、仕込んだ 1.08px のブロックが丸ごと消えた）。
 * ずらして比べれば、剛体変位では明るさが一致し、照明の変化だけが残る。
 *
 * @param {Gray} a 基準（幾何を揃えたもの）
 * @param {Gray} b 今回（同上）
 * @param {number} du b 側を読む位置のずれ（測った変位）
 */
function illuminationSpread(a, b, cx, cy, half, du = 0, dv = 0) {
  const FLOOR = 0.02;          // 暗部で比が暴れるのを防ぐ
  const s = Math.max(2, Math.floor((2 * half + 1) / 3));
  const ratios = [];
  for (let by = -1; by <= 1; by += 1) {
    for (let bx = -1; bx <= 1; bx += 1) {
      const x0 = Math.round(cx + bx * s - s / 2);
      const y0 = Math.round(cy + by * s - s / 2);
      let sa = 0, sb = 0, n = 0;
      for (let y = y0; y < y0 + s; y += 1) {
        if (y < 0 || y >= a.height) continue;
        for (let x = x0; x < x0 + s; x += 1) {
          if (x < 0 || x >= a.width) continue;
          const bx2 = x + du;
          const by2 = y + dv;
          if (bx2 < 0 || by2 < 0 || bx2 >= b.width - 1 || by2 >= b.height - 1) continue;
          sa += a.data[y * a.width + x];
          sb += bilinear(b, bx2, by2);
          n += 1;
        }
      }
      if (n < 4) continue;
      const ma = sa / n;
      const mb = sb / n;
      if (ma < FLOOR || mb < FLOOR) continue;
      ratios.push(mb / ma);
    }
  }
  if (ratios.length < 5) return 0;
  ratios.sort((x, y) => x - y);
  const med = ratios[ratios.length >> 1];
  return med > 0 ? (ratios[ratios.length - 1] - ratios[0]) / med : 0;
}

function bilinear(img, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const i = y0 * img.width + x0;
  return (img.data[i] * (1 - tx) + img.data[i + 1] * tx) * (1 - ty)
    + (img.data[i + img.width] * (1 - tx) + img.data[i + img.width + 1] * tx) * ty;
}

export async function measureEpochChange(referenceA, framesB, options = {}) {
  const {
    subsetHalf = 15,
    step = 25,
    minZNCC = 0.7,
    useHomography = true,
    region = null,
    stableRegion = null,
    sigmaAPx = null,
    k = 3,
    coarseSearch = 40,
    // 影の縁の判定。サブセット内で 2時期の明るさの比がこの割合を超えて
    // ばらついたら、そのセルの変位は信用しない
    illuminationTolerance = 0.13,
    // 視差補正。点群があるときだけ効く。
    // {camera, plane, intrinsics, heightAt, unitScaleToMM, minCoverage, minSpread}
    parallax = null,
    // レンズ歪み係数（lenscal.estimateDistortion の戻り値）。
    // 与えると、当てはめの前に対応を理想（ピンホール）座標へ移す
    lens = null,
    downsample = null,
    // 実機の画素数（4000px級）では広域探索が重すぎるので、段階1だけ
    // 縮小画像で回して変換を実寸へ引き上げる。座標の縮尺変換だけなので
    // 変換の表現形式には依存しない
    coarseScale = 1,
    // フレームの合間に UI へ制御を返すための足場（ブラウザで進捗を描くため）
    yieldBetweenFrames = null,
    onFrame = null,
    // 系統誤差の下限[px]。フレーム間ばらつきは「フレームごとに変わる誤差」しか
    // 拾えない。三脚で全フレームが同じ構図だと、サブピクセル補間のバイアス
    // （合成検証で 0.001〜0.005px 級）が共通に乗り、ばらつきには一切出ない。
    // その分の床を敷かないと、動いていない壁が一面「有意」に染まる（実際に染まった）。
    // 値は合成検証の誤差帯上限の4倍。実写で σ_A を測って渡せばさらに上に積まれる
    systematicFloorPx = 0.02,
  } = options;

  if (!framesB.length) throw new Error('今回セットが空です');

  const bins = new Map();
  const key = (x, y) => `${x},${y}`;
  const frameSummaries = [];

  const smallA = coarseScale > 1 && downsample ? downsample(referenceA, coarseScale) : referenceA;

  for (let fi = 0; fi < framesB.length; fi += 1) {
    if (yieldBetweenFrames) await yieldBetweenFrames();
    if (onFrame) onFrame(fi, framesB.length);
    // フレームは実体でも「呼んだら返す関数」でもよい。実機の画素数では
    // 全フレームのグレースケールを同時に持つとメモリが持たないため
    const provided = framesB[fi];
    const frame = typeof provided === 'function' ? await provided() : provided;

    // 段階1: 粗い格子・広い窓で変換を掴む（coarseScale 指定時は縮小画像で）
    const smallF = coarseScale > 1 && downsample ? downsample(frame, coarseScale) : frame;
    // 探索半径は縮小後の寸法に合わせる。縮小前の 400px をそのまま渡すと、
    // 縮小画像では探索点が全部画面外に落ちて confidence 0 で黙り、
    // 手持ちで 40px ずれただけで「相関が取れません」になる
    const shift = downsample
      ? estimateGlobalShift(smallA, smallF, downsample, {
        maxShiftPx: Math.min(Math.ceil(400 / coarseScale),
          Math.floor(Math.min(smallA.width, smallA.height) / 8)),
      })
      : { dx: 0, dy: 0 };

    // 探索窓も縮尺に合わせる。並進は段階0の全体シフトが受け持つので、
    // ここで探せばいいのは回転・射影の残りぶんだけ
    const coarse = measureDisplacementField(smallA, smallF, {
      subsetHalf,
      step: Math.max(10, Math.round((step * 2) / coarseScale)),
      searchRange: Math.max(10, Math.round(coarseSearch / coarseScale)),
      minZNCC: Math.min(0.55, minZNCC),
      initialShift: shift,
    });
    // 当てはめの自由度が確保できる点数か（アフィン6・ホモグラフィ8 + 余裕）
    if (coarse.points.length < (useHomography ? 10 : 8)) {
      frameSummaries.push({ ok: false, matched: coarse.points.length });
      continue;
    }
    const first = fitTransformRobust(coarse.points, useHomography);
    if (!first.transform) {
      frameSummaries.push({ ok: false, matched: coarse.points.length });
      continue;
    }

    const applySmall = useHomography
      ? (x, y) => applyHomography(first.transform, x, y)
      : (x, y) => applyAffine(first.transform, x, y);
    const applyFull = coarseScale > 1
      ? (x, y) => {
          const [X, Y] = applySmall(x / coarseScale, y / coarseScale);
          return [X * coarseScale, Y * coarseScale];
        }
      : applySmall;

    // 段階2: 変換で画像ごと基準の幾何へ戻してから、狭い窓で精密に照合する。
    // 予測付き照合では回転勾配のバイアス（0.1px級）が残る — warpToReference 参照
    const warped = warpToReference(
      frame, applyFull,
      referenceA.width, referenceA.height, subsetHalf + 6
    );
    let fineRegion = region ? intersectRegion(warped.region, region) : warped.region;
    fineRegion = alignRegion(fineRegion, { x: 0, y: 0 }, step);
    if (fineRegion.width < step * 2 || fineRegion.height < step * 2) {
      frameSummaries.push({ ok: false, matched: 0 });
      continue;
    }

    const fine = measureDisplacementField(referenceA, warped.image, {
      subsetHalf,
      step,
      searchRange: 3,
      minZNCC,
      region: fineRegion,
    });

    // ワープ後の残りずれ（段階1の粗さぶん）を安定域で当て直す。
    // モデルは段階1と同じにする。段階1がホモグラフィで反っていた場合、
    // アフィンの補正では角の反りを吸収できず、画面の角に系統残差が残る
    //（実際に角へ偽の有意セルが並んだ）
    // レンズ歪みの補正。ホモグラフィは放射歪みを表現できないので、姿勢差があると
    // 取り切れない残りが偽の変位として出る（合成検証: 姿勢差が中程度で 71 セル中 44）。
    // 対応を理想座標へ移してから当てれば、ホモグラフィで厳密に説明できる。
    // 画像を作り直すより安い（画素ではなく点にだけ効かせる）
    const undo = lens && !isIdentity(lens)
      ? (x, y) => undistortPoint(x, y, lens, { width: referenceA.width, height: referenceA.height })
      : null;
    const fitPoints = undo
      ? fine.points.map((p) => {
        const [ax, ay] = undo(p.x, p.y);
        // 対応先は「ワープ前の今回画像」での位置。そこで歪んでいる
        const [rawX, rawY] = applyFull(p.x + p.u, p.y + p.v);
        const [bx, by] = undo(rawX, rawY);
        return { x: ax, y: ay, u: bx - ax, v: by - ay, zncc: p.zncc };
      })
      : fine.points;

    const stableIdx = [];
    for (let i = 0; i < fine.points.length; i += 1) {
      if (!stableRegion || stableRegion(fine.points[i].x, fine.points[i].y)) stableIdx.push(i);
    }
    const refit = fitTransformRobust(stableIdx.map((i) => fitPoints[i]), useHomography);
    if (!refit.transform) {
      frameSummaries.push({ ok: false, matched: fine.points.length });
      continue;
    }
    const res = residuals(refit.transform, fitPoints);


    for (let i = 0; i < fine.points.length; i += 1) {
      const p = fine.points[i];
      const b = bins.get(key(p.x, p.y)) ?? {
        x: p.x, y: p.y, n: 0, su: 0, sv: 0, suu: 0, svv: 0, zncc: [], illum: [], failed: 0,
      };
      b.n += 1;
      b.su += res[i].du;
      b.sv += res[i].dv;
      b.suu += res[i].du * res[i].du;
      b.svv += res[i].dv * res[i].dv;
      b.zncc.push(p.zncc);
      // 変位ぶんずらして読む。p.u/p.v は基準→ワープ後の実測変位
      b.illum.push(illuminationSpread(
        referenceA, warped.image, p.x, p.y, subsetHalf, p.u ?? 0, p.v ?? 0
      ));
      bins.set(key(p.x, p.y), b);
    }
    for (const c of fine.cells) {
      if (c.ok) continue;
      const b = bins.get(key(c.x, c.y)) ?? {
        x: c.x, y: c.y, n: 0, su: 0, sv: 0, suu: 0, svv: 0, zncc: [], illum: [], failed: 0,
      };
      b.failed += 1;
      if (c.zncc != null) b.zncc.push(c.zncc);
      bins.set(key(c.x, c.y), b);
    }

    frameSummaries.push({
      ok: true,
      matched: fine.points.length,
      rejected: fine.rejected,
      stableUsed: refit.inlierCount,
    });
  }

  const okFrames = frameSummaries.filter((f) => f.ok).length;
  if (!okFrames) {
    return { ok: false, reason: 'どのフレームでも基準画像と相関が取れませんでした', frames: frameSummaries };
  }

  const cells = [];
  const spreads = [];

  for (const b of bins.values()) {
    const zSorted = [...b.zncc].sort((a, c) => a - c);
    const znccMedian = zSorted.length ? zSorted[zSorted.length >> 1] : null;
    const evaluated = b.n + b.failed;

    // 相関低下: そのセルで半分以上のフレームが不成立、または相関の中央値が低い
    const decorrelated = evaluated > 0 && (
      b.failed / evaluated >= 0.5 || (znccMedian != null && znccMedian < minZNCC)
    );

    // 影の縁は時期ごとに位置が違うので、フレーム間で最悪値ではなく中央値を採る
    const iSorted = [...b.illum].sort((a2, c2) => a2 - c2);
    const illum = iSorted.length ? iSorted[iSorted.length >> 1] : 0;
    const illuminationChanged = illum > illuminationTolerance;

    let cell = {
      x: b.x, y: b.y, n: b.n, failed: b.failed,
      zncc: znccMedian,
      decorrelated,
      illum,
      illuminationChanged,
      du: null, dv: null, magnitudePx: null, sePx: null, significant: false,
    };

    if (b.n >= 2) {
      const du = b.su / b.n;
      const dv = b.sv / b.n;
      // 不偏分散。フレーム間のばらつき = その場の実測ノイズ
      const varU = Math.max(0, (b.suu - b.n * du * du) / (b.n - 1));
      const varV = Math.max(0, (b.svv - b.n * dv * dv) / (b.n - 1));
      const spread = Math.sqrt((varU + varV) / 2);
      spreads.push(spread);

      // 平均の標準誤差 + 基準画像自身のノイズ + 系統誤差の床
      //（後2者は全フレーム共通に乗るので、ばらつきからは見えない）
      const se = Math.sqrt(
        (varU + varV) / 2 / b.n
        + (Number.isFinite(sigmaAPx) ? sigmaAPx * sigmaAPx : 0)
        + systematicFloorPx * systematicFloorPx
      );
      const magnitude = Math.hypot(du, dv);

      cell = {
        ...cell,
        du, dv,
        magnitudePx: magnitude,
        sePx: se,
      };
    }

    cells.push(cell);
  }

  // 視差の補正。立ち位置がずれると、面から出っ張った部分だけが余分に動く。
  // 段階1のホモグラフィは平面しか合わせられないので、ここまでの残差には
  // それが残ったまま（5m・凹凸20mm・横20cm のずれで 0.54mm ＝ 限界の5倍）
  const parallaxSummary = parallax ? applyParallax(cells, parallax, { useHomography }) : null;

  // 有意判定。相関が切れかけのセル、影の縁をまたいだセルの変位は信用しない
  //（半端に掴んだ値が跳ねる）。視差を引いた分の推定誤差も限界に足す
  for (const c of cells) {
    if (c.du == null) continue;
    const se = Math.hypot(c.sePx, c.parallaxSePx ?? 0);
    c.limitPx = k * se;
    c.significant = !c.decorrelated && !c.illuminationChanged && se > 0 && c.magnitudePx > c.limitPx;
  }

  // 変質セルに隣接するセルの「変位」は信用しない。サブセット半径は測点間隔と
  // 同程度なので、隣のセルの窓は変質域に食い込んでおり、半端な値を掴んでいる
  const decorrelatedSet = new Set(
    cells.filter((c) => c.decorrelated || c.illuminationChanged).map((c) => `${c.x},${c.y}`)
  );
  for (const c of cells) {
    if (!c.significant) continue;
    for (let dy = -step; dy <= step; dy += step) {
      for (let dx = -step; dx <= step; dx += step) {
        if (decorrelatedSet.has(`${c.x + dx},${c.y + dy}`)) {
          c.significant = false;
          c.nearDecorrelated = true;
        }
      }
    }
  }

  cells.sort((a, c) => (a.y - c.y) || (a.x - c.x));
  spreads.sort((a, c) => a - c);

  const significantCells = cells.filter((c) => c.significant);
  const decorrelatedCells = cells.filter((c) => c.decorrelated);

  return {
    ok: true,
    k,
    step,
    cells,
    frames: frameSummaries,
    // 視差補正の顛末。効かせられなかったときも理由を持って返す（黙らない）
    parallax: parallaxSummary,
    // その場で実測された1セルの時期またぎノイズ（中央値）。
    // これがこの比較の「担保された精度」そのもの
    sigmaCrossPx: spreads.length ? spreads[spreads.length >> 1] : null,
    sigmaAPx: Number.isFinite(sigmaAPx) ? sigmaAPx : null,
    // 亀裂測点（crackline.js）が同じ床を敷けるように返す
    systematicFloorPx,
    stats: {
      evaluated: cells.length,
      significant: significantCells.length,
      decorrelated: decorrelatedCells.length,
      illuminationChanged: cells.filter((c) => c.illuminationChanged).length,
      parallaxCorrected: cells.filter((c) => c.parallaxCorrected).length,
      maxMagnitudePx: significantCells.length
        ? Math.max(...significantCells.map((c) => c.magnitudePx))
        : 0,
    },
  };
}

/**
 * 点群から視差を計算して差し引く。
 *
 * 効かせられないときは**理由を持って断る**。凹凸が画面の一部にしか無いと、
 * そこに載っているセルの大半が本物に動いたブロックだったときに、当てはめが
 * 本物を視差と誤って説明してしまう（合成検証で 1.0mm の本物を丸ごと消した）。
 */
function applyParallax(cells, config, { useHomography }) {
  const {
    camera, plane, intrinsics, heightAt, unitScaleToMM = 1000,
    // しきい値は合成検証から。凹凸が1ブロックだけの盤面が coverage 0.17〜0.19 /
    // spread 0.45〜0.48、全面がざらついた盤面が 1.0 近辺
    minCoverage = 0.4, minSpread = 0.6,
  } = config;
  if (!camera || !plane || !intrinsics || typeof heightAt !== 'function') {
    return { ok: false, reason: '視差の補正に必要な点群の情報が足りません' };
  }
  const geo = cellGeometry(cells, { camera, plane, intrinsics, heightAt, unitScaleToMM });
  const quality = leverageQuality(geo, cells);
  if (quality.coverage < minCoverage || quality.spread < minSpread) {
    return {
      ok: false,
      quality,
      reason: '凹凸が画面の一部に偏っているため、視差と本物の変位を分離できません',
    };
  }
  return { ...correctParallax(cells, geo, { useHomography }), quality };
}

/**
 * 有意セルを連結成分にまとめる。単発のセルではなく「まとまって動いた領域」を
 * 返す（面外マップの findBulges と同じ考え方）。
 */
export function groupSignificant(result, { minCells = 2, which = 'significant' } = {}) {
  const flag = which === 'decorrelated'
    ? (c) => c.decorrelated
    : (c) => c.significant;

  const byPos = new Map(result.cells.map((c) => [`${c.x},${c.y}`, c]));
  const seen = new Set();
  const groups = [];

  for (const c of result.cells) {
    if (!flag(c) || seen.has(`${c.x},${c.y}`)) continue;
    const stack = [c];
    seen.add(`${c.x},${c.y}`);
    const members = [];
    while (stack.length) {
      const cur = stack.pop();
      members.push(cur);
      // 8近傍。き裂は斜めに走るので、4近傍だと1本の線が数珠切れになる
      for (let dy = -result.step; dy <= result.step; dy += result.step) {
        for (let dx = -result.step; dx <= result.step; dx += result.step) {
          if (!dx && !dy) continue;
          const nb = byPos.get(`${cur.x + dx},${cur.y + dy}`);
          if (nb && flag(nb) && !seen.has(`${nb.x},${nb.y}`)) {
            seen.add(`${nb.x},${nb.y}`);
            stack.push(nb);
          }
        }
      }
    }
    if (members.length < minCells) continue;

    const moving = members.filter((m) => m.magnitudePx != null);
    // 縁のセルはサブセットが境界をまたぐため、変位が薄まって出る。
    // 領域の代表値は「8近傍が全部この領域」の内部セルから取る
    const memberSet = new Set(members.map((m) => `${m.x},${m.y}`));
    const interior = moving.filter((m) => {
      for (let dy = -result.step; dy <= result.step; dy += result.step) {
        for (let dx = -result.step; dx <= result.step; dx += result.step) {
          if (!dx && !dy) continue;
          if (!memberSet.has(`${m.x + dx},${m.y + dy}`)) return false;
        }
      }
      return true;
    });
    const core = interior.length ? interior : moving;
    groups.push({
      cellCount: members.length,
      interiorCount: interior.length,
      // 領域の代表変位（内部セル優先）
      du: core.length ? core.reduce((s, m) => s + m.du, 0) / core.length : null,
      dv: core.length ? core.reduce((s, m) => s + m.dv, 0) / core.length : null,
      bounds: {
        x0: Math.min(...members.map((m) => m.x)),
        y0: Math.min(...members.map((m) => m.y)),
        x1: Math.max(...members.map((m) => m.x)),
        y1: Math.max(...members.map((m) => m.y)),
      },
    });
  }

  groups.sort((a, b) => b.cellCount - a.cellCount);
  return groups;
}
