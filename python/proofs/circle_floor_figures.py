"""Figures for docs/proofs/circle-container-floor.md, drawn from the proof's configurations.

Run from the repository root: python3 python/proofs/circle_floor_figures.py
Writes docs/proofs/figures/*.svg (standard library only).
"""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import circle_floor as cf  # noqa: E402

OUT = cf.ROOT / "docs/proofs/figures"
PANEL = 300  # px per panel
INK = "#1f2933"
CONTACT = "#c2410c"
FILL = "#dbeafe"
WALL = "#64748b"
# rho0(P) as printed in the panel titles
TITLES = {11: "radius 1 + 1/sin 20°", 13: "radius 2 + √5", 19: "radius 1 + √2 + √6"}


def svg(width, height, body):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="Helvetica, Arial, sans-serif">\n'
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>\n{body}</svg>\n'
    )


def panel(ox, scale, title, items):
    """items are SVG fragments in panel coordinates (origin at the panel centre, y up)."""
    c = PANEL / 2
    out = [f'<g transform="translate({ox + c:.1f},{c + 14:.1f}) scale({scale:.4f},{-scale:.4f})">']
    out += items
    out.append("</g>")
    out.append(f'<text x="{ox + c:.1f}" y="16" text-anchor="middle" font-size="13" fill="{INK}">{title}</text>')
    return out


def circle_panel(cfg, ox):
    rho0 = float(cfg.a.decimal()[0]) + 1
    scale = (PANEL / 2 - 20) / rho0
    pts = {k: tuple(float(t) for t in v.decimal()) for k, v in cfg.points.items()}
    w = 1 / scale
    items = [f'<circle cx="0" cy="0" r="{rho0:.5f}" fill="none" stroke="{WALL}" stroke-width="{1.2 * w:.4f}"/>']
    for x, y in pts.values():
        items.append(f'<circle cx="{x:.5f}" cy="{y:.5f}" r="1" fill="{FILL}" stroke="{INK}" stroke-width="{w:.4f}"/>')
    for i, j, _ in cfg.contacts:
        (x0, y0), (x1, y1) = pts[i], pts[j]
        items.append(
            f'<line x1="{x0:.5f}" y1="{y0:.5f}" x2="{x1:.5f}" y2="{y1:.5f}" stroke="{CONTACT}" stroke-width="{1.4 * w:.4f}"/>'
        )
    for name in cfg.walls:
        x, y = pts[name]
        d = math.hypot(x, y)
        items.append(
            f'<line x1="{x:.5f}" y1="{y:.5f}" x2="{x * rho0 / d:.5f}" y2="{y * rho0 / d:.5f}" '
            f'stroke="{CONTACT}" stroke-width="{1.4 * w:.4f}" stroke-dasharray="{3 * w:.4f}"/>'
        )
    for name, (x, y) in pts.items():
        items.append(
            f'<text transform="translate({x:.5f},{y - 0.12:.5f}) scale({w:.5f},{-w:.5f})" text-anchor="middle" '
            f'font-size="11" fill="{INK}" stroke="#ffffff" stroke-width="3" paint-order="stroke">{label(name)}</text>'
        )
    return panel(ox, scale, f"P = {cfg.P}: {TITLES[cfg.P]}", items)


def label(name):
    if name[0] in "WHXYc" and name[1:].isdigit():
        return f'{name[0]}<tspan font-size="8" dy="3">{name[1:]}</tspan>'
    return name


def polygon_panel(cfg, N, ox):
    ps = cf.poses(cfg, N)
    floor = float((cf.inradius(N) ** 2 * (cfg.a.decimal()[0] + 1) ** 2 + cf.Decimal(1) / 4).sqrt())
    scale = (PANEL / 2 - 20) / floor
    w = 1 / scale
    items = [f'<circle cx="0" cy="0" r="{floor:.5f}" fill="none" stroke="{WALL}" stroke-width="{1.2 * w:.4f}"/>']
    R = 1 / (2 * math.sin(math.pi / N))
    for x, y, theta in ps.values():
        x, y, theta = float(x), float(y), float(theta)
        v = [
            (x + R * math.cos(theta + math.pi / 2 + 2 * math.pi * k / N), y + R * math.sin(theta + math.pi / 2 + 2 * math.pi * k / N))
            for k in range(N)
        ]
        pts = " ".join(f"{a:.5f},{b:.5f}" for a, b in v)
        items.append(f'<polygon points="{pts}" fill="{FILL}" stroke="{INK}" stroke-width="{w:.4f}"/>')
    return panel(ox, scale, f"N = {N}, P = {cfg.P}: radius {floor:.6f}", items)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cfgs = {c.P: c for c in cf.configurations()}
    body = []
    for k, P in enumerate((11, 13, 19)):
        body += circle_panel(cfgs[P], k * PANEL)
    (OUT / "circle-floor-configurations.svg").write_text(svg(3 * PANEL, PANEL + 20, "\n".join(body) + "\n"), encoding="utf-8")
    body = []
    for k, (P, N) in enumerate(((11, 36), (13, 10), (19, 24))):
        body += polygon_panel(cfgs[P], N, k * PANEL)
    (OUT / "circle-floor-packings.svg").write_text(svg(3 * PANEL, PANEL + 20, "\n".join(body) + "\n"), encoding="utf-8")
    body = []
    for k, (cfg, N) in enumerate(((cfgs[6], 3), (cfgs[8], 28), (cf.config_six_centre(16), 16))):
        body += polygon_panel(cfg, N, k * PANEL)
    (OUT / "circle-floor-small.svg").write_text(svg(3 * PANEL, PANEL + 20, "\n".join(body) + "\n"), encoding="utf-8")
    for f in sorted(OUT.glob("*.svg")):
        print(f.relative_to(cf.ROOT))


if __name__ == "__main__":
    main()
