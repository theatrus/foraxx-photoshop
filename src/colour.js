"use strict";

// FPU curve control points: Copyright (C) 2023-2024 Paul Hancock and
// Copyright (C) 2026 Yann Ramin. Apache-2.0; see licenses/FPU-LICENSE.txt.
// Independent JavaScript implementation. Colour finishing uses document RGB / D50 Lab;
// this is not a pixel-identical implementation of PixInsight's native processes.
const { clamp01 } = require('./foraxx.js');
const { getSpace } = require('./color-space.js');
const { toLab, fromLab } = getSpace();

function akima(points) {
  const n = points.length, slopes = [];
  for (let i = 0; i < n - 1; i++) slopes[i + 2] = (points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]);
  slopes[1] = 2 * slopes[2] - slopes[3]; slopes[0] = 2 * slopes[1] - slopes[2];
  slopes[n + 1] = 2 * slopes[n] - slopes[n - 1]; slopes[n + 2] = 2 * slopes[n + 1] - slopes[n];
  const tangent = points.map((_, i) => {
    const a = Math.abs(slopes[i + 3] - slopes[i + 2]), b = Math.abs(slopes[i + 1] - slopes[i]);
    return a + b > 1e-12 ? (a * slopes[i + 1] + b * slopes[i + 2]) / (a + b) : (slopes[i + 1] + slopes[i + 2]) / 2;
  });
  return x => {
    if (x <= points[0][0]) return points[0][1];
    if (x >= points[n - 1][0]) return points[n - 1][1];
    let i = 0;
    while (x > points[i + 1][0]) i++;
    const h = points[i + 1][0] - points[i][0], t = (x - points[i][0]) / h;
    return (2*t*t*t - 3*t*t + 1) * points[i][1] + (t*t*t - 2*t*t + t) * h * tangent[i] +
      (-2*t*t*t + 3*t*t) * points[i + 1][1] + (t*t*t - t*t) * h * tangent[i + 1];
  };
}
const hue1 = akima([[0,0],[0.02517,0.05952],[0.07323,0.08571],[0.11442,0.13810],[0.62014,0.67619],[1,1]]);
const hue2 = akima([[0,0],[0.05034,0.03571],[0.08238,0.10238],[0.24943,0.25],[1,1]]);
const satCurve = akima([[0,0],[0.50801,0.61667],[1,1]]);
const selective = akima([[0,0],[0.04910,0.00909],[0.07235,0.00909],[0.10594,0.15455],[0.19380,0.00909],
  [0.37726,0],[0.52972,0.00909],[0.60465,0.13636],[0.68475,-0.00909],[0.84496,0],[1,0]]);
const starHue = akima([[0,0.05476],[0.12815,0.12857],[0.24943,0.24524],[0.373,0.37857],
  [0.49886,0.6],[0.62471,0.62619],[0.75057,0.74048],[0.87872,0.87381],[1,1]]);

function toHSV(r, g, b) {
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max-min;
  let h = !d ? 0 : max === r ? ((g-b)/d + 6) % 6 : max === g ? (b-r)/d + 2 : (r-g)/d + 4;
  return [h/6, max > 0 ? d/max : 0, max];
}
function fromHSV(h,s,v) {
  const c = v*s, hh = ((h % 1)+1)%1 * 6, x = c*(1-Math.abs(hh%2-1)), m = v-c;
  return (hh < 1 ? [c,x,0] : hh < 2 ? [x,c,0] : hh < 3 ? [0,c,x] : hh < 4 ? [0,x,c] : hh < 5 ? [x,0,c] : [c,0,x]).map(a => clamp01(a+m));
}
function hsvCurve(rgb, hue, sat, space = getSpace()) {
  const { toLab, fromLab } = space;
  const l = toLab(...rgb)[0], hsv = toHSV(...rgb);
  const out = fromHSV(clamp01(hue ? hue(hsv[0]) : hsv[0]), clamp01(sat ? sat(hsv[1], hsv[0]) : hsv[1]), hsv[2]);
  const lab = toLab(...out);
  return fromLab(l, lab[1], lab[2]);
}
const boost = (s, amount) => clamp01(s * (amount >= 0 ? 1 + amount : 1 / (1 - amount)));

// Undecimated B3-spline residual after discarding the first N detail layers.
function smoothChroma(input, width, height, layers) {
  let out = input;
  const weights = [1/16, 4/16, 6/16, 4/16, 1/16];
  for (let level = 0; level < layers; level++) {
    const step = 2 ** level, tmp = new Float32Array(out.length), next = new Float32Array(out.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += weights[k+2] * out[y*width + Math.max(0, Math.min(width-1,x+k*step))];
      tmp[y*width+x] = sum;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += weights[k+2] * tmp[Math.max(0, Math.min(height-1,y+k*step))*width+x];
      next[y*width+x] = sum;
    }
    out = next;
  }
  return out;
}
const noiseLayers = (o, scale = 1) => o.colourNoiseReduction ? Math.max(0, Math.round(o.colourNoiseLayers + Math.log2(scale))) : 0;
const noiseRadius = (o, scale = 1) => 2 * (2 ** noiseLayers(o, scale) - 1);
function finish(rgb, options, width, height, scale = 1, stars = false, colorProfile) {
  const space = getSpace(colorProfile), { toLab, fromLab } = space;
  const curve = (rgb,hue,sat) => hsvCurve(rgb,hue,sat,space);
  const n = rgb.r.length, result = { r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n) };
  let labChannels;
  const layers = stars ? 0 : noiseLayers(options, scale);
  if (layers) {
    labChannels = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i=0;i<n;i++) { const lab = toLab(rgb.r[i],rgb.g[i],rgb.b[i]); for (let c=0;c<3;c++) labChannels[c][i]=lab[c]; }
    for (const c of [1,2]) labChannels[c] = smoothChroma(labChannels[c],width,height,layers);
  }
  const satmask = !stars && options.protectedSaturation && options.saturationAmount > 0 ? new Float32Array(n) : null;
  const lift = options.lightnessLift ? akima([[0,0],[0.5,0.5+options.lightnessLift],[1,1]]) : null;
  for (let i=0;i<n;i++) {
    let pixel = labChannels ? fromLab(labChannels[0][i],labChannels[1][i],labChannels[2][i]) : [rgb.r[i],rgb.g[i],rgb.b[i]];
    if (options.applyAdjustments) {
      if (stars) pixel = curve(pixel,starHue);
      else {
        const original = pixel, l = toLab(...original)[0];
        pixel = curve(curve(pixel,hue1,satCurve),hue2);
        for (let pass=0;pass<2;pass++) pixel = curve(pixel,null,(s,h) => boost(s,selective(h)));
        if (options.protectBackground) {
          const weight = clamp01((l-options.saturationBackground)/Math.max(1e-6,options.saturationBackground));
          const hueOnly = curve(curve(original,hue1),hue2);
          pixel = pixel.map((v,c) => weight*v + (1-weight)*hueOnly[c]);
        }
      }
    }
    if (satmask) {
      const weight = clamp01((toLab(...pixel)[0]-options.saturationBackground)/(1-options.saturationBackground)) * (1-toHSV(...pixel)[1]);
      satmask[i] = weight;
      const saturated = curve(pixel,null,s => boost(s,options.saturationAmount));
      pixel = pixel.map((v,c) => weight*saturated[c] + (1-weight)*v);
    }
    if (!stars && lift) { const lab = toLab(...pixel); pixel = fromLab(clamp01(lift(lab[0])),lab[1],lab[2]); }
    result.r[i]=pixel[0]; result.g[i]=pixel[1]; result.b[i]=pixel[2];
  }
  return { rgb: result, satmask };
}
module.exports = { akima, toLab, fromLab, toHSV, fromHSV, smoothChroma, noiseRadius, finish };
