# Generates the bridge's icon assets, no external deps:
#   app.ico          - 16/32/48 px, classic BMP entries (exe + tray icon)
#   assets/icon.png  - 64 px PNG (External Tools ribbon iconData, base64'd at runtime)
# Look: the Studio's brand gradient (indigo -> violet) rounded square with a
# white spark, matching the web app's logo chip.
import os, struct, zlib

def lerp(a, b, t):
    return a + (b - a) * t

def px(x, y, size):
    """RGBA for pixel (x,y) in a size x size icon."""
    s = size
    r = s * 0.22  # corner radius
    # rounded-rect mask
    cx = min(max(x + 0.5, r), s - r)
    cy = min(max(y + 0.5, r), s - r)
    dx, dy = (x + 0.5) - cx, (y + 0.5) - cy
    inside = dx * dx + dy * dy <= r * r
    if not inside:
        return (0, 0, 0, 0)
    # diagonal gradient  #4f7dff -> #8a5cff
    t = (x + y) / (2 * (s - 1))
    col = (round(lerp(0x4F, 0x8A, t)), round(lerp(0x7D, 0x5C, t)), 0xFF)
    # white 4-point spark in the center
    mx = my = (s - 1) / 2
    ax, ay = abs(x - mx), abs(y - my)
    arm = s * 0.30
    thick = max(1.0, s * 0.055)
    in_spark = (ax < thick and ay < arm) or (ay < thick and ax < arm)
    core = ax + ay < s * 0.16
    if in_spark or core:
        return (255, 255, 255, 255)
    return (col[0], col[1], col[2], 255)

def raster(size):
    return [[px(x, y, size) for x in range(size)] for y in range(size)]

def to_png(size):
    rows = raster(size)
    raw = b''.join(b'\x00' + b''.join(bytes(p) for p in row) for row in rows)
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

def bmp_entry(size):
    """ICO BMP payload: BITMAPINFOHEADER + bottom-up BGRA + AND mask."""
    rows = raster(size)
    header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    xor = b''
    for y in range(size - 1, -1, -1):
        for (r, g, b, a) in rows[y]:
            xor += bytes((b, g, r, a))
    mask_row = ((size + 31) // 32) * 4
    land = b'\x00' * (mask_row * size)  # alpha channel does the masking
    return header + xor + land

def write_ico(path, sizes):
    entries = [(s, bmp_entry(s)) for s in sizes]
    out = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    body = b''
    for s, data in entries:
        out += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        body += data
    with open(path, 'wb') as f:
        f.write(out + body)

here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(here, 'assets'), exist_ok=True)
write_ico(os.path.join(here, 'app.ico'), [16, 32, 48])
with open(os.path.join(here, 'assets', 'icon.png'), 'wb') as f:
    f.write(to_png(64))
print('wrote app.ico (16/32/48) and assets/icon.png (64)')
