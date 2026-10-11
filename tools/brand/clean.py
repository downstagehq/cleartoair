# Clean the Illustrator exports of the Clear to Air logo into product assets.
# Illustrator wrote each artboard with a white background rectangle (holes cut for the
# shapes) plus white "counter" blobs inside the a's. On a dark screen those read as
# white boxes, so they go; the counters become a mask so the a's stay open.
import re, sys, pathlib, io
import cairosvg
from PIL import Image

# usage: python tools/brand/clean.py [out-dir]     (needs: pip install cairosvg pillow)
SRC = pathlib.Path(__file__).resolve().parents[2] / "brand" / "source"   # the designers' delivery, as received
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else SRC.parent    # brand/
OUT.mkdir(parents=True, exist_ok=True)

STATES = {"clear": "#3DDC84", "warn": "#FFB020", "fault": "#FF5A5A", "idle": "#1E242C"}

def shapes(svg):
    return re.findall(r'<(?:path|circle)\b[^>]*/>', svg, flags=re.S)

def is_bg(tag):
    return 'class="st0"' in tag

def bbox(svg_doc, w=2000):
    png = cairosvg.svg2png(bytestring=svg_doc.encode(), output_width=w)
    im = Image.open(io.BytesIO(png)).convert("RGBA")
    return im.getbbox(), im.size

# ---------- mark ----------
mark_src = (SRC / "Mark" / "Black Mark SVG.svg").read_text(encoding="utf-8")
mark_shapes = [s for s in shapes(mark_src) if not is_bg(s)]
vb = re.search(r'viewBox="([^"]+)"', mark_src).group(1).split()
vx, vy, vw, vh = map(float, vb)
probe = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb[0]} {vb[1]} {vb[2]} {vb[3]}">{"".join(mark_shapes)}</svg>'
(bx0, by0, bx1, by1), (pw, ph) = bbox(probe)
sx = vw / pw
x0, y0, x1, y1 = vx + bx0 * sx, vy + by0 * sx, vx + bx1 * sx, vy + by1 * sx
side = max(x1 - x0, y1 - y0)
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
pad = side * 0.06
mvb = f"{cx - side/2 - pad:.2f} {cy - side/2 - pad:.2f} {side + 2*pad:.2f} {side + 2*pad:.2f}"
mark_body = "".join(s.replace("<path ", '<path ').replace("<circle ", "<circle ") for s in mark_shapes)
mark_svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{mvb}" fill="currentColor" role="img" aria-label="Clear to Air">{mark_body}</svg>\n'
(OUT / "mark.svg").write_text(mark_svg, encoding="utf-8")
for st, col in STATES.items():
    (OUT / f"mark-{st}.svg").write_text(mark_svg.replace('fill="currentColor"', f'fill="{col}"'), encoding="utf-8")

# ---------- wordmark ----------
full_src = (SRC / "Full Logo" / "Full Black Logo SVG.svg").read_text(encoding="utf-8")
fvb = re.search(r'viewBox="([^"]+)"', full_src).group(1).split()
all_shapes = shapes(full_src)
bg = [s for s in all_shapes if is_bg(s)]
counters = [s for s in bg if len(s) < 600]          # the a-bowl blobs; the big one is the artboard rect
fg = [s for s in all_shapes if not is_bg(s)]
lamp = [s for s in fg if s.startswith('<circle cx="473.86"') or 'M457.28,417.71' in s]
word = [s for s in fg if s not in lamp]
assert len(lamp) == 2, f"lamp shapes: {len(lamp)}"
strip = lambda s: re.sub(r'\s*class="st0"', "", s)
probe = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(fvb)}">{"".join(fg)}</svg>'
(bx0, by0, bx1, by1), (pw, ph) = bbox(probe, 4000)
s = float(fvb[2]) / pw
x0, y0, x1, y1 = float(fvb[0]) + bx0 * s, float(fvb[1]) + by0 * s, float(fvb[0]) + bx1 * s, float(fvb[1]) + by1 * s
pad = (y1 - y0) * 0.08
wvb = f"{x0 - pad:.2f} {y0 - pad:.2f} {x1 - x0 + 2*pad:.2f} {y1 - y0 + 2*pad:.2f}"
mask = (f'<mask id="cta-a" maskUnits="userSpaceOnUse" x="{x0-pad:.2f}" y="{y0-pad:.2f}" width="{x1-x0+2*pad:.2f}" height="{y1-y0+2*pad:.2f}">'
        f'<rect x="{x0-pad:.2f}" y="{y0-pad:.2f}" width="{x1-x0+2*pad:.2f}" height="{y1-y0+2*pad:.2f}" fill="#fff"/>'
        + "".join(strip(c).replace("<path ", '<path fill="#000" ') for c in counters) + "</mask>")

def wordmark(word_fill, lamp_fill):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{wvb}" role="img" aria-label="Clear to Air">'
            f'<defs>{mask}</defs>'
            f'<g class="cta-word" fill="{word_fill}" mask="url(#cta-a)">{"".join(word)}</g>'
            f'<g class="cta-lamp" fill="{lamp_fill}">{"".join(lamp)}</g></svg>\n')

(OUT / "wordmark.svg").write_text(wordmark("currentColor", "currentColor"), encoding="utf-8")
for ink, word_col in (("white", "#FFFFFF"), ("black", "#000000")):
    (OUT / f"wordmark-{ink}.svg").write_text(wordmark(word_col, word_col), encoding="utf-8")
    for st, col in STATES.items():
        (OUT / f"wordmark-{ink}-{st}.svg").write_text(wordmark(word_col, col), encoding="utf-8")
print("mark viewBox", mvb)
print("wordmark viewBox", wvb, "counters", len(counters))
