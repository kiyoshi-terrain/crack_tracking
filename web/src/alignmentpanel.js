import { imagePoint, rectangleFromDrag, validAlignment } from './alignmentregion.js';

// 専用キャンバス。縮小プレビューを保持し、保存座標は常に元の基準画像に戻す。
export function createAlignmentEditor({ canvas, editButton, clearButton, info, onChange }) {
  let thumb = null, width = 0, height = 0, roi = null, measurementRoi = null, cracks = [];
  let editing = false, busy = false, drag = null, diagnostics = null;
  const point = (e) => imagePoint(e.clientX, e.clientY, canvas.getBoundingClientRect(), width, height);
  const settings = () => roi ? { version: 1, width, height, roi: { ...roi } } : null;
  function draw() {
    if (!thumb) return;
    const ctx = canvas.getContext('2d'), sx = canvas.width / width, sy = canvas.height / height;
    ctx.drawImage(thumb, 0, 0);
    const box = (r, color, dash = []) => {
      if (!r) return;
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash);
      ctx.strokeRect(r.x * sx, r.y * sy, r.width * sx, r.height * sy);
      ctx.setLineDash([]);
    };
    box(measurementRoi, '#ffb454', [6, 5]);
    for (const c of cracks) {
      ctx.strokeStyle = '#ffb454'; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(c.x1 * sx, c.y1 * sy); ctx.lineTo(c.x2 * sx, c.y2 * sy); ctx.stroke();
    }
    box(drag?.rect ?? roi, '#55c6ff');
    for (const p of diagnostics?.points ?? []) {
      ctx.beginPath(); ctx.fillStyle = p.status === 'check' ? '#d8a0ff' : p.status === 'used' ? '#70f080' : p.status === 'outlier' ? '#ff7d58' : p.status === 'matched' ? '#ffd166' : '#aaaaaa';
      ctx.arc(p.x * sx, p.y * sy, p.status === 'used' ? 3 : 2, 0, Math.PI * 2); ctx.fill();
    }
  }
  function controls(message = '') {
    editButton.disabled = busy || !thumb;
    clearButton.disabled = busy || !roi;
    editButton.textContent = editing ? '枠の描画を終了' : '青い基準枠を描く';
    editButton.setAttribute('aria-pressed', String(editing));
    canvas.style.touchAction = editing && !busy ? 'none' : 'pan-y';
    canvas.style.cursor = editing ? 'crosshair' : 'default';
    info.textContent = message || (roi
      ? `基準枠：幅 ${Math.round(roi.width)} × 高さ ${Math.round(roi.height)} px（元画像）。${editing ? 'ドラッグで描き直せます。' : ''}`
      : 'DIC基準領域は未指定です。「青い基準枠を描く」を押し、基準写真上をドラッグしてください。');
  }
  editButton.addEventListener('click', () => { editing = !editing; drag = null; controls(); draw(); });
  clearButton.addEventListener('click', () => { roi = null; drag = null; diagnostics = null; controls(); draw(); onChange(); });
  canvas.addEventListener('pointerdown', (e) => {
    if (!editing || busy || !thumb || drag || (e.button != null && e.button !== 0)) return;
    const start = point(e); if (!start) return;
    drag = { start, id: e.pointerId, rect: null };
    canvas.setPointerCapture?.(e.pointerId); e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const end = point(e); if (!end) return;
    drag.rect = rectangleFromDrag(drag.start, end, width, height); draw(); e.preventDefault();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const end = point(e), next = end && rectangleFromDrag(drag.start, end, width, height);
    drag = null;
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (next) { roi = next; diagnostics = null; editing = false; onChange(); }
    controls(next ? '' : '枠が小さすぎます。面積のある範囲をドラッグしてください。'); draw();
  });
  const cancel = (e) => { if (drag?.id === e.pointerId) { drag = null; draw(); } };
  canvas.addEventListener('pointercancel', cancel); canvas.addEventListener('lostpointercapture', cancel);
  controls();
  return {
    settings,
    setImage(image, meta = {}) {
      width = image.width; height = image.height;
      const factor = Math.min(1, 1000 / width);
      canvas.width = Math.round(width * factor); canvas.height = Math.round(height * factor);
      const full = new OffscreenCanvas(width, height); full.getContext('2d').putImageData(image, 0, 0);
      thumb = new OffscreenCanvas(canvas.width, canvas.height);
      thumb.getContext('2d').drawImage(full, 0, 0, canvas.width, canvas.height);
      full.width = 1; full.height = 1;
      const restored = validAlignment(meta.alignment, width, height);
      roi = restored?.roi ?? null; measurementRoi = meta.roi ?? null; cracks = meta.cracks ?? [];
      editing = false; drag = null; diagnostics = null; canvas.classList.remove('hidden'); draw();
      controls(meta.alignment && !restored ? '保存枠の座標・画像寸法が一致しません。青い基準枠を描き直してください。' : '');
    },
    reset() { thumb = null; roi = null; drag = null; diagnostics = null; editing = false; canvas.classList.add('hidden'); controls(); },
    setBusy(value) { busy = value; if (busy) { editing = false; drag = null; } controls(); draw(); },
    setDiagnostics(value) { diagnostics = value; draw(); },
  };
}
