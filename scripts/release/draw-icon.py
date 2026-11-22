"""
Draw assets/icon-180.png — the storefront tile for dsh-waypoint.

The subject is the name: a dashed route with a waypoint pin at its end. One
dominant shape (the pin), one supporting stroke (the route), no tile background
and no lettering, so it reads at the ~96 px the marketplace draws it and sits
quietly beside the other icons in the DSH plugin list.

Drawn at 4x and downsampled: Pillow's line and polygon joins are not
antialiased, and a 180 px canvas shows every jagged edge.
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 180
SCALE = 4
CANVAS = SIZE * SCALE

# Restrained palette: a slate route and one accent pin. Matches the saturation
# of neighbouring plugin icons rather than competing with them.
ROUTE = (100, 116, 139, 255)
PIN = (37, 99, 235, 255)

image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)


def s(value: float) -> int:
    """Scale a design unit to canvas pixels."""
    return round(value * SCALE)


# Geometry in 180-unit design space. The route runs up from the bottom-left,
# turns once, and stops just under the pin's tip so the pin reads as the
# destination the line arrives at. The pin's centre sits on the 1/3 line, which
# leaves air all round the glyph at row size.
PIN_CX, PIN_CY, PIN_R = 92, 54, 27
PIN_TIP_Y = 102
ROUTE = (100, 116, 139, 255)
ROUTE_WIDTH = 8
END_X = PIN_CX

route = [
    (40, 148),
    (40, 118),
    (END_X, 118),
]

# Dashes are measured in distance travelled, so the pattern stays even across
# the corner instead of restarting on each segment (which left two long dashes
# crashing into the pin).
DASH, GAP = 13.0, 10.0
carry = 0.0
drawing = True

for (ax, ay), (bx, by) in zip(route, route[1:]):
    dx, dy = bx - ax, by - ay
    length = (dx * dx + dy * dy) ** 0.5
    travelled = 0.0
    while travelled < length - 0.01:
        room = (DASH if drawing else GAP) - carry
        step = min(room, length - travelled)
        if drawing:
            t0 = travelled / length
            t1 = (travelled + step) / length
            draw.line(
                [
                    (s(ax + dx * t0), s(ay + dy * t0)),
                    (s(ax + dx * t1), s(ay + dy * t1)),
                ],
                fill=ROUTE,
                width=s(ROUTE_WIDTH),
            )
        travelled += step
        carry += step
        if carry >= (DASH if drawing else GAP) - 0.01:
            carry = 0.0
            drawing = not drawing

# The pin: a round head with a straight tail whose tip lands on the route. The
# tail is drawn as a polygon that meets the head at its widest tangent points,
# so the two shapes read as one silhouette instead of a ball on a stick.
draw.polygon(
    [
        (s(PIN_CX - 17), s(PIN_CY + 12)),
        (s(PIN_CX + 17), s(PIN_CY + 12)),
        (s(PIN_CX), s(PIN_TIP_Y)),
    ],
    fill=PIN,
)
draw.ellipse(
    [s(PIN_CX - PIN_R), s(PIN_CY - PIN_R), s(PIN_CX + PIN_R), s(PIN_CY + PIN_R)],
    fill=PIN,
)
# A genuinely transparent hole, not a white disc: the tile shows through it in
# both light and dark themes.
draw.ellipse(
    [s(PIN_CX - 11), s(PIN_CY - 11), s(PIN_CX + 11), s(PIN_CY + 11)],
    fill=(0, 0, 0, 0),
)

out = Path(__file__).resolve().parent.parent / "packages" / "local-plugin" / "icon-180.png"
out.parent.mkdir(parents=True, exist_ok=True)
image.resize((SIZE, SIZE), Image.LANCZOS).save(out, "PNG", optimize=True)
print(f"wrote {out} ({out.stat().st_size} bytes)")
