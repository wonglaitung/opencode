"""Generate portable-installer/build/icon.ico from the robot design.

Full body is used for 48px and above; 16/24/32 use a simplified head-only
version so the icon stays readable in Explorer and the taskbar.
"""
import struct
from pathlib import Path

from PIL import Image, ImageDraw

DARK = (30, 41, 59, 255)
LIGHT = (248, 250, 252, 255)
SCREEN = (11, 18, 32, 255)
BLUE = (56, 189, 248, 255)
WHITE = (255, 255, 255, 255)
BOLT = (203, 213, 225, 255)
HAND = (226, 232, 240, 255)

S = 5


def px(v):
    return int(round(v * S))


def full_icon():
    im = Image.new("RGBA", (200 * S, 200 * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    lw = lambda v: max(1, px(v))

    # antenna
    d.line([(px(100), px(34)), (px(100), px(20))], fill=DARK, width=lw(5))
    d.ellipse([px(95), px(12), px(105), px(22)], fill=BLUE, outline=DARK, width=lw(3))

    # head + screen + eyes
    d.rounded_rectangle([px(52), px(34), px(148), px(112)], radius=px(28), fill=LIGHT, outline=DARK, width=lw(6))
    d.rounded_rectangle([px(66), px(48), px(134), px(98)], radius=px(18), fill=SCREEN)
    for cx in (85, 115):
        d.ellipse([px(cx - 9), px(64), px(cx + 9), px(82)], fill=BLUE)
        d.ellipse([px(cx - 3.5), px(69.5), px(cx + 3.5), px(76.5)], fill=WHITE)
    for cx in (44, 156):
        d.ellipse([px(cx - 6), px(60), px(cx + 6), px(72)], fill=BOLT, outline=DARK, width=lw(3))

    # neck + body
    d.rounded_rectangle([px(88), px(112), px(112), px(126)], radius=px(4), fill=BOLT, outline=DARK, width=lw(4))
    d.rounded_rectangle([px(58), px(124), px(142), px(182)], radius=px(22), fill=LIGHT, outline=DARK, width=lw(6))

    # symmetric arms + hands
    for start, ctrl, end, hx in (
        ((60, 138), (42, 146), (38, 164), 36),
        ((140, 138), (158, 146), (162, 164), 164),
    ):
        d.line([(px(start[0]), px(start[1])), (px(ctrl[0]), px(ctrl[1])), (px(end[0]), px(end[1]))], fill=DARK, width=lw(10), joint="curve")
        d.ellipse([px(hx - 8), px(160), px(hx + 8), px(176)], fill=HAND, outline=DARK, width=lw(4))

    # legs + feet
    for x in (82, 118):
        d.line([(px(x), px(182)), (px(x - 4 if x < 100 else x + 4), px(190))], fill=DARK, width=lw(12))
    for x0 in (66, 108):
        d.rounded_rectangle([px(x0), px(188), px(x0 + 26), px(198)], radius=px(5), fill=HAND, outline=DARK, width=lw(3))

    return im


def small_icon():
    im = Image.new("RGBA", (200 * S, 200 * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    lw = lambda v: max(1, px(v))
    d.rounded_rectangle([px(20), px(20), px(180), px(180)], radius=px(42), fill=LIGHT, outline=DARK, width=lw(10))
    d.rounded_rectangle([px(42), px(44), px(158), px(156)], radius=px(30), fill=SCREEN)
    for cx in (78, 122):
        d.ellipse([px(cx - 16), px(84), px(cx + 16), px(116)], fill=BLUE)
        d.ellipse([px(cx - 6), px(94), px(cx + 6), px(106)], fill=WHITE)
    return im


def main():
    full = full_icon()
    small = small_icon()
    entries = []
    for size in (16, 24, 32, 48, 64, 128, 256):
        src = small if size <= 32 else full
        im = src.resize((size, size), Image.Resampling.LANCZOS)
        entries.append((size, im))

    payload = []
    for size, im in entries:
        buf = __import__("io").BytesIO()
        im.save(buf, format="PNG")
        payload.append((size, buf.getvalue()))

    offset = 6 + 16 * len(payload)
    header = struct.pack("<HHH", 0, 1, len(payload))
    directory = []
    for size, data in payload:
        dim = 0 if size == 256 else size
        directory.append(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset))
        offset += len(data)

    out = Path(__file__).with_name("icon.ico")
    out.write_bytes(header + b"".join(directory) + b"".join(data for _, data in payload))
    print("OK", out, "sizes:", [s for s, _ in payload])


if __name__ == "__main__":
    main()
