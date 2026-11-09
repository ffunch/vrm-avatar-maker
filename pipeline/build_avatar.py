"""Build one avatar from a recipe and export it as VRM 1.0, headless.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b \
      --python pipeline/build_avatar.py -- <recipe.json> <out.vrm>

A recipe (pipeline/recipes/*.json) names the body settings and the CC0 MakeHuman assets to wear.
Asset paths are relative to MPFB's user data folder, which holds the installed asset packs
(see README.md, "The asset pipeline"). Only assets whose own header says CC0 may be used.

Needs the Blender extensions "mpfb" and "vrm" enabled.
"""

import json
import os
import sys

import bpy
from mathutils import Vector

from bl_ext.blender_org.mpfb.services.exportservice import ExportService
from bl_ext.blender_org.mpfb.services.faceservice import FaceService
from bl_ext.blender_org.mpfb.services.humanservice import HumanService
from bl_ext.blender_org.mpfb.services.locationservice import LocationService
from bl_ext.blender_org.mpfb.services.rigservice import RigService
from bl_ext.blender_org.mpfb.services.targetservice import TargetService

# VRM 1.0 preset expressions, built from MPFB face shapes: (shape key, weight). Mouth shapes for
# talking: aa/ih/ou/ee/oh. Blinks drive the eyelids (and are copied to the lashes). The mapping lives
# in expressions.json, shared with the browser editor (pipeline/export_web_assets.py).
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "expressions.json")) as _handle:
    EXPRESSIONS = {name: [tuple(bind) for bind in binds] for name, binds in json.load(_handle).items()}

argv = sys.argv[sys.argv.index("--") + 1:]
recipe_path, out_path = argv[0], argv[1]
with open(recipe_path) as handle:
    recipe = json.load(handle)
DATA = LocationService.get_user_data()
MAX_TEXTURE = recipe.get("max_texture", 2048)  # So Many Rooms' budget: longest edge <= 2048


def asset(relative):
    path = os.path.join(DATA, relative)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Asset not installed: {relative}")
    return path


def log(*parts):
    print("BUILD", *parts)


for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

# --- Body ---------------------------------------------------------------------------------------
# MPFB macros: gender 0 = female, 1 = male; age 0.5 = 25 years; race weights sum to about 1.
macros = TargetService.get_default_macro_info_dict()
for key, value in recipe.get("body", {}).items():
    if key == "race":
        macros["race"].update(value)
    else:
        macros[key] = value
basemesh = HumanService.create_human(
    mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True,  # joint-* helpers place the bones
    feet_on_ground=True, scale=0.1, macro_detail_dict=macros,
)
rig = HumanService.add_builtin_rig(basemesh, "game_engine", import_weights=True)

# --- Skin and worn assets -------------------------------------------------------------------------
# GAMEENGINE materials are plain textured Principled materials, which glTF/VRM export cleanly.
HumanService.set_character_skin(asset(recipe["skin"]), basemesh, skin_type="GAMEENGINE")
worn = [("Eyes", recipe["eyes"])]
# Teeth and tongue show when the mouth opens (talking); default on.
worn += [("Teeth", recipe.get("teeth", "teeth/teeth_base/teeth_base.mhclo"))] if recipe.get("teeth", True) else []
worn += [("Tongue", recipe.get("tongue", "tongue/tongue01/tongue01.mhclo"))] if recipe.get("tongue", True) else []
worn += [("Eyebrows", recipe["eyebrows"])] if recipe.get("eyebrows") else []
worn += [("Eyelashes", recipe["eyelashes"])] if recipe.get("eyelashes") else []
worn += [("Hair", recipe["hair"])] if recipe.get("hair") else []  # no hair = bald
worn += [("Clothes", item) for item in recipe.get("clothes", [])]
for asset_type, relative in worn:
    HumanService.add_mhclo_asset(
        asset(relative), basemesh, asset_type=asset_type, subdiv_levels=0, material_type="GAMEENGINE",
    )
    log("wear", asset_type, relative)

# MPFB keeps the body shape as live shape keys, which the VRM exporter mishandles; bake them now,
# before the T-pose (applying a pose fails on meshes that have shape keys).
TargetService.bake_targets(basemesh)

# --- T-pose as rest -------------------------------------------------------------------------------
# MPFB's rest pose is an A-pose. VRM 1.0 wants a T-pose at rest, and So Many Rooms' seating
# poses bones relative to it. Aim each arm bone straight out
# along world X, then make that pose the rest pose (this also re-skins the worn assets).
targets = []
for side, sign in (("l", 1.0), ("r", -1.0)):
    for name in (f"upperarm_{side}", f"lowerarm_{side}", f"hand_{side}"):
        head = rig.matrix_world @ rig.data.bones[name].head_local
        target = bpy.data.objects.new(f"aim_{name}", None)
        target.location = head + Vector((sign * 10.0, 0.0, 0.0))
        bpy.context.scene.collection.objects.link(target)
        targets.append(target)
        track = rig.pose.bones[name].constraints.new("DAMPED_TRACK")
        track.target = target
        track.track_axis = "TRACK_Y"  # a bone points along its own Y
bpy.ops.object.select_all(action="DESELECT")
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.select_all(action="SELECT")
bpy.ops.pose.visual_transform_apply()
for bone in rig.pose.bones:
    for constraint in list(bone.constraints):
        bone.constraints.remove(constraint)
for target in targets:
    bpy.data.objects.remove(target, do_unlink=True)
bpy.ops.object.mode_set(mode="OBJECT")
RigService.apply_pose_as_rest_pose(rig)
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.update()

# --- Face shapes (expressions) ----------------------------------------------------------------
# Added after the T-pose: posing can't be applied to meshes with shape keys, and the T-pose moves
# only the arms, so face offsets are unaffected. Visemes (Microsoft set) drive talking; a few ARKit
# face units drive blinking and emotions. Only the units the VRM expressions below use are kept,
# to keep the file small. interpolate_targets copies them onto brows, lashes and facial hair.
if recipe.get("expressions", True):
    FaceService.load_targets(basemesh, load_microsoft_visemes=True, load_arkit_faceunits=True)
    keep = {key for binds in EXPRESSIONS.values() for key, _ in binds}
    for block in list(basemesh.data.shape_keys.key_blocks):
        if block.name != "Basis" and block.name not in keep:
            basemesh.shape_key_remove(block)
    FaceService.interpolate_targets(basemesh)
    log("face shapes", len(basemesh.data.shape_keys.key_blocks) - 1)

# --- Bake ---------------------------------------------------------------------------------------
# bake_masks applies the clothes' delete groups, removing body faces hidden under clothes.
# MPFB applies these modifiers while keeping the face shape keys.
ExportService.bake_modifiers_remove_helpers(basemesh, bake_masks=True, remove_helpers=True)
for obj in rig.children:
    for modifier in list(obj.modifiers) if obj.type == "MESH" else []:
        if modifier.type == "SUBSURF":
            obj.modifiers.remove(modifier)

# --- Lighter teeth --------------------------------------------------------------------------------
# MakeHuman teeth are 7,120 triangles, too many for So Many Rooms' 40k budget. Make a decimated copy,
# carry over the armature weights (Data Transfer) and every face shape (Surface Deform bound to the
# original), then replace the original.


def decimate_keeping_shapes(source, ratio):
    keys = [block.name for block in source.data.shape_keys.key_blocks[1:]] if source.data.shape_keys else []
    low = source.copy()
    low.data = source.data.copy()
    bpy.context.scene.collection.objects.link(low)
    low.parent = source.parent
    low.matrix_world = source.matrix_world.copy()
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = low
    low.select_set(True)
    if low.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True, apply_mix=False)
    for modifier in list(low.modifiers):
        low.modifiers.remove(modifier)
    decimate = low.modifiers.new("Decimate", "DECIMATE")
    decimate.ratio = ratio
    bpy.ops.object.modifier_apply(modifier=decimate.name)
    low.vertex_groups.clear()
    for group in source.vertex_groups:
        low.vertex_groups.new(name=group.name)
    transfer = low.modifiers.new("Weights", "DATA_TRANSFER")
    transfer.object = source
    transfer.use_vert_data = True
    transfer.data_types_verts = {"VGROUP_WEIGHTS"}
    transfer.vert_mapping = "NEAREST"
    transfer.layers_vgroup_select_src = "ALL"
    transfer.layers_vgroup_select_dst = "NAME"
    bpy.ops.object.modifier_apply(modifier=transfer.name)
    if keys:
        for block in source.data.shape_keys.key_blocks:
            block.value = 0.0
        deform = low.modifiers.new("Follow", "SURFACE_DEFORM")
        deform.target = source
        bpy.ops.object.surfacedeform_bind(modifier=deform.name)
        low.shape_key_add(name="Basis", from_mix=False)
        for key in keys:
            source.data.shape_keys.key_blocks[key].value = 1.0
            bpy.context.view_layer.update()
            bpy.ops.object.modifier_apply_as_shapekey(keep_modifier=True, modifier=deform.name)
            low.data.shape_keys.key_blocks[-1].name = key
            source.data.shape_keys.key_blocks[key].value = 0.0
        low.modifiers.remove(deform)
    for modifier in source.modifiers:
        if modifier.type == "ARMATURE":
            armature = low.modifiers.new("Armature", "ARMATURE")
            armature.object = modifier.object
    name = source.name
    bpy.data.objects.remove(source, do_unlink=True)
    low.name = name
    return low


for obj in list(rig.children):
    if obj.type == "MESH" and "teeth" in obj.name.lower():
        before = len(obj.data.polygons)
        low = decimate_keeping_shapes(obj, recipe.get("teeth_ratio", 0.15))
        log("teeth", before, "->", len(low.data.polygons), "faces;",
            len(low.data.shape_keys.key_blocks) - 1 if low.data.shape_keys else 0, "shapes")

# --- Textures within budget -----------------------------------------------------------------------
# Longest edge <= MAX_TEXTURE. (Opaque textures become JPEG after export, in fix_materials.)
for image in list(bpy.data.images):
    if image.size[0] == 0:
        continue
    longest = max(image.size)
    if longest > MAX_TEXTURE:
        factor = MAX_TEXTURE / longest
        image.scale(max(1, int(image.size[0] * factor)), max(1, int(image.size[1] * factor)))
        log("scaled", image.name, "from", longest)

# --- VRM 1.0 --------------------------------------------------------------------------------------
ext = rig.data.vrm_addon_extension
ext.spec_version = "1.0"
bpy.context.view_layer.objects.active = rig
bpy.ops.vrm.assign_vrm1_humanoid_human_bones_automatically(armature_object_name=rig.name)
ext.vrm1.humanoid.pose = "restPositionPose"  # export the T-pose rest as-is; no automatic re-posing

# Expressions: bind each preset to the shape keys on every mesh that has them.
if recipe.get("expressions", True):
    preset = ext.vrm1.expressions.preset
    meshes_with_keys = [obj for obj in rig.children if obj.type == "MESH" and obj.data.shape_keys]
    for expression, keys in EXPRESSIONS.items():
        group = getattr(preset, expression)
        for obj in meshes_with_keys:
            for key, weight in keys:
                if key in obj.data.shape_keys.key_blocks:
                    bind = group.morph_target_binds.add()
                    bind.node.mesh_object_name = obj.name
                    bind.index = key
                    bind.weight = weight
        log("expression", expression, len(group.morph_target_binds))
    for obj in meshes_with_keys:
        for block in obj.data.shape_keys.key_blocks:
            block.value = 0.0

meta = ext.vrm1.meta
meta.vrm_name = recipe.get("name", "VRM Avatar Maker avatar")
meta.version = "0.1"
if not len(meta.authors):
    meta.authors.add()
meta.authors[0].value = "VRM Avatar Maker"
meta.copyright_information = "Made with MPFB 2 (MakeHuman) and CC0 MakeHuman assets"
for field, value in {
    "avatar_permission": "everyone",
    "commercial_usage": "corporation",
    "credit_notation": "unnecessary",
    "modification": "allowModificationRedistribution",
}.items():
    setattr(meta, field, value)
meta.allow_redistribution = True

meshes = [obj for obj in rig.children if obj.type == "MESH"]
log("meshes", [(obj.name, len(obj.data.polygons), len(obj.material_slots)) for obj in meshes])
result = bpy.ops.export_scene.vrm(filepath=out_path, armature_object_name=rig.name, export_try_sparse_sk=True)
log("export", result, out_path)

# Alpha modes for three-vrm, JPEG for opaque textures, sparse face shapes, embedded recipe
# (see fix_materials.py). Blender does the JPEG encoding; the stdlib can't.
import tempfile  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fix_materials  # noqa: E402


def encode_jpeg(png_bytes):
    folder = tempfile.mkdtemp(prefix="avatar-jpeg-")
    source, target = os.path.join(folder, "in.png"), os.path.join(folder, "out.jpg")
    with open(source, "wb") as handle:
        handle.write(png_bytes)
    image = bpy.data.images.load(source)
    settings = bpy.context.scene.render.image_settings
    settings.file_format, settings.color_mode, settings.quality = "JPEG", "RGB", recipe.get("jpeg_quality", 85)
    image.save_render(target, scene=bpy.context.scene)
    bpy.data.images.remove(image)
    with open(target, "rb") as handle:
        return handle.read()


with open(out_path, "rb") as handle:
    fixed = fix_materials.fix(handle.read(), recipe=recipe, encode_jpeg=encode_jpeg)
with open(out_path, "wb") as handle:
    handle.write(fixed)
