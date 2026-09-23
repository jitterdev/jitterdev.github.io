#!/usr/bin/env python3
"""Add the "lightraised" bevel to an 88x31 badge, or generate a striped flag
and bevel it in one go!

The bevel is the one used on assets/badges/queer.png: a 2px highlight along the
top/left edge and a 2px shadow along the bottom/right, with the corners cut
diagonally. Strength defaults were fitted against that badge.

No third-party deps. PNG is read and written with the stdlib.

Examples:
    # bevel an existing image in place
    python3 tools/bevel.py assets/badges/pansexual.png assets/badges/pansexual.png

    # build a flag from stripe colors, then bevel it
    python3 tools/bevel.py --colors "#E40303,#FF8C00,#FFED00,#008026,#004DFF,#750787" \
        --heights 6,5,5,5,5,5 assets/badges/queer-old.png

    # tweak the bevel strength
    python3 tools/bevel.py in.png out.png --light 0.56 --dark 0.62
"""

import argparse
import struct
import zlib

LIGHT = 0.561  # fraction of the way to white for the highlight
DARK = 0.619   # fraction of the way to black for the shadow

_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def _unfilter(raw, width, height, bit_depth, channels):
    stride = (width * channels * bit_depth + 7) // 8
    bpp = max(1, channels * bit_depth // 8)
    out = bytearray()
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if ftype == 1:
            for i in range(len(line)):
                line[i] = (line[i] + (line[i - bpp] if i >= bpp else 0)) & 255
        elif ftype == 2:
            for i in range(len(line)):
                line[i] = (line[i] + prev[i]) & 255
        elif ftype == 3:
            for i in range(len(line)):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif ftype == 4:
            for i in range(len(line)):
                a = line[i - bpp] if i >= bpp else 0
                c = prev[i - bpp] if i >= bpp else 0
                b = prev[i]
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out += line
        prev = line
    return out


def _unpack_bits(data, count, bit_depth):
    if bit_depth == 8:
        return list(data[:count])
    per_byte = 8 // bit_depth
    mask = (1 << bit_depth) - 1
    vals = []
    for byte in data:
        for k in range(per_byte - 1, -1, -1):
            vals.append((byte >> (k * bit_depth)) & mask)
            if len(vals) == count:
                return vals
    return vals


def read_png(path):
    """Return (width, height, pixels) where pixels is a flat list of RGBA tuples."""
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG: %s" % path)
    pos, idat = 8, b""
    palette = trns = None
    width = height = bit_depth = color_type = None
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, bit_depth, color_type, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
            if interlace:
                raise ValueError("interlaced PNGs are not supported")
        elif tag == b"PLTE":
            palette = [tuple(chunk[i:i + 3]) for i in range(0, len(chunk), 3)]
        elif tag == b"tRNS":
            trns = chunk
        elif tag == b"IDAT":
            idat += chunk
        elif tag == b"IEND":
            break

    raw = _unfilter(zlib.decompress(idat), width, height, bit_depth, _CHANNELS[color_type])
    count = width * height
    pixels = []

    if color_type == 3:
        idxs = _unpack_bits(raw, count, bit_depth)
        for i in idxs:
            r, g, b = palette[i]
            a = trns[i] if trns and i < len(trns) else 255
            pixels.append((r, g, b, a))
    elif color_type in (0, 4):
        vals = _unpack_bits(raw, count * _CHANNELS[color_type], bit_depth)
        step = _CHANNELS[color_type]
        for i in range(count):
            v = vals[i * step]
            a = vals[i * step + 1] if step == 2 else 255
            pixels.append((v, v, v, a))
    else:
        step = _CHANNELS[color_type]
        for i in range(count):
            base = i * step
            r, g, b = raw[base], raw[base + 1], raw[base + 2]
            a = raw[base + 3] if step == 4 else 255
            pixels.append((r, g, b, a))
    return width, height, pixels


def write_png(path, width, height, pixels, alpha=False):
    color_type = 6 if alpha else 2
    step = 4 if alpha else 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            px = pixels[y * width + x]
            raw += bytes(px[:step])

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload +
                struct.pack(">I", zlib.crc32(tag + payload) & 0xffffffff))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(chunk(b"IHDR", ihdr))
        fh.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        fh.write(chunk(b"IEND", b""))


def bevel_kind(x, y, width, height):
    """1 = highlight, 2 = shadow, 0 = untouched."""
    if y == 0:
        return 1
    if y == 1 and x <= width - 2:
        return 1
    if x == 0 and y <= height - 2:
        return 1
    if x == 1 and y <= height - 3:
        return 1
    if x == width - 1 and y >= 1:
        return 2
    if x == width - 2 and y >= 2:
        return 2
    if y == height - 1 and x >= 1:
        return 2
    if y == height - 2 and x >= 2:
        return 2
    return 0


def add_bevel(width, height, pixels, light=LIGHT, dark=DARK):
    out = []
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[y * width + x]
            kind = bevel_kind(x, y, width, height)
            if kind == 1:
                rgb = [min(255, round(c + (255 - c) * light)) for c in (r, g, b)]
            elif kind == 2:
                rgb = [max(0, round(c * (1 - dark))) for c in (r, g, b)]
            else:
                rgb = [r, g, b]
            out.append((rgb[0], rgb[1], rgb[2], a))
    return out


def stripes_from_colors(colors, heights, width):
    rows = []
    for color, n in zip(colors, heights):
        h = color.lstrip("#")
        rgb = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
        rows += [rgb] * n
    return rows


def even_heights(count, height):
    base, extra = divmod(height, count)
    return [base + (1 if i < extra else 0) for i in range(count)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="input PNG, or the output path when --colors is used")
    ap.add_argument("output", nargs="?", help="output PNG (defaults to overwriting input)")
    ap.add_argument("--colors", help="comma-separated hex stripe colors; skips reading an input file")
    ap.add_argument("--heights", help="comma-separated stripe heights in pixels")
    ap.add_argument("--light", type=float, default=LIGHT, help="highlight strength (default %(default)s)")
    ap.add_argument("--dark", type=float, default=DARK, help="shadow strength (default %(default)s)")
    args = ap.parse_args()

    out_path = args.output or args.input

    if args.colors:
        colors = [c.strip() for c in args.colors.split(",") if c.strip()]
        height = 31
        if args.heights:
            heights = [int(h) for h in args.heights.split(",")]
        else:
            heights = even_heights(len(colors), height)
        if sum(heights) != height:
            ap.error("stripe heights must add up to %d, got %d" % (height, sum(heights)))
        width = 88
        rows = stripes_from_colors(colors, heights, width)
        pixels = [(r, g, b, 255) for (r, g, b) in rows for _ in range(width)]
    else:
        width, height, pixels = read_png(args.input)
        if (width, height) != (88, 31):
            print("warning: expected 88x31, got %dx%d" % (width, height))

    result = add_bevel(width, height, pixels, args.light, args.dark)
    write_png(out_path, width, height, result, alpha=False)
    print("wrote %s (%dx%d, light=%.3f dark=%.3f)" % (out_path, width, height, args.light, args.dark))


if __name__ == "__main__":
    main()
