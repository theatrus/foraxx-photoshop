"use strict";
const {test}=require('node:test'), assert=require('node:assert/strict');
const F=require('../src/foraxx.js'), C=require('../src/colour.js'), R=require('../src/render.js'), O=require('../src/options.js');
const near=(a,b,tol=2e-6)=>{assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-b[i])<tol,`${i}: ${a[i]} vs ${b[i]}`);};
const source=(w,h)=>({sii:Float32Array.from({length:w*h},(_,i)=>(i*13%99)/100),
  ha:Float32Array.from({length:w*h},(_,i)=>(i*37%95)/100),oiii:Float32Array.from({length:w*h},(_,i)=>(i*73%90)/100)});

test('static palettes map all channels, support stars and reject missing SII',()=>{
  const raw=source(5,4), stars={sii:raw.oiii,ha:raw.sii,oiii:raw.ha};
  for(const palette of ['SHO','HOO','HSO','OHS']) {
    const o={palette,threeChannels:true,createStars:true,combineStars:false};
    const r=R.render(raw,stars,o,5,4), map=O.PALETTES[palette];
    for(const [i,c] of ['r','g','b'].entries()) {near(r.nebula[c],raw[map[i]]);near(r.stars[c],stars[map[i]]);}
    assert.deepEqual(R.displayed(r,o),r.nebula);
    const combined=R.displayed(r,{...o,combineStars:true});
    near(combined.r,Float32Array.from(r.nebula.r,(v,i)=>1-(1-v)*(1-r.stars.r[i])));
  }
  assert.throws(()=>R.render(raw,null,{palette:'SHO',threeChannels:false},5,4),/SII/);
});

test('all channel midtones apply after gain; stars remain unshaped',()=>{
  const raw=source(4,3), tuning={siiMidtone:0.2,haMidtone:0.7,oiiiMidtone:0.3};
  const r=R.render(raw,raw,{palette:'SHO',threeChannels:true,createStars:true,gains:{sii:1.5,ha:0.8},tuning},4,3);
  near(r.nebula.r,F.midtones(F.scaled(raw.sii,1.5),0.2));
  near(r.nebula.g,F.midtones(F.scaled(raw.ha,0.8),0.7));
  near(r.stars.r,raw.sii);near(r.stars.g,raw.ha);
});

test('ratio masks fade low signal and zero threshold is finite even at black',()=>{
  const src={ha:Float32Array.of(0,0.01,0.2),oiii:Float32Array.of(0,0.03,0.6),sii:Float32Array.of(0,0.02,0.4)};
  const m=R.ratioMasks(src,true,0.1);
  near(m.ratio_OIII,[0,0.03/0.040001*0.2,0.6/0.800001]);
  const z=R.ratioMasks(src,false,0);assert.equal(z.ratio_OIII[0],0);assert.equal(z.ratio_SII,undefined);
});

test('sRGB/Lab round trips, neutral colors, and HSV round trips',()=>{
  for(const rgb of [[0,0,0],[1,1,1],[0.3,0.3,0.3],[0.7,0.2,0.4],[1,0,0],[0,1,0],[0,0,1]]) {
    near(C.fromLab(...C.toLab(...rgb)),rgb,3e-6);near(C.fromHSV(...C.toHSV(...rgb)),rgb);
  }
  const white=C.toLab(1,1,1);near(white,[1,0,0],3e-5);
});

test('Akima curves pass through knots and preserve an identity ramp',()=>{
  const points=[[0,0],[0.1,0.2],[0.5,0.65],[0.8,0.9],[1,1]], curve=C.akima(points);
  for(const [x,y] of points) assert.ok(Math.abs(curve(x)-y)<1e-12);
  const identity=C.akima([[0,0],[0.5,0.5],[1,1]]);
  for(let i=0;i<=100;i++)assert.ok(Math.abs(identity(i/100)-i/100)<1e-12);
});

test('protected saturation leaves black and fully saturated pixels alone',()=>{
  const rgb={r:Float32Array.of(0,0.01,1,0.45),g:Float32Array.of(0,0.01,0,0.4),b:Float32Array.of(0,0.01,0,0.35)};
  const result=C.finish(rgb,O.normalize({protectedSaturation:true,saturationAmount:0.5}),4,1);
  for(const i of [0,1,2]) {assert.equal(result.satmask[i],0); for(const c of ['r','g','b'])assert.equal(result.rgb[c][i],rgb[c][i]);}
  assert.ok(result.satmask[3]>0);
  assert.ok(C.toHSV(result.rgb.r[3],result.rgb.g[3],result.rgb.b[3])[1]>C.toHSV(rgb.r[3],rgb.g[3],rgb.b[3])[1]);
});

test('L* lift retains Lab chroma for in-gamut colors and neutral endpoints',()=>{
  const rgb={r:Float32Array.of(0,0.35,1),g:Float32Array.of(0,0.4,1),b:Float32Array.of(0,0.45,1)};
  const result=C.finish(rgb,O.normalize({lightnessLift:0.1}),3,1).rgb;
  const before=C.toLab(rgb.r[1],rgb.g[1],rgb.b[1]),after=C.toLab(result.r[1],result.g[1],result.b[1]);
  assert.ok(after[0]>before[0]);near(after.slice(1),before.slice(1),2e-5);
  near([result.r[0],result.g[0],result.b[0]],[0,0,0]);near([result.r[2],result.g[2],result.b[2]],[1,1,1]);
});

test('wavelet residual reduces chroma noise while retaining L*',()=>{
  const w=17,h=15,n=w*h, rgb={r:new Float32Array(n),g:new Float32Array(n),b:new Float32Array(n)};
  for(let i=0;i<n;i++) {const p=C.fromLab(0.5,i%2?12:-12,0);for(const [c,k] of ['r','g','b'].entries())rgb[k][i]=p[c];}
  const result=C.finish(rgb,O.normalize({colourNoiseReduction:true,colourNoiseLayers:2}),w,h).rgb;
  const i=7*w+8,p=C.toLab(result.r[i],result.g[i],result.b[i]);
  assert.ok(Math.abs(p[1])<1);assert.ok(Math.abs(p[0]-0.5)<2e-6);
  near(C.smoothChroma(new Float32Array(n).fill(0.25),w,h,4),new Float32Array(n).fill(0.25));
});

test('all finishing options remain finite and tiled processing agrees at seams',()=>{
  const w=11,h=87,raw=source(w,h),o={threeChannels:true,createStars:true,applyAdjustments:true,protectBackground:true,
    colourNoiseReduction:true,colourNoiseLayers:2,protectedSaturation:true,lightnessLift:0.08,createRatioMasks:true,createFactorImages:true,tuning:{maskBlur:1.2}};
  const full=R.render(raw,raw,o,w,h),halo=R.halo(o);
  for(let top=0;top<h;top+=19){
    const bottom=Math.min(h,top+19),a=Math.max(0,top-halo),b=Math.min(h,bottom+halo);
    const partial=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,v.subarray(a*w,b*w)]));
    const part=R.render(partial,partial,o,w,b-a);
    for(const kind of ['nebula','stars'])for(const c of ['r','g','b']){
      near(part[kind][c].subarray((top-a)*w,(bottom-a)*w),full[kind][c].subarray(top*w,bottom*w));
      assert.ok(part[kind][c].every(v=>Number.isFinite(v)&&v>=0&&v<=1));
    }
  }
});
