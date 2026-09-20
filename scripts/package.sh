#!/usr/bin/env bash
# Packages the plugin folder as a .ccx (a zip) for installation with the
# Creative Cloud app or the UXP Developer Tool. Output: dist/foraxx-palette.ccx
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$here/dist"
rm -f "$here/dist/foraxx-palette.ccx"
(cd "$here" && zip -q -X -r dist/foraxx-palette.ccx manifest.json index.html src icons -x 'src/*.test.js')
echo "wrote $here/dist/foraxx-palette.ccx"
