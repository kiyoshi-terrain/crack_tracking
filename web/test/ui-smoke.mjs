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
import { readFileSync } from 'node:fs';
const w = new Window({url:'http://localhost:8080',settings:{disableJavaScriptFileLoading:true,disableJavaScriptEvaluation:true,disableCSSFileLoading:true}});
w.document.write(readFileSync(new URL('../index.html', import.meta.url),'utf8'));
for(const k of ['window','document','navigator','localStorage','sessionStorage','HTMLElement','HTMLCanvasElement','ImageData','Image','File','Blob','Event','CustomEvent','ResizeObserver','requestAnimationFrame','cancelAnimationFrame','matchMedia','getComputedStyle']){
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
Object.defineProperty($('fileInput'),'files',{value:files});$('fileInput').dispatchEvent(new w.Event('change'));
const waitFor=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('timed out');};
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
await w.happyDOM.abort();
