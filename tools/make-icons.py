#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
零依赖 PWA 图标生成器（不需要 Pillow / cairosvg / 浏览器）。
用 SDF（有向距离场）+ 超采样抗锯齿直接光栅化，手写 PNG 编码器。

产出：
  icons/icon-192.png          普通图标（圆角蓝底 + 白色 ¥）
  icons/icon-512.png          普通图标大图
  icons/icon-maskable-512.png 可遮罩图标（满幅蓝底 + 缩小的 ¥，适配任意形状遮罩）
  icons/icon.svg              矢量源文件

用法： python tools/make-icons.py
"""
import math, os, struct, zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')

# ---------- PNG 编码 ----------
def write_png(path, w, h, rgba):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)                       # filter type 0 (None)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)   # 8bit RGBA
    blob = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
            chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(blob)
    return len(blob)

# ---------- SDF ----------
def sd_seg(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    l2 = vx * vx + vy * vy
    t = 0.0 if l2 == 0 else (wx * vx + wy * vy) / l2
    if t < 0.0: t = 0.0
    elif t > 1.0: t = 1.0
    dx = px - (ax + t * vx); dy = py - (ay + t * vy)
    return math.sqrt(dx * dx + dy * dy)

def sd_roundrect(px, py, x0, y0, x1, y1, r):
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    hx, hy = (x1 - x0) / 2.0 - r, (y1 - y0) / 2.0 - r
    qx, qy = abs(px - cx) - hx, abs(py - cy) - hy
    mx, my = max(qx, 0.0), max(qy, 0.0)
    return math.sqrt(mx * mx + my * my) + min(max(qx, qy), 0.0) - r

# ¥ 字形的骨架线段（单位坐标 0..1，原点左上）
YEN_SEGS = [
    (0.285, 0.300, 0.500, 0.505),   # 左斜臂
    (0.715, 0.300, 0.500, 0.505),   # 右斜臂
    (0.500, 0.455, 0.500, 0.790),   # 竖干
    (0.340, 0.580, 0.660, 0.580),   # 上横
    (0.340, 0.700, 0.660, 0.700),   # 下横
]
YEN_STROKE = 0.088

def sd_yen(px, py, S):
    dmin = 1e9
    half = YEN_STROKE * S / 2.0
    for (ax, ay, bx, by) in YEN_SEGS:
        d = sd_seg(px, py, ax * S, ay * S, bx * S, by * S)
        if d < dmin: dmin = d
    return dmin - half

# ---------- 配色 ----------
def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))
BG_TOP = (0x25, 0x63, 0xeb)
BG_BOT = (0x5c, 0xa3, 0xfb)
FG = (0xff, 0xff, 0xff)

def render(size, radius=0.22, glyph_scale=1.0, ss=2, maskable=False):
    """radius: 圆角半径(相对边长)；maskable: 满幅方底无圆角"""
    S = float(size)
    r = radius * S
    # 字形缩放：以画布中心为基准
    def sd_glyph(px, py):
        cx = cy = S / 2.0
        lx = (px - cx) / glyph_scale + cx
        ly = (py - cy) / glyph_scale + cy
        return sd_yen(lx, ly, S) * glyph_scale

    def sd_bg(px, py):
        if maskable:
            return -1.0
        return sd_roundrect(px, py, 0.0, 0.0, S, S, r)

    buf = bytearray(size * size * 4)
    n = ss * ss
    step = 1.0 / ss
    off = [(i % ss + 0.5) * step for i in range(n)]
    offy = [(i // ss + 0.5) * step for i in range(n)]

    for y in range(size):
        row = y * size * 4
        for x in range(size):
            px0, py0 = x + 0.5, y + 0.5
            # 快速路径：完全在内部/外部就跳过超采样
            gb = sd_bg(px0, py0)
            if not maskable and gb > 1.5:
                continue                                  # 透明
            gg = sd_glyph(px0, py0)
            inside_glyph = gg < -1.5
            far_from_bg = maskable or gb < -1.5
            if inside_glyph:
                # 纯色，直接写
                ar, ag, ab, aa = FG[0], FG[1], FG[2], 255
                if far_from_bg:
                    i = row + x * 4
                    buf[i] = ar; buf[i+1] = ag; buf[i+2] = ab; buf[i+3] = aa
                    continue
            sr = sg = sb = sa = 0
            for k in range(n):
                sx = px0 - 0.5 + off[k]
                sy = py0 - 0.5 + offy[k]
                # 背景
                if maskable:
                    bsd = -1.0
                else:
                    bsd = sd_bg(sx, sy)
                a = 0.0 if bsd > 0 else 1.0
                # 边缘抗锯齿：用 1px 过渡带
                if not maskable and abs(bsd) < 0.75:
                    a = 0.5 - bsd / 1.5
                    a = 0.0 if a < 0 else (1.0 if a > 1 else a)
                t = (sy / S)
                cr, cg, cb = lerp(BG_TOP, BG_BOT, t)
                # 前景
                if sd_glyph(sx, sy) < 0:
                    cr, cg, cb = FG
                sa += a
                sr += cr * a; sg += cg * a; sb += cb * a
            if sa <= 0:
                continue
            ar = int(round(sr / sa)); ag = int(round(sg / sa)); ab = int(round(sb / sa))
            aa = int(round(255.0 * sa / n))
            i = row + x * 4
            buf[i] = ar; buf[i+1] = ag; buf[i+2] = ab; buf[i+3] = aa
    return buf

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2563eb"/>
      <stop offset="1" stop-color="#5ca3fb"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" ry="112" fill="url(#bg)"/>
  <g fill="none" stroke="#ffffff" stroke-width="45" stroke-linecap="round" stroke-linejoin="round">
    <path d="M146 154 L256 259"/>
    <path d="M366 154 L256 259"/>
    <path d="M256 233 L256 405"/>
    <path d="M174 297 L338 297"/>
    <path d="M174 358 L338 358"/>
  </g>
</svg>
'''

def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ('icon-192.png', 192, dict(radius=0.22, glyph_scale=0.86, ss=3)),
        ('icon-512.png', 512, dict(radius=0.22, glyph_scale=0.86, ss=2)),
        ('icon-maskable-512.png', 512, dict(glyph_scale=0.62, ss=2, maskable=True)),
    ]
    for name, size, kw in jobs:
        buf = render(size, **kw)
        n = write_png(os.path.join(OUT, name), size, size, buf)
        print('%-24s %dx%d  %6.1f KB' % (name, size, size, n / 1024.0))
    with open(os.path.join(OUT, 'icon.svg'), 'w', encoding='utf-8') as f:
        f.write(SVG)
    print('icon.svg               矢量源')
    print('完成 ->', OUT)

if __name__ == '__main__':
    main()
