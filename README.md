# Foraxx Palette for Photoshop

A Photoshop UXP plugin that builds a Foraxx palette image from stretched,
starless narrowband layers as a stack of ordinary, mergeable layers. Instead
of writing one flattened result, it creates layers whose blend modes and
masks reproduce the palette exactly, so you can keep tweaking after the fact.

Status: tested locally on Windows in Photoshop 2026 (27.10.0) using synthetic
8- and 16-bit RGB documents and a full-resolution, 96.8-megapixel narrowband
example. The host tests check the output against the formula, merging, undo,
strip boundaries, and rollback after a failed build. Older Photoshop versions
have not yet been tested.

One Photoshop crash occurred during repeated development reloads and a native
picker check (Windows reported heap corruption, `0xc0000374`). The cause is
unresolved; after restarting, panel builds with and without stars succeeded.

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

Download the `.ccx` installer from [GitHub Releases](https://github.com/theatrus/foraxx-photoshop/releases).
Double-click it to install through Creative Cloud Desktop, accepting the
outside-Marketplace prompt. Developer Mode is not needed for packaged installs.
Download the `.ccx` asset, not GitHub's automatically generated source archive.
The first release is a beta validated on Windows with Photoshop 27.10;
macOS and the declared minimum Photoshop 24.4 remain untested.

1. Open an RGB document (8 or 16 bit) with the stretched, starless
   channels as full-canvas grayscale layers, plus the stars layers if you
   want a stars stack.
2. Open the panel (Plugins > Foraxx Palette) and pick a layer for each channel.
3. Click **Load preview**, then adjust gains and palette sliders. The preview
   updates as you adjust them. Click **Original Foraxx** to reset all gains
   and palette controls to the original formula.
4. Click **Build Foraxx layers**. The new group appears at the top. Hide the
   source layers or leave them.

Gains multiply a starless channel before combination, clipped at 1, and
shift the dynamic factors with it. Star layers are not scaled.

### Palette controls

- **Red bias** moves the red mix toward SII when positive and Ha when
  negative. It applies only in three-channel mode.
- **Green bias** moves the green mix toward Ha when positive and OIII when
  negative.
- **Red/green contrast** sharpens each mask's transition above 1 and softens
  it below 1. Bias 0 and contrast 1 leave that mask unchanged.
- **OIII midtones** shapes the starless OIII channel after gain and before
  both the masks and color combination. Values below 0.5 lift midtones;
  values above 0.5 darken them. Black and white stay fixed. Star pixels
  remain unshaped, while their masks follow the shaped starless sources.

For a mask value `x`, bias `b` and contrast `c`, the shaped mask is
`1 / (1 + exp(-c * log(x/(1-x)) - b * log(2)))`, with endpoints preserved.
The OIII midtones transfer is `(1-m)*x / (m + (1-2*m)*x)`.
The defaults preserve the original Foraxx calculation exactly.

The preview caches source thumbnails up to 512 pixels on the longest edge
and does not edit the document or add undo history. It combines those sampled
sources, so fine detail can differ from the full-resolution build. Click
**Load preview** again after editing a source. Previewing shows the palette
combination of the selected inputs, without later adjustments added to an
existing output group. Changes take effect in a new group on the next build;
existing groups do not update automatically.

32-bit documents are rejected before any edits: Photoshop does not support
the Screen blend mode at that depth. Make an 8- or 16-bit RGB copy first.
The build is one undo step; a failed build rolls back its partial output.
Images are processed in full-width strips of at most about two million
pixels to bound temporary JavaScript memory. There is no downsampling.
Photoshop shows build progress and supports cancellation.

## Develop

```
npm test                 # node unit tests for the math and the stack
npm run package -- --stage-only  # clean folder for UDT's Package action
```

To load during development, enable Developer Mode in the UXP Developer Tool
and Photoshop's Preferences > Plugins, then restart Photoshop. Add this
folder's `manifest.json` to UDT and click Load. The declared minimum is
Photoshop 24.4; local validation used 27.10.

For normal use, select **Package** in UDT and double-click the resulting
`.ccx` installer to install through Creative Cloud Desktop. Installed packages
do not need Developer Mode or a signing certificate. See Adobe's
[packaging](https://developer.adobe.com/uxp/guides/how-to/distribution/package/)
and [installation](https://developer.adobe.com/uxp/guides/how-to/distribution/install/)
guides. Use the clean staging folder printed by the packaging script so
development tools, tests and example images are excluded from the installer.

Alternatively, with Adobe's UXP Developer Tools service running, package via
its CLI (pass the path to the installed CLI's `src/uxp.js`):

```
npm run package -- /path/to/@adobe/uxp-devtools-cli/src/uxp.js
```

This stages the runtime files, calls Adobe's `uxp plugin package`, and writes
`dist/foraxx-palette-0.1.0.ccx` plus `dist/SHA256SUMS.txt`. A local installation
of `@adobe/uxp-devtools-cli` is also detected without the path argument.
GitHub releases use the independent plugin ID `us.theatr.foraxx`; keep it
stable across updates. Any future Marketplace build needs its own portal ID.

### Tests inside Photoshop

Open the plugin's debugger in UDT and run:

```js
await require('./scripts/photoshop-smoke.js').runSuite()
await require('./scripts/photoshop-smoke.js').checkPreview()
```

This creates and closes small synthetic documents. It tests 8/16 bits,
two/three channels, stars on/off, and non-unit gains with clipping. It also
checks that merging preserves pixels, undo restores the source layers, 32-bit
documents are rejected without edits, and a late read failure rolls back.
Every returned result should have `pass: true`. Run `fixture(16)` or `run()`
from the same module to leave a test document open for panel inspection.

The suite also builds a 2053 × 1031 document with stars, crossing the strip
boundary and ending with a partial strip. It returns 16 results, including
custom mask and OIII settings at both depths, with and without stars.
The five preview checks verify that thumbnail reads leave document history
and layers unchanged, that history changes invalidate the cache, and that preview
pixels agree with builds to within one 8-bit step on the small fixtures.

On 27.10, the largest formula differences were 0.004607 at 8 bits and
0.000045 at 16 bits (less than two storage steps). Merging the full output
group changed no samples. Source pixels must be read at native depth:
requesting 32-bit samples from an 8/16-bit document linearizes the RGB data
and changes the palette substantially.

Panel checks also caught two UXP details: refresh the existing `sp-menu`
instead of replacing it (replacement leaves the native picker label stale),
and give the scrolling body an explicit height so the build button remains
accessible when the stars controls are expanded.

### Full-resolution example

The RedCat 61 Teddy Bear example uses the stretched, starless Ha, OIII, and
SII TIFFs at 12174 × 7952, 16-bit grayscale. Their stored grayscale samples
were replicated into RGB source layers in an sRGB document, without a tonal
conversion, and built with unity gains and no stars stack. The source TIFFs
were left unchanged.

On the local test machine, the build took 37.3 seconds. Checking every one
of the 290,422,944 RGB output samples against the direct Foraxx formula found
a maximum error of 0.00002445 (less than one Photoshop 16-bit storage step),
with no samples outside the two-step tolerance. This validates the full-size
strip writes as well as the math; it is not a performance guarantee for other
machines. Example images and local debugging tools are excluded from Git.

Layout:

```
manifest.json      UXP manifest (v5)
index.html         the panel
src/main.js        panel logic
src/foraxx.js      pure math: factors, mixes, tinting, encoding, a plan
                   builder and a simulated compositor used by the tests
src/psbuild.js     reads layers, builds groups, layers and masks
src/preview.js     caches source thumbnails and renders the palette preview
test/              node:test suite
```

## Credits

The Foraxx palette and its expressions are from The Coldest Nights,
<https://thecoldestnights.com/2020/06/pixinsight-dynamic-narrowband-combinations-with-pixelmath/>.
The PixInsight Foraxx Palette Utility that this follows was written by Paul
Hancock (Paulyman Astro); its V8 port lives at
<https://github.com/theatrus/foraxx-palette-utility>.

Copyright (c) 2026 Yann Ramin.
