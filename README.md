# Foraxx Palette for Photoshop

A Photoshop UXP plugin that builds a Foraxx palette image from stretched,
starless narrowband layers as a stack of ordinary, mergeable layers. Instead
of writing one flattened result, it creates layers whose blend modes and
masks reproduce the palette exactly, so you can keep tweaking after the fact.

Status: early. The math is unit-tested in node; the Photoshop side follows
the documented UXP imaging and DOM APIs but has not yet been run inside
Photoshop. Expect to fix small API details on first load.

## The idea

The Foraxx palette (The Coldest Nights) is

```
o  = OIII^~OIII
ho = (Ha*OIII)^~(Ha*OIII)
R  = o*SII + ~o*Ha        (two channels: R = Ha)
G  = ho*Ha + ~ho*OIII
B  = OIII
```

where `~x` is `1 - x`. Only the two factors `o` and `ho` are non-linear. The
plugin computes those as pixels and stores them as layer masks. Everything
else maps onto Photoshop exactly:

- A Normal layer with a mask over another layer is the mix
  `mask*top + (1-mask)*bottom`. That gives R and G.
- A gray image tinted into one channel, screened over layers that occupy
  the other channels, adds without loss, because `screen(x, 0) = x`. That
  assembles R, G and B into one RGB result.

So the stack is, bottom to top, inside one group:

```
Foraxx
  Black                          solid black
  Red   (Screen)   Ha (red)      then  SII (red)  with mask o
  Green (Screen)   OIII (green)  then  Ha (green) with mask ho
  Blue  (Screen)   OIII (blue)
  Stars (Screen)   the same three groups from the star layers,
                   masks still computed from the starless data
```

Merge any of it and the pixels do not change. Paint on a mask, drop a
curves layer inside a group, or lower a group's opacity, and you are editing
the palette rather than a baked result. The one thing the stack cannot do is
follow later edits to the source layers: the masks are computed once.

Blend modes operate on the document's stored values, as does PixInsight's
PixelMath on stretched data, so results match the PixInsight script. Leave
"Blend RGB Colors Using Gamma" off in Color Settings.

## Use

1. Open an RGB document (8, 16 or 32 bit) with the stretched, starless
   channels as full-canvas grayscale layers, plus the stars layers if you
   want a stars stack.
2. Open the panel (Plugins > Foraxx Palette), pick a layer for each channel,
   set optional gains, and click **Build Foraxx layers**.
3. The new group appears at the top. Hide the source layers or leave them.

Gains multiply a starless channel before combination, clipped at 1, and
shift the dynamic factors with it. Star layers are not scaled.

## Develop

```
npm test                 # node unit tests for the math and the stack
scripts/package.sh       # dist/foraxx-palette.ccx
```

To load during development, open the UXP Developer Tool, add this folder's
`manifest.json`, and click Load. Photoshop 24.4 or newer.

Layout:

```
manifest.json      UXP manifest (v5)
index.html         the panel
src/main.js        panel logic
src/foraxx.js      pure math: factors, mixes, tinting, encoding, a plan
                   builder and a simulated compositor used by the tests
src/psbuild.js     reads layers, builds groups, layers and masks
test/              node:test suite
```

## Credits

The Foraxx palette and its expressions are from The Coldest Nights,
<https://thecoldestnights.com/2020/06/pixinsight-dynamic-narrowband-combinations-with-pixelmath/>.
The PixInsight Foraxx Palette Utility that this follows was written by Paul
Hancock (Paulyman Astro); its V8 port lives at
<https://github.com/theatrus/foraxx-palette-utility>.

Copyright (c) 2026 Yann Ramin.
