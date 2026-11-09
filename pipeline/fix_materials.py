"""Post-process an exported VRM: alpha modes three-vrm can sort, compact face shapes, recipe.

Blender's exporter marks every MPFB GAMEENGINE material as alphaMode BLEND. Blended materials
can't be depth-sorted reliably, so in three-vrm the face shows through the hair and eyebrows turn
into grey patches. Rules:
  - hair, eyebrows, eyelashes, facial hair, glasses: MASK (cut-out at 0.5), double-sided
  - the body: OPAQUE, single-sided
  - everything else (eyes, clothes, shoes): OPAQUE, double-sided (necklines and cuffs show their inside)

Also stores morph targets (face shapes) sparsely without normals and repacks the binary chunk,
and optionally stores the avatar's recipe in asset.extras.avatarEditorRecipe.
Usage: python3 pipeline/fix_materials.py <in.vrm> [out.vrm]   (in place if no out)
"""

import json
import struct
import sys

CUTOUT = ("hair", "eyebrow", "eyelash", "moustache", "mustache", "beard", "glasses", "goatee", "short0", "long0", "bob0", "afro", "ponytail", "braid")


def kind(material_name, mesh_types):
    lowered = material_name.lower()
    if mesh_types.get(material_name) == "hair" or any(word in lowered for word in CUTOUT):
        return "cutout"
    if lowered.endswith(".body") or lowered == "body":
        return "body"
    return "opaque"


def jpeg_opaque_images(document, binary, encode_jpeg):
    """Re-encode PNG images used only by opaque materials as JPEG (alpha isn't needed there).

    Writes the JPEGs as new buffer views at the end; compact_morphs (or the next repack) drops the
    old PNG views. Returns the new binary payload.
    """
    textures, images, views = document.get("textures", []), document.get("images", []), document["bufferViews"]
    cutout_images, opaque_images = set(), set()
    for material in document.get("materials", []):
        refs = [material.get("pbrMetallicRoughness", {}).get("baseColorTexture"), material.get("normalTexture"),
                material.get("pbrMetallicRoughness", {}).get("metallicRoughnessTexture"),
                material.get("occlusionTexture"), material.get("emissiveTexture")]
        for ref in filter(None, refs):
            source = textures[ref["index"]].get("source")
            if source is not None:
                (cutout_images if material.get("alphaMode") == "MASK" else opaque_images).add(source)
    binary = bytearray(binary)
    for index in sorted(opaque_images - cutout_images):
        image = images[index]
        if image.get("mimeType") != "image/png" or "bufferView" not in image:
            continue
        view = views[image["bufferView"]]
        start = view.get("byteOffset", 0)
        jpeg = encode_jpeg(bytes(binary[start:start + view["byteLength"]]))
        if len(jpeg) >= view["byteLength"]:
            continue
        binary += b"\0" * (-len(binary) % 4)
        views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(jpeg)})
        binary += jpeg
        image["bufferView"], image["mimeType"] = len(views) - 1, "image/jpeg"
        print("JPEG", image.get("name"), view["byteLength"] // 1024, "->", len(jpeg) // 1024, "KB")
    document["buffers"][0]["byteLength"] = len(binary)
    return bytes(binary)


def compact_morphs(document, binary):
    """Store morph targets (face shapes) sparsely and drop their normals, then repack the buffer.

    Blender writes every morph target densely (every vertex, moved or not) plus a NORMAL target.
    A face shape moves a few hundred of the body's ~13k vertices, so sparse POSITION targets are a
    small fraction of the size. Returns the new binary chunk payload.
    """
    accessors, views = document["accessors"], document["bufferViews"]
    pieces, new_views = [], []

    def add_view(blob):
        offset = sum(len(piece) for piece in pieces)
        pad = -offset % 4
        if pad:
            pieces.append(b"\0" * pad)
            offset += pad
        pieces.append(blob)
        new_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob)})
        return len(new_views) - 1

    def view_bytes(index):
        view = views[index]
        start = view.get("byteOffset", 0)
        return binary[start:start + view["byteLength"]]

    # 1. Rewrite targets: keep POSITION only, made sparse.
    sparse_made = {}
    for mesh in document.get("meshes", []):
        for primitive in mesh["primitives"]:
            for target in primitive.get("targets", []):
                for attribute in [name for name in target if name != "POSITION"]:
                    del target[attribute]
                index = target.get("POSITION")
                if index is None or index in sparse_made or "bufferView" not in accessors[index]:
                    continue
                accessor = accessors[index]
                assert accessor["componentType"] == 5126 and accessor["type"] == "VEC3"
                view = views[accessor["bufferView"]]
                assert view.get("byteStride", 12) == 12
                raw = view_bytes(accessor["bufferView"])[accessor.get("byteOffset", 0):]
                count = accessor["count"]
                values = struct.unpack_from(f"<{count * 3}f", raw)
                moved = [i for i in range(count) if max(abs(values[3 * i]), abs(values[3 * i + 1]), abs(values[3 * i + 2])) > 1e-6]
                if not moved:
                    moved = [0]  # glTF needs at least one sparse entry
                wide = count > 65535
                indices = struct.pack(f"<{len(moved)}{'I' if wide else 'H'}", *moved)
                moved_values = [component for i in moved for component in values[3 * i:3 * i + 3]]
                packed = struct.pack(f"<{len(moved_values)}f", *moved_values)
                zeros = [0.0] if len(moved) < count else []  # unlisted vertices are 0 in a sparse accessor
                mins = [min(*zeros, *moved_values[axis::3]) for axis in range(3)]
                maxs = [max(*zeros, *moved_values[axis::3]) for axis in range(3)]
                accessor.pop("bufferView", None)
                accessor.pop("byteOffset", None)
                accessor["min"], accessor["max"] = mins, maxs
                accessor["sparse"] = {
                    "count": len(moved),
                    "indices": {"bufferView": ("new", indices), "componentType": 5125 if wide else 5123},
                    "values": {"bufferView": ("new", packed)},
                }
                sparse_made[index] = len(moved)

    # 2. Drop accessors nothing uses any more, remapping every reference.
    used = set()
    for mesh in document.get("meshes", []):
        for primitive in mesh["primitives"]:
            used.update(primitive["attributes"].values())
            if "indices" in primitive:
                used.add(primitive["indices"])
            for target in primitive.get("targets", []):
                used.update(target.values())
    for skin in document.get("skins", []):
        if "inverseBindMatrices" in skin:
            used.add(skin["inverseBindMatrices"])
    for animation in document.get("animations", []):
        for sampler in animation["samplers"]:
            used.update((sampler["input"], sampler["output"]))
    remap = {old: new for new, old in enumerate(sorted(used))}
    document["accessors"] = [accessors[old] for old in sorted(used)]
    for mesh in document.get("meshes", []):
        for primitive in mesh["primitives"]:
            primitive["attributes"] = {k: remap[v] for k, v in primitive["attributes"].items()}
            if "indices" in primitive:
                primitive["indices"] = remap[primitive["indices"]]
            if primitive.get("targets"):
                primitive["targets"] = [{k: remap[v] for k, v in t.items()} for t in primitive["targets"]]
            else:
                primitive.pop("targets", None)  # glTF forbids an empty list
    for skin in document.get("skins", []):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = remap[skin["inverseBindMatrices"]]
    for animation in document.get("animations", []):
        for sampler in animation["samplers"]:
            sampler["input"], sampler["output"] = remap[sampler["input"]], remap[sampler["output"]]

    # 3. Repack: copy only buffer views still referenced, in a fresh buffer.
    view_remap = {}

    def keep(old_index):
        if old_index not in view_remap:
            old = views[old_index]
            view_remap[old_index] = add_view(view_bytes(old_index))
            for key in ("byteStride", "target", "name"):
                if key in old:
                    new_views[view_remap[old_index]][key] = old[key]
        return view_remap[old_index]

    for accessor in document["accessors"]:
        if "bufferView" in accessor:
            accessor["bufferView"] = keep(accessor["bufferView"])
        if "sparse" in accessor:
            for part in ("indices", "values"):
                ref = accessor["sparse"][part]["bufferView"]
                accessor["sparse"][part]["bufferView"] = add_view(ref[1]) if isinstance(ref, tuple) else keep(ref)
    for image in document.get("images", []):
        if "bufferView" in image:
            image["bufferView"] = keep(image["bufferView"])
    document["bufferViews"] = new_views
    payload = b"".join(pieces)
    payload += b"\0" * (-len(payload) % 4)
    document["buffers"] = [{"byteLength": len(payload)}]
    print("MORPHS", len(sparse_made), "made sparse;", sum(sparse_made.values()), "moved vertices in total")
    return payload


def fix(data, mesh_types=None, recipe=None, encode_jpeg=None):
    mesh_types = mesh_types or {}
    magic, version, _length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67 and version == 2, "not a GLB v2 file"
    json_length, json_type = struct.unpack_from("<II", data, 12)
    assert json_type == 0x4E4F534A
    document = json.loads(data[20:20 + json_length])
    bin_length, bin_type = struct.unpack_from("<II", data, 20 + json_length)
    assert bin_type == 0x004E4942
    binary = data[28 + json_length:28 + json_length + bin_length]

    for material in document.get("materials", []):
        what = kind(material.get("name", ""), mesh_types)
        material.pop("alphaCutoff", None)
        if what == "cutout":
            material["alphaMode"] = "MASK"
            material["alphaCutoff"] = 0.5
            material["doubleSided"] = True
        elif what == "body":
            material["alphaMode"] = "OPAQUE"
            material["doubleSided"] = False
        else:
            material["alphaMode"] = "OPAQUE"
            material["doubleSided"] = True
        print("MATERIAL", material.get("name"), material["alphaMode"], "double" if material["doubleSided"] else "single")

    if encode_jpeg is not None:
        binary = jpeg_opaque_images(document, binary, encode_jpeg)

    if any(primitive.get("targets") for mesh in document.get("meshes", []) for primitive in mesh["primitives"]):
        binary = compact_morphs(document, binary)

    if recipe is not None:
        # The recipe travels inside the file so the editor can reopen and change the avatar.
        document.setdefault("asset", {}).setdefault("extras", {})["avatarEditorRecipe"] = recipe

    encoded = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)  # JSON chunk is padded with spaces to 4 bytes
    total = 12 + 8 + len(encoded) + 8 + len(binary)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


if __name__ == "__main__":
    source = sys.argv[1]
    target = sys.argv[2] if len(sys.argv) > 2 else source
    with open(source, "rb") as handle:
        fixed = fix(handle.read())
    with open(target, "wb") as handle:
        handle.write(fixed)
