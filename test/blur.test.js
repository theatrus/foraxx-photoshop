"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/foraxx.js');
const near = (a, b) => {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 2e-7, `sample ${i}: ${a[i]} != ${b[i]}`);
};

// Independent direct 2D convolution, including edges and one-pixel dimensions.
function reference(input, width, height, sigma) {
  const radius = Math.ceil(4 * sigma);
  return Float32Array.from(input, (_, i) => {
    let sum = 0, total = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const w = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      const x = Math.max(0, Math.min(width - 1, i % width + dx));
      const y = Math.max(0, Math.min(height - 1, Math.floor(i / width) + dy));
      sum += w * input[y * width + x]; total += w;
    }
    return sum / total;
  });
}

test('Gaussian agrees with independent 2D convolution at edges and on tiny images', () => {
  for (const [width, height] of [[7, 5], [1, 5], [7, 1], [1, 1]]) {
    const input = Float32Array.from({ length: width * height }, (_, i) => (i * 37 % 101) / 100);
    for (const sigma of [0.3, 0.7, 2, 25]) near(F.gaussianBlur(input, width, height, sigma), reference(input, width, height, sigma));
    assert.strictEqual(F.gaussianBlur(input, width, height, 0), input);
  }
  const constant = new Float32Array(35).fill(0.4);
  near(F.gaussianBlur(constant, 7, 5, 2), constant);
});

test('PI order: smooth shaped sources, then factors, then mask shaping; keep color detail', () => {
  const width = 9, height = 7, n = width * height;
  const raw = { sii: new Float32Array(n).fill(0.8),
    ha: Float32Array.from({ length: n }, (_, i) => i % 3 ? 0.1 : 0.7),
    oiii: Float32Array.from({ length: n }, (_, i) => i % 2 ? 0.9 : 0.05) };
  const tuning = { maskBlur: 2, oiiiMidtone: 0.3, redBias: 0.5, greenContrast: 2 };
  const src = F.prepareSources(raw, { ha: 1.2 }, tuning);
  const masks = F.mixingMasks(src, true, tuning, width, height);
  const h = reference(src.ha, width, height, 2), o = reference(src.oiii, width, height, 2);
  near(masks.o, F.shapeMask(F.oFactor(o), 0.5, 1));
  near(masks.ho, F.shapeMask(F.hoFactor(h, o), 0, 2));
  const postBlur = F.gaussianBlur(F.oFactor(src.oiii), width, height, 2);
  assert.ok(masks.o.some((v, i) => Math.abs(v - postBlur[i]) > 0.01));
  for (const three of [false, true]) for (const colour of [src, raw]) {
    const plan = F.planStack(src, colour, three, tuning, masks);
    const rgb = F.compositeStack(plan, n);
    near(rgb.r, three ? F.mix(masks.o, colour.sii, colour.ha) : colour.ha);
    near(rgb.g, F.mix(masks.ho, colour.ha, colour.oiii));
    near(rgb.b, colour.oiii);
    assert.strictEqual(plan[2].layers[0].image, colour.oiii);
  }
});

test('overlapping strips match a whole-image blur, including partial strips', () => {
  const width = 13, height = 79;
  const sources = { ha: Float32Array.from({ length: width * height }, (_, i) => (i * 23 % 103) / 103),
    oiii: Float32Array.from({ length: width * height }, (_, i) => (i * 73 % 109) / 109) };
  for (const sigma of [0, 0.3, 2, 25]) {
    const tuning = { maskBlur: sigma, greenBias: 0.3, redContrast: 2 };
    const full = F.mixingMasks(sources, true, tuning, width, height);
    const radius = F.gaussianRadius(sigma);
    for (let top = 0; top < height; top += 17) {
      const bottom = Math.min(top + 17, height), start = Math.max(0, top - radius), end = Math.min(height, bottom + radius);
      const part = F.mixingMasks({ ha: sources.ha.subarray(start * width, end * width),
        oiii: sources.oiii.subarray(start * width, end * width) }, true, tuning, width, end - start);
      for (const key of ['o', 'ho']) near(part[key].subarray((top - start) * width, (bottom - start) * width), full[key].subarray(top * width, bottom * width));
    }
  }
});

test('preview scales blur in full-image pixels and original reset disables it', () => {
  const sources = { ha: Float32Array.of(0.1, 0.8, 0.2), oiii: Float32Array.of(0.9, 0.1, 0.7) };
  assert.deepEqual(F.mixingMasks(sources, true, { maskBlur: 4 }, 3, 1, 0.5), F.mixingMasks(sources, true, { maskBlur: 2 }, 3, 1));
  assert.deepEqual(F.mixingMasks(sources, true, { maskBlur: 2 }, 3, 1, 0.1), F.mixingMasks(sources, true, F.ORIGINAL));
  assert.equal(F.ORIGINAL.maskBlur, 0);
  assert.equal(F.tuningOptions({ maskBlur: -1 }).maskBlur, 0);
  assert.equal(F.tuningOptions({ maskBlur: 100 }).maskBlur, 25);
  assert.equal(F.tuningOptions({ maskBlur: NaN }).maskBlur, 0);
});
