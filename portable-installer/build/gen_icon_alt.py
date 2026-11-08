"""Generate the alternate SmartHub "harness clamp" icon."""
import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw

S = 5
DARK = (11, 18, 32, 255)
WHITE = (248, 250, 252, 255)
CYAN = (34, 211, 238, 255)
LEFT = [(82, 46), (62, 46), (54, 54), (54, 146), (62, 154), (82, 154)]
RIGHT = [(126, 46), (146, 46), (154, 54), (154, 146), (146, 154), (126, 154)]


def px(value):
    return int(round(value * S))


def draw_icon(stroke, outer, inner):
    im = Image.new("RGBA", (200 * S, 200 * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([px(8), px(8), px(192), px(192)], radius=px(40), fill=DARK)
    width = px(stroke)
    for points in (LEFT, RIGHT):
        path = [(px(x), px(y)) for x, y in points]
        d.line(path, fill=WHITE, width=width, joint="curve")
        for x, y in (path[0], path[-1]):
            d.ellipse([x - width // 2, y - width // 2, x + width // 2, y + width // 2], fill=WHITE)
    d.polygon(
        [(px(104), px(104 - outer)), (px(104 + outer), px(104)), (px(104), px(104 + outer)), (px(104 - outer), px(104))],
        fill=DARK,
    )
    d.polygon(
        [(px(104), px(104 - inner)), (px(104 + inner), px(104)), (px(104), px(104 + inner)), (px(104 - inner), px(104))],
        fill=CYAN,
    )
    return im


def main():
    full = draw_icon(18, 30, 16)
    small = draw_icon(20, 32, 17)
    entries = []
    for size in (16, 24, 32, 48, 64, 128, 256):
        source = small if size <= 32 else full
        entries.append((size, source.resize((size, size), Image.Resampling.LANCZOS)))

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

    out = Path(__file__).with_name("icon-alt.ico")
    out.write_bytes(struct.pack("<HHH", 0, 1, len(payload)) + b"".join(directory) + b"".join(data for _, data in payload))
    full.resize((512, 512), Image.Resampling.LANCZOS).save(Path(__file__).with_name("icon-alt-preview.png"))
    print("OK", out)


if __name__ == "__main__":
    main()
