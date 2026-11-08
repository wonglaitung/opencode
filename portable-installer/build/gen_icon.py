"""Generate the SmartHub icon set.

The mark is a white S built as one continuous rounded stroke, with a cyan
hub node at the center. A dark squircle keeps the small sizes legible.
"""
import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw

S = 5
DARK = (11, 18, 32, 255)
WHITE = (248, 250, 252, 255)
CYAN = (34, 211, 238, 255)
SEGMENTS = [
    ((146, 62), (146, 48), (130, 40), (108, 40)),
    ((108, 40), (82, 40), (60, 52), (60, 74)),
    ((60, 74), (60, 94), (78, 102), (104, 105)),
    ((104, 105), (126, 108), (144, 116), (144, 136)),
    ((144, 136), (144, 158), (124, 164), (100, 164)),
    ((100, 164), (76, 164), (58, 156), (58, 142)),
]


def px(value):
    return int(round(value * S))


def s_points(steps=80):
    points = []
    for p0, p1, p2, p3 in SEGMENTS:
        for i in range(steps + 1):
            t = i / steps
            m = 1 - t
            x = m**3 * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t**3 * p3[0]
            y = m**3 * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t**3 * p3[1]
            points.append((px(x), px(y)))
    return points


def draw_icon(stroke, outer, inner):
    im = Image.new("RGBA", (200 * S, 200 * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([px(8), px(8), px(192), px(192)], radius=px(40), fill=DARK)
    points = s_points()
    width = px(stroke)
    d.line(points, fill=WHITE, width=width, joint="curve")
    for x, y in (points[0], points[-1]):
        d.ellipse([x - width // 2, y - width // 2, x + width // 2, y + width // 2], fill=WHITE)
    d.ellipse([px(104 - outer), px(104 - outer), px(104 + outer), px(104 + outer)], fill=DARK)
    d.ellipse([px(104 - inner), px(104 - inner), px(104 + inner), px(104 + inner)], fill=CYAN)
    return im


def main():
    full = draw_icon(22, 22, 12)
    small = draw_icon(24, 23, 13)

    entries = []
    for size in (16, 24, 32, 48, 64, 128, 256):
        source = small if size <= 32 else full
        resized = source.resize((size, size), Image.Resampling.LANCZOS)
        entries.append((size, resized))

    payload = []
    for size, im in entries:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        payload.append((size, buf.getvalue()))

    offset = 6 + 16 * len(payload)
    directory = []
    for size, data in payload:
        dim = 0 if size == 256 else size
        directory.append(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset))
        offset += len(data)

    out = Path(__file__).with_name("icon.ico")
    out.write_bytes(struct.pack("<HHH", 0, 1, len(payload)) + b"".join(directory) + b"".join(data for _, data in payload))
    full.resize((512, 512), Image.Resampling.LANCZOS).save(Path(__file__).with_name("icon-preview.png"))
    print("OK", out, "sizes:", [size for size, _ in payload])


if __name__ == "__main__":
    main()
