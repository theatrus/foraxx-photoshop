"use strict";

const DEFAULTS = Object.freeze({ palette: "Foraxx", combineStars: true, createFactorImages: false,
  createRatioMasks: false, ratioThreshold: 0.05, applyAdjustments: false, protectBackground: false,
  protectedSaturation: false, saturationAmount: 0.25, saturationBackground: 0.1,
  lightnessLift: 0, colourNoiseReduction: false, colourNoiseLayers: 2 });
const PALETTES = Object.freeze({ Foraxx: null, SHO: ['sii', 'ha', 'oiii'], HOO: ['ha', 'oiii', 'oiii'],
  HSO: ['ha', 'sii', 'oiii'], OHS: ['oiii', 'ha', 'sii'] });

function normalize(options = {}) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(out)) {
    if (typeof out[key] === 'boolean' && typeof options[key] === 'boolean') out[key] = options[key];
  }
  out.palette = Object.prototype.hasOwnProperty.call(PALETTES, options.palette) ? options.palette : 'Foraxx';
  for (const [key, low, high] of [['ratioThreshold', 0, 0.5], ['saturationAmount', 0, 1],
    ['saturationBackground', 0, 0.5], ['lightnessLift', -0.3, 0.3], ['colourNoiseLayers', 1, 4]]) {
    if (Number.isFinite(options[key])) out[key] = Math.max(low, Math.min(high, options[key]));
  }
  out.colourNoiseLayers = Math.round(out.colourNoiseLayers);
  return out;
}
const finishing = o => o.applyAdjustments || o.colourNoiseReduction || (o.protectedSaturation && o.saturationAmount > 0) || o.lightnessLift !== 0;
module.exports = { DEFAULTS, PALETTES, normalize, finishing };
