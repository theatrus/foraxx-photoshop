"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../src/foraxx.js");

const W = 16, H = 12, N = W * H;
const gen = (fn) => { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = fn(i % W, Math.floor(i / W)); return a; };
const sii = gen((x, y) => 0.05 + 0.45 * (1 - x / (W - 1)) + 0.25 * (y / (H - 1)));
const ha = gen((x) => 0.05 + 0.9 * (x / (W - 1)));
const oiii = gen((_, y) => 0.05 + 0.9 * (y / (H - 1)));
const siiStars = gen((x, y) => 0.1 + 0.6 * (((x + y) % 7) / 6));
const haStars = gen((x, y) => 0.2 + 0.7 * (((x * 3 + y) % 5) / 4));
const oiiiStars = gen((x, y) => 0.15 + 0.5 * (((x + y * 2) % 9) / 8));

const near = (a, b, tol = 1e-6) => { assert.equal(a.length, b.length); for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol, `sample ${i}: ${a[i]} vs ${b[i]}`); };

test("factors match the PixelMath definitions", () => {
  const o = F.oFactor(oiii), ho = F.hoFactor(ha, oiii);
  for (let i = 0; i < N; i++) {
    assert.ok(Math.abs(o[i] - Math.pow(oiii[i], 1 - oiii[i])) < 1e-6);
    const p = ha[i] * oiii[i];
    assert.ok(Math.abs(ho[i] - Math.pow(p, 1 - p)) < 1e-6);
  }
});

test("three-channel layer stack screens to the Foraxx formula", () => {
  const src = { sii, ha, oiii };
  const plan = F.planStack(src, src, true);
  assert.deepEqual(plan.map((g) => g.name), ["Red", "Green", "Blue"]);
  assert.equal(plan[0].layers[1].mask.length, N);
  const got = F.compositeStack(plan, N), want = F.foraxx(src, src, true);
  near(got.r, want.r); near(got.g, want.g); near(got.b, want.b);
  // R really is o*SII + ~o*Ha
  const o = F.oFactor(oiii);
  for (let i = 0; i < N; i++) assert.ok(Math.abs(got.r[i] - (o[i] * sii[i] + (1 - o[i]) * ha[i])) < 1e-6);
});

test("two-channel stack: red is plain Ha", () => {
  const src = { ha, oiii };
  const plan = F.planStack(src, src, false);
  assert.equal(plan[0].layers.length, 1);
  const got = F.compositeStack(plan, N), want = F.foraxx(src, src, false);
  near(got.r, ha); near(got.g, want.g); near(got.b, oiii);
});

test("stars stack uses star images in the colour terms and starless factors", () => {
  const src = { sii, ha, oiii }, stars = { sii: siiStars, ha: haStars, oiii: oiiiStars };
  const got = F.compositeStack(F.planStack(src, stars, true), N);
  const o = F.oFactor(oiii), ho = F.hoFactor(ha, oiii);
  for (let i = 0; i < N; i++) {
    assert.ok(Math.abs(got.r[i] - (o[i] * siiStars[i] + (1 - o[i]) * haStars[i])) < 1e-6);
    assert.ok(Math.abs(got.g[i] - (ho[i] * haStars[i] + (1 - ho[i]) * oiiiStars[i])) < 1e-6);
    assert.ok(Math.abs(got.b[i] - oiiiStars[i]) < 1e-6);
  }
});

test("gains scale and clip before the factors", () => {
  const s = F.scaled(oiii, 1.5);
  for (let i = 0; i < N; i++) assert.equal(s[i], Math.min(1, Math.fround(oiii[i] * 1.5)));
});

test("tint puts the gray in one channel and zeros elsewhere", () => {
  const t = F.tint(ha, 1);
  assert.equal(t.length, N * 3);
  for (let i = 0; i < N; i++) { assert.equal(t[i * 3], 0); assert.equal(t[i * 3 + 1], ha[i]); assert.equal(t[i * 3 + 2], 0); }
});

test("encode/decode round trip at 8, 16 and 32 bits", () => {
  const v = Float32Array.from([0, 0.25, 0.5, 1, 1.2, -0.1]);
  assert.deepEqual(Array.from(F.encode(v, 8)), [0, 64, 128, 255, 255, 0]);
  assert.deepEqual(Array.from(F.encode(v, 16)), [0, 8192, 16384, 32768, 32768, 0]);
  assert.deepEqual(Array.from(F.encode(v, 32)), [0, 0.25, 0.5, 1, 1, 0]);
  near(F.decode(F.encode(v, 16), 16), Float32Array.from([0, 0.25, 0.5, 1, 1, 0]));
});

test("toGray averages colour components and ignores alpha", () => {
  const rgba = Float32Array.from([0.2, 0.4, 0.6, 1, 1, 1, 1, 0.5]);
  near(F.toGray(rgba, 4, true), Float32Array.from([0.4, 1]));
  near(F.toGray(Float32Array.from([0.3, 0.7]), 1, false), Float32Array.from([0.3, 0.7]));
});
