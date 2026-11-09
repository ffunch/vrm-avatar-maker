"""Our own garments: new designs painted onto the textures of existing CC0 garments.

The mesh stays the original's (so fit, coverage and seated behaviour are the same); only the texture
is new. Painting is by place on the body, not by place on the texture: for every texel we know the
point of the garment it lands on (fitted to the base mesh at rest, MakeHuman decimeters, y up, +z the
front, +x the avatar's left). A design is a function of that point, and the original texture's
light and shade (folds, seams, weave) is multiplied in so the result reads as cloth.

Each design writes assets/painted/<id>.png (committed); export_web_assets.py uses it for catalog items
that name a "base" item (same mesh, this texture).

Run headless (Blender's numpy):
  Blender -b --python pipeline/paint_garments.py [-- id ...]
"""

import json
import os
import sys

import numpy as np
import bpy  # noqa: F401  (run inside Blender: numpy, and images via bpy)

HOME = os.path.expanduser("~")
SYSTEM = os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/blender_org/mpfb/data")
USER = os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/.user/blender_org/mpfb/data")
REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SIZE = 2048  # px: the texture size the editor and the VRM use
CACHE = os.path.join(REPO, "out", "paint-cache")


# --- reading -----------------------------------------------------------------------------------

def read_obj(path):
    verts, uvs, faces = [], [], []
    for line in open(path, errors="replace"):
        p = line.split()
        if not p:
            continue
        if p[0] == "v":
            verts.append([float(x) for x in p[1:4]])
        elif p[0] == "vt":
            uvs.append([float(x) for x in p[1:3]])
        elif p[0] == "f":
            c = [x.split("/") for x in p[1:]]
            vi = [int(x[0]) - 1 for x in c]
            ti = [int(x[1]) - 1 if len(x) > 1 and x[1] else -1 for x in c]
            for k in range(1, len(c) - 1):  # fan into triangles
                faces.append((vi[0], vi[k], vi[k + 1], ti[0], ti[k], ti[k + 1]))
    return np.array(verts), np.array(uvs), np.array(faces)


def read_mhclo(path):
    fit, scale, obj, material, section = [], {}, None, None, None
    for line in open(path, errors="replace"):
        p = line.split()
        if not p or p[0].startswith("#"):
            continue
        if p[0] in ("x_scale", "y_scale", "z_scale"):
            scale[p[0][0]] = (int(p[1]), int(p[2]), float(p[3]))
        elif p[0] == "obj_file":
            obj = p[1]
        elif p[0] == "material":
            material = p[1]
        elif p[0] in ("verts", "delete_verts"):
            section = p[0]
        elif section == "verts" and len(p) == 9:
            fit.append(([int(x) for x in p[:3]], [float(x) for x in p[3:6]], [float(x) for x in p[6:9]]))
        elif section == "verts" and len(p) == 1 and p[0].isdigit():
            fit.append(([int(p[0])] * 3, [1.0, 0.0, 0.0], [0.0, 0.0, 0.0]))
    return fit, scale, obj, material


def read_texture_name(mhmat):
    for line in open(mhmat, errors="replace"):
        p = line.split()
        if len(p) > 1 and p[0] == "diffuseTexture":
            return p[1]


def load_image(path, size=SIZE):
    """RGB float array (rows top to bottom), resized to size x size."""
    img = bpy.data.images.load(path)
    if img.size[0] != size:
        img.scale(size, size)
    a = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, img.channels)[::-1, :, :3]
    bpy.data.images.remove(img)
    return a


def save_image(path, rgb):
    h, w, _ = rgb.shape
    img = bpy.data.images.new("out", w, h)
    a = np.concatenate([np.clip(rgb, 0, 1), np.ones((h, w, 1), np.float32)], axis=2)[::-1]
    img.pixels[:] = a.ravel()
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


# --- where each texel is on the body -----------------------------------------------------------

BASE = None


def base_mesh():
    global BASE
    if BASE is None:
        BASE, _, _ = read_obj(os.path.join(SYSTEM, "3dobjs/base.obj"))
    return BASE


def surface_maps(garment):
    """Per texel: position (xyz), normal, and coverage (1 on the garment), as SIZE x SIZE arrays.
    Texels just off the UV islands get their nearest neighbour's values (so filtering doesn't
    bleed the background in)."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, garment + ".npz")
    if os.path.exists(cache):
        d = np.load(cache)
        return d["P"], d["N"], d["M"]
    folder = os.path.join(USER, "clothes", garment)
    fit, scale, obj, _ = read_mhclo(os.path.join(folder, garment + ".mhclo"))
    base = base_mesh()
    s = [abs(base[scale[a][0]]["xyz".index(a)] - base[scale[a][1]]["xyz".index(a)]) / scale[a][2] if a in scale else 1.0
         for a in "xyz"]
    refs = np.array([f[0] for f in fit]); w = np.array([f[1] for f in fit]); o = np.array([f[2] for f in fit])
    V = (base[refs] * w[:, :, None]).sum(1) + o * np.array(s)
    _, UV, F = read_obj(os.path.join(folder, obj))
    # vertex normals
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    fn = np.cross(b - a, c - a)
    VN = np.zeros_like(V)
    for k in range(3):
        np.add.at(VN, F[:, k], fn)
    VN /= np.linalg.norm(VN, axis=1, keepdims=True) + 1e-12

    P = np.zeros((SIZE, SIZE, 3), np.float32); N = np.zeros((SIZE, SIZE, 3), np.float32)
    M = np.zeros((SIZE, SIZE), np.float32)
    T = UV[F[:, 3:6]] * SIZE  # (faces, 3, 2), v up
    T[:, :, 1] = SIZE - T[:, :, 1]
    for f in range(len(F)):
        t = T[f]
        x0, y0 = np.floor(t.min(0)).astype(int); x1, y1 = np.ceil(t.max(0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, SIZE - 1), min(y1, SIZE - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        d = (t[1, 1] - t[2, 1]) * (t[0, 0] - t[2, 0]) + (t[2, 0] - t[1, 0]) * (t[0, 1] - t[2, 1])
        if abs(d) < 1e-12:
            continue
        l0 = ((t[1, 1] - t[2, 1]) * (xs - t[2, 0]) + (t[2, 0] - t[1, 0]) * (ys - t[2, 1])) / d
        l1 = ((t[2, 1] - t[0, 1]) * (xs - t[2, 0]) + (t[0, 0] - t[2, 0]) * (ys - t[2, 1])) / d
        l2 = 1 - l0 - l1
        inside = (l0 >= -0.01) & (l1 >= -0.01) & (l2 >= -0.01)
        if not inside.any():
            continue
        iy, ix = np.nonzero(inside)
        L = np.stack([l0[inside], l1[inside], l2[inside]], 1)
        P[iy + y0, ix + x0] = L @ V[F[f, :3]]
        N[iy + y0, ix + x0] = L @ VN[F[f, :3]]
        M[iy + y0, ix + x0] = 1
    # pad the islands by 8 px
    filled = M > 0
    for _ in range(8):
        grow = np.zeros_like(filled)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            src = np.roll(np.roll(filled, dy, 0), dx, 1) & ~filled & ~grow
            P[src] = np.roll(np.roll(P, dy, 0), dx, 1)[src]
            N[src] = np.roll(np.roll(N, dy, 0), dx, 1)[src]
            grow |= src
        filled |= grow
    np.savez_compressed(cache, P=P, N=N, M=M)
    return P, N, M


# --- painting helpers --------------------------------------------------------------------------

def rgb(hex_):
    """sRGB hex to the linear floats Blender's image pixels hold."""
    c = np.array([int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def smooth(edge0, edge1, x):
    t = np.clip((x - edge0) / (edge1 - edge0), 0, 1)
    return t * t * (3 - 2 * t)


def band(x, center, half, soft=0.03):
    """1 within half of center, soft edges."""
    return 1 - smooth(half, half + soft, np.abs(x - center))


def mix(base, color, amount):
    return base * (1 - amount[..., None]) + color * amount[..., None]


def shade_of(original, low=0.55, high=1.15):
    """The original texture's light and shade, normalized around 1: folds and weave without its colour."""
    lum = original @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    m = np.median(lum[lum > 0.002]) if (lum > 0.002).any() else 1
    return np.clip(lum / max(m, 1e-4), low, high)


def hash_noise(P, scale, seed=0):
    """Cheap smooth-ish value noise in 3D (for wear and mottling)."""
    q = P * scale
    i = np.floor(q); f = q - i
    f = f * f * (3 - 2 * f)

    def h(dx, dy, dz):
        n = (i[..., 0] + dx) * 127.1 + (i[..., 1] + dy) * 311.7 + (i[..., 2] + dz) * 74.7 + seed * 19.3
        return np.modf(np.sin(n) * 43758.5453)[0] % 1.0

    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                wgt = (f[..., 0] if dx else 1 - f[..., 0]) * (f[..., 1] if dy else 1 - f[..., 1]) * (f[..., 2] if dz else 1 - f[..., 2])
                out = out + wgt * h(dx, dy, dz)
    return out


# --- the body, at rest (MakeHuman base mesh landmarks, left side; mirror for the right) ---------

SHOULDER, ELBOW, WRIST = np.array([1.75, 5.0, 0.1]), np.array([3.13, 3.49, 0.13]), np.array([4.15, 1.95, 0.25])
HIP, KNEE, ANKLE = np.array([0.95, -0.3, 0.15]), np.array([1.58, -3.69, 0.32]), np.array([2.2, -7.45, -0.01])
NECK_Y, CHEST_Y, WAIST_Y = 5.75, 3.3, 0.9


def along(P, a, b):
    """Position along the segment a->b (0..1, unclamped) and distance from it, mirrored to the left side."""
    Q = P.copy(); Q[..., 0] = np.abs(Q[..., 0])
    d = b - a
    t = ((Q - a) @ d) / (d @ d)
    near = a + np.clip(t, 0, 1)[..., None] * d
    return t, np.linalg.norm(Q - near, axis=-1)


def limbs(P):
    """Masks for arm and leg (soft), and the position along each (0 at shoulder/hip, 1 at elbow/knee, 2 at wrist/ankle)."""
    tu, du = along(P, SHOULDER, ELBOW); tl, dl = along(P, ELBOW, WRIST)
    arm_t = np.where(tu < 1, tu, 1 + tl)
    arm = (np.minimum(du, dl) < 0.9) & (arm_t > 0.08) & (np.abs(P[..., 0]) > 1.45)
    tt, dt = along(P, HIP, KNEE); ts, ds = along(P, KNEE, ANKLE)
    leg_t = np.where(tt < 1, tt, 1 + ts)
    leg = (P[..., 1] < -0.4) & (np.abs(P[..., 0]) > 0.05)
    return arm, arm_t, leg, leg_t


# --- designs -----------------------------------------------------------------------------------

def space_suit(P, N, M, shade):
    """White pressure suit: grey side panels, dark boots, gloves and pads, orange bands on the arms and chest."""
    arm, arm_t, leg, leg_t = limbs(P)
    c = np.broadcast_to(rgb("#e6e6e1"), P.shape).copy()
    outward = N[..., 0] * np.sign(P[..., 0])  # toward the avatar's own side, away from the middle
    side = smooth(0.62, 0.72, outward) * ~arm
    c = mix(c, rgb("#8d939b"), side)
    # arms: a grey stripe down the outside
    out = np.abs(N[..., 0]) * 0.7 + N[..., 1] * 0.7  # the arm's outside (arms hang out and down at rest)
    c = mix(c, rgb("#8d939b"), arm * smooth(0.8, 0.88, out))
    # orange bands: upper arms, and across the chest (front only)
    c = mix(c, rgb("#e2701f"), arm * band(arm_t, 0.55, 0.07, 0.02))
    c = mix(c, rgb("#e2701f"), ~arm * ~leg * band(P[..., 1], CHEST_Y + 1.3, 0.1, 0.02))  # above the bust, all round
    # dark: collar, belt, knee and elbow pads, gloves, boots
    dark = rgb("#3a3d42")
    c = mix(c, dark, smooth(NECK_Y - 0.35, NECK_Y - 0.25, P[..., 1]) * ~arm)
    c = mix(c, dark, ~arm * band(P[..., 1], WAIST_Y - 0.15, 0.22, 0.02))
    c = mix(c, dark, leg * band(leg_t, 1.0, 0.13, 0.03) * smooth(0.1, 0.3, N[..., 2]))
    c = mix(c, dark, arm * band(arm_t, 1.0, 0.1, 0.03) * smooth(0.1, 0.3, -N[..., 2]))
    c = mix(c, dark, arm * smooth(1.82, 1.86, arm_t))
    c = mix(c, dark, leg * smooth(1.68, 1.72, leg_t))
    return c * (shade ** 0.45)[..., None]  # light cloth: the black original's folds, softened


def neon_suit(P, N, M, shade):
    """Black bodysuit with glowing cyan lines: side seams, a chevron on the chest, rings at the wrists and ankles."""
    arm, arm_t, leg, leg_t = limbs(P)
    c = np.broadcast_to(rgb("#141519"), P.shape).copy() * (0.8 + 0.4 * shade[..., None])
    glow = rgb("#3ff0ff")

    def line(d, w):  # thin bright core, soft halo
        return np.maximum(band(d, 0, w, w * 0.6), 0.35 * band(d, 0, w * 3.5, w * 3))
    seam = line(N[..., 2], 0.045)  # where the front turns into the back
    chevron = (N[..., 2] > 0.3) * ~arm * ~leg * line(P[..., 1] - (CHEST_Y + 0.9 - 0.75 * np.abs(P[..., 0])), 0.06)
    chevron *= (np.abs(P[..., 0]) < 1.5)
    rings = arm * line(arm_t - 1.82, 0.02) + leg * line(leg_t - 1.62, 0.02) + ~arm * line(P[..., 1] - (NECK_Y - 0.3), 0.06)
    belt = ~arm * line(P[..., 1] - WAIST_Y, 0.05)
    amount = np.clip(seam + chevron + rings + belt, 0, 1)
    return mix(c, glow, amount)


def stars(M, count, radius, seed, spacing=3.0):
    """Five-pointed stars stamped in texture space (they sit flat on the cloth), at random places on
    the garment, at least spacing radii apart. Returns their coverage, soft edged."""
    rng = np.random.default_rng(seed)
    out = np.zeros(M.shape, np.float32)
    ys, xs = np.nonzero(M[radius:-radius, radius:-radius] > 0)
    placed = []
    for k in rng.permutation(len(ys)):
        if len(placed) >= count:
            break
        cy, cx = ys[k] + radius, xs[k] + radius
        r = radius * rng.uniform(0.6, 1.2)
        if any((cy - y) ** 2 + (cx - x) ** 2 < (spacing * radius) ** 2 for y, x in placed):
            continue
        if M[cy - radius:cy + radius, cx - radius:cx + radius].min() == 0:
            continue  # whole star on the cloth
        placed.append((cy, cx))
        R = int(r) + 2
        yy, xx = np.mgrid[-R:R + 1, -R:R + 1].astype(np.float32)
        a = np.arctan2(xx, -yy) + rng.uniform(-0.3, 0.3)
        d = np.hypot(xx, yy)
        # star outline radius at angle a: between the points (0.42 r) and the tips (r)
        sector = (a % (2 * np.pi / 5)) / (2 * np.pi / 5)
        edge = r * (0.42 + 0.58 * np.abs(1 - 2 * sector) ** 1.6)
        star = np.clip(edge - d + 0.5, 0, 1)
        win = out[cy - R:cy + R + 1, cx - R:cx + R + 1]
        np.maximum(win, star[:win.shape[0], :win.shape[1]], out=win)
    return out


def robe(cloth, trim, star_color, seed, cord="#c99a3a"):
    def design(P, N, M, shade, original):
        c = np.broadcast_to(rgb(cloth), P.shape).copy()
        y = P[..., 1]
        hem = (1 - smooth(-7.12, -7.08, y)) + band(y, -6.9, 0.05, 0.02)  # a broad hem (the robe ends about -7.6) and a line above it
        tu, _ = along(P, ELBOW, WRIST)
        cuff = (smooth(0.78, 0.82, tu) + band(tu, 0.7, 0.025, 0.015)) * (np.abs(P[..., 0]) > 2.6) * (y > 0.5)
        trims = np.clip(hem + cuff, 0, 1)
        c = mix(c, rgb(trim), trims)
        c = mix(c, rgb(star_color), stars(M * (trims < 0.01), 260, 14, seed))
        # the rope belt (beige in the original): gold cord
        lum = original @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        rope = (original[..., 0] > 0.12) & (original[..., 0] > original[..., 2] * 1.6) & (lum > 0.12)
        c = mix(c, rgb(cord), rope.astype(np.float32))
        return c * shade[..., None]
    return design


# --- the catalog of painted garments -----------------------------------------------------------

# id: (garments whose islands share the texture, design). The first garment's texture is repainted.
DESIGNS = {
    "ours_space_suit": (["matcreator_mc-skinsuit_2022"], lambda P, N, M, s, o: space_suit(P, N, M, s)),
    "ours_neon_suit": (["matcreator_mc-skinsuit_2022"], lambda P, N, M, s, o: neon_suit(P, N, M, s)),
    "ours_wizard_robe": (["donitz_monk_robe", "donitz_monk_robe_hood"], robe("#2b3478", "#c99a3a", "#e6c46a", 7)),
    "ours_sorcerer_robe": (["donitz_monk_robe", "donitz_monk_robe_hood"], robe("#4e2675", "#b9bcc6", "#eceef4", 11, cord="#b9bcc6")),
}
DESIGNS["ours_wizard_hood"] = DESIGNS["ours_wizard_robe"]  # robe and hood share one texture
DESIGNS["ours_sorcerer_hood"] = DESIGNS["ours_sorcerer_robe"]


def paint(id_):
    garments, design = DESIGNS[id_]
    folder = os.path.join(USER, "clothes", garments[0])
    _, _, _, material = read_mhclo(os.path.join(folder, garments[0] + ".mhclo"))
    original = load_image(os.path.join(folder, read_texture_name(os.path.join(folder, material))))
    P = np.zeros((SIZE, SIZE, 3), np.float32); N = np.zeros_like(P); M = np.zeros((SIZE, SIZE), np.float32)
    for g in garments:  # each garment fills its own islands
        p, n, m = surface_maps(g)
        take = (m > 0) | ((M == 0) & (np.abs(p).sum(-1) > 0))
        P[take], N[take] = p[take], n[take]
        M = np.maximum(M, m)
    N /= np.linalg.norm(N, axis=-1, keepdims=True) + 1e-6
    out = design(P, N, M, shade_of(original), original)
    used = (np.abs(P).sum(-1) > 0)  # off the islands: the original (nothing samples it)
    out = np.where(used[..., None], out, original)
    os.makedirs(os.path.join(REPO, "assets", "painted"), exist_ok=True)
    save_image(os.path.join(REPO, "assets", "painted", id_ + ".png"), out)
    print("painted", id_)


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    for id_ in args or DESIGNS:
        paint(id_)
