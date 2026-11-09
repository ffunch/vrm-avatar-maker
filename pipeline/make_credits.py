"""ASSETS.md: every worn asset in the catalog, its author and the license its own files state.

Reads pipeline/catalog.json and each item's .mhclo/.mhmat headers (MPFB's data folders). Items
painted or trimmed here name the CC0 item they come from. Exits with an error if any item's own
files don't say CC0. Usage: python3 pipeline/make_credits.py
"""
import glob
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
DATA = [os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/.user/blender_org/mpfb/data"),
        os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/blender_org/mpfb/data")]
REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
CC0 = re.compile(r"\bCC-?0\b|creative commons zero|public domain", re.I)


def header(path):
    """(author, says CC0) from the item's own .mhclo/.mhmat/.mhpxy files."""
    folder = next((os.path.dirname(os.path.join(d, path)) for d in DATA if os.path.exists(os.path.join(d, path))), None)
    if not folder:
        return None, False
    author, cc0 = None, False
    for f in sorted(glob.glob(os.path.join(folder, "*.mh*"))):
        for line in open(f, errors="replace"):
            if not line.strip() or line.lstrip("#/ ").startswith(("verts", "v ")):
                continue
            m = re.match(r"[#\s]*author:?\s+(.+)", line, re.I)
            if m and not author:
                author = m.group(1).strip()
            if re.match(r"[#\s]*licen[sc]e", line, re.I) or "released as" in line:
                cc0 |= bool(CC0.search(line))
            m = re.match(r"#\s*(.+?)\s+-\s+CC-?0\s*$", line, re.I)  # "# Cortu Johnstone - CC0"
            if m:
                author, cc0 = author or m.group(1), True
    return author, cc0


def main():
    catalog = json.load(open(os.path.join(REPO, "pipeline", "catalog.json")))
    by_id = {i["id"]: i for c in catalog["categories"].values() for i in c["items"]}
    lines = ["# Assets", "",
             "Everything an avatar is made of comes from CC0 (public domain) MakeHuman community assets, via",
             "MPFB 2. Each item's own files were checked to say CC0; this list is generated from them by",
             "`pipeline/make_credits.py`. CC0 asks for nothing, but thanks to the authors:", ""]
    bad = []
    sections = [("Always", catalog["always"])] + [(c["label"], c["items"]) for c in catalog["categories"].values()]
    for title, items in sections:
        rows = []
        for item in items:
            if "paint" in item:
                rows.append(f"| {item['label']} | painted into the skin by this project | CC0 |")
                continue
            source = by_id[item["base"]] if "base" in item else item
            if source["path"].startswith("assets/"):
                rows.append(f"| {item.get('label', item['id'])} | made by this project (`pipeline/`) | CC0 |")
                continue
            author, cc0 = header(source["path"])
            if not cc0:
                bad.append(item["id"])
            note = f" (our design on {source['label']})" if "base" in item else ""
            rows.append(f"| {item.get('label', item['id'])}{note} | {author or 'MakeHuman team'} | {'CC0' if cc0 else '**not stated**'} |")
        lines += [f"## {title}", "", "| Item | Author | License |", "|---|---|---|", *rows, ""]
    lines += ["## Skins and eyes", "", "MakeHuman's CC0 skins (" + ", ".join(catalog["skins"]) + ") and eye textures.", ""]
    open(os.path.join(REPO, "ASSETS.md"), "w").write("\n".join(lines))
    print("wrote ASSETS.md")
    if bad:
        sys.exit("no CC0 statement found for: " + ", ".join(bad))


main()
