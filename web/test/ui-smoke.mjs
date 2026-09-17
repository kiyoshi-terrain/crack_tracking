// 任意のDOMスモーク試験。実Safari/Chromeの代わりにはならない。
// CRACK_UI_DEPS に任意依存をインストールしたディレクトリを指定（README参照）。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { delimiter } from 'node:path';
const require = createRequire(import.meta.url);
const dependency = (name) => pathToFileURL(require.resolve(name, {
  paths: process.env.CRACK_UI_DEPS?.split(delimiter),
})).href;
const { Window } = await import(dependency('happy-dom'));
const { indexedDB } = await import(dependency('fake-indexeddb'));
globalThis.indexedDB = indexedDB;
const NativeBlob = globalThis.Blob;
import { readFileSync } from 'node:fs';
const w = new Window({url:'http://localhost:8080',settings:{disableJavaScriptFileLoading:true,disableJavaScriptEvaluation:true,disableCSSFileLoading:true}});
w.document.write(readFileSync(new URL('../index.html', import.meta.url),'utf8'));
for(const k of ['window','document','navigator','localStorage','sessionStorage','HTMLElement','HTMLCanvasElement','ImageData','Image','Event','CustomEvent','ResizeObserver','requestAnimationFrame','cancelAnimationFrame','matchMedia','getComputedStyle']){
 const v=k==='window'?w:w[k];if(v!==undefined)Object.defineProperty(globalThis,k,{value:typeof v==='function'&&['requestAnimationFrame','cancelAnimationFrame','matchMedia','getComputedStyle'].includes(k)?v.bind(w):v,configurable:true});
}
const { createCanvas, loadImage, ImageData: NativeImageData } = await import(dependency('@napi-rs/canvas'));
globalThis.OffscreenCanvas = function(w,h){ return createCanvas(w,h); };
Object.defineProperty(globalThis,"ImageData",{value:NativeImageData,configurable:true});
globalThis.createImageBitmap = async (f) => {const im = await loadImage(Buffer.from(await f.arrayBuffer())); im.close=()=>{};return im;};
URL.createObjectURL=()=> 'blob:mock';URL.revokeObjectURL=()=>{};
const canvases=new WeakMap();
w.HTMLCanvasElement.prototype.getContext=function(type){
 let c=canvases.get(this);if(!c||c.width!==this.width||c.height!==this.height){c=createCanvas(this.width||300,this.height||150);canvases.set(this,c);}
 const ctx=c.getContext(type);return new Proxy(ctx,{get(t,k){if(k==='drawImage')return(im,...args)=>t.drawImage(canvases.get(im)||im,...args);const v=t[k];return typeof v==='function'?v.bind(t):v;},set(t,k,v){t[k]=v;return true;}});
};
await import('../src/app.js');
console.log('app imported',w.__JS_VERSION);
for(const id of ['compareStable','compareReferenceGsd','referenceLength','referencePair']){
 w.document.getElementById(id).dispatchEvent(new w.Event('input'));
 console.log('input handled',id);
}
const $=(id)=>w.document.getElementById(id);
const png=createCanvas(480,480), ctx=png.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,480,480);ctx.fillStyle='black';
for(const [x,y] of [[140,140],[140,320],[320,140]]){ctx.beginPath();ctx.arc(x,y,10,0,Math.PI*2);ctx.fill();}
const files=[0,1,2].map(i=>new w.File([png.toBuffer('image/png')],`frame${i}.png`,{type:'image/png'}));
Object.defineProperty($('fileInput'),'files',{value:files,configurable:true});$('fileInput').dispatchEvent(new w.Event('change'));
const waitFor=async(fn)=>{for(let i=0;i<1200;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('timed out');};
await waitFor(()=>w.document.querySelectorAll('#thumbs .thumb').length===3);
$('method').value='targets';$('run').click();
await waitFor(()=>w.document.querySelectorAll('[data-target-id]').length===3);
for(let i=0;i<3;i++){
 const id=w.document.querySelector(`[data-target-id="${i}"]`);id.value=`T${i+1}`;id.dispatchEvent(new w.Event('input'));
 const member=w.document.querySelector(`[data-target-member="${i}"]`);member.value=i<2?'石A':'石B';member.dispatchEvent(new w.Event('input'));
}
$('referencePair').value='0-1';$('referenceLength').value='180';$('referencePair').dispatchEvent(new w.Event('change'));
console.log('calibrated:', $('targetCalibrated').textContent);
console.log('history:', $('obsValueSource').textContent);
if($('obsValueSource').options.length!==3)throw Error('missing two measurement pairs');
$('run').click();await waitFor(()=>!$('run').disabled);
if($('referencePair').value!=='0-1')throw Error('scale selection lost');
console.log('rerun preserved scale and IDs');
w.document.getElementById('clearBtn').click();
if($('obsValueSource').options.length!==1)throw Error('stale history after clear');
console.log('clear handled');

// 専用基準領域を描き、同じ基準セットへの保存と再読込みを通す。
const {saveBaseline, getBaseline, updateBaselineAlignment} = await import('../src/store.js');
const {refreshSavedBaselines} = await import('../src/comparepanel.js');
const meta = {gsd:0.5, roi:{x:96,y:96,width:288,height:288},
 cracks:[{label:'C1', x1:240,y1:70,x2:240,y2:410}]};
const data = png.toBuffer('image/png');
await saveBaseline('UI基準', [new NativeBlob([data],{type:'image/png'}),new NativeBlob([data],{type:'image/png'})], meta);
const before = await getBaseline('UI基準');
await refreshSavedBaselines();$('compareSaved').value='UI基準';$('compareUseSaved').click();
await waitFor(()=>!$('compareAlignmentCanvas').classList.contains('hidden')&&!$('compareRun').disabled);
if(!$('compareAlignmentInfo').textContent.includes('未指定'))throw Error('旧ROIが基準枠に転用された');
const cv=$('compareAlignmentCanvas');
cv.getBoundingClientRect=()=>({left:10,top:20,width:240,height:240});
const pointer=(type,x,y,id=1)=>cv.dispatchEvent(new w.PointerEvent(type,{clientX:x,clientY:y,pointerId:id,button:0,bubbles:true}));
$('compareAlignmentEdit').click();pointer('pointerdown',20,30);pointer('pointermove',110,245);pointer('pointerup',110,245);
if(!$('compareAlignmentInfo').textContent.includes('幅 180 × 高さ 430'))throw Error('元画像座標への変換不良');
$('compareAlignmentSave').click();await waitFor(()=>$('compareAlignmentSaveInfo').textContent.includes('基準枠を保存しました'));
const after=await getBaseline('UI基準');
if(after.meta.alignment.roi.x!==20||after.meta.alignment.roi.width!==180)throw Error('枠の保存不良');
if(JSON.stringify(after.meta.roi)!==JSON.stringify(meta.roi)||JSON.stringify(after.meta.cracks)!==JSON.stringify(meta.cracks)||after.meta.gsd!==0.5||before.savedAt!==after.savedAt)throw Error('他の基準メタ情報が変化');
if(Buffer.compare(Buffer.from(await after.frames[0].arrayBuffer()),data))throw Error('保存写真が変化');
$('compareAlignmentClear').click();
if(!$('compareAlignmentInfo').textContent.includes('未指定'))throw Error('枠消去失敗');
$('compareUseSaved').click();await waitFor(()=>$('compareAlignmentInfo').textContent.includes('幅 180 × 高さ 430'));
$('compareAlignmentEdit').click();pointer('pointerdown',30,40);pointer('pointermove',180,220);pointer('pointercancel',180,220);
if(!$('compareAlignmentInfo').textContent.includes('幅 180 × 高さ 430'))throw Error('中断で既存枠を破壊');
$('compareAlignmentEdit').click();
let conflict=false;
try{await updateBaselineAlignment('UI基準',null,before.savedAt,null);}catch{conflict=true;}
if(!conflict)throw Error('古い枠からの更新を許可');
console.log('独立した基準枠: 描画、保存、再読込み、ドラッグ中断、原画像保持、更新競合拒否を確認');
// 空白面では基準点を得られない。失敗時にも表と基準写真を表示する。
const input=$('fileInput');Object.defineProperty(input,'files',{value:files,configurable:true});input.dispatchEvent(new w.Event('change'));
await waitFor(()=>w.document.querySelectorAll('#thumbs .thumb').length===3);
$('compareRun').click();await waitFor(()=>!$('compareRun').disabled);
if($('compareAlignmentResult').classList.contains('hidden')||!$('compareAlignmentCounts').textContent.includes('不'))throw Error('不成立の対応点診断がない');
$('compareAlignmentFrame').value='1';$('compareAlignmentFrame').dispatchEvent(new w.Event('change'));
$('clearBtn').click();
if(!$('compareAlignmentResult').classList.contains('hidden')||!$('compareCanvas').classList.contains('hidden'))throw Error('写真変更後に古い比較が残る');
console.log('不成立時の診断と写真変更後の結果破棄を確認');
// 模様がある同一写真の比較を通し、両段階の採用点と結果図を確認する。
const {makeBlobs, renderBlobs}=await import('./synthetic.mjs');
const texture=renderBlobs(makeBlobs({width:480,height:480,count:2300,seed:83}),480,480);
const pixels=ctx.createImageData(480,480);
for(let i=0;i<texture.data.length;i++){
 const v=Math.round(Math.max(0,Math.min(1,texture.data[i]))*255);
 pixels.data.set([v,v,v,255],i*4);
}
ctx.putImageData(pixels,0,0);
const texturedData=png.toBuffer('image/png');
await saveBaseline('模様のある基準',[new NativeBlob([texturedData],{type:'image/png'})],{
 alignment:{version:1,width:480,height:480,roi:{x:0,y:0,width:480,height:480}},gsd:0.5,
});
await refreshSavedBaselines();$('compareSaved').value='模様のある基準';$('compareUseSaved').click();
await waitFor(()=>!$('compareRun').disabled);
Object.defineProperty(input,'files',{value:[0,1].map(i=>new w.File([texturedData],`texture${i}.png`,{type:'image/png'})),configurable:true});
input.dispatchEvent(new w.Event('change'));await waitFor(()=>w.document.querySelectorAll('#thumbs .thumb').length===2);
$('compareRun').click();await waitFor(()=>!$('compareRun').disabled);
if($('compareCanvas').classList.contains('hidden')||!$('compareStats').textContent.includes('評価セル'))throw Error('成立した比較の結果が表示されない');
for(const stage of ['fine','coarse']){
 $('compareAlignmentStage').value=stage;$('compareAlignmentStage').dispatchEvent(new w.Event('change'));
 const rgba=canvases.get(cv).getContext('2d').getImageData(0,0,cv.width,cv.height).data;
 let green=0;for(let i=0;i<rgba.length;i+=4)if(rgba[i+1]>220&&rgba[i]<150&&rgba[i+2]<170)green++;
 if(!green)throw Error(`${stage}の採用点が描画されない`);
}
$('compareAlignmentClear').click();$('compareAlignmentSave').click();
await waitFor(()=>$('compareAlignmentSaveInfo').textContent.includes('削除を保存'));
$('compareUseSaved').click();await waitFor(()=>!$('compareRun').disabled);
if(!$('compareAlignmentInfo').textContent.includes('未指定'))throw Error('保存した基準枠の削除が復元されない');
console.log('成立した比較、粗い／精密な採用点の描画、基準枠の削除保存を確認');
await w.happyDOM.abort();
