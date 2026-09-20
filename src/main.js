"use strict";

const { app } = require("photoshop");
const { buildForaxx } = require("./psbuild.js");

const $ = (id) => document.getElementById(id);
const pickers = ["sii", "ha", "oiii", "siiStars", "haStars", "oiiiStars"];

function allLayers(doc) {
  const out = [];
  const walk = (layers) => { for (const l of layers) { out.push(l); if (l.layers) walk(l.layers); } };
  walk(doc.layers);
  return out;
}

function refreshLayers() {
  const doc = app.activeDocument;
  const layers = doc ? allLayers(doc).filter((l) => l.kind === "pixel" || l.kind === "smartObject" || l.kind === undefined) : [];
  for (const id of pickers) {
    const picker = $(id);
    const previous = picker.value;
    picker.innerHTML = "";
    const menu = document.createElement("sp-menu");
    const none = document.createElement("sp-menu-item");
    none.value = ""; none.textContent = "— none —";
    menu.appendChild(none);
    for (const l of layers) {
      const item = document.createElement("sp-menu-item");
      item.value = String(l.id); item.textContent = l.name;
      menu.appendChild(item);
    }
    picker.appendChild(menu);
    picker.value = previous;
  }
  $("status").textContent = doc ? `${layers.length} layers in "${doc.name}"` : "Open a document.";
  updateEnabled();
}

function layerById(id) {
  if (!id) return null;
  const doc = app.activeDocument;
  return allLayers(doc).find((l) => String(l.id) === String(id)) || null;
}

function updateEnabled() {
  const three = $("threeChannels").checked, stars = $("createStars").checked;
  $("sii").disabled = !three; $("siiGain").disabled = !three;
  $("siiStars").disabled = !(three && stars);
  $("haStars").disabled = !stars; $("oiiiStars").disabled = !stars;
}

async function run() {
  const gain = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v > 0 ? v : 1; };
  $("run").disabled = true;
  $("status").textContent = "Building…";
  try {
    await buildForaxx({
      sii: layerById($("sii").value), ha: layerById($("ha").value), oiii: layerById($("oiii").value),
      siiStars: layerById($("siiStars").value), haStars: layerById($("haStars").value), oiiiStars: layerById($("oiiiStars").value),
      threeChannels: $("threeChannels").checked,
      createStars: $("createStars").checked,
      gains: { sii: gain("siiGain"), ha: gain("haGain"), oiii: gain("oiiiGain") },
      name: $("outputName").value.trim() || "Foraxx",
    });
    $("status").textContent = "Done. The stack is in the new group.";
  } catch (e) {
    $("status").textContent = "Error: " + (e && e.message ? e.message : e);
    console.error(e);
  } finally {
    $("run").disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("refresh").addEventListener("click", refreshLayers);
  $("run").addEventListener("click", run);
  $("threeChannels").addEventListener("change", updateEnabled);
  $("createStars").addEventListener("change", updateEnabled);
  refreshLayers();
});
