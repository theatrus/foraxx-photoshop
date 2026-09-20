"use strict";

// Run from the plugin's UXP debugger, not Node:
// await require('./scripts/photoshop-smoke.js').run({ bits: 16 })
// Creates a separate synthetic document; never edits an existing document.
const { app, core, imaging, constants, action } = require("photoshop");
const F = require("../src/foraxx.js");
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

async function fixture(bits = 16, width = 32, height = 24) {
  return core.executeAsModal(async () => {
    const doc = await app.createDocument({
      name: `Foraxx smoke ${bits}-bit`, width, height,
      mode: constants.NewDocumentMode.RGB,
      depth: bits, profile: "sRGB IEC61966-2.1",
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
        width, height, components: 3, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1",
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
  gains = { sii: 1, ha: 1, oiii: 1 }, tuning = {}, width = 32, height = 24 } = {}) {
  const { doc, layers, samples } = await fixture(bits, width, height);
  await buildForaxx({ ...layers, threeChannels, createStars, gains, tuning, name: "Foraxx test" });
  const sources = F.prepareSources(samples, gains, tuning);
  const expected = F.foraxx(sources, sources, threeChannels, tuning);
  if (createStars) {
    const stars = F.foraxx(sources, { sii: samples.siiStars, ha: samples.haStars, oiii: samples.oiiiStars }, threeChannels, tuning);
    for (const c of ["r", "g", "b"]) {
      for (let i = 0; i < expected[c].length; i++) expected[c][i] = 1 - (1 - expected[c][i]) * (1 - stars[c][i]);
    }
  }
  const actual = await core.executeAsModal(() => pixels(doc), { commandName: "Read Foraxx test result" });
  let maxError = 0;
  for (let i = 0; i < expected.r.length; i++) {
    for (let c = 0; c < 3; c++) maxError = Math.max(maxError, Math.abs(actual.data[i * actual.components + c] - expected[["r", "g", "b"][c]][i]));
  }
  const tree = (items) => Array.from(items, l => ({ name: l.name, kind: l.kind, blendMode: l.blendMode,
    ...(l.layers ? { layers: tree(l.layers) } : {}) }));
  const report = { version: require("uxp").host.version, bits, width, height, threeChannels, createStars, gains, tuning, maxError,
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
        tuning: { redBias: 1.5, redContrast: 2, greenBias: -1, greenContrast: 0.5, oiiiMidtone: 0.25 } }))),
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

module.exports = { fixture, run, runSuite, checkRejectedBuild, checkPreview };
