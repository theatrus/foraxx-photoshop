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
/*
 * Photoshop side: reads the source layers, computes the Foraxx plan, and
 * builds the layer stack with the UXP imaging API and the Photoshop DOM.
 *
 * Stack (bottom to top), all inside one group named after the palette:
 *
 *   Black                      solid black, the base the channels screen onto
 *   Red   (group, Screen)      Ha tinted red; SII tinted red with mask o
 *   Green (group, Screen)      OIII tinted green; Ha tinted green with mask ho
 *   Blue  (group, Screen)      OIII tinted blue
 *   Stars (group, Screen)      the same three groups built from the star
 *                              images, masks still from the starless data
 *
 * Non-linear parts of Foraxx live only in the two masks, computed here as
 * pixels. The rest is Normal-with-mask (a linear mix) and Screen of layers
 * that occupy disjoint channels (exact addition). Merge anything you like.
 */

"use strict";

const { app, core, imaging, constants } = require("photoshop");
const F = require("./foraxx.js");

// Bound temporary JavaScript buffers even for drizzled, 100+ MP images.
const TILE_PIXELS = 2 * 1024 * 1024;

function docBits(doc) {
  const T = constants.BitsPerChannelType;
  if (doc.bitsPerChannel === T.EIGHT) return 8;
  if (doc.bitsPerChannel === T.SIXTEEN) return 16;
  return 32;
}

/** Reads one full-width strip at native depth, without resampling. */
async function readGray(doc, layer, bounds) {
  // Request native depth: conversion to 32-bit linearizes 8/16-bit RGB values.
  const got = await imaging.getPixels({ documentID: doc.id, layerID: layer.id, sourceBounds: bounds, componentSize: -1, applyAlpha: true });
  try {
    const img = got.imageData;
    if (img.width !== bounds.right - bounds.left || img.height !== bounds.bottom - bounds.top ||
        got.sourceBounds.left !== bounds.left || got.sourceBounds.top !== bounds.top)
      throw new Error(`Layer "${layer.name}" must cover the whole canvas (missing pixels in rows ${bounds.top + 1}–${bounds.bottom}).`);
    const data = await img.getData({ chunky: true });
    return F.toGray(F.decode(data, img.componentSize), img.components, img.hasAlpha);
  } finally {
    got.imageData.dispose();
  }
}

async function rgbImageData(doc, floatsRGB, bounds) {
  const bits = docBits(doc);
  const samples = F.encode(floatsRGB, bits);
  return imaging.createImageDataFromBuffer(samples, { width: doc.width, height: bounds.bottom - bounds.top, components: 3, colorSpace: "RGB", chunky: true });
}

async function grayImageData(doc, floats, bounds) {
  const bits = docBits(doc);
  const samples = F.encode(floats, bits);
  return imaging.createImageDataFromBuffer(samples, { width: doc.width, height: bounds.bottom - bounds.top, components: 1, colorSpace: "Grayscale", chunky: true });
}

async function newPixelLayer(doc, parent, name) {
  const layer = await doc.createLayer({ name, blendMode: constants.BlendMode.NORMAL, opacity: 100 });
  await layer.move(parent, constants.ElementPlacement.PLACEINSIDE);
  return layer;
}

async function writePixels(doc, layer, floatsRGB, bounds) {
  const img = await rgbImageData(doc, floatsRGB, bounds);
  try {
    await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: img,
      replace: bounds.top === 0, targetBounds: { left: 0, top: bounds.top }, commandName: "Foraxx layer" });
  } finally {
    img.dispose();
  }
}

async function setMask(doc, layer, floats, bounds) {
  const img = await grayImageData(doc, floats, bounds);
  try {
    await imaging.putLayerMask({ documentID: doc.id, layerID: layer.id, imageData: img,
      replace: bounds.top === 0, targetBounds: { left: 0, top: bounds.top }, commandName: "Foraxx mask" });
  } finally {
    img.dispose();
  }
}

async function newGroup(doc, parent, name, screen) {
  const group = await doc.createLayerGroup({ name, blendMode: screen ? constants.BlendMode.SCREEN : constants.BlendMode.NORMAL, opacity: 100 });
  if (parent) await group.move(parent, constants.ElementPlacement.PLACEINSIDE);
  return group;
}

/** Creates the layer structure once; subsequent strips reuse those layers. */
async function writeChannelGroups(doc, parent, plan, label, bounds, existing) {
  const output = existing || [];
  // PLACEINSIDE inserts at the top, so create the bottom group first.
  for (let i = 0; i < plan.length; i++) {
    const group = plan[i];
    if (!existing) output[i] = { group: await newGroup(doc, parent, `${group.name}${label}`, true), layers: [] };
    for (let j = 0; j < group.layers.length; j++) {
      const layer = group.layers[j];
      if (!existing) output[i].layers[j] = await newPixelLayer(doc, output[i].group, `${layer.name} (${group.name.toLowerCase()})`);
      const l = output[i].layers[j];
      await writePixels(doc, l, F.tint(layer.image, group.channel), bounds);
      if (layer.mask) {
        await setMask(doc, l, layer.mask, bounds);
        if (!existing) l.name = `${layer.name} (${group.name.toLowerCase()}) · mask ${layer.maskName}`;
      }
    }
  }
  return output;
}

/**
 * options: { sii, ha, oiii, siiStars, haStars, oiiiStars (Layer|null),
 *            threeChannels, createStars, gains: {sii, ha, oiii},
 *            tuning?: {redBias, redContrast, greenBias, greenContrast, oiiiMidtone}, name }
 */
function validateOptions(options) {
  const doc = app.activeDocument;
  if (!doc) throw new Error("Open a document first.");
  if (doc.mode !== constants.DocumentMode.RGB) throw new Error("The document must be in RGB mode.");
  if (docBits(doc) === 32) throw new Error("Use an 8- or 16-bit RGB document. Photoshop does not support Screen blending at 32 bits per channel.");

  const need = [["Ha", options.ha], ["OIII", options.oiii]];
  if (options.threeChannels) need.unshift(["SII", options.sii]);
  if (options.createStars) {
    if (options.threeChannels) need.push(["SII stars", options.siiStars]);
    need.push(["Ha stars", options.haStars], ["OIII stars", options.oiiiStars]);
  }
  const missing = need.filter(([, l]) => !l).map(([n]) => n);
  if (missing.length) throw new Error("Select a layer for: " + missing.join(", ") + ".");
  return doc;
}

async function buildForaxx(options) {
  const doc = validateOptions(options);

  await core.executeAsModal(async (ctx) => {
    const history = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Build Foraxx palette" });
    let complete = false;
    try {
      const root = await newGroup(doc, null, options.name || "Foraxx", false);
      if (doc.layers[0].id !== root.id) await root.move(doc.layers[0], constants.ElementPlacement.PLACEBEFORE);
      const black = await newPixelLayer(doc, root, "Black");
      let nebulaLayers, starsGroup, starsLayers;
      const rows = Math.max(1, Math.floor(TILE_PIXELS / doc.width));
      for (let top = 0; top < doc.height; top += rows) {
        if (ctx.isCancelled) throw new Error("Build cancelled.");
        const bounds = { left: 0, top, right: doc.width, bottom: Math.min(top + rows, doc.height) };
        const sources = F.prepareSources({
          sii: options.threeChannels ? await readGray(doc, options.sii, bounds) : null,
          ha: await readGray(doc, options.ha, bounds),
          oiii: await readGray(doc, options.oiii, bounds),
        }, options.gains, options.tuning);
        await writePixels(doc, black, new Float32Array(doc.width * (bounds.bottom - top) * 3), bounds);
        nebulaLayers = await writeChannelGroups(doc, root, F.planStack(sources, sources, options.threeChannels, options.tuning), "", bounds, nebulaLayers);

        if (options.createStars) {
          const stars = {
            sii: options.threeChannels ? await readGray(doc, options.siiStars, bounds) : null,
            ha: await readGray(doc, options.haStars, bounds),
            oiii: await readGray(doc, options.oiiiStars, bounds),
          };
          if (!starsGroup) starsGroup = await newGroup(doc, root, "Stars", true);
          starsLayers = await writeChannelGroups(doc, starsGroup, F.planStack(sources, stars, options.threeChannels, options.tuning), " stars", bounds, starsLayers);
        }
        ctx.reportProgress({ value: bounds.bottom / doc.height });
      }
      complete = true;
    } finally {
      // Failed reads or writes must not leave a half-built palette behind.
      await ctx.hostControl.resumeHistory(history, complete);
    }
  }, { commandName: "Build Foraxx palette" });
}

module.exports = { buildForaxx, validateOptions };
