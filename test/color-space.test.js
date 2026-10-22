"use strict";
const {test}=require('node:test'), assert=require('node:assert/strict');
const {getSpace,SRGB}=require('../src/color-space.js'), C=require('../src/colour.js'), O=require('../src/options.js'), R=require('../src/render.js');
const names=[SRGB,'Adobe RGB (1998)','Display P3','ProPhoto RGB'];
const near=(a,b,tol=3e-6)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<tol,`${v} vs ${b[i]}`));

test('supported RGB spaces round-trip colors, including wide-gamut primaries and deep shadows',()=>{
  for(const name of names) {
    const s=getSpace(name);
    for(const rgb of [[0,0,0],[1,1,1],[0.001,0.002,0.003],[0.5,0.5,0.5],[1,0,0],[0,1,0],[0,0,1],[0.12,0.88,0.7]]) near(s.fromLab(...s.toLab(...rgb)),rgb);
    near(s.toLab(1,1,1),[1,0,0],0.004);
  }
});
test('Adobe and ProPhoto gamma produce the expected neutral lightness',()=>{
  for(const [name,gamma] of [['Adobe RGB (1998)',563/256],['ProPhoto RGB',461/256]])
    near([getSpace(name).toLab(0.5,0.5,0.5)[0]],[(116*Math.cbrt(0.5**gamma)-16)/100],1e-5);
});
test('wide-gamut colors are retained without an sRGB round trip',()=>{
  for(const name of names.slice(1)) {
    const s=getSpace(name), green=[0,1,0], lab=s.toLab(...green);
    const clipped=getSpace().fromLab(...lab), lost=s.fromLab(...getSpace().toLab(...clipped));
    assert.ok(Math.max(...lost.map((v,i)=>Math.abs(v-green[i])))>0.1);
    const rgb={r:Float32Array.of(0),g:Float32Array.of(1),b:Float32Array.of(0)};
    const out=C.finish(rgb,O.normalize({protectedSaturation:true}),1,1,1,false,name).rgb;
    near([out.r[0],out.g[0],out.b[0]],green);
  }
});
test('L* lift and combined finishing use the requested document space',()=>{
  const rgb={r:Float32Array.of(0.35),g:Float32Array.of(0.4),b:Float32Array.of(0.45)};
  for(const name of names) {
    const s=getSpace(name), out=C.finish(rgb,O.normalize({lightnessLift:0.1}),1,1,1,false,name).rgb;
    const before=s.toLab(0.35,0.4,0.45),after=s.toLab(out.r[0],out.g[0],out.b[0]);
    assert.ok(after[0]>before[0]);near(after.slice(1),before.slice(1),0.0001);
    const raw={sii:rgb.r,ha:rgb.g,oiii:rgb.b};
    const result=R.render(raw,raw,{colorProfile:name,threeChannels:true,createStars:true,applyAdjustments:true,protectedSaturation:true,lightnessLift:0.1},1,1);
    for(const kind of ['nebula','stars'])for(const c of ['r','g','b'])assert.ok(result[kind][c].every(v=>Number.isFinite(v)&&v>=0&&v<=1));
  }
});
test('unknown and untagged profiles are rejected for finishing',()=>{
  assert.equal(getSpace('image P3'),getSpace('Display P3'));
  for(const name of ['', 'Custom RGB','toString'])assert.throws(()=>getSpace(name),/does not yet support/);
});
