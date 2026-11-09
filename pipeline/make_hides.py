"""Work out which body vertices each garment covers, for garments whose .mhclo doesn't say.

MakeHuman items list the body vertices they hide (delete_verts), but many CC0 clothes leave it empty.
Then the whole body renders under them: wasted triangles (a polo and trousers left an avatar 285 over
So Many Rooms' 40k budget), and skin can poke through the cloth.

For each opaque garment in the catalog: fit it to the base mesh at rest, then cast a ray outward
from every body vertex along its normal. A vertex is covered if the garment lies within 0.4 dm (4 cm).
The covered set is eroded by one ring, so the edges at hems and sleeves stay closed. The result goes
to assets/hides/<id>.json (committed); export_web_assets.py adds it to the item's delete_verts.

Run headless (uses Blender's BVH tree):
  Blender -b --python pipeline/make_hides.py
"""

import json
import os

import bpy  # noqa: F401  (run inside Blender for mathutils)
from mathutils import Vector
from mathutils.bvhtree import BVHTree

HOME = os.path.expanduser("~")
SYSTEM = os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/blender_org/mpfb/data")
USER = os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/.user/blender_org/mpfb/data")
REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
REACH = 0.4  # decimeters
# Skirts and dresses stand off the thighs. Seated, the thighs bend and the knees bulge, and the skin
# pokes through the lap; so the legs they cover are hidden (the skirt is weighted to follow them).
REACH_SKIRT = 1.5
# But seated, a flared or tiered skirt opens between the knees, and with the legs hidden there one sees
# straight through to the seat. So the inner thighs stay (skin whose normal points toward the middle
# by more than this); only the tops and outsides of the legs, where the knees would poke through, go.
INNER = 0.35
# Seated, a hem rides up the leg and the cut edge of hidden skin (saw-toothed, the mesh's own triangles)
# would show just below it: below the knee the hidden area is eroded by this many more rings of vertices
# (not above: there the bent knee and thigh would poke through a short skirt).
LEG_RINGS = 4
CLOTHES = ("outfit", "top", "bottom", "shoes")


def read_obj(path, only_group=None):
    verts, faces, group = [], [], None
    for line in open(path, errors="replace"):
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "v":
            verts.append(Vector([float(x) for x in parts[1:4]]))
        elif parts[0] == "g":
            group = parts[1] if len(parts) > 1 else None
        elif parts[0] == "f" and (only_group is None or group == only_group):
            faces.append([int(c.split("/")[0]) - 1 for c in parts[1:]])
    return verts, faces


def read_mhclo(path):
    fit, deletes, scale, obj, section = [], 0, {}, None, None
    for line in open(path, errors="replace"):
        parts = line.split()
        if not parts or parts[0].startswith("#"):
            continue
        if parts[0] in ("x_scale", "y_scale", "z_scale"):
            scale[parts[0][0]] = (int(parts[1]), int(parts[2]), float(parts[3]))
        elif parts[0] == "obj_file":
            obj = parts[1]
        elif parts[0] == "verts":
            section = "verts"
        elif parts[0] == "delete_verts":
            section = "delete"
        elif section == "verts" and len(parts) == 9:
            fit.append(([int(x) for x in parts[:3]], [float(x) for x in parts[3:6]], [float(x) for x in parts[6:9]]))
        elif section == "verts" and len(parts) == 1 and parts[0].isdigit():
            fit.append(([int(parts[0])] * 3, [1.0, 0.0, 0.0], [0.0, 0.0, 0.0]))
        elif section == "delete" and parts[0][0].isdigit():
            deletes += len(parts)
    return fit, deletes, scale, obj


base, body_faces = read_obj(os.path.join(SYSTEM, "3dobjs/base.obj"), only_group="body")
normals = [Vector() for _ in base]
neighbors = {}
for face in body_faces:
    n = (base[face[1]] - base[face[0]]).cross(base[face[2]] - base[face[0]])
    for i, v in enumerate(face):
        normals[v] += n
        neighbors.setdefault(v, set()).update(face[:i] + face[i + 1:])
body = sorted(neighbors)
_low, _high = min(base[v].y for v in body), max(base[v].y for v in body)
knee = _low + 0.26 * (_high - _low)  # just below the kneecap: shins under this

catalog = json.load(open(os.path.join(REPO, "pipeline", "catalog.json")))
out_dir = os.path.join(REPO, "assets", "hides")
os.makedirs(out_dir, exist_ok=True)
for key in CLOTHES:
    for item in catalog["categories"][key]["items"]:
        if item.get("cutout") or "base" in item:
            continue  # see-through textures: the body must show; painted copies use their base's
        path = os.path.join(REPO, "assets", "parts", item["id"], item["id"] + ".mhclo") if "derive" in item else os.path.join(USER, item["path"])
        fit, existing, scale, obj = read_mhclo(path)
        if existing and not item.get("skirt"):
            continue  # the item already says what it hides (skirts: add ours, see REACH_SKIRT)
        s = [abs(base[scale[a][0]]["xyz".index(a)] - base[scale[a][1]]["xyz".index(a)]) / scale[a][2] if a in scale else 1.0 for a in "xyz"]
        verts = [sum((base[r] * w for r, w in zip(refs, ws)), Vector()) + Vector([o[k] * s[k] for k in range(3)])
                 for refs, ws, o in fit]
        _, faces = read_obj(os.path.join(os.path.dirname(path), obj))
        tree = BVHTree.FromPolygons(verts, faces)
        covered = set()
        for v in body:
            n = normals[v].normalized()
            if item.get("skirt") and abs(base[v].x) > 0.05 and n.x * base[v].x < -INNER * abs(base[v].x):
                continue  # inner thigh: kept (see INNER)

            hit = tree.ray_cast(base[v] + n * 0.001, n, REACH_SKIRT if item.get("skirt") else REACH)
            if hit[0] is not None:
                covered.add(v)
        if item.get("skirt"):  # on the shins, stop well short of the hem (see LEG_RINGS)
            for _ in range(LEG_RINGS):
                covered -= {v for v in covered if base[v].y < knee and not neighbors[v] <= covered}
        hides = sorted(v for v in covered if neighbors[v] <= covered)  # erode one ring
        json.dump({"id": item["id"], "hides": hides}, open(os.path.join(out_dir, item["id"] + ".json"), "w"))
        print(f"{item['id']:32s} covers {len(covered):5d}, hides {len(hides):5d} body vertices")
