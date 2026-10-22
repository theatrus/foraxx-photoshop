"use strict";
const F = require('./foraxx.js'), O = require('./options.js'), C = require('./colour.js');

function ratioMasks(sources, threeChannels, threshold) {
  const n = sources.ha.length, oxygen = new Float32Array(n), sulfur = threeChannels ? new Float32Array(n) : null;
  for (let i=0;i<n;i++) {
    const h=sources.ha[i], o=sources.oiii[i], s=threeChannels ? sources.sii[i] : 0;
    const mean=(h+o+s)/(threeChannels ? 3 : 2), fade=threshold > 0 ? Math.min(1,mean/threshold) : 1;
    oxygen[i]=o/(h+o+1e-6)*fade;
    if (sulfur) sulfur[i]=s/(h+s+1e-6)*fade;
  }
  return { ratio_OIII: oxygen, ...(sulfur ? { ratio_SII: sulfur } : {}) };
}

function render(raw, stars, options, width, height, scale=1) {
  const o=O.normalize(options), sources=F.prepareSources(raw,options.gains,options.tuning);
  const masks=o.palette === 'Foraxx' ? F.mixingMasks(sources,options.threeChannels,options.tuning,width,height,scale) : null;
  const plan=F.planStack(sources,sources,options.threeChannels,options.tuning,masks,o.palette);
  const n=width*height, rawRGB=F.compositeStack(plan,n);
  const finished=O.finishing(o) ? C.finish(rawRGB,o,width,height,scale,false,options.colorProfile) : {rgb:rawRGB,satmask:null};
  const starPlan=options.createStars ? F.planStack(sources,stars,options.threeChannels,options.tuning,masks,o.palette) : null;
  let starRGB=starPlan ? F.compositeStack(starPlan,n) : null;
  if (starRGB && o.applyAdjustments) starRGB=C.finish(starRGB,o,width,height,scale,true,options.colorProfile).rgb;
  const exports={};
  if (o.createFactorImages && masks) {
    exports.factor_ho=masks.ho;
    if (masks.o) exports.factor_o=masks.o;
  }
  if (o.createRatioMasks) Object.assign(exports,ratioMasks(sources,options.threeChannels,o.ratioThreshold));
  if (finished.satmask) exports.saturation_mask=finished.satmask;
  return {plan,starPlan,nebula:finished.rgb,stars:starRGB,exports};
}
function displayed(rendered, options) {
  const o=O.normalize(options), view=options.previewTarget || 'result';
  if (view === 'stars' && rendered.stars) return rendered.stars;
  if (rendered.exports[view]) {
    const gray=rendered.exports[view]; return {r:gray,g:gray,b:gray};
  }
  if (o.combineStars && rendered.stars) {
    const rgb={};
    for (const c of ['r','g','b']) rgb[c]=Float32Array.from(rendered.nebula[c],(v,i)=>1-(1-v)*(1-rendered.stars[c][i]));
    return rgb;
  }
  return rendered.nebula;
}
function halo(options,scale=1) {
  const o=O.normalize(options);
  return (o.palette === 'Foraxx' ? F.gaussianRadius(F.tuningOptions(options.tuning).maskBlur*scale) : 0) + C.noiseRadius(o,scale);
}
function cropPlan(plan,crop) {
  return plan && plan.map(group=>({...group,layers:group.layers.map(layer=>({...layer,image:crop(layer.image),mask:layer.mask ? crop(layer.mask):undefined}))}));
}
function interleave(rgb) {
  const output=new Float32Array(rgb.r.length*3);
  for (let i=0;i<rgb.r.length;i++) {output[i*3]=rgb.r[i];output[i*3+1]=rgb.g[i];output[i*3+2]=rgb.b[i];}
  return output;
}
module.exports={ratioMasks,render,displayed,halo,cropPlan,interleave};
