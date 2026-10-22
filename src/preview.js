/*
 * Foraxx Palette for Photoshop
 * Copyright 2026 Yann Ramin
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0. See LICENSE
 * and NOTICE in this distribution.
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Foraxx palette and its expressions are the work of The Coldest Nights:
 * https://thecoldestnights.com/2020/06/pixinsight-dynamic-narrowband-combinations-with-pixelmath/
 */
"use strict";

const { core, imaging } = require("photoshop");
const F = require("./foraxx.js");
const R = require("./render.js");
const { getSpace, SRGB } = require('./color-space.js');
const { validateOptions } = require("./psbuild.js");

function previewRegion(doc,options) {
  const bounded=(value,fallback,low,high)=>Number.isFinite(value)?Math.max(low,Math.min(high,value)):fallback;
  const zoom=bounded(options.previewZoom,1,1,32), width=Math.max(1,Math.round(doc.width/zoom)), height=Math.max(1,Math.round(doc.height/zoom));
  const left=Math.round((doc.width-width)*bounded(options.previewX,50,0,100)/100);
  const top=Math.round((doc.height-height)*bounded(options.previewY,50,0,100)/100);
  return {left,top,right:left+width,bottom:top+height};
}

// Cache only source thumbnails. Changing tuning never rereads a 100 MP layer.
function previewKey(options) {
  const doc = validateOptions(options);
  const keys = options.threeChannels ? ["sii", "ha", "oiii"] : ["ha", "oiii"];
  if (options.createStars) keys.push(...(options.threeChannels ? ["siiStars", "haStars", "oiiiStars"] : ["haStars", "oiiiStars"]));
  return JSON.stringify([doc.id, doc.activeHistoryState.id, doc.colorProfileName, keys.map(k => options[k].id),previewRegion(doc,options)]);
}

async function loadPreview(options, maxEdge = 512) {
  const doc = validateOptions(options), key = previewKey(options);
  const region=previewRegion(doc,options), regionWidth=region.right-region.left, regionHeight=region.bottom-region.top;
  const scale = Math.min(1, maxEdge / Math.max(regionWidth,regionHeight));
  const width = Math.max(1, Math.round(regionWidth * scale)), height = Math.max(1, Math.round(regionHeight * scale));
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
          applyAlpha: true, sourceBounds: region,
          targetSize: { width, height } });
        try {
          const img = got.imageData;
          if (img.width !== width || img.height !== height) throw new Error("Source preview dimensions do not match.");
          (isStars ? stars : raw)[channel] = F.toGray(F.decode(await img.getData(), img.componentSize), img.components, img.hasAlpha);
          colorProfile = img.colorProfile;
        } finally { got.imageData.dispose(); }
      }
    }
    return { key, width, height, scale, region, raw, stars, colorProfile };
  }, { commandName: "Read Foraxx preview sources" });
}

function previewPixels(cache, options, forDisplay = false) {
  const rendered=R.render(cache.raw,cache.stars,{...options,
    colorProfile: cache.colorProfile,
    createFactorImages: options.createFactorImages || options.previewTarget?.startsWith('factor_'),
    createRatioMasks: options.createRatioMasks || options.previewTarget?.startsWith('ratio_')},cache.width,cache.height,cache.scale ?? 1);
  const rgb=R.displayed(rendered,options);
  // The panel thumbnail uses sRGB. Keep all image processing and output layers
  // in document RGB; only this display copy may clip colors outside sRGB.
  let sourceSpace;
  const maskView = Boolean(rendered.exports[options.previewTarget]);
  if (forDisplay && !maskView && cache.colorProfile !== SRGB) {
    try { sourceSpace=getSpace(cache.colorProfile || ''); } catch (_) { /* Other profiles retain the legacy tagged preview. */ }
  }
  const pixels = new Uint8Array(cache.width * cache.height * 3);
  for (let i = 0; i < rgb.r.length; i++) {
    const pixel=sourceSpace ? getSpace().fromLab(...sourceSpace.toLab(rgb.r[i],rgb.g[i],rgb.b[i])) : [rgb.r[i],rgb.g[i],rgb.b[i]];
    for (let c=0;c<3;c++) pixels[i*3+c]=Math.round(255*F.clamp01(pixel[c]));
  }
  return pixels;
}

async function renderPreview(cache, options) {
  let colorProfile=cache.colorProfile;
  try { getSpace(colorProfile || ''); colorProfile=SRGB; } catch (_) { /* Unrecognized profile, finishing disabled. */ }
  if (options.previewTarget?.includes('mask') || options.previewTarget?.startsWith('factor_') || options.previewTarget?.startsWith('ratio_')) colorProfile=SRGB;
  const data = await imaging.createImageDataFromBuffer(previewPixels(cache, options, true), {
    width: cache.width, height: cache.height, components: 3, colorSpace: "RGB", colorProfile,
  });
  try { return "data:image/jpeg;base64," + await imaging.encodeImageData({ imageData: data, base64: true }); }
  finally { data.dispose(); }
}

module.exports = { previewKey, loadPreview, previewPixels, renderPreview, previewRegion };
