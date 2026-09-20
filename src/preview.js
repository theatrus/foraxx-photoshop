"use strict";

const { core, imaging } = require("photoshop");
const F = require("./foraxx.js");
const { validateOptions } = require("./psbuild.js");

// Cache only source thumbnails. Changing tuning never rereads a 100 MP layer.
function previewKey(options) {
  const doc = validateOptions(options);
  const keys = options.threeChannels ? ["sii", "ha", "oiii"] : ["ha", "oiii"];
  if (options.createStars) keys.push(...(options.threeChannels ? ["siiStars", "haStars", "oiiiStars"] : ["haStars", "oiiiStars"]));
  return JSON.stringify([doc.id, doc.activeHistoryState.id, keys.map(k => options[k].id)]);
}

async function loadPreview(options, maxEdge = 512) {
  const doc = validateOptions(options), key = previewKey(options);
  const scale = Math.min(1, maxEdge / Math.max(doc.width, doc.height));
  const width = Math.max(1, Math.round(doc.width * scale)), height = Math.max(1, Math.round(doc.height * scale));
  return core.executeAsModal(async () => {
    const raw = {}, stars = {};
    let colorProfile;
    const channels = options.threeChannels ? ["sii", "ha", "oiii"] : ["ha", "oiii"];
    for (const isStars of (options.createStars ? [false, true] : [false])) {
      for (const channel of channels) {
        const layer = options[channel + (isStars ? "Stars" : "")];
        const bounds = layer.boundsNoEffects;
        if (bounds.left > 0 || bounds.top > 0 || bounds.right < doc.width || bounds.bottom < doc.height)
          throw new Error(`Layer "${layer.name}" must cover the whole canvas.`);
        const got = await imaging.getPixels({ documentID: doc.id, layerID: layer.id, componentSize: -1,
          applyAlpha: true, sourceBounds: { left: 0, top: 0, right: doc.width, bottom: doc.height },
          targetSize: { width, height } });
        try {
          const img = got.imageData;
          if (img.width !== width || img.height !== height) throw new Error("Source preview dimensions do not match.");
          (isStars ? stars : raw)[channel] = F.toGray(F.decode(await img.getData(), img.componentSize), img.components, img.hasAlpha);
          colorProfile = img.colorProfile;
        } finally { got.imageData.dispose(); }
      }
    }
    return { key, width, height, raw, stars, colorProfile };
  }, { commandName: "Read Foraxx preview sources" });
}

function previewPixels(cache, options) {
  const sources = F.prepareSources(cache.raw, options.gains, options.tuning);
  const rgb = F.foraxx(sources, sources, options.threeChannels, options.tuning);
  if (options.createStars) {
    const stars = F.foraxx(sources, cache.stars, options.threeChannels, options.tuning);
    for (const c of ["r", "g", "b"]) {
      for (let i = 0; i < rgb[c].length; i++) rgb[c][i] = 1 - (1 - rgb[c][i]) * (1 - stars[c][i]);
    }
  }
  const pixels = new Uint8Array(cache.width * cache.height * 3);
  for (let i = 0; i < rgb.r.length; i++) {
    pixels[i * 3] = Math.round(255 * F.clamp01(rgb.r[i]));
    pixels[i * 3 + 1] = Math.round(255 * F.clamp01(rgb.g[i]));
    pixels[i * 3 + 2] = Math.round(255 * F.clamp01(rgb.b[i]));
  }
  return pixels;
}

async function renderPreview(cache, options) {
  const data = await imaging.createImageDataFromBuffer(previewPixels(cache, options), {
    width: cache.width, height: cache.height, components: 3, colorSpace: "RGB", colorProfile: cache.colorProfile,
  });
  try { return "data:image/jpeg;base64," + await imaging.encodeImageData({ imageData: data, base64: true }); }
  finally { data.dispose(); }
}

module.exports = { previewKey, loadPreview, previewPixels, renderPreview };
