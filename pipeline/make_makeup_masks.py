"""Make the makeup masks (eye shadow, lips, nails) for the browser editor.

All MakeHuman skins share one UV layout, so one set of grayscale masks works for every skin. The
editor tints the skin texture through them (lip color, eye shadow, nail color). The masks are our
own, made from the base mesh and CC0 skins:
  - eyeshadow: a soft weight on upper-eyelid vertices, measured in 3D from each eye's center
  - lips:      the pinker lip pixels around the mouth, averaged over several CC0 skins
  - nails:     a nail shape on the back of each last finger segment (*_03 bones), evaluated per pixel
               from interpolated 3D position and normal, so its edges stay crisp
  - beard:     a short full beard (cheeks, jaw, chin, upper lip, under the jaw), per pixel from 3D
               position, with fine downward hair streaks and a ragged edge; minus the lips. The editor
               paints it in the hair color (full beard, or lighter as stubble)
Eye shadow is painted per vertex into UV space with barycentric interpolation.

Run headless (uses Blender's numpy and image I/O):
  Blender -b --python pipeline/make_makeup_masks.py -- [out_dir] [--preview]
Writes <out_dir>/mask_eyeshadow.png, mask_lips.png, mask_nails.png, mask_beard.png (default web/assets/masks).
"""

import json
import os
import sys

import bpy
import numpy as np

HOME = os.path.expanduser("~")
SYSTEM = os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/blender_org/mpfb/data")
USER = os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/.user/blender_org/mpfb/data")
REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SIZE = 2048  # the skin textures are 2048; nails are only ~20 px wide here
LIP_SKINS = ["young_caucasian_female", "young_caucasian_male", "young_african_female", "young_asian_female",
             "middleage_caucasian_female", "young_african_male"]

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
preview = "--preview" in argv
argv = [a for a in argv if a != "--preview"]
out_dir = argv[0] if argv else os.path.join(REPO, "web", "assets", "masks")
os.makedirs(out_dir, exist_ok=True)


# ---- Base mesh -------------------------------------------------------------------------------
def read_base():
    pos, uvs, faces, group = [], [], [], None
    with open(os.path.join(SYSTEM, "3dobjs/base.obj"), errors="replace") as handle:
        for line in handle:
            parts = line.split()
            if not parts:
                continue
            if parts[0] == "v":
                pos.append([float(x) for x in parts[1:4]])
            elif parts[0] == "vt":
                uvs.append([float(parts[1]), float(parts[2])])
            elif parts[0] == "g":
                group = parts[1] if len(parts) > 1 else None
            elif parts[0] == "f" and group == "body":
                corners = [(int(c.split("/")[0]) - 1, int(c.split("/")[1]) - 1) for c in parts[1:]]
                for i in range(1, len(corners) - 1):
                    faces.append((corners[0], corners[i], corners[i + 1]))
    return np.array(pos), np.array(uvs), faces


P, UV, FACES = read_base()
N = len(P)
groups = json.load(open(os.path.join(SYSTEM, "mesh_metadata/basemesh_vertex_groups.json")))
members = lambda name: [i for a, b in groups[name] for i in range(a, b + 1)]
body = sorted({v for face in FACES for v, _ in face})

normals = np.zeros_like(P)
for (a, _), (b, _), (c, _) in FACES:
    n = np.cross(P[b] - P[a], P[c] - P[a])
    normals[[a, b, c]] += n
normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-9)


def paint(weights):
    """Rasterize per-vertex weights into a SIZE x SIZE image (row 0 = v 0, Blender's order)."""
    image = np.zeros((SIZE, SIZE), dtype=np.float32)
    for face in FACES:
        w = np.array([weights[v] for v, _ in face])
        if w.max() <= 0.001:
            continue
        t = np.array([UV[uv] for _, uv in face]) * SIZE
        x0, y0 = np.floor(t.min(axis=0)).astype(int)
        x1, y1 = np.ceil(t.max(axis=0)).astype(int)
        xs, ys = np.meshgrid(np.arange(max(x0, 0), min(x1 + 1, SIZE)), np.arange(max(y0, 0), min(y1 + 1, SIZE)))
        px, py = xs + 0.5, ys + 0.5
        (ax, ay), (bx, by), (cx, cy) = t
        det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(det) < 1e-12:
            continue
        l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det
        l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det
        l3 = 1 - l1 - l2
        inside = (l1 >= -0.02) & (l2 >= -0.02) & (l3 >= -0.02)
        value = l1 * w[0] + l2 * w[1] + l3 * w[2]
        image[ys[inside], xs[inside]] = np.maximum(image[ys[inside], xs[inside]], value[inside])
    return image


def paint_field(faces, fn):
    """Per-pixel evaluation: fn(positions (k,3), normals (k,3)) -> values (k), for pixels inside the given
    faces, with 3D position and normal interpolated across each triangle. Crisp edges where per-vertex
    painting would blur (fingertips have few vertices)."""
    image = np.zeros((SIZE, SIZE), dtype=np.float32)
    for face in faces:
        t = np.array([UV[uv] for _, uv in face]) * SIZE
        x0, y0 = np.floor(t.min(axis=0)).astype(int)
        x1, y1 = np.ceil(t.max(axis=0)).astype(int)
        xs, ys = np.meshgrid(np.arange(max(x0, 0), min(x1 + 1, SIZE)), np.arange(max(y0, 0), min(y1 + 1, SIZE)))
        px, py = xs.ravel() + 0.5, ys.ravel() + 0.5
        (ax, ay), (bx, by), (cx, cy) = t
        det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(det) < 1e-12:
            continue
        l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det
        l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det
        l3 = 1 - l1 - l2
        inside = (l1 >= -0.05) & (l2 >= -0.05) & (l3 >= -0.05)
        if not inside.any():
            continue
        lam = np.stack([l1, l2, l3], axis=1)[inside]
        verts = [v for v, _ in face]
        pos = lam @ P[verts]
        nrm = lam @ normals[verts]
        nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
        yy, xx = ys.ravel()[inside], xs.ravel()[inside]
        image[yy, xx] = np.maximum(image[yy, xx], fn(pos, nrm))
    return image


def blur(image, radius):
    """Separable box blur, run twice (close to a Gaussian)."""
    for _ in range(2):
        for axis in (0, 1):
            padded = np.pad(image, [(radius, radius) if a == axis else (0, 0) for a in (0, 1)], mode="edge")
            c = np.cumsum(padded, axis=axis, dtype=np.float64)
            c = np.insert(c, 0, 0, axis=axis)
            hi = np.take(c, np.arange(2 * radius + 1, c.shape[axis]), axis=axis)
            lo = np.take(c, np.arange(0, c.shape[axis] - 2 * radius - 1), axis=axis)
            image = ((hi - lo) / (2 * radius + 1)).astype(np.float32)
    return image


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def save(name, image):
    img = bpy.data.images.new(name, SIZE, SIZE, alpha=False, float_buffer=False)
    rgba = np.repeat(np.clip(image, 0, 1)[:, :, None], 4, axis=2)
    rgba[:, :, 3] = 1
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = os.path.join(out_dir, name + ".png")
    img.file_format = "PNG"
    img.save()
    print("wrote", img.filepath_raw, "coverage", round(float((image > 0.05).mean()) * 100, 2), "%")


def load_texture(path):
    img = bpy.data.images.load(path)
    img.scale(SIZE, SIZE)
    return np.array(img.pixels[:], dtype=np.float32).reshape(SIZE, SIZE, 4)[:, :, :3]


# ---- Eye shadow ------------------------------------------------------------------------------
# Local frame per eye: x across the face, y up, z forward (MakeHuman: y up, +z forward).
eyeshadow = np.zeros(N)
for side in ("l", "r"):
    eye = P[members(f"helper-{side}-eye")]
    center = eye.mean(axis=0)
    radius = np.linalg.norm(eye - center, axis=1).max()
    d = P - center
    outward = np.sign(center[0])  # outer corner direction
    lateral = d[:, 0] * outward / radius          # + toward the temple
    up = d[:, 1] / radius
    front = d[:, 2] / radius
    # An ellipse over the upper lid, wider toward the outer corner, fading toward the brow.
    # Mostly on the lid: stops well below the brow (first version reached into the eyebrows).
    ex = np.where(lateral > 0, lateral / 1.7, lateral / 1.2)
    ey = (up - 0.1) / 0.85
    dist = np.sqrt(ex ** 2 + ey ** 2)
    w = (1 - smoothstep(0.45, 1.0, dist)) * smoothstep(-0.25, 0.2, up) * smoothstep(-0.4, 0.3, front)
    eyeshadow = np.maximum(eyeshadow, w)
eyeshadow_img = blur(paint(eyeshadow), 2)

# ---- Nails -----------------------------------------------------------------------------------
rig = json.load(open(os.path.join(SYSTEM, "rigs/standard/rig.game_engine.json")))
bone_weights = json.load(open(os.path.join(SYSTEM, "rigs/standard/weights.game_engine.json")))["weights"]
cube = lambda name: P[members(name)].mean(axis=0)
end = lambda info: cube(info["cube_name"]) if info["strategy"] == "CUBE" else P[info["vertex_indices"]].mean(axis=0)
nails_img = np.zeros((SIZE, SIZE), dtype=np.float32)
for side in ("l", "r"):
    hand = end(rig[f"hand_{side}"]["head"])
    along = end(rig[f"middle_01_{side}"]["head"]) - hand
    across = end(rig[f"index_01_{side}"]["head"]) - end(rig[f"pinky_01_{side}"]["head"])
    back = np.cross(along, across) * (-1 if side == "l" else 1)  # checked in 3D: the other sign tints the finger pads
    back /= np.linalg.norm(back)
    for finger in ("thumb", "index", "middle", "ring", "pinky"):
        bone = f"{finger}_03_{side}"
        head, tail = end(rig[bone]["head"]), end(rig[bone]["tail"])
        axis = tail - head
        length = np.linalg.norm(axis)
        axis /= length
        b = back
        if finger == "thumb":  # the thumb's nail faces sideways relative to the hand
            b = np.cross(axis, np.cross(back, axis))
        b = b - axis * (b @ axis)
        b /= np.linalg.norm(b)
        side_axis = np.cross(axis, b)
        weight = np.zeros(N)
        for index, value in bone_weights[bone]:
            weight[index] = value
        segment = [v for v in range(N) if weight[v] > 0.5]
        rel = P[segment] - head
        radius = np.median(np.linalg.norm(rel - np.outer(rel @ axis, axis), axis=1))
        faces = [f for f in FACES if sum(weight[v] > 0.3 for v, _ in f) >= 2]

        def nail(pos, nrm, head=head, axis=axis, length=length, b=b, side_axis=side_axis, radius=radius):
            rel = pos - head
            t = rel @ axis / length                  # 0 at the last knuckle, 1 at the bone's tip marker
            lat = (rel @ side_axis) / (0.62 * radius)  # across the nail
            up = rel @ b / radius                    # height on the back of the finger
            base = 0.5                               # nail starts halfway along the segment, rounded
            shape = lat ** 2 + np.where(t < base + 0.18, ((base + 0.18 - t) / 0.18) ** 2, 0)
            return ((1 - smoothstep(0.75, 1.0, shape)) * smoothstep(0.15, 0.35, nrm @ b)
                    * smoothstep(0.1, 0.3, up) * (1 - smoothstep(1.25, 1.4, t)))
        nails_img = np.maximum(nails_img, paint_field(faces, nail))
nails_img = blur(nails_img, 1)

# ---- Lips ------------------------------------------------------------------------------------
# Mouth region: skin vertices near the front of the teeth; its UV box bounds the pixel search.
teeth = P[members("helper-upper-teeth") + members("helper-lower-teeth")]
mouth = teeth.mean(axis=0) + np.array([0, 0, (teeth[:, 2].max() - teeth.mean(axis=0)[2])])
# Wide enough that most of it is plain skin; only outward skin in front of the teeth (the mouth's
# inside is part of the body mesh too, and much redder than the lips).
near = [v for v in body if np.linalg.norm(P[v] - mouth) < 1.0 and P[v][2] > mouth[2] - 0.05 and normals[v][2] > 0.2]
region = paint(np.isin(np.arange(N), near).astype(float)) > 0.5   # skin baseline
rows, cols = np.nonzero(region)
box = np.zeros_like(region)                                          # where the mask may go: the
box[rows.min():rows.max() + 1, cols.min():cols.max() + 1] = True     # face area around the mouth
redness = np.zeros((SIZE, SIZE), dtype=np.float32)
for skin in LIP_SKINS:
    folder = os.path.join(USER, "skins", skin)
    texture = next(l.split()[1] for l in open(os.path.join(folder, skin + ".mhmat")) if l.startswith("diffuseTexture"))
    rgb = load_texture(os.path.join(folder, texture))
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    red = (r - g) / np.maximum(r + g + b, 1e-3)
    base = np.median(red[region])
    spread = np.percentile(red[box], 99.5) - base
    redness += np.clip((red - base) / max(spread, 1e-3), 0, 1) * box
redness /= len(LIP_SKINS)
lips_img = blur(smoothstep(0.2, 0.5, blur(redness, 2)), 1) * box
# Keep only the connected patch around the strongest pixel: nostrils and the inner eye corners are
# reddish too.
seed = np.unravel_index(np.argmax(lips_img), lips_img.shape)
keep = np.zeros_like(region)
stack = [seed]
while stack:
    y, x = stack.pop()
    if 0 <= y < SIZE and 0 <= x < SIZE and not keep[y, x] and lips_img[y, x] > 0.02:
        keep[y, x] = True
        stack += [(y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)]
lips_img = lips_img * keep

# ---- Beard -----------------------------------------------------------------------------------
# MakeHuman units (dm), y up, +z forward. Landmarks on the base mesh: chin tip about y 6.3, mouth
# 6.65-6.75, nose base 6.88, eyes 7.28; the ears sit around z 0.
def hash3(cells):
    """Pseudo-random 0..1 per integer lattice point (k,3)."""
    h = (cells[:, 0] * 73856093) ^ (cells[:, 1] * 19349663) ^ (cells[:, 2] * 83492791)
    h = (h ^ (h >> 13)) * 1274126177
    return ((h ^ (h >> 16)) & 0xFFFF).astype(np.float32) / 0xFFFF


def value_noise(pos, scale):
    """Smooth 3D value noise; `scale` (3,) is cells per dm on each axis (stretch for streaks)."""
    q = pos * scale
    base = np.floor(q).astype(np.int64)
    f = q - base
    f = f * f * (3 - 2 * f)
    out = np.zeros(len(pos), dtype=np.float32)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out += w * hash3(base + np.array([dx, dy, dz]))
    return out


def beard(pos, nrm):
    x, y, z = pos[:, 0], pos[:, 1], pos[:, 2]
    ragged = (value_noise(pos, np.array([9.0, 9.0, 9.0])) - 0.5) * 0.08      # wobbly edges, about 4 mm
    # Upper edge: the cheek line slopes from the sideburns in front of the ear down to just above the
    # mouth corners; across the front it follows the moustache line under the nose.
    side = np.interp(z, [0.15, 0.5, 0.95], [7.25, 7.08, 6.92])
    front = np.interp(np.abs(x), [0.0, 0.2, 0.3, 0.42, 0.6], [6.87, 6.86, 6.76, 6.8, 6.92])
    top = side + (front - side) * smoothstep(0.85, 1.1, z) + ragged
    # Lower edge: just under the jawline (from the jaw angle below the ear to under the chin); the
    # neck itself stays bare.
    low = np.interp(z, [0.15, 0.6, 1.0, 1.3], [6.62, 6.38, 6.14, 6.1]) + ragged
    w = (1 - smoothstep(top - 0.1, top + 0.02, y)) * smoothstep(low - 0.02, low + 0.1, y)
    w *= smoothstep(0.08, 0.3, z)                                               # not behind the ear
    # Hair: dense fine streaks running down the face, plus some patchiness. Toward the edges the
    # hair thins out rather than fading as a flat tone.
    streaks = value_noise(pos, np.array([260.0, 40.0, 260.0]))
    patches = value_noise(pos, np.array([14.0, 14.0, 14.0]))
    density = np.clip(streaks * 0.75 + patches * 0.35, 0, 1)
    edge = smoothstep(0.0, 0.45, w - (1 - density) * 0.55)
    return edge * (0.2 + 0.8 * streaks ** 1.5)                                 # strands and skin between them


head_faces = [f for f in FACES if all(P[v][1] > 5.7 and P[v][2] > -0.3 for v, _ in f)]
beard_img = paint_field(head_faces, beard) * (1 - smoothstep(0.05, 0.35, blur(lips_img, 3)))

save("mask_eyeshadow", eyeshadow_img)
save("mask_lips", lips_img)
save("mask_nails", nails_img)
save("mask_beard", beard_img)

if preview:  # tint a CC0 skin through the masks, to check placement
    folder = os.path.join(USER, "skins", "young_caucasian_female")
    rgb = load_texture(os.path.join(folder, "young_lightskinned_female_diffuse.png"))
    for mask, color in ((beard_img, (0.12, 0.08, 0.05)), (eyeshadow_img, (0.45, 0.25, 0.55)), (lips_img, (0.75, 0.1, 0.2)), (nails_img, (0.85, 0.05, 0.15))):
        a = np.clip(mask, 0, 1)[:, :, None] * 0.8
        rgb = rgb * (1 - a) + np.array(color) * rgb.mean(axis=2, keepdims=True) * 1.6 * a
    img = bpy.data.images.new("preview", SIZE, SIZE)
    rgba = np.concatenate([np.clip(rgb, 0, 1), np.ones((SIZE, SIZE, 1))], axis=2)
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.filepath_raw = os.path.join(out_dir, "preview.png")
    img.file_format = "PNG"
    img.save()
    print("wrote", img.filepath_raw)
