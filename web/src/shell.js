/**
 * カメラ風シェル。
 *
 * 画面の作りだけを持ちます。計測も判定も一切やりません。
 * ビューファインダーを常に見せておいて、各機能はシートとして手前に出す、
 * という Blackmagic Camera 型の構成です。現場で片手・一瞥で使うため。
 *
 * ## なぜスクロールを捨てたか
 *
 * 縦に積むと「今どこを見ているか」が分からなくなり、
 * 撮り直すべき状況（ピントが甘い・模様が無い・斜めすぎる）に気づくのが
 * 現場を離れた後になります。数値を常時 HUD に出し、
 * 詳細だけをシートに追い出すことで、判断に必要な情報が常に画面にあります。
 */

const $ = (id) => document.getElementById(id);

// レール項目 → シート
const SHEETS = {
  photo: 'step1',
  scale: 'step2',
  cloud: 'stepCloud',
  analyze: 'step3',
  history: 'stepHistory',
  result: 'results',
};

let openId = null;

export function initShell() {
  document.querySelectorAll('[data-sheet]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      toggleSheet(el.dataset.sheet);
    });
  });

  document.querySelectorAll('[data-close-sheet]').forEach((el) => {
    el.addEventListener('click', () => closeSheet());
  });

  $('sheetBackdrop').addEventListener('click', () => closeSheet());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openId) closeSheet();
  });

  // 画面の向きが変わるとビューファインダーの実寸が変わる。
  // ROI の枠は実寸基準で置いているので、置き直しの合図を出す
  window.addEventListener('resize', () => {
    window.dispatchEvent(new CustomEvent('shell:resize'));
  });
}

export function openSheet(name) {
  const id = SHEETS[name];
  if (!id) return;
  openId = name;
  document.body.classList.add('sheet-open');
  Object.entries(SHEETS).forEach(([key, sectionId]) => {
    $(sectionId).classList.toggle('sheet-active', key === name);
  });
  document.querySelectorAll('[data-sheet]').forEach((el) => {
    el.classList.toggle('on', el.dataset.sheet === name);
  });
  $(id).scrollTop = 0;
}

export function closeSheet() {
  openId = null;
  document.body.classList.remove('sheet-open');
  Object.values(SHEETS).forEach((sectionId) => $(sectionId).classList.remove('sheet-active'));
  document.querySelectorAll('[data-sheet]').forEach((el) => el.classList.remove('on'));
}

function toggleSheet(name) {
  if (openId === name) closeSheet(); else openSheet(name);
}

/**
 * HUD の数値を書き換える。
 *
 * 値が無いところは「—」。空欄にすると項目ごと消えて、
 * 何が測れていないのかが分からなくなります。
 */
export function updateHud(v = {}) {
  setHud('hudFrames', v.frames ? String(v.frames) : '0', v.frames >= 2 ? 'ok' : 'idle');
  setHud('hudGsd', v.gsd ? v.gsd.toFixed(4) : '—', v.gsd ? 'ok' : 'idle');
  setHud('hudDistance', v.distanceM ? `${v.distanceM.toFixed(2)}` : '—', v.distanceM ? 'ok' : 'idle');
  setHud('hudOblique', v.obliquityDeg != null ? `${v.obliquityDeg.toFixed(0)}°` : '—',
    v.obliquityDeg == null ? 'idle' : v.obliquityDeg > 30 ? 'warn' : 'ok');
  setHud('hudLimit', v.limitMM != null ? v.limitMM.toFixed(4)
    : (v.limitPx != null ? v.limitPx.toFixed(3) : '—'),
    v.limitMM != null || v.limitPx != null ? 'ok' : 'idle');
  const limitUnit = $('hudLimitUnit');
  if (limitUnit) limitUnit.textContent = v.limitMM != null ? 'mm' : (v.limitPx != null ? 'px' : '');


  // 主動作の可否
  const run = $('run');
  if (run) run.disabled = !(v.frames >= 2);
}

function setHud(id, text, state) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.parentElement.dataset.state = state;
}

/** ビューファインダー中央に出す一言。撮り直しの判断に効くものだけ。 */
export function setViewfinderHint(text, kind = 'info') {
  const el = $('vfHint');
  if (!el) return;
  el.textContent = text ?? '';
  el.dataset.kind = kind;
  el.classList.toggle('hidden', !text);
}
