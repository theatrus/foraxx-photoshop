/*
 * Foraxx palette math, independent of Photoshop so it can be unit-tested.
 *
 * Images are Float32Array samples in [0,1], row-major, one sample per pixel.
 * '~x' in the PixelMath original is 1 - x.
 *
 *   o  = OIII^~OIII
 *   ho = (Ha*OIII)^~(Ha*OIII)
 *   R  = o*SII + ~o*Ha        (two channels: R = Ha)
 *   G  = ho*Ha + ~ho*OIII
 *   B  = OIII
 *
 * Expressions: The Coldest Nights, "Dynamic Narrowband Combinations with
 * PixelMath". Original PixInsight script: Paul Hancock (Paulyman Astro).
 */

"use strict";

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Multiplies every sample by gain and clips at 1. Returns a new array. */
function scaled(img, gain) {
  const out = new Float32Array(img.length);
  for (let i = 0; i < img.length; i++) out[i] = clamp01(img[i] * gain);
  return out;
}

/** o = O^(1-O), per pixel. */
function oFactor(oiii) {
  const out = new Float32Array(oiii.length);
  for (let i = 0; i < oiii.length; i++) {
    const v = clamp01(oiii[i]);
    out[i] = clamp01(Math.pow(v, 1 - v));
  }
  return out;
}

/** ho = (Ha*O)^(1-Ha*O), per pixel. */
function hoFactor(ha, oiii) {
  const out = new Float32Array(ha.length);
  for (let i = 0; i < ha.length; i++) {
    const p = clamp01(ha[i]) * clamp01(oiii[i]);
    out[i] = clamp01(Math.pow(p, 1 - p));
  }
  return out;
}

/** factor*a + (1-factor)*b, per pixel. This is what a Normal layer with a mask does. */
function mix(factor, a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = clamp01(factor[i] * a[i] + (1 - factor[i]) * b[i]);
  return out;
}

/**
 * The layer plan. Each channel group holds a base layer and, for the mixed
 * channels, a top layer with a mask. Groups are screened together over black.
 *
 * sources: { sii?, ha, oiii } starless channels (already gain-scaled)
 * colour:  { sii?, ha, oiii } the images placed in the colour terms: the
 *          starless channels for the nebula stack, the star images for the
 *          stars stack. Factors always come from `sources`.
 *
 * Returns [{ name, channel, layers: [{ name, image, mask? }] }, ...] where
 * layers are listed bottom to top.
 */
function planStack(sources, colour, threeChannels) {
  const ho = hoFactor(sources.ha, sources.oiii);
  const red = threeChannels
    ? { name: "Red", channel: 0, layers: [
        { name: "Ha", image: colour.ha },
        { name: "SII", image: colour.sii, mask: oFactor(sources.oiii), maskName: "o = OIII^~OIII" },
      ] }
    : { name: "Red", channel: 0, layers: [{ name: "Ha", image: colour.ha }] };
  const green = { name: "Green", channel: 1, layers: [
    { name: "OIII", image: colour.oiii },
    { name: "Ha", image: colour.ha, mask: ho, maskName: "ho = (Ha*OIII)^~(Ha*OIII)" },
  ] };
  const blue = { name: "Blue", channel: 2, layers: [{ name: "OIII", image: colour.oiii }] };
  return [red, green, blue];
}

/**
 * Simulates what Photoshop does with the plan: inside each group, layers
 * composite Normal (a mask is a per-pixel opacity); each group is then
 * screened over the running result, which starts black. Returns {r,g,b}.
 * Used by the tests to prove the stack reproduces the formula.
 */
function compositeStack(plan, n) {
  const rgb = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (const group of plan) {
    let acc = new Float32Array(n);
    for (const layer of group.layers) {
      acc = layer.mask ? mix(layer.mask, layer.image, acc) : Float32Array.from(layer.image, clamp01);
    }
    const out = rgb[group.channel];
    for (let i = 0; i < n; i++) out[i] = 1 - (1 - out[i]) * (1 - acc[i]); // screen
  }
  return { r: rgb[0], g: rgb[1], b: rgb[2] };
}

/** The reference formula, computed directly. */
function foraxx(sources, colour, threeChannels) {
  const ho = hoFactor(sources.ha, sources.oiii);
  const r = threeChannels ? mix(oFactor(sources.oiii), colour.sii, colour.ha) : Float32Array.from(colour.ha, clamp01);
  const g = mix(ho, colour.ha, colour.oiii);
  const b = Float32Array.from(colour.oiii, clamp01);
  return { r, g, b };
}

/** A gray image tinted into one RGB channel: chunky RGB buffer with zeros elsewhere. */
function tint(img, channel) {
  const out = new Float32Array(img.length * 3);
  for (let i = 0; i < img.length; i++) out[i * 3 + channel] = clamp01(img[i]);
  return out;
}

/**
 * Converts float samples to Photoshop's storage for a bit depth:
 * 8 -> Uint8Array 0..255, 16 -> Uint16Array 0..32768 (Photoshop's reduced
 * 16-bit range, the imaging API default), 32 -> Float32Array 0..1.
 */
function encode(floats, bits) {
  if (bits === 32) return Float32Array.from(floats, clamp01);
  const max = bits === 8 ? 255 : 32768;
  const out = bits === 8 ? new Uint8Array(floats.length) : new Uint16Array(floats.length);
  for (let i = 0; i < floats.length; i++) out[i] = Math.round(clamp01(floats[i]) * max);
  return out;
}

/** Inverse of encode for reading. Float input is returned clamped. */
function decode(samples, bits) {
  const out = new Float32Array(samples.length);
  const max = bits === 8 ? 255 : bits === 16 ? 32768 : 1;
  for (let i = 0; i < samples.length; i++) out[i] = clamp01(samples[i] / max);
  return out;
}

/**
 * Reduces a chunky buffer with `components` per pixel to one gray sample
 * per pixel by averaging the colour components (alpha ignored).
 */
function toGray(samples, components, hasAlpha) {
  const colour = hasAlpha ? components - 1 : components;
  const n = samples.length / components;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < colour; c++) s += samples[i * components + c];
    out[i] = s / colour;
  }
  return out;
}

module.exports = { clamp01, scaled, oFactor, hoFactor, mix, planStack, compositeStack, foraxx, tint, encode, decode, toGray };
