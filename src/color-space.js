"use strict";

const { clamp01 } = require('./foraxx.js');
const SRGB = 'sRGB IEC61966-2.1';
const srgbDecode = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const srgbEncode = v => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
const power = gamma => ({ decode: v => v ** gamma, encode: v => Math.max(0, v) ** (1 / gamma) });

// D50 PCS colorants and TRCs of the standard Adobe-supplied ICC profiles.
// In particular, Photoshop's ProPhoto profile has a pure gamma TRC (461/256),
// not the shadow toe of the CSS/ROMM RGB encoding. No ICC files are bundled.
const definitions = {
  [SRGB]: {
    matrix: [[0.4360747,0.3850649,0.1430804],[0.2225045,0.7168786,0.0606169],[0.0139322,0.0971045,0.7141733]],
    inverse: [[3.1338561,-1.6168667,-0.4906146],[-0.9787684,1.9161415,0.033454],[0.0719453,-0.2289914,1.4052427]],
    white: [0.96422,1,0.82521], decode: srgbDecode, encode: srgbEncode,
  },
  'Adobe RGB (1998)': {
    matrix: [[39960,13453,9777],[20389,41004,4143],[1276,3989,48795]].map(row => row.map(v => v / 65536)),
    ...power(563 / 256),
  },
  'ProPhoto RGB': {
    matrix: [[52276,8860,2054],[18877,46654,6],[0,0,54061]].map(row => row.map(v => v / 65536)),
    ...power(461 / 256),
  },
  'Display P3': {
    matrix: [[33759,19135,10296],[15807,45367,4363],[-69,2745,51385]].map(row => row.map(v => v / 65536)),
    decode: v => v >= 2651/65536 ? ((62119*v+3417)/65536) ** (157286/65536) : 5072/65536*v,
    encode: v => v >= 5072/65536*2651/65536 ? (v ** (65536/157286)*65536-3417)/62119 : v*65536/5072,
  },
};

function invert(m) {
  const [[a,b,c],[d,e,f],[g,h,i]] = m;
  const det = a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  return [[e*i-f*h,c*h-b*i,b*f-c*e],[f*g-d*i,a*i-c*g,c*d-a*f],[d*h-e*g,b*g-a*h,a*e-b*d]].map(row=>row.map(v=>v/det));
}
const multiply = (m,v) => m.map(row=>row[0]*v[0]+row[1]*v[1]+row[2]*v[2]);
const labF = v => v > 216/24389 ? Math.cbrt(v) : (24389/27*v+16)/116;
const labInv = v => v > 6/29 ? v**3 : (116*v-16)*27/24389;
const spaces = new Map();
function getSpace(name = SRGB) {
  // Adobe ships the Display P3 encoding under this profile description on Windows.
  if (name === 'image P3') name = 'Display P3';
  if (spaces.has(name)) return spaces.get(name);
  if (!Object.prototype.hasOwnProperty.call(definitions,name))
    throw new Error(`Color finishing does not yet support "${name || 'untagged RGB'}". Use sRGB, Adobe RGB (1998), Display P3 or ProPhoto RGB, or turn finishing off.`);
  const d=definitions[name], inverse=d.inverse || invert(d.matrix), white=d.white || [0.9642,1,0.8249];
  const space={
    toLab(r,g,b) {
      const xyz=multiply(d.matrix,[d.decode(r),d.decode(g),d.decode(b)]).map((v,i)=>labF(v/white[i]));
      return [(116*xyz[1]-16)/100,500*(xyz[0]-xyz[1]),200*(xyz[1]-xyz[2])];
    },
    fromLab(l,a,b) {
      const y=(100*l+16)/116;
      const xyz=[labInv(y+a/500)*white[0],labInv(y),labInv(y-b/200)*white[2]];
      return multiply(inverse,xyz).map(v=>clamp01(d.encode(v)));
    },
  };
  spaces.set(name,space);
  return space;
}

module.exports={SRGB,getSpace};
