# Renders the launcher's icon images from brand/mark.svg:
#   tools/launcher/brand/app-<n>.png   the exe / taskbar / desktop icon: the Clear mark on the graphite tile
#   tools/launcher/brand/tray-<state>.png  the tray lamp, mark only, one per state
# tools/make-icon.mjs packs app-*.png into icon.ico; build.cmd embeds tray-*.png in the exe.
# usage: python tools/brand/icons.py      (needs: pip install cairosvg pillow)
import io, pathlib
import cairosvg
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[2]
MARK = (ROOT / "brand" / "mark.svg").read_text(encoding="utf-8")
OUT = ROOT / "tools" / "launcher" / "brand"
OUT.mkdir(parents=True, exist_ok=True)

# Tray: Windows draws these on the taskbar, light or dark. Idle is a mid grey so it
# reads on both (the designers' idle slate vanishes on a dark taskbar).
TRAY = {"ok": "#3DDC84", "warn": "#FFB020", "fail": "#FF5A5A", "idle": "#8792A2"}

def mark_png(colour, px):
    svg = MARK.replace('fill="currentColor"', f'fill="{colour}"')
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=px, output_height=px))).convert("RGBA")

for state, colour in TRAY.items():
    for px in (16, 20, 24, 32, 48):
        # The mark's own padding is generous; fill the tray square a little more at small sizes.
        big = mark_png(colour, px * 4)
        bb = big.getbbox()
        side = max(bb[2] - bb[0], bb[3] - bb[1])
        pad = int(side * 0.04)
        cx, cy = (bb[0] + bb[2]) // 2, (bb[1] + bb[3]) // 2
        crop = big.crop((cx - side // 2 - pad, cy - side // 2 - pad, cx + side // 2 + pad, cy + side // 2 + pad))
        crop.resize((px, px), Image.LANCZOS).save(OUT / f"tray-{state}-{px}.png")

# App icon: graphite rounded tile (the control room's --bg-1) with the Clear mark.
for px in (16, 24, 32, 48, 64, 128, 256):
    s = 4  # supersample
    W = px * s
    tile = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    inset = round(W * 0.03)
    d.rounded_rectangle((inset, inset, W - inset - 1, W - inset - 1), radius=round(W * 0.22), fill=(18, 21, 26, 255),
                        outline=(255, 255, 255, 34), width=max(1, round(W * 0.012)))
    m = mark_png("#3DDC84", round(W * 0.78))
    tile.alpha_composite(m, ((W - m.width) // 2, (W - m.height) // 2))
    tile.resize((px, px), Image.LANCZOS).save(OUT / f"app-{px}.png")
print("wrote", len(list(OUT.glob("*.png"))), "png to", OUT)

# Install icons for the two web apps (Chrome/Edge "Install app", iPhone "Add to Home Screen"):
#   web/public/icons/*   the control room the agent serves (http://127.0.0.1:7700), listed in web/public/manifest.webmanifest
#   site/icons/*         the public site, listed in site/site.webmanifest
# "any" icons are the launcher's rounded tile; maskable and Apple ones are full-bleed squares the OS crops,
# with the mark inside the centre 80%.
GRAPHITE = (18, 21, 26, 255)

def web_icon(px, rounded, mark_share):
    W = px * 4
    tile = Image.new("RGBA", (W, W), (0, 0, 0, 0) if rounded else GRAPHITE)
    if rounded:
        d = ImageDraw.Draw(tile)
        inset = round(W * 0.03)
        d.rounded_rectangle((inset, inset, W - inset - 1, W - inset - 1), radius=round(W * 0.22), fill=GRAPHITE,
                            outline=(255, 255, 255, 34), width=max(1, round(W * 0.012)))
    m = mark_png("#3DDC84", round(W * mark_share))
    tile.alpha_composite(m, ((W - m.width) // 2, (W - m.height) // 2))
    return tile.resize((px, px), Image.LANCZOS)

for dest in (ROOT / "web" / "public" / "icons", ROOT / "site" / "icons"):
    dest.mkdir(parents=True, exist_ok=True)
    for px in (192, 512):
        web_icon(px, True, 0.78).save(dest / f"icon-{px}.png", optimize=True)
        web_icon(px, False, 0.62).save(dest / f"maskable-{px}.png", optimize=True)
    web_icon(180, False, 0.7).save(dest / "apple-touch-icon.png", optimize=True)
print("wrote web app icons to web/public/icons and site/icons")
