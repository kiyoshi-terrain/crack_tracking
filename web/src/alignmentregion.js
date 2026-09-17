// DIC基準領域は基準画像の画素座標で保存する。解析範囲とは別の設定。
export function imagePoint(clientX, clientY, bounds, width, height) {
  if (!(bounds.width > 0 && bounds.height > 0)) return null;
  return {
    x: Math.max(0, Math.min(width, (clientX - bounds.left) * width / bounds.width)),
    y: Math.max(0, Math.min(height, (clientY - bounds.top) * height / bounds.height)),
  };
}

export function rectangleFromDrag(a, b, width, height) {
  const x = Math.max(0, Math.min(width, Math.min(a.x, b.x)));
  const y = Math.max(0, Math.min(height, Math.min(a.y, b.y)));
  const right = Math.max(0, Math.min(width, Math.max(a.x, b.x)));
  const bottom = Math.max(0, Math.min(height, Math.max(a.y, b.y)));
  if (right - x < 2 || bottom - y < 2) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function validAlignment(value, width, height) {
  if (!value || value.version !== 1 || value.width !== width || value.height !== height) return null;
  const r = value.roi;
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)
    || r.x < 0 || r.y < 0 || r.width < 2 || r.height < 2
    || r.x + r.width > width || r.y + r.height > height) return null;
  return { version: 1, width, height, roi: { x: r.x, y: r.y, width: r.width, height: r.height } };
}

export function alignmentPredicate(setting) {
  const r = setting.roi;
  return (x, y) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}
