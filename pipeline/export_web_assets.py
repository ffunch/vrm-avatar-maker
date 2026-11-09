"""Convert MakeHuman/MPFB data into compact assets for the browser editor (spike).

Writes web/assets/ (gitignored, regenerate with this script):
  base.json + base.bin     all 19,158 base vertices (MakeHuman units, decimeters, y up), the body's
                           render triangles with UVs (vertices split at UV seams; `source` maps each
                           render vertex back to its base vertex)
  macros.json + macros.bin the macro targets (race/gender/age, gender/age/muscle/weight), as sparse
                           int16-quantized offsets, plus macro.json's slider definitions
  items/<name>.json + .bin worn assets (.mhclo): render mesh + the fitting data (3 base vertices,
                           3 weights, an offset per vertex, and the x/y/z scale references), plus
                           the body vertices it hides (delete_verts)
  textures/                diffuse textures: JPEG (opaque) or WebP with alpha (cut-outs, 1024 px)
  thumbs/                  128 px WebP item thumbnails, small eye-color swatches
  All .bin files are written gzipped (.bin.gz) and unpacked in the browser (avatar-core.js fetchBin).
  faces.json + faces.bin   the face shapes our VRM expressions use (pipeline/expressions.json): MPFB
                           visemes and ARKit face units, same format as the macros
  rig.json + skin.bin      the game_engine skeleton (53 bones; each end placed at the mean of a
                           "joint-*" helper cube or of listed vertices), the VRM humanoid map, and
                           per-base-vertex skin weights (top 4 bones, renormalized)

Stdlib only, plus macOS `sips` (JPEG, swatches) and Homebrew `cwebp` (WebP). Items come from pipeline/catalog.json; run
pipeline/make_parts.sh first (lighter items, makeup masks). Usage: python3 pipeline/export_web_assets.py
"""

import gzip
import json
import os
import shutil
import struct
import subprocess
import sys

HOME = os.path.expanduser("~")
SYSTEM = os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/blender_org/mpfb/data")
USER = os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/.user/blender_org/mpfb/data")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "assets")
QUANT = 1.0 / 8000.0  # int16 step for target offsets: 1/8000 dm = 0.0125 mm, range +-4 dm

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def read_obj(path, only_group=None):
    """Positions, and triangles split at UV seams: render verts carry (source vertex, uv)."""
    positions, uvs, faces, group = [], [], [], None
    with open(path, errors="replace") as handle:
        for line in handle:
            parts = line.split()
            if not parts:
                continue
            if parts[0] == "v":
                positions.append(tuple(float(x) for x in parts[1:4]))
            elif parts[0] == "vt":
                uvs.append((float(parts[1]), float(parts[2])))
            elif parts[0] == "g":
                group = parts[1] if len(parts) > 1 else None
            elif parts[0] == "f" and (only_group is None or group == only_group):
                corners = []
                for corner in parts[1:]:
                    fields = corner.split("/")
                    v = int(fields[0]) - 1
                    t = int(fields[1]) - 1 if len(fields) > 1 and fields[1] else -1
                    corners.append((v, t))
                for i in range(1, len(corners) - 1):  # fan triangulation
                    faces.append((corners[0], corners[i], corners[i + 1]))
    lookup, source, render_uv, indices = {}, [], [], []
    for face in faces:
        for corner in face:
            if corner not in lookup:
                lookup[corner] = len(source)
                source.append(corner[0])
                render_uv.append(uvs[corner[1]] if corner[1] >= 0 else (0.0, 0.0))
            indices.append(lookup[corner])
    return positions, source, render_uv, indices


def write_bin(path, chunks):
    """chunks: list of (name, struct format char, values[, "planes"]). Returns {name: [byteOffset, count, type(, "planes")]}.

    Written gzipped as <path>.gz; the browser unpacks it with DecompressionStream, so any static host works
    without server settings. Offsets refer to the unpacked bytes. A "planes" chunk stores its 2-byte
    values as all low bytes, then all high bytes: small offsets then compress about 10% better. An "xyz"
    chunk is also stored as all x, then all y, then all z (sparse targets: another ~10%).
    """
    layout, blob = {}, bytearray()
    for name, kind, values, *flags in chunks:
        blob += b"\0" * (-len(blob) % 4)
        layout[name] = [len(blob), len(values), kind] + list(flags)
        data = struct.pack(f"<{len(values)}{kind}", *values)
        if "planes" in flags or "xyz" in flags:  # "xyz": values already ordered as all x, all y, all z
            data = data[0::2] + data[1::2]
        blob += data
    if os.path.exists(path):
        os.remove(path)  # the old uncompressed file
    # mtime=0 and no file name in the header: the same content gives the same bytes, so re-exporting
    # doesn't rewrite every file in git.
    with open(path + ".gz", "wb") as raw, gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw, mtime=0) as handle:
        handle.write(blob)
    return layout


def target_chunks(name, rows):
    """A sparse target: vertex index gaps (uint16) and int16 offsets, both as byte planes."""
    gaps, previous = [], -1
    for r in rows:
        gaps.append(r[0] - previous)
        previous = r[0]
    return [(name + ":g", "H", gaps, "planes"),
            (name + ":d", "h", [max(-32767, min(32767, round(r[1 + k] / QUANT))) for k in range(3) for r in rows], "xyz")]


def export_base():
    positions, source, uv, indices = read_obj(os.path.join(SYSTEM, "3dobjs/base.obj"), only_group="body")
    layout = write_bin(os.path.join(OUT, "base.bin"), [
        ("positions", "f", [c for p in positions for c in p]),
        ("source", "I", source),
        ("uv", "f", [c for t in uv for c in t]),
        ("indices", "I", indices),
    ])
    json.dump({"vertexCount": len(positions), "layout": layout, "unitsPerMeter": 10}, open(os.path.join(OUT, "base.json"), "w"))
    print("base", len(positions), "vertices,", len(indices) // 3, "body triangles,", len(source), "render vertices")
    return len(positions)


# VRM 1.0 humanoid bone -> game_engine bone (the same map the VRM Add-on assigns in build_avatar.py)
HUMANOID = {"hips": "pelvis", "spine": "spine_01", "chest": "spine_02", "upperChest": "spine_03",
            "neck": "neck_01", "head": "head", "leftEye": "eye_l", "rightEye": "eye_r"}
for side, s in (("left", "l"), ("right", "r")):
    HUMANOID.update({f"{side}Shoulder": f"clavicle_{s}", f"{side}UpperArm": f"upperarm_{s}",
                     f"{side}LowerArm": f"lowerarm_{s}", f"{side}Hand": f"hand_{s}",
                     f"{side}UpperLeg": f"thigh_{s}", f"{side}LowerLeg": f"calf_{s}",
                     f"{side}Foot": f"foot_{s}", f"{side}Toes": f"ball_{s}",
                     f"{side}ThumbMetacarpal": f"thumb_01_{s}", f"{side}ThumbProximal": f"thumb_02_{s}",
                     f"{side}ThumbDistal": f"thumb_03_{s}"})
    for finger, ours in (("Index", "index"), ("Middle", "middle"), ("Ring", "ring"), ("Little", "pinky")):
        for level, n in (("Proximal", 1), ("Intermediate", 2), ("Distal", 3)):
            HUMANOID[f"{side}{finger}{level}"] = f"{ours}_0{n}_{s}"


def export_rig(vertex_count):
    rig = json.load(open(os.path.join(SYSTEM, "rigs/standard/rig.game_engine.json")))
    groups = json.load(open(os.path.join(SYSTEM, "mesh_metadata/basemesh_vertex_groups.json")))
    order, seen = [], set()
    def visit(name):  # parents before children
        if name in seen:
            return
        parent = rig[name]["parent"]
        if parent:
            visit(parent)
        seen.add(name)
        order.append(name)
    for name in rig:
        visit(name)
    def end(info):
        if info["strategy"] == "CUBE":
            return {"cube": info["cube_name"]}
        return {"mean": info["vertex_indices"]}
    bones = [{"name": n, "parent": order.index(rig[n]["parent"]) if rig[n]["parent"] else -1,
              "head": end(rig[n]["head"]), "tail": end(rig[n]["tail"])} for n in order]
    # The game-engine rig has no eye bones, so eyes can't look at anyone. Add one per eye (head at the
    # eyeball's center, tail at MakeHuman's eye-target cube) and give it the eye helper's vertices,
    # which the eye item is fitted to one-to-one. VRM look-at then turns these bones.
    head_index = order.index("head")
    for s in ("l", "r"):
        bones.append({"name": f"eye_{s}", "parent": head_index,
                      "head": {"cube": f"joint-{s}-eye"}, "tail": {"cube": f"joint-{s}-eye-target"}})
    used = {b[k]["cube"] for b in bones for k in ("head", "tail") if "cube" in b[k]}
    cubes = {name: [i for start, stop in groups[name] for i in range(start, stop + 1)] for name in sorted(used)}
    weights = json.load(open(os.path.join(SYSTEM, "rigs/standard/weights.game_engine.json")))["weights"]
    eye_vertices = {f"eye_{s}": [i for start, stop in groups[f"helper-{s}-eye"] for i in range(start, stop + 1)] for s in "lr"}
    per_vertex = [[] for _ in range(vertex_count)]
    for name, pairs in weights.items():
        for index, weight in pairs:
            per_vertex[index].append((weight, order.index(name)))
    names = [b["name"] for b in bones]
    for name, members in eye_vertices.items():
        for index in members:
            per_vertex[index] = [(1.0, names.index(name))]
    joints, values, trimmed = [], [], 0
    for influences in per_vertex:
        influences.sort(reverse=True)
        trimmed += len(influences) > 4
        top = (influences[:4] + [(0.0, 0)] * 4)[:4]
        total = sum(w for w, _ in top) or 1.0
        joints += [j for _, j in top]
        values += [w / total for w, _ in top]
    layout = write_bin(os.path.join(OUT, "skin.bin"), [("joints", "H", joints), ("weights", "f", values)])
    json.dump({"bones": bones, "cubes": cubes, "humanoid": HUMANOID, "layout": layout},
              open(os.path.join(OUT, "rig.json"), "w"))
    print("rig", len(bones), "bones,", len(HUMANOID), "humanoid,", trimmed, "vertices trimmed to 4 influences")


def read_target(path):
    opener = gzip.open if path.endswith(".gz") else open
    rows = []
    with opener(path, "rt") as handle:
        for line in handle:
            parts = line.split()
            if len(parts) == 4 and not line.startswith("#"):
                rows.append((int(parts[0]), float(parts[1]), float(parts[2]), float(parts[3])))
    return rows


def export_macros():
    folder = os.path.join(SYSTEM, "targets/macrodetails")
    # No "baby" targets: the editor's age slider starts at 11 years, where they always weigh 0.
    names = sorted(name[:-len(".target.gz")] for name in os.listdir(folder)
                   if name.endswith(".target.gz") and "baby" not in name)
    chunks, index = [], {}
    for name in names:
        rows = sorted(read_target(os.path.join(folder, name + ".target.gz")))
        chunks += target_chunks(name, rows)
        index[name] = len(rows)
    layout = write_bin(os.path.join(OUT, "macros.bin"), chunks)
    config = json.load(open(os.path.join(folder, "macro.json")))
    json.dump({"targets": index, "layout": layout, "quant": QUANT, "macro": config}, open(os.path.join(OUT, "macros.json"), "w"))
    print("macros", len(names), "targets,", os.path.getsize(os.path.join(OUT, "macros.bin.gz")) // 1024, "KB")


def export_modifiers():
    """Face-shape sliders (pipeline/modifiers.json): their MakeHuman targets, same format as the macros."""
    config = json.load(open(os.path.join(REPO, "pipeline", "modifiers.json")))
    names = sorted({t for m in config["modifiers"] for t in m.get("decr", []) + m.get("incr", [])})
    chunks, index = [], {}
    for name in names:
        rows = sorted(read_target(os.path.join(SYSTEM, "targets", name + ".target.gz")))
        chunks += target_chunks(name, rows)
        index[name] = len(rows)
    layout = write_bin(os.path.join(OUT, "modifiers.bin"), chunks)
    json.dump({"targets": index, "layout": layout, "quant": QUANT, "modifiers": config["modifiers"]},
              open(os.path.join(OUT, "modifiers.json"), "w"))
    print("modifiers", len(config["modifiers"]), "sliders,", len(names), "targets,", os.path.getsize(os.path.join(OUT, "modifiers.bin.gz")) // 1024, "KB")


def export_faces():
    expressions = json.load(open(os.path.join(REPO, "pipeline", "expressions.json")))
    names = sorted({key for binds in expressions.values() for key, _ in binds})
    chunks, index = [], {}
    for name in names:
        path = next(p for p in (os.path.join(USER, "targets", folder, name + ".target") for folder in ("visemes", "faceunits"))
                    if os.path.exists(p))
        rows = sorted(read_target(path))
        chunks += target_chunks(name, rows)
        index[name] = len(rows)
    layout = write_bin(os.path.join(OUT, "faces.bin"), chunks)
    json.dump({"targets": index, "layout": layout, "quant": QUANT, "expressions": expressions},
              open(os.path.join(OUT, "faces.json"), "w"))
    print("faces", len(names), "targets,", os.path.getsize(os.path.join(OUT, "faces.bin.gz")) // 1024, "KB")


def read_mhclo(path):
    info = {"scale": {}, "refs": [], "weights": [], "offsets": [], "delete": []}
    section = None
    with open(path, errors="replace") as handle:
        for line in handle:
            parts = line.split()
            if not parts or parts[0].startswith("#"):
                continue
            key = parts[0]
            if key in ("x_scale", "y_scale", "z_scale"):
                info["scale"][key[0]] = [int(parts[1]), int(parts[2]), float(parts[3])]
            elif key in ("obj_file", "material", "name", "z_depth", "source_item"):
                info[key] = parts[1]
            elif key == "verts":
                section = "verts"
            elif key == "delete_verts":
                section = "delete"
            elif section == "verts" and len(parts) == 9:
                info["refs"] += [int(x) for x in parts[0:3]]
                info["weights"] += [float(x) for x in parts[3:6]]
                info["offsets"] += [float(x) for x in parts[6:9]]
            elif section == "verts" and len(parts) == 1:
                info["refs"] += [int(parts[0]), 0, 0]
                info["weights"] += [1.0, 0.0, 0.0]
                info["offsets"] += [0.0, 0.0, 0.0]
            elif section == "delete" and key[0].isdigit():  # "a - b" ranges and single indices
                tokens = parts
                i = 0
                while i < len(tokens):
                    if i + 2 < len(tokens) and tokens[i + 1] == "-":
                        info["delete"] += range(int(tokens[i]), int(tokens[i + 2]) + 1)
                        i += 3
                    else:
                        info["delete"].append(int(tokens[i]))
                        i += 1
            elif section == "delete":
                section = None
    return info


def read_mhmat(path):
    texture = None
    if os.path.exists(path):
        for line in open(path, errors="replace"):
            parts = line.split()
            if len(parts) >= 2 and parts[0] == "diffuseTexture":
                texture = parts[1]
    return texture


CUTOUT = {"hair", "eyebrows", "eyelashes", "moustache", "beard", "glasses"}  # alpha MASK; everything else opaque


CUTOUT_SIZE = 1024   # px: cut-out textures (hair, brows, lashes, beards); the VRM export uses 1024 for these too
SMALL = {"teeth_front": 512, "tongue01": 512}  # barely visible: smaller textures


def image_size(path):
    out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path], check=True, capture_output=True, text=True).stdout
    return max(int(line.split()[-1]) for line in out.splitlines() if "pixel" in line)


def convert_texture(source, target_base, opaque, max_size=2048):
    """A texture for the browser: opaque ones as JPEG (macOS sips), cut-outs as WebP with lossless alpha
    (Homebrew cwebp), at most max_size px (cut-outs CUTOUT_SIZE)."""
    if opaque:
        target = target_base + ".jpg"
        resize = ["-Z", str(max_size)] if image_size(source) > max_size else []
        subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "85", *resize, source, "--out",
                        os.path.join(OUT, "textures", target)], check=True, capture_output=True)
    else:
        target = target_base + ".webp"
        side = min(max_size, CUTOUT_SIZE)
        size = image_size(source)
        resize = ["-resize", str(side), "0"] if size > side else []
        subprocess.run(["cwebp", "-quiet", "-q", "88", "-alpha_q", "100", "-exact", *resize, source, "-o",
                        os.path.join(OUT, "textures", target)], check=True, capture_output=True)
    return target


def thumbnail(source, target):
    """A 128 px WebP thumbnail."""
    subprocess.run(["cwebp", "-quiet", "-q", "80", "-resize", "128", "0", source, "-o", target], check=True, capture_output=True)


def average_color(path):
    """Mean color of an image, via an 8x8 BMP from sips (stdlib can't decode PNG/JPEG pixels)."""
    tmp = os.path.join(OUT, "_swatch.bmp")
    subprocess.run(["sips", "-z", "8", "8", "-s", "format", "bmp", path, "--out", tmp], check=True, capture_output=True)
    data = open(tmp, "rb").read()
    os.remove(tmp)
    offset, width, height, bits = struct.unpack_from("<I", data, 10)[0], *struct.unpack_from("<iiH", data, 18)[:2], struct.unpack_from("<H", data, 28)[0]
    step, row = bits // 8, (bits // 8 * width + 3) & ~3
    pixels = [data[offset + y * row + x * step: offset + y * row + x * step + 3] for y in range(abs(height)) for x in range(width)]
    return [round(sum(p[2 - k] for p in pixels) / len(pixels)) for k in range(3)]  # BMP is BGR


def export_item(relative, slug, category, cutout=None, base=None):
    path = os.path.join(REPO if relative.startswith("assets/") else USER, relative)
    folder = os.path.dirname(path)
    fit = read_mhclo(path)
    if "source_item" in fit:  # a lighter copy from make_low_item.py: material and thumbnail stay with the original
        original_folder = os.path.dirname(os.path.join(USER, fit["source_item"]))
    else:
        original_folder = folder
    _, source, uv, indices = read_obj(os.path.join(folder, fit["obj_file"]))
    hides = os.path.join(REPO, "assets", "hides", (base or slug) + ".json")  # make_hides.py, for items that don't say
    if os.path.exists(hides):
        fit["delete"] = sorted(set(fit["delete"]) | set(json.load(open(hides))["hides"]))
    layout = write_bin(os.path.join(OUT, "items", slug + ".bin"), [
        ("source", "I", source),
        ("uv", "f", [c for t in uv for c in t]),
        ("indices", "I", indices),
        ("refs", "I", fit["refs"]),
        ("weights", "f", fit["weights"]),
        ("offsets", "f", fit["offsets"]),
        ("delete", "I", fit["delete"]),
    ])
    material = os.path.normpath(os.path.join(original_folder, fit.get("material", "")))
    texture = read_mhmat(material)
    texture_file = None
    if texture:  # relative to the .mhmat file (eyes keep theirs in ../materials/)
        candidates = [os.path.join(os.path.dirname(material), texture), os.path.join(folder, texture)]
        found = next((c for c in candidates if os.path.isfile(c)), None)
        branded = os.path.join(REPO, "assets", "plain", slug + ".png")  # make_plain_shirts.py: logo covered
        painted = os.path.join(REPO, "assets", "painted", slug + ".png")  # paint_garments.py: our own designs
        if found and os.path.isfile(branded):
            found = branded
        elif base and os.path.isfile(painted):
            found = painted
        if found:
            texture_file = convert_texture(found, slug, not (cutout if cutout is not None else category in CUTOUT), SMALL.get(slug, 2048))
    if cutout is None:
        cutout = category in CUTOUT
    thumbs = [f for f in os.listdir(original_folder) if f.endswith(".thumb")]
    if "source_item" in fit and os.path.exists(os.path.join(folder, slug + ".trimmed")):
        thumbs = []  # a trimmed copy (goatee from a long beard): the original's picture would mislead
    if base:
        thumbs = []  # a painted copy: the original's picture would mislead
    branded_thumb = os.path.join(REPO, "assets", "plain" if not base else "painted", slug + ".thumb.png")
    if os.path.isfile(branded_thumb):
        thumbnail(branded_thumb, os.path.join(OUT, "thumbs", slug + ".webp"))
    elif thumbs:
        thumbnail(os.path.join(original_folder, thumbs[0]), os.path.join(OUT, "thumbs", slug + ".webp"))
    json.dump({"name": fit.get("name", slug), "kind": category, "cutout": cutout, "layout": layout,
               "scale": fit["scale"], "texture": texture_file, "vertexCount": len(fit["refs"]) // 3,
               "triangles": len(indices) // 3, "zDepth": int(fit.get("z_depth", 50))},
              open(os.path.join(OUT, "items", slug + ".json"), "w"))
    print(f"item {slug:36s} {category:10s} {len(indices) // 3:6d} triangles, hides {len(fit['delete'])} body vertices")
    return len(indices) // 3


def export_skin(name):
    path = os.path.join(USER, "skins", name, name + ".mhmat")
    source = os.path.join(os.path.dirname(path), read_mhmat(path))
    return {"texture": convert_texture(source, "skin_" + name, True), "swatch": average_color(source)}


def export_eye_color(name):
    """The eye texture, plus a small copy for the color swatch (the editor zooms it onto one iris)."""
    path = os.path.join(USER, "eyes", "materials", name + ".mhmat")
    source = os.path.join(os.path.dirname(path), read_mhmat(path))
    subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "192", source, "--out",
                    os.path.join(OUT, "thumbs", "eye_" + name + ".jpg")], check=True, capture_output=True)
    return convert_texture(source, "eye_" + name, True)


if __name__ == "__main__":
    for sub in ("", "items", "textures", "thumbs"):
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)
    for sub in ("thumbs", "textures", "items"):  # start clean: formats change (PNG -> WebP, .bin -> .bin.gz)
        for old in os.listdir(os.path.join(OUT, sub)):
            os.remove(os.path.join(OUT, sub, old))
    catalog = json.load(open(os.path.join(REPO, "pipeline", "catalog.json")))
    export_rig(export_base())
    export_macros()
    export_modifiers()
    export_faces()
    index = {"categories": {}, "always": [], "skins": {}, "eyeColors": {}}
    by_id = {i["id"]: i for c in catalog["categories"].values() for i in c["items"]}
    # "base": our own design painted on another item's mesh (pipeline/paint_garments.py)
    source_of = lambda item: (source_of(by_id[item["base"]]) if "base" in item else
                              f"assets/parts/{item['id']}/{item['id']}.mhclo" if "derive" in item else item["path"])
    for item in catalog["always"]:
        export_item(source_of(item), item["id"], item["path"].split("/")[0])
        index["always"].append(item["id"])
    for key, category in catalog["categories"].items():
        entries = []
        for item in category["items"]:
            if "paint" in item:  # painted into the skin texture by the editor (masks/), no mesh
                entries.append({"id": item["id"], "label": item["label"], "triangles": 0, "thumb": False, "paint": item["paint"]})
                continue
            relative = source_of(item)
            if not os.path.exists(os.path.join(REPO if relative.startswith("assets/") else USER, relative)):
                print("MISSING (run pipeline/make_parts.sh):", relative)
                continue
            triangles = export_item(relative, item["id"], key, item.get("cutout"), item.get("base"))
            entries.append({"id": item["id"], "label": item["label"], "triangles": triangles,
                            "thumb": os.path.exists(os.path.join(OUT, "thumbs", item["id"] + ".webp"))})
            if item.get("skirt"):  # skinned as a skirt (web/lib/cloth.js) so it doesn't tear when seated
                entries[-1]["skirt"] = True
        index["categories"][key] = {"label": category["label"], "none": category.get("none"), "items": entries}
    for name in catalog["skins"]:
        index["skins"][name] = export_skin(name)
    for name in catalog["eyeColors"]:
        index["eyeColors"][name] = export_eye_color(name)
    masks = os.path.join(OUT, "masks")
    index["masks"] = sorted(f for f in os.listdir(masks) if f.startswith("mask_")) if os.path.isdir(masks) else []
    if not index["masks"]:
        print("MISSING makeup masks (run pipeline/make_parts.sh)")
    json.dump(index, open(os.path.join(OUT, "index.json"), "w"), indent=1)
    print("wrote", os.path.normpath(OUT), "-", sum(len(c["items"]) for c in index["categories"].values()), "catalog items,",
          len(index["skins"]), "skins,", len(index["eyeColors"]), "eye colors")
