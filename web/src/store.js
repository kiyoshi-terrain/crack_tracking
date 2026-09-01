/**
 * 基準セットの保存（IndexedDB）。
 *
 * これまで比較モードは「前回の連写フォルダを毎回手で読み込む」運用だった。
 * 画像を localStorage に入れると容量が破綻するため保存を諦めていたが、
 * IndexedDB なら数十MBの Blob を素直に持てる。
 * 保存しておけば、次回は測点を選ぶだけで前回との比較ができる。
 *
 * 保存するのは JPEG の Blob（フル解像度）とメタ情報だけ。
 * 判定に使う数値はすべて読み出し後に計算し直す（保存形式に精度を依存させない）。
 */

const DB_NAME = 'crack-tracking';
const STORE = 'baselines';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けませんでした'));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB の操作に失敗しました'));
  });
}

/**
 * 基準セットを保存する。同名は上書き。
 * @param {string} name 測点名
 * @param {Blob[]} frames JPEG の Blob（1枚目が基準）
 * @param {object} meta {gsd, focal35, distanceM, note, capturedAt} など再現に要る値
 */
export async function saveBaseline(name, frames, meta = {}) {
  if (!name) throw new Error('測点名を入れてください');
  if (!frames?.length) throw new Error('保存する写真がありません');
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put({
    name,
    savedAt: new Date().toISOString(),
    count: frames.length,
    frames,
    meta,
  });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error('保存に失敗しました')); };
  });
}

/** 保存済みの一覧（Blob は含まない）。新しい順。 */
export async function listBaselines() {
  const db = await openDB();
  const rows = await requestToPromise(
    db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
  );
  db.close();
  return rows
    .map(({ name, savedAt, count, meta }) => ({ name, savedAt, count, meta }))
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

/** 1件読み出す。無ければ null。 */
export async function getBaseline(name) {
  const db = await openDB();
  const row = await requestToPromise(
    db.transaction(STORE, 'readonly').objectStore(STORE).get(name)
  );
  db.close();
  return row ?? null;
}

export async function deleteBaseline(name) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(name);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error('削除に失敗しました')); };
  });
}

/** ImageData を JPEG Blob にする（保存用）。 */
export function imageDataToBlob(imageData, quality = 0.9) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('JPEG 化に失敗しました'))),
      'image/jpeg', quality);
  });
}
