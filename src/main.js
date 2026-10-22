"use strict";

const { app } = require("photoshop");
// HTML script tags resolve require() from the plugin root in UXP.
const { buildForaxx } = require("./src/psbuild.js");
const F = require("./src/foraxx.js");
const P = require("./src/preview.js");
const O = require("./src/options.js");

const $ = (id) => document.getElementById(id);
const pickers = ["sii", "ha", "oiii", "siiStars", "haStars", "oiiiStars"];
let selectedDocumentId = null;
const tuningIds = Object.keys(F.ORIGINAL);
const extraIds = Object.keys(O.DEFAULTS);
const viewIds=['previewZoom','previewX','previewY'];
let initialized=false;
let building = false, previewWanted = false, previewRunning = false;
let previewCache = null, previewRevision = 0, previewTimer;

function allLayers(doc) {
  const out = [];
  const walk = (layers) => { for (const l of layers) { out.push(l); if (l.layers) walk(l.layers); } };
  walk(doc.layers);
  return out;
}

function refreshLayers() {
  clearPreview();
  const doc = app.activeDocument;
  const sameDocument = doc && doc.id === selectedDocumentId;
  const layers = doc ? allLayers(doc).filter((l) => l.kind === "pixel" || l.kind === "smartObject" || l.kind === undefined) : [];
  for (const id of pickers) {
    const picker = $(id);
    const previous = sameDocument ? picker.value : "";
    // UXP binds the native picker to its original menu. Replacing that menu
    // leaves the displayed selection disconnected from the JavaScript value.
    const menu = picker.querySelector("sp-menu");
    menu.innerHTML = "";
    const none = document.createElement("sp-menu-item");
    none.value = ""; none.textContent = "— none —";
    menu.appendChild(none);
    for (const l of layers) {
      const item = document.createElement("sp-menu-item");
      item.value = String(l.id); item.textContent = l.name;
      menu.appendChild(item);
    }
    picker.selectedIndex = Math.max(0, layers.findIndex((l) => String(l.id) === previous) + 1);
  }
  $("status").textContent = doc ? `${layers.length} layers in "${doc.name}"` : "Open a document.";
  selectedDocumentId = doc ? doc.id : null;
  updateEnabled();
}

function layerById(id) {
  if (!id) return null;
  const doc = app.activeDocument;
  if (!doc) return null;
  return allLayers(doc).find((l) => String(l.id) === String(id)) || null;
}

function updateEnabled() {
  for (const control of document.querySelectorAll("sp-picker, sp-textfield, sp-slider, sp-checkbox, sp-button")) control.disabled = building;
  if (building) return;
  const three = $("threeChannels").checked, stars = $("createStars").checked;
  $("starsInputs").style.display = stars ? "block" : "none";
  $("sii").disabled = !three; $("siiGain").disabled = !three;
  $("siiMidtone").disabled = !three;
  if (!three && !['Foraxx','HOO'].includes($("palette").value)) $("palette").selectedIndex=0;
  const dynamic=$("palette").value === 'Foraxx';
  $("combineStars").disabled=!stars;
  $("siiStars").disabled = !(three && stars);
  $("haStars").disabled = !stars; $("oiiiStars").disabled = !stars;
  $("redBias").disabled = !(three && dynamic); $("redContrast").disabled = !(three && dynamic);
  for (const id of ['greenBias','greenContrast','maskBlur','createFactorImages']) $(id).disabled=!dynamic;
  $("ratioThreshold").disabled=!$("createRatioMasks").checked && !$("previewTarget").value?.startsWith('ratio_');
  $("colourNoiseLayers").disabled=!$("colourNoiseReduction").checked;
  $("protectBackground").disabled=!$("applyAdjustments").checked;
  $("saturationAmount").disabled=!$("protectedSaturation").checked;
  $("saturationBackground").disabled=!($("protectedSaturation").checked || ($("applyAdjustments").checked && $("protectBackground").checked));
  const target=$("previewTarget").value;
  if ((target === 'stars' && !stars) || (target?.startsWith('factor_') && !dynamic) ||
    (['factor_o','ratio_SII'].includes(target) && !three) || (target === 'saturation_mask' && (!$("protectedSaturation").checked || Number($("saturationAmount").value) === 0))) $("previewTarget").selectedIndex=0;
  $("preview").disabled = previewRunning;
  $("run").disabled = previewRunning;
  $("previewX").disabled=$("previewY").disabled=Number($("previewZoom").value) === 1;
}

function readOptions() {
  if (!app.activeDocument) throw new Error("Open a document first.");
  if (app.activeDocument.id !== selectedDocumentId) {
    refreshLayers();
    throw new Error("The active document changed. Select its source layers again.");
  }
  const gain = (id) => {
    const value = Number($(id).value);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Gains must be positive numbers.");
    return value;
  };
  const threeChannels = $("threeChannels").checked;
  return {
    ...O.normalize(Object.fromEntries(extraIds.map(id=>[id,typeof O.DEFAULTS[id] === 'boolean' ? $(id).checked : id === 'palette' ? $(id).value : Number($(id).value)]))),
    sii: layerById($("sii").value), ha: layerById($("ha").value), oiii: layerById($("oiii").value),
    siiStars: layerById($("siiStars").value), haStars: layerById($("haStars").value), oiiiStars: layerById($("oiiiStars").value),
    threeChannels,
    createStars: $("createStars").checked,
    gains: { sii: threeChannels ? gain("siiGain") : 1, ha: gain("haGain"), oiii: gain("oiiiGain") },
    tuning: F.tuningOptions(Object.fromEntries(tuningIds.map(id => [id, Number($(id).value)]))),
    previewTarget: $("previewTarget").value || 'result',
    ...Object.fromEntries(viewIds.map(id=>[id,Number($(id).value)])),
    name: $("outputName").value.trim() || "Foraxx",
  };
}

function updatePreset() {
  const original = tuningIds.every(id => Number($(id).value) === F.ORIGINAL[id]) &&
    ["siiGain", "haGain", "oiiiGain"].every(id => Number($(id).value) === 1) &&
    extraIds.every(id => (typeof O.DEFAULTS[id] === 'boolean' ? $(id).checked : typeof O.DEFAULTS[id] === 'number' ? Number($(id).value) : $(id).value) === O.DEFAULTS[id]);
  $("preset").textContent = original ? "Original Foraxx" : `Custom ${$("palette").value || 'Foraxx'}`;
}

function saveSettings() {
  if (!initialized) return;
  const saved={};
  for (const id of [...tuningIds,...extraIds,...viewIds,'threeChannels','createStars','livePreview','siiGain','haGain','oiiiGain','outputName'])
    saved[id]=$(id).tagName.toLowerCase() === 'sp-checkbox' ? $(id).checked : $(id).value;
  try { localStorage.setItem('foraxx.settings.v1',JSON.stringify(saved)); } catch(e) { console.warn('Could not save settings',e); }
}
function restoreSettings() {
  try {
    const saved=JSON.parse(localStorage.getItem('foraxx.settings.v1') || '{}');
    for (const id of [...tuningIds,...extraIds,...viewIds,'threeChannels','createStars','livePreview','siiGain','haGain','oiiiGain','outputName']) {
      if (!(id in saved)) continue;
      if ($(id).tagName.toLowerCase() === 'sp-checkbox') $(id).checked=saved[id] === true;
      else if (id === 'palette') $(id).selectedIndex=Math.max(0,Object.keys(O.PALETTES).indexOf(saved[id]));
      else if (typeof saved[id] === 'string' || Number.isFinite(saved[id])) $(id).value=saved[id];
    }
  } catch(e) { console.warn('Could not restore settings',e); }
}

function clearPreview() {
  previewRevision++;
  clearTimeout(previewTimer);
  previewCache = null;
  previewWanted = false;
  $("previewImage").style.display = "none";
  $("previewStatus").textContent = "Select source layers, then load a preview.";
}

function queuePreview() {
  updatePreset();
  saveSettings();
  previewRevision++;
  clearTimeout(previewTimer);
  if (previewWanted && !building && $("livePreview").checked) previewTimer = setTimeout(updatePreview, 120);
  else if (previewWanted && !$("livePreview").checked) $("previewStatus").textContent = "Settings changed · click Load preview to update.";
}

async function updatePreview() {
  if (previewRunning || building || !previewWanted) return;
  const revision = previewRevision;
  previewRunning = true;
  updateEnabled();
  $("previewStatus").textContent = "Updating preview…";
  try {
    const options = readOptions(), key = P.previewKey(options);
    if (!previewCache || previewCache.key !== key) previewCache = await P.loadPreview(options);
    const cache = previewCache;
    const url = await P.renderPreview(cache, options);
    if (revision !== previewRevision || !previewWanted) return;
    // A document switch or source edit while awaiting a thumbnail invalidates it.
    if (P.previewKey(readOptions()) !== key) { queuePreview(); return; }
    $("previewImage").src = url;
    $("previewImage").style.display = "block";
    $("previewStatus").textContent = `${cache.width} × ${cache.height} preview · ${Math.round(cache.scale*100)}% source scale · refresh after source edits`;
  } catch (e) {
    if (revision === previewRevision) {
      $("previewImage").style.display = "none";
      $("previewStatus").textContent = "Preview: " + e.message;
    }
  } finally {
    previewRunning = false;
    updateEnabled();
    if (revision !== previewRevision && previewWanted && !building && $("livePreview").checked) previewTimer = setTimeout(updatePreview, 120);
    else if (revision !== previewRevision && previewWanted && !$("livePreview").checked) $("previewStatus").textContent = "Settings changed · click Load preview to update.";
  }
}

function resetOriginal() {
  for (const id of tuningIds) $(id).value = F.ORIGINAL[id];
  for (const id of ["siiGain", "haGain", "oiiiGain"]) $(id).value = "1";
  for (const id of extraIds) {
    if (typeof O.DEFAULTS[id] === 'boolean') $(id).checked=O.DEFAULTS[id];
    else if (id === 'palette') $(id).selectedIndex=0;
    else $(id).value=O.DEFAULTS[id];
  }
  $("previewTarget").selectedIndex=0;
  $("previewZoom").value=1; $("previewX").value=$("previewY").value=50;
  updateEnabled();
  queuePreview();
}

async function run() {
  if (building || previewRunning) return;
  building = true;
  previewRevision++;
  clearTimeout(previewTimer);
  updateEnabled();
  $("status").textContent = "Building…";
  try {
    await buildForaxx(readOptions());
    $("status").textContent = "Done. The stack is in the new group.";
  } catch (e) {
    $("status").textContent = "Error: " + (e && e.message ? e.message : e);
    console.error(e);
  } finally {
    building = false;
    updateEnabled();
  }
}

// The script is placed after the panel markup.
function initialize() {
  $("refresh").addEventListener("click", refreshLayers);
  $("run").addEventListener("click", run);
  $("preview").addEventListener("click", () => { previewCache = null; previewWanted = true; previewRevision++; clearTimeout(previewTimer); updatePreview(); });
  $("reset").addEventListener("click", resetOriginal);
  $("extrasToggle").addEventListener('click',()=>{
    const show=$("extras").style.display === 'none';
    $("extras").style.display=show ? 'block':'none';
    $("extrasToggle").textContent=show ? 'Hide color finishing and masks':'Show color finishing and masks';
  });
  for (const id of ["threeChannels", "createStars", "livePreview", "previewTarget", ...extraIds, ...pickers]) {
    $(id).addEventListener("change", () => { updateEnabled(); queuePreview(); });
  }
  for (const id of [...tuningIds, ...extraIds.filter(id=>typeof O.DEFAULTS[id] === 'number'), "siiGain", "haGain", "oiiiGain"]) {
    $(id).addEventListener("input", queuePreview);
    $(id).addEventListener("change", queuePreview);
  }
  for(const id of viewIds) {
    $(id).addEventListener('input',()=>{updateEnabled();queuePreview();});
    $(id).addEventListener('change',()=>{updateEnabled();queuePreview();});
  }
  $("outputName").addEventListener('change',saveSettings);
  restoreSettings();
  refreshLayers();
  updatePreset();
  initialized=true;
}
initialize();
