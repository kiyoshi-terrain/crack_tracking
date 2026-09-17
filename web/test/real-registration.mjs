// 実写用の任意検証。写真はリポジトリへ入れない。
// CRACK_UI_DEPS=/path/to/dependencies node web/test/real-registration.mjs \
//   reference.JPG 950,450,350,1100 current1.JPG current2.JPG
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { delimiter, basename } from 'node:path';
import { toGray, downsample } from '../src/image.js';
import { measureEpochChange } from '../src/change.js';
const require=createRequire(import.meta.url);
const {createCanvas,loadImage}=await import(pathToFileURL(require.resolve('@napi-rs/canvas',{
  paths:process.env.CRACK_UI_DEPS?.split(delimiter),
})).href);
const [referencePath,rectangle,...frames]=process.argv.slice(2);
if(!referencePath||!rectangle||!frames.length)throw Error('基準画像、x,y,width,height、今回画像を指定してください');
const [x,y,width,height]=rectangle.split(',').map(Number),roi={x,y,width,height};
async function read(path){
 const im=await loadImage(path),cv=createCanvas(im.width,im.height),ctx=cv.getContext('2d');ctx.drawImage(im,0,0);
 return toGray(ctx.getImageData(0,0,im.width,im.height),null,'luma',true);
}
const reference=await read(referencePath);
const result=await measureEpochChange(reference,frames.map(path=>()=>read(path)),{
 downsample,coarseScale:Math.max(1,Math.round(reference.width/1000)),step:40,subsetHalf:15,
 stableRegion:(px,py)=>px>=x&&px<=x+width&&py>=y&&py<=y+height,
 alignmentRegion:roi,alignmentQuality:{maxErrorPx:1},
 // このスクリプトは基準領域だけを検査。枠外の計測精度を評価するものではない。
 region:roi,
});
console.log(JSON.stringify({reference:basename(referencePath),roi,ok:result.ok,reason:result.reason,
 frames:result.frames.map((f,i)=>({name:basename(frames[i]),ok:f.ok,reason:f.reason,seed:f.alignment?.seed,
 coarse:f.alignment?.coarse&&{...f.alignment.coarse,points:undefined},fine:f.alignment?.fine&&{...f.alignment.fine,points:undefined}}))},null,2));
