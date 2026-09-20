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

function docBits(doc) {
  const T = constants.BitsPerChannelType;
  if (doc.bitsPerChannel === T.EIGHT) return 8;
  if (doc.bitsPerChannel === T.SIXTEEN) return 16;
  return 32;
}

/** Reads a layer as one float gray sample per pixel over the whole canvas. */
async function readGray(doc, layer) {
  const bounds = { left: 0, top: 0, right: doc.width, bottom: doc.height };
  const got = await imaging.getPixels({ documentID: doc.id, layerID: layer.id, sourceBounds: bounds, componentSize: 32, applyAlpha: true });
  try {
    const img = got.imageData;
    if (img.width !== doc.width || img.height !== doc.height)
      throw new Error(`Layer "${layer.name}" must cover the whole canvas (got ${img.width}x${img.height}, need ${doc.width}x${doc.height}).`);
    const data = await img.getData({ chunky: true });
    return F.toGray(data, img.components, img.hasAlpha);
  } finally {
    got.imageData.dispose();
  }
}

async function rgbImageData(doc, floatsRGB) {
  const bits = docBits(doc);
  const samples = F.encode(floatsRGB, bits);
  return imaging.createImageDataFromBuffer(samples, { width: doc.width, height: doc.height, components: 3, colorSpace: "RGB", chunky: true });
}

async function grayImageData(doc, floats) {
  const bits = docBits(doc);
  const samples = F.encode(floats, bits);
  return imaging.createImageDataFromBuffer(samples, { width: doc.width, height: doc.height, components: 1, colorSpace: "Grayscale", chunky: true });
}

async function newPixelLayer(doc, parent, name, floatsRGB) {
  const layer = await doc.createLayer({ name, blendMode: constants.BlendMode.NORMAL, opacity: 100 });
  await layer.move(parent, constants.ElementPlacement.PLACEINSIDE);
  const img = await rgbImageData(doc, floatsRGB);
  try {
    await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: img, targetBounds: { left: 0, top: 0 }, commandName: "Foraxx layer" });
  } finally {
    img.dispose();
  }
  return layer;
}

async function setMask(doc, layer, floats) {
  const img = await grayImageData(doc, floats);
  try {
    await imaging.putLayerMask({ documentID: doc.id, layerID: layer.id, imageData: img, targetBounds: { left: 0, top: 0 }, commandName: "Foraxx mask" });
  } finally {
    img.dispose();
  }
}

async function newGroup(doc, parent, name, screen) {
  const group = await doc.createLayerGroup({ name, blendMode: screen ? constants.BlendMode.SCREEN : constants.BlendMode.NORMAL, opacity: 100 });
  if (parent) await group.move(parent, constants.ElementPlacement.PLACEINSIDE);
  return group;
}

/** Builds one set of Red/Green/Blue groups from a plan into `parent`. */
async function buildChannelGroups(doc, parent, plan, label) {
  // Groups are created top-down in Photoshop's stacking, so build in reverse
  // to end with Red at the bottom and Blue at the top.
  for (const group of [...plan].reverse()) {
    const g = await newGroup(doc, parent, `${group.name}${label}`, true);
    for (const layer of group.layers) {
      const l = await newPixelLayer(doc, g, `${layer.name} (${group.name.toLowerCase()})`, F.tint(layer.image, group.channel));
      if (layer.mask) {
        await setMask(doc, l, layer.mask);
        l.name = `${layer.name} (${group.name.toLowerCase()}) · mask ${layer.maskName}`;
      }
    }
  }
}

/**
 * options: { sii, ha, oiii, siiStars, haStars, oiiiStars (Layer|null),
 *            threeChannels, createStars, gains: {sii, ha, oiii}, name }
 */
async function buildForaxx(options) {
  const doc = app.activeDocument;
  if (!doc) throw new Error("Open a document first.");
  if (doc.mode !== constants.DocumentMode.RGB) throw new Error("The document must be in RGB mode.");

  const need = [["Ha", options.ha], ["OIII", options.oiii]];
  if (options.threeChannels) need.unshift(["SII", options.sii]);
  if (options.createStars) {
    if (options.threeChannels) need.push(["SII stars", options.siiStars]);
    need.push(["Ha stars", options.haStars], ["OIII stars", options.oiiiStars]);
  }
  const missing = need.filter(([, l]) => !l).map(([n]) => n);
  if (missing.length) throw new Error("Select a layer for: " + missing.join(", ") + ".");

  await core.executeAsModal(async (ctx) => {
    const history = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Build Foraxx palette" });
    try {
      const sources = {
        sii: options.threeChannels ? F.scaled(await readGray(doc, options.sii), options.gains.sii) : null,
        ha: F.scaled(await readGray(doc, options.ha), options.gains.ha),
        oiii: F.scaled(await readGray(doc, options.oiii), options.gains.oiii),
      };

      const root = await newGroup(doc, null, options.name || "Foraxx", false);
      const black = await newPixelLayer(doc, root, "Black", new Float32Array(doc.width * doc.height * 3));

      await buildChannelGroups(doc, root, F.planStack(sources, sources, options.threeChannels), "");

      if (options.createStars) {
        const stars = {
          sii: options.threeChannels ? await readGray(doc, options.siiStars) : null,
          ha: await readGray(doc, options.haStars),
          oiii: await readGray(doc, options.oiiiStars),
        };
        const starsGroup = await newGroup(doc, root, "Stars", true);
        await buildChannelGroups(doc, starsGroup, F.planStack(sources, stars, options.threeChannels), " stars");
      }
      void black;
    } finally {
      await ctx.hostControl.resumeHistory(history);
    }
  }, { commandName: "Build Foraxx palette" });
}

module.exports = { buildForaxx };
