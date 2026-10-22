"use strict";

// Run from the plugin's UXP debugger, not Node:
// await require('./scripts/photoshop-smoke.js').run({ bits: 16 })
// Creates a separate synthetic document; never edits an existing document.
const { app, core, imaging, constants, action } = require("photoshop");
const F = require("../src/foraxx.js");
const R = require("../src/render.js");
const { buildForaxx } = require("../src/psbuild.js");

async function pixels(doc, layer) {
  const got = await imaging.getPixels({
    documentID: doc.id, ...(layer ? { layerID: layer.id } : {}),
    componentSize: -1, applyAlpha: false,
    sourceBounds: { left: 0, top: 0, right: doc.width, bottom: doc.height },
  });
  try {
    return { data: F.decode(await got.imageData.getData(), got.imageData.componentSize),
      components: got.imageData.components, hasAlpha: got.imageData.hasAlpha };
  } finally { got.imageData.dispose(); }
}

async function fixture(bits = 16, width = 32, height = 24, profile = 'sRGB IEC61966-2.1') {
  return core.executeAsModal(async () => {
    const doc = await app.createDocument({
      name: `Foraxx smoke ${bits}-bit`, width, height,
      mode: constants.NewDocumentMode.RGB,
      depth: bits, profile,
    });
    const layers = {}, samples = {};
    for (const [name, fn] of Object.entries({
      sii: (x, y) => 0.05 + 0.45 * (1 - x / (width - 1)) + 0.25 * y / (height - 1),
      ha: (x) => 0.05 + 0.9 * x / (width - 1),
      oiii: (_, y) => 0.05 + 0.9 * y / (height - 1),
      siiStars: (x, y) => ((x + y) % 7 === 0 ? 0.6 : 0),
      haStars: (x, y) => ((x + y) % 7 === 0 ? 0.8 : 0),
      oiiiStars: (x, y) => ((x + y) % 7 === 0 ? 0.4 : 0),
    })) {
      const gray = Float32Array.from({ length: width * height }, (_, i) => fn(i % width, Math.floor(i / width)));
      const rgb = Float32Array.from({ length: gray.length * 3 }, (_, i) => gray[Math.floor(i / 3)]);
      const layer = await doc.createLayer({ name });
      const imageData = await imaging.createImageDataFromBuffer(F.encode(rgb, bits), {
        width, height, components: 3, colorSpace: "RGB", colorProfile: profile,
      });
      try { await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData }); }
      finally { imageData.dispose(); }
      layers[name] = layer;
      const read = await pixels(doc, layer);
      samples[name] = F.toGray(read.data, read.components, read.hasAlpha);
    }
    return { doc, layers, samples };
  }, { commandName: "Create Foraxx test fixture" });
}

async function run({ bits = 16, threeChannels = true, createStars = false,
  gains = { sii: 1, ha: 1, oiii: 1 }, tuning = {}, width = 32, height = 24, ...extras } = {}) {
  const { doc, layers, samples } = await fixture(bits, width, height, extras.colorProfile);
  const options={ ...layers, threeChannels, createStars, gains, tuning, ...extras, colorProfile:doc.colorProfileName, name: "Foraxx test" };
  await buildForaxx(options);
  const expected = R.displayed(R.render(samples,{sii:samples.siiStars,ha:samples.haStars,oiii:samples.oiiiStars},options,width,height),options);
  const actual = await core.executeAsModal(() => pixels(doc), { commandName: "Read Foraxx test result" });
  let maxError = 0;
  for (let i = 0; i < expected.r.length; i++) {
    for (let c = 0; c < 3; c++) maxError = Math.max(maxError, Math.abs(actual.data[i * actual.components + c] - expected[["r", "g", "b"][c]][i]));
  }
  const tree = (items) => Array.from(items, l => ({ name: l.name, kind: l.kind, blendMode: l.blendMode,
    ...(l.layers ? { layers: tree(l.layers) } : {}) }));
  const report = { version: require("uxp").host.version, bits, width, height, threeChannels, createStars, gains, tuning, ...extras, maxError,
    tolerance: bits === 8 ? 2 / 255 : 2 / 32768,
    tree: tree(doc.layers) };
  await core.executeAsModal(async () => {
    const root = doc.layers[0];
    await root.merge();
    const merged = await pixels(doc);
    report.mergeError = 0;
    for (let i = 0; i < actual.data.length; i++) {
      report.mergeError = Math.max(report.mergeError, Math.abs(actual.data[i] - merged.data[i]));
    }
    // Undo merge, then undo the entire palette build in one step.
    const previous = { _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] };
    await action.batchPlay([previous, previous], {});
    report.undoRestoredSources = doc.layers.length === 7 &&
      Object.values(layers).every(source => Array.from(doc.layers).some(l => l.id === source.id));
    // Leave the editable palette available for visual inspection.
    await action.batchPlay([{ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "next" }] }], {});
  }, { commandName: "Verify Foraxx merge and undo" });
  report.pass = maxError <= report.tolerance && report.mergeError <= report.tolerance && report.undoRestoredSources;
  console.log(JSON.stringify(report));
  return report;
}

async function runSuite() {
  const results = [];
  for (const bits of [8, 16]) {
    for (const threeChannels of [false, true]) {
      for (const createStars of [false, true]) {
        const { tree, ...result } = await run({ bits, threeChannels, createStars,
          gains: { sii: 0.85, ha: 1.2, oiii: 1.1 } });
        results.push(result);
        const doc = app.activeDocument;
        await core.executeAsModal(() => doc.closeWithoutSaving(), { commandName: "Close Foraxx test document" });
      }
    }
  }
  results.push(await checkRejectedBuild(32, false));
  results.push(await checkRejectedBuild(16, true));
  // Cross the production strip boundary and finish with a partial strip.
  const { tree, ...tiled } = await run({ bits: 16, width: 2053, height: 1031, createStars: true });
  results.push(tiled);
  const tiledDoc = app.activeDocument;
  await core.executeAsModal(() => tiledDoc.closeWithoutSaving(), { commandName: "Close Foraxx test document" });
  const tuning = { redBias: 1.1, redContrast: 1.7, greenBias: -0.8, greenContrast: 0.6, oiiiMidtone: 0.3 };
  for (const bits of [8, 16]) {
    for (const createStars of [false, true]) {
      const { tree, ...custom } = await run({ bits, createStars, tuning });
      results.push(custom);
      const doc = app.activeDocument;
      await core.executeAsModal(() => doc.closeWithoutSaving(), { commandName: "Close Foraxx test document" });
    }
  }
  const { tree: customTree, ...twoChannel } = await run({ threeChannels: false, createStars: true, tuning });
  results.push(twoChannel);
  const customDoc = app.activeDocument;
  await core.executeAsModal(() => customDoc.closeWithoutSaving(), { commandName: "Close Foraxx test document" });
  return results;
}

async function checkRejectedBuild(bits, lateFailure) {
  const { doc, layers } = await fixture(bits);
  if (lateFailure) {
    layers.haStars = await core.executeAsModal(() => doc.createLayer({ name: "Empty stars" }),
      { commandName: "Create invalid test source" });
  }
  const before = Array.from(doc.layers, l => l.id);
  const historyBefore = doc.activeHistoryState.id;
  let error = null;
  try {
    await buildForaxx({ ...layers, threeChannels: true, createStars: lateFailure,
      gains: { sii: 1, ha: 1, oiii: 1 } });
  } catch (e) { error = String(e); }
  const unchanged = JSON.stringify(before) === JSON.stringify(Array.from(doc.layers, l => l.id)) &&
    historyBefore === doc.activeHistoryState.id;
  const result = { test: lateFailure ? "failed build rolls back" : "32-bit rejected before edits",
    pass: !!error && unchanged, error, unchanged };
  await core.executeAsModal(() => doc.closeWithoutSaving(), { commandName: "Close Foraxx test document" });
  return result;
}

async function checkPreview() {
  const P = require('../src/preview.js');
  const { doc, layers } = await fixture(16);
  const results = [];
  try {
    for (const settings of [
      { threeChannels: true, createStars: false, tuning: {} },
      ...[false, true].flatMap(threeChannels => [false, true].map(createStars => ({ threeChannels, createStars,
        tuning: { redBias: 1.5, redContrast: 2, greenBias: -1, greenContrast: 0.5, oiiiMidtone: 0.25, maskBlur: 2 } }))),
    ]) {
      const options = { ...layers, ...settings, gains: { sii: 1, ha: 1, oiii: 1 } };
      const history = doc.activeHistoryState.id, layerCount = doc.layers.length;
      const cache = await P.loadPreview(options);
      const expected = P.previewPixels(cache, options);
      const jpeg = await P.renderPreview(cache, options);
      const readOnly = history === doc.activeHistoryState.id && layerCount === doc.layers.length;
      await buildForaxx(options);
      const actual = await core.executeAsModal(() => pixels(doc), { commandName: 'Check preview against built pixels' });
      let maxError8 = 0;
      for (let i = 0; i < doc.width * doc.height; i++) for (let c = 0; c < 3; c++) {
        maxError8 = Math.max(maxError8, Math.abs(expected[i * 3 + c] - Math.round(actual.data[i * actual.components + c] * 255)));
      }
      results.push({ ...settings, readOnly, maxError8,
        pass: readOnly && maxError8 <= 1 && jpeg.startsWith('data:image/jpeg;base64,') && P.previewKey(options) !== cache.key });
    }
    return { test: 'preview is read-only, matches builds, and detects history changes',
      pass: results.every(r => r.pass), results };
  } finally {
    await core.executeAsModal(() => doc.closeWithoutSaving(), { commandName: 'Close preview test document' });
  }
}

async function checkBlur() {
  const results = [];
  for (const settings of [
    { bits: 8, threeChannels: true, createStars: true, tuning: { maskBlur: 2 } },
    { bits: 16, threeChannels: false, createStars: true, tuning: { maskBlur: 2, greenBias: -0.5 } },
    { bits: 16, tuning: { maskBlur: 25, oiiiMidtone: 0.3 } },
    { bits: 16, width: 2053, height: 1031, createStars: true, tuning: { maskBlur: 2 } },
  ]) {
    const { tree, ...result } = await run(settings);
    results.push(result);
    const doc = app.activeDocument;
    await core.executeAsModal(() => doc.closeWithoutSaving(), { commandName: 'Close blur test document' });
  }
  return { pass: results.every(r => r.pass), results };
}

async function checkOptions() {
  const results=[];
  const settings=[...['SHO','HOO','HSO','OHS'].map(palette=>({palette,createStars:true,createRatioMasks:true})),
    {palette:'HOO',threeChannels:false,createStars:true,combineStars:false,tuning:{haMidtone:0.3,oiiiMidtone:0.6}},
    {bits:8,applyAdjustments:true,protectedSaturation:true,createStars:true,createFactorImages:true},
    {applyAdjustments:true,protectBackground:true,protectedSaturation:true,lightnessLift:0.1,colourNoiseReduction:true,
      createFactorImages:true,createRatioMasks:true,createStars:true,tuning:{maskBlur:2,haMidtone:0.4,siiMidtone:0.6}},
    {colourNoiseReduction:true,colourNoiseLayers:4,width:2053,height:1031,tuning:{maskBlur:2}}];
  for(const options of settings) {
    const {tree,...result}=await run(options);results.push(result);
    const doc=app.activeDocument;
    await core.executeAsModal(()=>doc.closeWithoutSaving(),{commandName:'Close options test'});
  }
  return {pass:results.every(r=>r.pass),results};
}

async function checkOptionPreview() {
  const P=require('../src/preview.js'),{doc,layers,samples}=await fixture(16,96,64),results=[];
  try {
    for(const extras of [{palette:'SHO',combineStars:false},{palette:'OHS',combineStars:true},
      {applyAdjustments:true,colourNoiseReduction:true,protectedSaturation:true,lightnessLift:0.1,createFactorImages:true,createRatioMasks:true,tuning:{maskBlur:2}}]) {
      const options={...layers,threeChannels:true,createStars:true,...extras};
      const history=doc.activeHistoryState.id,cache=await P.loadPreview(options),expected=P.previewPixels(cache,options);
      const readOnly=doc.activeHistoryState.id === history;
      await buildForaxx(options);
      const actual=await core.executeAsModal(()=>pixels(doc),{commandName:'Check finishing preview'});
      let maxError8=0;
      for(let i=0;i<doc.width*doc.height;i++)for(let c=0;c<3;c++)maxError8=Math.max(maxError8,Math.abs(expected[i*3+c]-Math.round(actual.data[i*actual.components+c]*255)));
      const root=doc.layers[0],maskGroup=Array.from(root.layers).find(l=>l.name === 'Reusable masks (hidden)');
      let masksValid=true;
      if(maskGroup) {
        masksValid=!maskGroup.visible;
        const rendered=R.render(cache.raw,cache.stars,options,cache.width,cache.height);
        for(const [name,gray] of Object.entries(rendered.exports)) {
          const layer=Array.from(maskGroup.layers).find(l=>l.name === name);
          if(!layer) {masksValid=false;continue;}
          const got=await core.executeAsModal(()=>pixels(doc,layer),{commandName:'Check reusable mask'});
          for(let i=0;i<gray.length;i++)if(Math.abs(got.data[i*got.components]-gray[i])>1/32768)masksValid=false;
        }
      }
      results.push({extras,readOnly,maxError8,masksValid,pass:readOnly&&maxError8<=1&&masksValid});
    }
    const options={...layers,threeChannels:true,previewZoom:2,previewX:100,previewY:0};
    const zoom=await P.loadPreview(options);
    const cropCorrect=zoom.width===48&&zoom.height===32&&zoom.region.left===48&&zoom.region.top===0&&
      zoom.raw.ha.every((v,i)=>v===samples.ha[Math.floor(i/48)*96+48+i%48]);
    results.push({test:'zoom reads the selected source region',pass:cropCorrect});
    return {pass:results.every(r=>r.pass),results};
  } finally {await core.executeAsModal(()=>doc.closeWithoutSaving(),{commandName:'Close option preview test'});}
}

module.exports = { fixture, run, runSuite, checkRejectedBuild, checkPreview, checkBlur, checkOptions, checkOptionPreview };

// Independent reference: Photoshop performs the RGB-to-Lab conversion.
async function checkProfileLab() {
 const S=require('../src/color-space.js');
 return core.executeAsModal(async()=>{
  const results=[];
  const patches=[[0,0,0],[1,1,1],[0.5,0.5,0.5],[0.03,0.03,0.03],[0.25,0.5,0.4],[0.7,0.2,0.4],[0.1,0.2,0.7]];
  for(const profile of ['sRGB IEC61966-2.1','Adobe RGB (1998)','image P3','ProPhoto RGB']){
   const doc=await app.createDocument({name:'Lab profile reference',width:patches.length,height:1,mode:constants.NewDocumentMode.RGB,depth:16,profile});
   try{
    const layer=await doc.createLayer({name:'Color patches'}),values=Uint16Array.from(patches.flat(),v=>Math.round(v*32768));
    const img=await imaging.createImageDataFromBuffer(values,{width:patches.length,height:1,components:3,colorSpace:'RGB',colorProfile:profile});
    try{await imaging.putPixels({documentID:doc.id,layerID:layer.id,imageData:img});}finally{img.dispose();}
    const got=await imaging.getPixels({documentID:doc.id,layerID:layer.id,colorSpace:'Lab',colorProfile:'Lab D50',componentSize:8,applyAlpha:true});
    try{
     const data=await got.imageData.getData(),space=S.getSpace(profile),errors=[];
     for(let i=0;i<patches.length;i++){
      const expected=space.toLab(...Array.from(values.subarray(i*3,i*3+3),v=>v/32768));
      const actual=[data[i*3]/255,data[i*3+1]-128,data[i*3+2]-128];
      errors.push(Math.max(Math.abs(expected[0]-actual[0])*100,Math.abs(expected[1]-actual[1]),Math.abs(expected[2]-actual[2])));
     }
     results.push({profile,maxLabError:Math.max(...errors),pass:Math.max(...errors)<1});
    }finally{got.imageData.dispose();}
   }finally{await doc.closeWithoutSaving();}
  }
  return results;
 },{commandName:'Verify profile conversions against Photoshop Lab'});
}

async function checkProfiles() {
  const P=require("../src/preview.js"), results=[];
  for (const colorProfile of ["sRGB IEC61966-2.1","Adobe RGB (1998)","image P3","ProPhoto RGB"]) {
    for (const bits of [8,16]) {
      const {tree,...result}=await run({colorProfile,bits,createStars:true,applyAdjustments:true,protectedSaturation:true,colourNoiseReduction:true,lightnessLift:0.1,tuning:{maskBlur:2}});
      const doc=app.activeDocument;
      try {
        const layers=Object.fromEntries(Array.from(doc.layers).filter(l=>["sii","ha","oiii"].includes(l.name)).map(l=>[l.name,l]));
        const options={...layers,threeChannels:true,applyAdjustments:true,protectedSaturation:true,lightnessLift:0.1};
        const history=doc.activeHistoryState.id,cache=await P.loadPreview(options);
        const raw=P.previewPixels(cache,options), display=P.previewPixels(cache,options,true);
        const jpeg=await P.renderPreview(cache,options);
        result.previewReadOnly=history===doc.activeHistoryState.id;
        result.profilePreserved=doc.colorProfileName===colorProfile && cache.colorProfile===colorProfile;
        result.displayConverted=colorProfile==="sRGB IEC61966-2.1" ? display.every((v,i)=>v===raw[i]) : display.some((v,i)=>v!==raw[i]);
        result.pass=result.pass && result.previewReadOnly && result.profilePreserved && result.displayConverted && jpeg.startsWith("data:image/jpeg;base64,");
        results.push(result);
      } finally { await core.executeAsModal(()=>doc.closeWithoutSaving(),{commandName:"Close profile test fixture"}); }
    }
  }
  return {pass:results.every(r=>r.pass),results};
}

module.exports.checkProfileLab=checkProfileLab;
module.exports.checkProfiles=checkProfiles;
