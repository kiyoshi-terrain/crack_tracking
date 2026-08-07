/**
 * 点群から得た平面を、写真の mm/px に橋渡しする。
 *
 * これが「良いとこどり」の接点です。
 *
 * - 点群は面内の計測には粗すぎるが、**実寸の平面**を持っている
 * - 写真は面内が 2桁精度で強いが、**スケールを自前で決められない**
 *
 * 平面を写真に渡すと、レーザー距離計も焦点距離の手入力も要らなくなり、
 * さらに斜め撮影で mm/px が方向ごとに違う問題を**近似なしで**扱えます。
 * （画素の四隅を平面に飛ばして実際の交点距離を測るだけなので、
 *   cosθ の一次近似ではなく厳密解になります）
 *
 * ## 前提と、その誤差
 *
 * 点群と写真の厳密な位置合わせはしません。代わりに
 * **「スキャンを開始した位置から写真を撮る」** という撮影手順を前提にします。
 * Scaniverse の座標原点はスキャン開始地点なので、これで視点が決まります。
 *
 * 立ち位置が D=10m に対して 0.3m ずれた場合、スケール誤差は 3%。
 * 追跡計測（変化量）ではこれは変化量の 3% にしか効かない
 * （0.10mm の開きに対して 0.003mm）ので実質無視できます。
 * 絶対幅を出すときだけ 3% が効くので、そこは明示します。
 */

import { signedDistance } from './pointcloud.js';

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

/**
 * 平面と点群の重心からカメラ姿勢を組み立てる。
 *
 * 光軸は「視点 → 見ている面の重心」。スキャンした壁を撮っている以上、
 * これが最も素直な仮定です。ロール（画像の傾き）は世界の上方向に合わせます。
 *
 * @param {object} plane fitWallPlane の戻り値
 * @param {number[]} lookAt 注視点（点群の重心を渡す）
 * @param {{worldUp?: number[]}} options
 */
export function cameraFromPlane(plane, lookAt, { worldUp = [0, 0, 1] } = {}) {
  const eye = plane.viewpoint || [0, 0, 0];
  const forward = normalize(sub(lookAt, eye));

  let up = worldUp;
  if (Math.abs(dot(forward, normalize(up))) > 0.99) up = [1, 0, 0];

  // 画像系（X=右, Y=下, Z=前方）。CrackCore と同じ約束にしてある。
  const right = normalize(cross(forward, up));
  const down = cross(forward, right);

  return { eye, forward, right, down };
}

/**
 * 画素座標から世界のレイ方向を作る。
 * @param {object} camera cameraFromPlane の戻り値
 * @param {{focalLengthPx: number, cx: number, cy: number}} intrinsics
 */
export function rayThroughPixel(camera, intrinsics, px, py) {
  const { focalLengthPx: f, cx, cy } = intrinsics;
  const a = (px - cx) / f;
  const b = (py - cy) / f;
  const d = [
    camera.forward[0] + a * camera.right[0] + b * camera.down[0],
    camera.forward[1] + a * camera.right[1] + b * camera.down[1],
    camera.forward[2] + a * camera.right[2] + b * camera.down[2],
  ];
  return normalize(d);
}

/**
 * レイと平面の交点。面の裏側・平行なら null。
 */
export function intersectPlane(plane, origin, direction) {
  const denom = dot(plane.normal, direction);
  if (Math.abs(denom) < 1e-9) return null;
  const t = -(dot(plane.normal, origin) + plane.offset) / denom;
  if (!(t > 0)) return null;
  return {
    point: [origin[0] + t * direction[0], origin[1] + t * direction[1], origin[2] + t * direction[2]],
    distance: t,
  };
}

/**
 * ある画素における mm/px を求める。
 *
 * 隣の画素を実際に平面へ飛ばして交点間の距離を測るので、
 * 斜め撮影による異方性（横は縮み、縦はそのまま、など）が近似なしに出ます。
 *
 * @param {object} camera
 * @param {object} plane
 * @param {object} intrinsics {focalLengthPx, cx, cy}
 * @param {number} px
 * @param {number} py
 * @param {number} unitScaleToMM 点群の単位 → mm（メートルなら 1000）
 */
export function pixelScale(camera, plane, intrinsics, px, py, unitScaleToMM = 1000) {
  const centre = intersectPlane(plane, camera.eye, rayThroughPixel(camera, intrinsics, px, py));
  const rightHit = intersectPlane(plane, camera.eye, rayThroughPixel(camera, intrinsics, px + 1, py));
  const downHit = intersectPlane(plane, camera.eye, rayThroughPixel(camera, intrinsics, px, py + 1));
  if (!centre || !rightHit || !downHit) return null;

  const dx = Math.hypot(
    rightHit.point[0] - centre.point[0],
    rightHit.point[1] - centre.point[1],
    rightHit.point[2] - centre.point[2]
  );
  const dy = Math.hypot(
    downHit.point[0] - centre.point[0],
    downHit.point[1] - centre.point[1],
    downHit.point[2] - centre.point[2]
  );

  const ray = rayThroughPixel(camera, intrinsics, px, py);
  // 法線は視点側を向けてあるので、正対なら ray·n = -1
  const cosTheta = Math.min(1, Math.abs(dot(ray, plane.normal)));

  return {
    mmPerPxX: dx * unitScaleToMM,
    mmPerPxY: dy * unitScaleToMM,
    // 等方でない場合に「最悪側」を代表値にする。分解能の主張は悪い方で言う。
    mmPerPx: Math.max(dx, dy) * unitScaleToMM,
    distanceMM: centre.distance * unitScaleToMM,
    obliquityDeg: (Math.acos(cosTheta) * 180) / Math.PI,
    worldPoint: centre.point,
  };
}

/**
 * 画像全体の mm/px を要約する。
 *
 * 斜めに構えていると画面の端と端で mm/px が変わります。その比を出しておくと、
 * 「この写真1枚を一定スケールとして扱ってよいか」がその場で判断できます。
 */
export function frameScaleSummary(camera, plane, intrinsics, width, height, unitScaleToMM = 1000) {
  const samples = [];
  for (const fy of [0.1, 0.5, 0.9]) {
    for (const fx of [0.1, 0.5, 0.9]) {
      const s = pixelScale(camera, plane, intrinsics, fx * width, fy * height, unitScaleToMM);
      if (s) samples.push(s);
    }
  }
  if (!samples.length) return null;

  const values = samples.map((s) => s.mmPerPx);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const centre = pixelScale(camera, plane, intrinsics, width / 2, height / 2, unitScaleToMM);

  return {
    centre,
    minMMPerPx: min,
    maxMMPerPx: max,
    // 1.0 なら画面内で一定。1.1 を超えると端と中央で 10% 違う
    variation: max / min,
    obliquityDeg: centre ? centre.obliquityDeg : null,
    anisotropy: centre ? Math.max(centre.mmPerPxX, centre.mmPerPxY) / Math.min(centre.mmPerPxX, centre.mmPerPxY) : null,
  };
}

/**
 * 面外のはらみ出しと、面内のき裂の開きを突き合わせて剥落リスクを出す。
 *
 * どちらか片方だけでは判断材料にならない。
 * - 開いているが動いていない → まだ様子見でよい
 * - 出ているが開いていない → 元からの不陸かもしれない
 * - **両方 → 抜け落ちる経路が揃っている**
 *
 * しきい値は現場ごとに決めるものなので既定値を持たせません。
 *
 * @param {{openingMM: number|null, limitMM: number|null}} inPlane 写真から
 * @param {{bulgeMM: number|null, noiseMM: number|null}} outOfPlane 点群から
 */
export function spallingRisk(inPlane, outOfPlane) {
  const opening = inPlane?.openingMM ?? null;
  const limit = inPlane?.limitMM ?? null;
  const bulge = outOfPlane?.bulgeMM ?? null;
  const noise = outOfPlane?.noiseMM ?? null;

  const openingSignificant = opening != null && limit != null && Math.abs(opening) > limit;
  const bulgeSignificant = bulge != null && noise != null && bulge > 3 * noise;

  let level = 'unknown';
  let reason = '';

  if (opening == null && bulge == null) {
    level = 'unknown';
    reason = '面内・面外とも計測がありません';
  } else if (openingSignificant && bulgeSignificant) {
    level = 'high';
    reason = 'き裂が有意に開いており、かつ面外にはらみ出しています';
  } else if (openingSignificant) {
    level = 'watch';
    reason = 'き裂は有意に開いていますが、面外の変位は検出限界内です';
  } else if (bulgeSignificant) {
    level = 'watch';
    reason = '面外にはらみ出していますが、き裂の開きは有意ではありません';
  } else {
    level = 'low';
    reason = '面内・面外とも検出限界を超える変化はありません';
  }

  return {
    level,
    reason,
    openingSignificant,
    bulgeSignificant,
    // 判断の根拠を必ず一緒に返す。数字を見ずに level だけ使われるのを防ぐため。
    evidence: { openingMM: opening, limitMM: limit, bulgeMM: bulge, noiseMM: noise },
  };
}

export { signedDistance };
