import { searchReferenceRegion, splitRegistrationPoints, registrationQuality } from '../src/registration.js';
import { fitAffine } from '../src/transform.js';
import { downsample } from '../src/image.js';
import { measureEpochChange } from '../src/change.js';
import { crackOpeningEpoch } from '../src/crackline.js';
import { makeBlobs, renderBlobs } from './synthetic.mjs';

export async function runRegistrationTests(check, near) {
  console.log('\n== 再撮影の位置合わせと独立検査 ==');
  const width=240,height=180, data=new Float32Array(width*height);
  let seed=41;for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed/4294967296;}
  const ref={width,height,data},target={width,height,data:new Float32Array(data.length)};
  for(let y=0;y<height-50;y++)for(let x=0;x<width-90;x++)target.data[(y+50)*width+x+90]=data[y*width+x];
  const roi={x:20,y:20,width:70,height:80};
  const shifted=searchReferenceRegion(ref,target,roi,downsample);
  check('画面幅の37.5%の構図ずれを基準枠から発見',shifted.ok&&shifted.dx===90&&shifted.dy===50);
  const flat={width,height,data:new Float32Array(width*height).fill(0.3)};
  check('一様面の初期位置を捏造しない',!searchReferenceRegion(flat,flat,roi,downsample).ok);
  const gradient={width,height,data:Float32Array.from(data,(_,i)=>(i%width+Math.floor(i/width))/(width+height))};
  check('明暗勾配だけの高相関を採用しない',!searchReferenceRegion(gradient,gradient,roi,downsample).ok);
  check('画像外の基準枠を拒否',!searchReferenceRegion(ref,target,{...roi,x:width},downsample).ok);
  const repeating={width,height,data:Float32Array.from(data,(_,i)=>((i%width)%8+Math.floor(i/width)%8)/16)};
  check('反復模様の紛らわしい照合を拒否',!searchReferenceRegion(repeating,repeating,roi,downsample).ok);
  const pts=[];for(let y=0;y<300;y+=30)for(let x=0;x<300;x+=30)pts.push({x,y,u:3+0.01*x,v:-2+0.02*y});
  const split=splitRegistrationPoints(pts,30),t=fitAffine(split.train);
  check('フィット用と検査用に同じ点を使わない',split.train.length+split.check.length===pts.length&&!split.check.some(p=>split.train.includes(p)));
  check('独立点で正しい変換に合格',registrationQuality(split.train,split.check,t,false).ok);
  check('検査点だけのずれを検出',!registrationQuality(split.train,split.check.map(p=>({...p,u:p.u+3})),t,false).ok);
  check('少ない検査点では計測しない',!registrationQuality(split.train,split.check.slice(0,3),t,false).ok);
  const line=pts.map(p=>({...p,y:p.x}));
  check('一直線の基準を拒否',!registrationQuality(line,line,t,false).ok);
  const W=480,H=360,blobs=makeBlobs({width:W,height:H,count:1800,seed:342});
  const image=renderBlobs(blobs,W,H), angle=0.4*Math.PI/180;
  const frames=[21,22].map(seed=>renderBlobs(blobs.map(b=>{
    const u=b.x>W/2?0.75:0;return {...b,x:(b.x+u)*Math.cos(angle)-b.y*Math.sin(angle)+2,y:(b.x+u)*Math.sin(angle)+b.y*Math.cos(angle)-2};
  }),W,H,{noise:0.002,seed}));
  const options={subsetHalf:10,step:20,coarseSearch:10,downsample,coarseScale:2,
    stableRegion:(x)=>x<205,alignmentRegion:{x:0,y:0,width:205,height:H},alignmentQuality:{maxErrorPx:1},sigmaAPx:0.01};
  const result=await measureEpochChange(image,[...frames,{width:W,height:H,data:new Float32Array(W*H).fill(0.3)}],options);
  check('独立検査を通した2枚で比較成立',result.ok,JSON.stringify(result.frames.map(f=>({ok:f.ok,reason:f.reason}))));
  check('不合格写真を成立した2枚に混ぜない',result.frames.filter(f=>f.ok).length===2&&!result.frames[2].ok);
  if(result.ok){
    const opening=crackOpeningEpoch(result.cells,{x1:240,y1:50,x2:240,y2:310},{margin:25,depth:70});
    check('独立検査後も0.75pxの開口を消さない',opening.ok&&near(opening.openingPx,0.75,0.08),String(opening.openingPx));
    check('検査点を採用点と別色で返す',result.frames.filter(f=>f.ok).every(f=>f.alignment.fine.points.some(p=>p.status==='check')&&f.alignment.fine.quality.ok));
  }
  const one=await measureEpochChange(image,[frames[0]],options);
  check('合格1枚を確定結果にしない',!one.ok&&one.reason.includes('2枚未満'));
}
if(process.argv[1]===new URL(import.meta.url).pathname){let failures=0;await runRegistrationTests((name,ok,detail='')=>{console.log(ok?'OK':'NG',name,detail);if(!ok)failures++;},(a,b,t)=>Math.abs(a-b)<=t);process.exitCode=failures?1:0;}
