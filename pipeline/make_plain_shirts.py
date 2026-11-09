"""Plain shirts: MakeHuman's T-shirts without MakeHuman's logo.

For each texture, every logo is covered with plain fabric copied from elsewhere on the same shirt
(soft elliptical edge). Writes assets/plain/<item id>.png (committed); export_web_assets.py uses it
instead of the item's own texture. Needs ImageMagick. Usage: python3 pipeline/make_plain_shirts.py
"""
import os
import subprocess
import tempfile

HOME = os.path.expanduser("~")
USER = os.path.join(HOME, "Library/Application Support/Blender/5.2/extensions/.user/blender_org/mpfb/data")
REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# Per texture (2048 px): (centre x, y, radius x, y, fabric offset dx, dy) per logo. The two women's
# textures are laid out sideways (the top of the shirt points right).
SHIRTS = {
    "male_casualsuit04": [(1143, 342, 128, 128, -787, 0)],
    "male_casualsuit02": [(1145, 346, 128, 128, -800, 0)],
    "female_casualsuit01": [(1615, 472, 190, 165, -1000, 0)],
    "female_casualsuit02": [(1615, 472, 190, 165, -1000, 0)],
    "male_casualsuit06": [(1092, 335, 185, 85, 0, 230), (500, 285, 100, 48, 0, 150)],
}


def run(*args):
    subprocess.run(["magick", *map(str, args)], check=True)


def plain(item, covers, tmp):
    source = os.path.join(USER, "clothes", item, item + "_diffuse.png")
    out = os.path.join(REPO, "assets", "plain", item + ".png")
    work = os.path.join(tmp, "work.png")
    run(source, "-alpha", "off", work)
    for cx, cy, rx, ry, dx, dy in covers:
        w, h = 2 * rx + 40, 2 * ry + 40
        x0, y0 = cx - w // 2, cy - h // 2
        patch, mask = os.path.join(tmp, "patch.png"), os.path.join(tmp, "mask.png")
        run(source, "-crop", f"{w}x{h}+{x0 + dx}+{y0 + dy}", "+repage", patch)
        run("-size", f"{w}x{h}", "xc:black", "-fill", "white", "-draw", f"ellipse {w // 2},{h // 2} {rx},{ry} 0,360", "-blur", "0x8", mask)
        run(work, "(", patch, mask, "-alpha", "off", "-compose", "CopyOpacity", "-composite", ")",
            "-geometry", f"+{x0}+{y0}", "-compose", "Over", "-composite", work)
    run(work, "-define", "png:exclude-chunks=date,time,tIME", out)  # no timestamps: same pixels, same bytes
    print("wrote", os.path.relpath(out, REPO))


if __name__ == "__main__":
    os.makedirs(os.path.join(REPO, "assets", "plain"), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for item, covers in SHIRTS.items():
            plain(item, covers, tmp)
