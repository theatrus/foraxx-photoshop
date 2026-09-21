"use strict";

// Stage only runtime files, then let Adobe's UXP Developer Tools create the CCX.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("Manifest and package versions must match (major.minor.patch).");
}
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
const work = fs.mkdtempSync(path.join(dist, "package-"));
const stage = path.join(work, "plugin"), output = path.join(work, "output");
fs.mkdirSync(stage);
fs.mkdirSync(output);
for (const name of ["manifest.json", "index.html", "src", "icons", "LICENSE", "NOTICE"]) {
  fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
}
console.log(`Clean plugin folder: ${stage}`);
if (process.argv.includes("--stage-only")) {
  console.log("Add its manifest to UXP Developer Tool and choose Package.");
  process.exit(0);
}
// Pass the path to Adobe's src/uxp.js, or install the CLI locally.
let cli = process.argv[2];
if (!cli) {
  try { cli = require.resolve("@adobe/uxp-devtools-cli"); }
  catch { throw new Error("Pass the path to Adobe's uxp.js, or use --stage-only with UDT."); }
}
cli = path.resolve(cli);
const result = spawnSync(process.execPath, [cli, "plugin", "package",
  "--manifest", path.join(stage, "manifest.json"), "--outputPath", output], {
  cwd: root, stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Adobe packager exited with ${result.status}`);
// The Adobe CLI can report command errors with exit code 0. Require a new file.
const packages = fs.readdirSync(output).filter(name => name.endsWith(".ccx"));
if (packages.length !== 1) throw new Error("Adobe did not produce exactly one CCX package.");
const name = `foraxx-palette-${manifest.version}.ccx`;
const target = path.join(dist, name);
fs.copyFileSync(path.join(output, packages[0]), target);
const checksum = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
fs.writeFileSync(path.join(dist, "SHA256SUMS.txt"), `${checksum}  ${name}\n`);
console.log(`Installer: ${target}\nSHA256: ${checksum}`);
