// 再撮影の初期探索と、フィットに使わない点による位置合わせ検査。
// 許容値は画像上の品質ゲートであり、現場でのmm精度保証ではない。
import { applyHomography, applyAffine } from './transform.js';

// 壁の明暗勾配だけで高相関になる誤照合を避け、局所的な模様を探す。
function localTexture(image) {
  const { width: w, height: h, data } = image, pitch = w + 1;
  const integral = new Float64Array(pitch * (h + 1)), out = new Float32Array(w * h);
  for (let y=0;y<h;y++) { let row=0; for(let x=0;x<w;x++) { row+=data[y*w+x]; integral[(y+1)*pitch+x+1]=integral[y*pitch+x+1]+row; } }
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const x0=Math.max(0,x-4),x1=Math.min(w,x+5),y0=Math.max(0,y-4),y1=Math.min(h,y+5);
    const sum=integral[y1*pitch+x1]-integral[y0*pitch+x1]-integral[y1*pitch+x0]+integral[y0*pitch+x0];
    out[y*w+x]=data[y*w+x]-sum/((x1-x0)*(y1-y0));
  }
  return { width:w,height:h,data:out };
}

export function searchReferenceRegion(reference, target, roi, downsample) {
  if (!roi || ![roi.x, roi.y, roi.width, roi.height].every(Number.isFinite)
    || roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0
    || roi.x + roi.width > reference.width || roi.y + roi.height > reference.height)
    return { ok: false, reason: '基準枠の座標が不正です' };
  const factor = Math.max(1, Math.ceil(Math.max(reference.width, reference.height) / 320));
  const a = localTexture(downsample(reference, factor)), b = localTexture(downsample(target, factor));
  const x0 = Math.ceil(roi.x / factor), y0 = Math.ceil(roi.y / factor);
  const w = Math.floor((roi.x + roi.width) / factor) - x0;
  const h = Math.floor((roi.y + roi.height) / factor) - y0;
  if (w < 8 || h < 8) return { ok: false, reason: '基準枠が小さく広域探索できません' };
  const stride = Math.max(1, Math.ceil(Math.sqrt(w * h / 900)));
  const samples = [];
  let sum = 0, sq = 0;
  for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) {
    const v = a.data[(y0 + y) * a.width + x0 + x];
    samples.push({ x, y, v }); sum += v; sq += v * v;
  }
  const n = samples.length, variance = sq - sum * sum / n;
  if (!(variance / n > 1e-8)) return { ok: false, reason: '基準枠の模様が不足しています' };
  const scores = []; let best = null;
  // 枠全体が入る位置だけを探索。範囲外の画素を端で複製しない。
  for (let y = 0; y <= b.height - h; y++) for (let x = 0; x <= b.width - w; x++) {
    let sb = 0, bb = 0, ab = 0;
    for (const p of samples) {
      const v = b.data[(y + p.y) * b.width + x + p.x]; sb += v; bb += v * v; ab += p.v * v;
    }
    const den = Math.sqrt(variance * Math.max(0, bb - sb * sb / n));
    const score = den > 1e-12 ? (ab - sum * sb / n) / den : -1;
    const candidate = { x, y, score }; scores.push(candidate);
    if (!best || score > best.score) best = candidate;
  }
  if (!best) return { ok: false, reason: '基準枠が今回写真に収まりません' };
  const second = scores.filter(p => Math.hypot(p.x - best.x, p.y - best.y) > 4)
    .reduce((m, p) => Math.max(m, p.score), -1);
  const result = { dx: (best.x - x0) * factor, dy: (best.y - y0) * factor,
    score: best.score, ambiguity: best.score - second, factor };
  return { ...result, ok: best.score >= 0.65 && result.ambiguity >= 0.04,
    reason: best.score < 0.65 ? '基準枠の広域照合が弱い（構図・模様・照明を確認）'
      : result.ambiguity < 0.04 ? '似た模様が複数あり初期位置を特定できません' : '' };
}

export function splitRegistrationPoints(points, step) {
  const train = [], check = [];
  for (const p of points) {
    // 格子上で分散させ、順序や欠測数で検査点の場所が変わらないようにする。
    const bucket = ((Math.round(p.x / step) + 2 * Math.round(p.y / step)) % 3 + 3) % 3;
    (bucket === 0 ? check : train).push(p);
  }
  return { train, check };
}

export function registrationQuality(train, check, transform, homography, { maxErrorPx = 1, minSpanPx = 40 } = {}) {
  const fail = (reason, extra = {}) => ({ ok: false, reason, checkCount: check.length, ...extra });
  if (!transform || train.length < 12 || check.length < 6) return fail('基準点または独立検査点が不足');
  const spread = (pts) => {
    const mx = pts.reduce((s,p)=>s+p.x,0)/pts.length, my = pts.reduce((s,p)=>s+p.y,0)/pts.length;
    let xx=0,yy=0,xy=0;
    for(const p of pts){xx+=(p.x-mx)**2;yy+=(p.y-my)**2;xy+=(p.x-mx)*(p.y-my);}
    const minor=(xx+yy-Math.hypot(xx-yy,2*xy))/2/pts.length;
    return Math.sqrt(Math.max(0,minor));
  };
  if (spread(train) < minSpanPx || spread(check) < minSpanPx) return fail('基準点・検査点が狭い範囲や一直線に偏っています');
  const apply = homography ? applyHomography : applyAffine;
  const errors = check.map(p=>{const [x,y]=apply(transform,p.x,p.y);return Math.hypot(p.x+p.u-x,p.y+p.v-y);});
  if (!errors.every(Number.isFinite)) return fail('位置合わせの変換が不正です');
  const sorted = [...errors].sort((a,b)=>a-b), p90=sorted[Math.ceil(sorted.length*0.9)-1];
  const rms = Math.sqrt(errors.reduce((s,v)=>s+v*v,0)/errors.length);
  return { ok: p90 <= maxErrorPx, reason: p90 <= maxErrorPx ? '' : '独立検査点の残差が許容値を超過',
    checkCount: check.length, rmsPx: rms, p90Px: p90, maxErrorPx };
}
