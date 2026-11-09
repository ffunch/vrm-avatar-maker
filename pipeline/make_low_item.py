"""Make a lighter copy of a MakeHuman item (.mhclo + .obj) for the browser editor.

The browser fits items with .mhclo data, so a decimated mesh needs its own fitting data. Each new
vertex takes the 3 base-mesh references, weights and offset of the nearest original vertex, with the
offset shifted by how far Decimate moved it from that vertex. Weights, face shapes and refitting then work
as for any other item. Output goes to assets/parts/<name>/ (committed: small, derived from CC0 data).

Optionally keep only some faces first (a front-teeth-only set, a beard trimmed short):
  --keep EXPR        Python expression on a face's center x, y, z (.obj units: decimeters, y up,
                     +z forward) and the mesh bounds xmin..zmax; faces where it is false are deleted
  --drop-reddish     also delete faces whose texture is reddish at their UV center (gums)

Run headless:
  Blender -b --python pipeline/make_low_item.py -- teeth/teeth_base/teeth_base.mhclo 0.15 teeth_base_low
  Blender -b --python pipeline/make_low_item.py -- <beard.mhclo> 1.0 beard_short --keep "y > 6.95"
"""

import os
import sys

import bmesh
import bpy
from mathutils import kdtree

HOME = os.path.expanduser("~")
SYSTEM = os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/blender_org/mpfb/data")
USER = os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/.user/blender_org/mpfb/data")
REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

argv = sys.argv[sys.argv.index("--") + 1:]
relative, ratio, name = argv[0], float(argv[1]), argv[2]
keep_expr = argv[argv.index("--keep") + 1] if "--keep" in argv else None
drop_reddish = "--drop-reddish" in argv
source = os.path.join(USER, relative)
out_dir = os.path.join(REPO, "assets", "parts", name)
os.makedirs(out_dir, exist_ok=True)


def read_positions(path):
    with open(path, errors="replace") as handle:
        return [tuple(float(x) for x in line.split()[1:4]) for line in handle if line.startswith("v ")]



# Original .mhclo: header lines (kept), and the fit rows.
header, fits, deletes, section = [], [], [], None
with open(source, errors="replace") as handle:
    for line in handle:
        parts = line.split()
        if parts and parts[0] == "verts":
            section = "verts"
            continue
        if parts and parts[0] == "delete_verts":
            section = "delete"
        if section == "delete":
            deletes.append(line)  # base-mesh vertices the item hides: unchanged by decimation
            continue
        if section == "verts" and len(parts) == 9:
            fits.append(([int(x) for x in parts[0:3]], [float(x) for x in parts[3:6]], [float(x) for x in parts[6:9]]))
            continue
        if section == "verts" and len(parts) == 1 and parts[0].isdigit():
            fits.append(([int(parts[0]), 0, 0], [1.0, 0.0, 0.0], [0.0, 0.0, 0.0]))
            continue
        # Keyword lines may sit inside the verts section (bob01 has "material" after "verts 0");
        # like MakeHuman's reader, they don't end it.
        if parts and parts[0] == "obj_file":
            line = f"obj_file {name}.obj\n"
        header.append(line)

# Decimate in Blender, in the .obj's own coordinates (no axis conversion).
original_obj = os.path.join(os.path.dirname(source), [l for l in open(source, errors="replace") if l.startswith("obj_file")][0].split()[1])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=original_obj, forward_axis="Y", up_axis="Z")
obj = bpy.context.selected_objects[0]
original = [tuple(v.co) for v in obj.data.vertices]
assert len(original) == len(fits), (len(original), len(fits))
before = len(obj.data.polygons)
if keep_expr or drop_reddish:
    pixels = None
    if drop_reddish:
        material = next(l.split()[1] for l in header if l.startswith("material"))
        mhmat = os.path.join(os.path.dirname(source), material)
        texture = next(l.split()[1] for l in open(mhmat, errors="replace") if l.startswith("diffuseTexture"))
        image = bpy.data.images.load(os.path.join(os.path.dirname(mhmat), texture))
        width, height = image.size
        pixels = image.pixels[:]
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv_layer = bm.loops.layers.uv.active
    xs, ys, zs = zip(*original)
    bounds = dict(xmin=min(xs), xmax=max(xs), ymin=min(ys), ymax=max(ys), zmin=min(zs), zmax=max(zs))
    drop = []
    for face in bm.faces:
        c = face.calc_center_median()
        if keep_expr and not eval(keep_expr, {}, dict(bounds, x=c.x, y=c.y, z=c.z)):
            drop.append(face)
            continue
        if pixels is not None:
            u = sum(loop[uv_layer].uv.x for loop in face.loops) / len(face.loops)
            v = sum(loop[uv_layer].uv.y for loop in face.loops) / len(face.loops)
            i = 4 * (min(height - 1, int(v * height)) * width + min(width - 1, int(u * width)))
            r, g = pixels[i], pixels[i + 1]
            if r > 1.35 * g:
                drop.append(face)
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # Keep the original vertex order for the survivors' fitting rows: map by position below.
    bm.to_mesh(obj.data)
    bm.free()
    print(f"kept {len(obj.data.polygons)} of {before} faces")
if ratio < 1.0:
    decimate = obj.modifiers.new("Decimate", "DECIMATE")
    decimate.ratio = ratio
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=decimate.name)
low_path = os.path.join(out_dir, name + ".obj")
bpy.ops.wm.obj_export(filepath=low_path, forward_axis="Y", up_axis="Z", export_selected_objects=True,
                      export_materials=False, export_normals=False, export_uv=True, apply_modifiers=True)
low = read_positions(low_path)

tree = kdtree.KDTree(len(original))
for i, co in enumerate(original):
    tree.insert(co, i)
tree.balance()

rows = []
for p in low:
    _, nearest, _ = tree.find(p)
    # Keep MakeHuman's own placement: the .mhclo fit does not reproduce the raw .obj coordinates
    # (teeth land ~4 cm higher), so shift the nearest vertex's offset by the local displacement.
    refs, weights, offset0 = fits[nearest]
    offset = [offset0[k] + p[k] - original[nearest][k] for k in range(3)]
    rows.append(f"{refs[0]} {refs[1]} {refs[2]} {weights[0]:.6f} {weights[1]:.6f} {weights[2]:.6f} "
                f"{offset[0]:.6f} {offset[1]:.6f} {offset[2]:.6f}\n")

with open(os.path.join(out_dir, name + ".mhclo"), "w") as handle:
    handle.write(f"# Generated by pipeline/make_low_item.py from {relative} (Decimate ratio {ratio}).\n")
    handle.write(f"source_item {relative}\n")
    handle.writelines(header)
    handle.write("verts 0\n")
    handle.writelines(rows)
    handle.writelines(deletes)
if keep_expr:  # marks a trimmed copy, so export_web_assets.py doesn't reuse the original's thumbnail
    open(os.path.join(out_dir, name + ".trimmed"), "w").write(keep_expr + "\n")
print(f"{relative}: {before} -> {len(obj.data.polygons)} faces, {len(low)} vertices -> {out_dir}")
