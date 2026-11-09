#!/bin/sh
# Asset factory steps: derived catalog items (lighter, trimmed or front-only copies, into
# assets/parts/<id>/, committed), generated visors, body coverage for garments that don't list it
# (assets/hides/, committed), and the makeup masks (web/assets/masks/, regenerated).
# Then run export_web_assets.py.
set -e
cd "$(dirname "$0")/.."
BLENDER=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
python3 -c "
import json, shlex
c = json.load(open('pipeline/catalog.json'))
items = c['always'] + [i for cat in c['categories'].values() for i in cat['items']]
for i in items:
    d = i.get('derive')
    if d:
        args = [i['path'], str(d.get('ratio', 1.0)), i['id']]
        if 'keep' in d: args += ['--keep', d['keep']]
        if d.get('dropReddish'): args += ['--drop-reddish']
        print(' '.join(shlex.quote(a) for a in args))
" | while read -r line; do
  eval "set -- $line"
  "$BLENDER" -b --python pipeline/make_low_item.py -- "$@" 2>&1 | grep -E "kept|faces|Error|Traceback" || true
done
python3 pipeline/make_visor.py
"$BLENDER" -b --python pipeline/make_hides.py 2>&1 | grep -E "covers|Error|Traceback" || true
"$BLENDER" -b --python pipeline/make_makeup_masks.py 2>&1 | grep -E "wrote|Error|Traceback" || true
