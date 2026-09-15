"""
Netra pocket hotspot - product concept renderer (Blender 5.2+, Cycles).

Builds three form-factor variants of the device with molded-part detailing,
renders four stills of each, and exports STL + GLB.

    cd hardware
    /Applications/Blender.app/Contents/MacOS/Blender --background --python render_device.py

Optional overrides after "--" (handy for cheap iteration):

    ... --python render_device.py -- --variants card --shots hero --samples 64 --percent 50
    ... --python render_device.py -- --colorway chalk --no-export

Output (relative to the directory you run Blender from):
    renders/<variant>_<colorway>_<shot>.png
    renders/<variant>_<colorway>.stl   (millimeters)
    renders/<variant>_<colorway>.glb   (meters, Y-up)

Units: every dimension below is in MILLIMETERS. The scene itself is built in
meters so lights, depth of field and GLB export behave physically.
Only built-in Blender modules are used (no add-ons beyond the bundled glTF exporter).
"""

import argparse
import math
import os
import random
import sys
import time

import bmesh
import bpy
from mathutils import Matrix, Vector

# =============================================================================
# 1. WHAT TO BUILD
# =============================================================================
VARIANTS = ["puck", "card", "stick"]   # any subset, rendered in this order
COLORWAY = "graphite"                  # "graphite" | "chalk" | "ember"  <- switch here
SHOTS = ["hero", "front", "side", "context"]
WORDMARK_TEXT = "NETRA"                # pad-printed on the top shell ("" to disable)

# =============================================================================
# 2. OUTPUT
# =============================================================================
RENDER_DIR = "./renders"
EXPORT_DIR = "./renders"
EXPORT_STL = True
EXPORT_GLB = True
STL_SCALE = 1000.0                     # scene meters -> STL millimeters

# =============================================================================
# 3. RENDER QUALITY
# =============================================================================
RESOLUTION_X = 2000
RESOLUTION_Y = 1334                    # 3:2
RESOLUTION_PERCENT = 100
MAX_SAMPLES = 384                      # ceiling; adaptive sampling stops earlier
MIN_SAMPLES = 48
NOISE_THRESHOLD = 0.01                 # lower = cleaner and slower
DENOISE = True                         # OpenImageDenoise (albedo + normal passes)
USE_GPU = True                         # Metal / OptiX / CUDA / HIP / oneAPI if present
CLAMP_INDIRECT = 5.0                   # suppresses fireflies from glossy bounces
VIEW_TRANSFORM = "AgX"
LOOK = "AgX - Medium High Contrast"
EXPOSURE = 0.0

# =============================================================================
# 4. COLORWAYS  (sRGB hex; converted to linear internally)
# =============================================================================
COLORWAYS = {
    "graphite": dict(
        shell="#2B2D32", shell_roughness=0.58, button="#3B3E45",
        ink="#8C919A", led="#3BE3CB", screen_ui="#E2FAF5", backdrop="#9A9CA1",
    ),
    "chalk": dict(
        shell="#E4E0D8", shell_roughness=0.62, button="#C8C3BA",
        ink="#6E6960", led="#34B8FF", screen_ui="#EAF6FF", backdrop="#B7AEA3",
    ),
    "ember": dict(
        shell="#B8441C", shell_roughness=0.55, button="#26272B",
        ink="#1D1D20", led="#FFE7C4", screen_ui="#FFF2DE", backdrop="#CFBFAE",
    ),
}

# =============================================================================
# 5. MATERIAL TUNING
# =============================================================================
SOFT_TOUCH = dict(
    specular=0.22,          # Specular IOR Level; soft-touch coatings reflect little
    sheen=0.15,             # velvet-like grazing highlight of TPU soft-touch paint
    sheen_roughness=0.55,
    texture_scale=3200.0,   # mold texture grain, 1/m (3200 -> ~0.3 mm)
    texture_strength=0.10,
)
BUTTON_GLOSS = dict(roughness=0.24, coat=0.35, coat_roughness=0.08)
LED_STRENGTH = 8.0          # emission strength of lit status LEDs
SCREEN_UI_STRENGTH = 2.5    # emission strength of display graphics

# =============================================================================
# 6. MOLDING DETAILS (mm)  - shared by every variant
# =============================================================================
PARTING_GAP = 0.10          # visible gap between top and bottom housings
PARTING_CHAMFER = 0.35      # chamfer on each housing at the parting line
EDGE_CHAMFER = 0.30         # chamfer on openings, wells and small parts
SUPPORT_LOOP = 0.35         # distance of subdivision support loops from fillets
BEVEL_SEGMENTS = 4
BEVEL_PROFILE = 0.6         # 0.5 = circular fillet, >0.5 = fuller, molded look
SUBSURF_LEVELS = 3
OUTLINE_SEGMENTS = 12       # vertices per 90 degrees of planform corner
SHARP_ANGLE_DEG = 32.0      # shading split angle after modifiers are applied
BUTTON_CLEARANCE = 0.25     # radial gap between a button cap and its well
BUTTON_RECESS = 0.15        # top buttons sit this far below the surface
SIDE_BUTTON_PROUD = 0.40    # side buttons stand this far out of the wall
WELL_DEPTH = 1.4            # depth of the recess around buttons
PORT_DEPTH = 6.5            # depth of port pockets
DECAL_OFFSET = 0.03         # pad-print ink height above the surface

USBC_OPENING = (9.4, 3.8)           # molded opening (width, height)
USBC_SHELL = (8.9, 3.3, 0.3)        # receptacle shell (width, height, wall)
USBC_SETBACK = 0.5                  # receptacle sits behind the opening face

# =============================================================================
# 7. VARIANT DIMENSIONS (mm)
#    Device frame: bottom at z=0, centered in XY, long axis on X, UI face +Z.
# =============================================================================
PUCK = dict(                         # palm-sized disc, one thumb button, LED ring
    diameter=72.0, thickness=17.0,
    top_fillet=5.0, bottom_fillet=3.0, crown=0.9, parting_z=11.2,
    button_diameter=16.0, button_dish=-0.30,        # negative = concave thumb dish
    led_ring_inner=10.3, led_ring_width=1.1,
    usbc_z=6.4, pinhole_diameter=1.0, pinhole_offset=10.0,
    wordmark_size=3.2, wordmark_y=-21.0,
)

CARD = dict(                         # phone-like slab with a small status display
    length=98.0, width=62.0, thickness=13.5, corner_radius=11.0,
    top_fillet=3.2, bottom_fillet=2.4, crown=0.35, parting_z=8.6,
    screen_size=(38.0, 21.0), screen_center=(-14.0, 5.0), screen_corner=2.2,
    top_button_diameter=11.0, top_button_center=(28.0, 1.0),
    led_count=3, led_diameter=1.6, led_pitch=4.2, led_center=(28.0, 15.0), leds_lit=2,
    side_button_size=(12.0, 3.4), side_button_x=18.0,
    side_z=5.3, sim_tray_size=(16.0, 4.2), sim_tray_x=-12.0,
    wordmark_size=2.6, wordmark_center=(-14.0, -15.5),
)

STICK = dict(                        # travel stick with a fold-out antenna paddle
    length=118.0, width=36.0, thickness=19.0,
    top_fillet=5.5, bottom_fillet=3.0, crown=0.5, parting_z=12.5,
    antenna_length=58.0, antenna_width=15.0, antenna_thickness=5.2,
    antenna_bay_x=16.0, antenna_open_deg=34.0,      # 0 = folded flat (best for STL)
    led_bar_size=(14.0, 1.8), led_bar_center=(-43.0, 0.0),
    button_size=(9.0, 5.5), button_center=(-26.0, 0.0),
    usbc_z=7.0, wordmark_size=2.8, wordmark_center=(-36.0, -9.5),
)

# =============================================================================
# 8. STUDIO: HDRI + KEY + RIM, SEAMLESS BACKDROP  (sizes/distances in mm)
#    Azimuth 0 = camera side (-Y), +90 = right (+X), 180 = behind (backdrop).
# =============================================================================
HDRI_PATH = ""              # "" = Blender's bundled studio.exr; or any .exr/.hdr path
HDRI_STRENGTH = 0.4
HDRI_ROTATION_DEG = 140.0
KEY_LIGHT = dict(power=9.0, size=(450, 320), azimuth=-48.0, elevation=50.0,
                 distance=750.0, kelvin=5600)
RIM_LIGHT = dict(power=16.0, size=(900, 70), azimuth=125.0, elevation=40.0,
                 distance=650.0, kelvin=7200)
BACKDROP = dict(width=2600.0, front=900.0, wall_y=950.0, cove_radius=420.0, height=1400.0)

# =============================================================================
# 9. CAMERAS
#    yaw = device rotation (deg), elevation = camera angle above the floor,
#    lens = focal length (mm, 36 mm sensor), fill = fraction of frame width the
#    device spans, aim_z = raise the look-at point (mm), fstop = 0 disables DOF.
# =============================================================================
SENSOR_WIDTH = 36.0
SHOT_SETTINGS = {
    "hero":    dict(yaw=32.0,  elevation=24.0, lens=85.0,  fill=0.62, aim_z=0.0,  fstop=0.0),
    "front":   dict(yaw=0.0,   elevation=90.0, lens=100.0, fill=0.58, aim_z=0.0,  fstop=0.0),
    "side":    dict(yaw=0.0,   elevation=3.5,  lens=100.0, fill=0.72, aim_z=0.0,  fstop=0.0),
    "context": dict(yaw=-22.0, elevation=7.0,  lens=70.0,  fill=0.40, aim_z=35.0, fstop=2.8),
}

# =============================================================================
# 10. IN-CONTEXT SET (cafe table, window light, out-of-focus practicals)
# =============================================================================
CONTEXT = dict(
    table_size=(1600.0, 900.0), table_thickness=40.0,
    wood_light="#C49A6C", wood_dark="#86583A", wood_roughness=0.38, wood_grain_scale=40.0,
    wall_color="#4A3F37", wall_y=2400.0,
    window_light=dict(power=70.0, size=(1400, 1000), azimuth=-75.0, elevation=32.0,
                      distance=1800.0, kelvin=4800),
    hdri_strength=0.25,
    bokeh_count=16, bokeh_kelvin=2600, bokeh_strength=40.0, bokeh_radius=(5.0, 11.0),
    cup=True, phone=True,
)

MM = 0.001  # millimeters -> meters


# =============================================================================
# COMMAND-LINE OVERRIDES  (everything after "--")
# =============================================================================
def apply_cli_overrides():
    """Returns True if rendering is enabled."""
    global VARIANTS, COLORWAY, SHOTS, MAX_SAMPLES, RESOLUTION_PERCENT, EXPORT_STL, EXPORT_GLB
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="render_device.py")
    parser.add_argument("--variants", help="comma list: puck,card,stick")
    parser.add_argument("--colorway", choices=sorted(COLORWAYS))
    parser.add_argument("--shots", help="comma list: hero,front,side,context")
    parser.add_argument("--samples", type=int, help="max samples")
    parser.add_argument("--percent", type=int, help="resolution percentage")
    parser.add_argument("--no-export", action="store_true")
    parser.add_argument("--no-render", action="store_true")
    args = parser.parse_args(argv)

    def split(value, allowed, label):
        items = [v.strip() for v in value.split(",") if v.strip()]
        bad = [v for v in items if v not in allowed]
        if bad:
            parser.error(f"unknown {label}: {', '.join(bad)} (choose from {', '.join(allowed)})")
        return items

    if args.variants:
        VARIANTS = split(args.variants, list(VARIANT_BUILDERS), "variant")
    if args.shots:
        SHOTS = split(args.shots, list(SHOT_SETTINGS), "shot")
    if args.colorway:
        COLORWAY = args.colorway
    if args.samples:
        MAX_SAMPLES = args.samples
    if args.percent:
        RESOLUTION_PERCENT = args.percent
    if args.no_export:
        EXPORT_STL = EXPORT_GLB = False
    return not args.no_render


# =============================================================================
# GENERAL HELPERS
# =============================================================================
def reset_scene():
    """Start from an empty factory scene so the script is fully re-runnable."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "MILLIMETERS"
    return scene


def hex_color(value, alpha=1.0):
    """sRGB hex -> linear RGBA tuple for shader inputs."""
    value = value.lstrip("#")
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return tuple(lin(int(value[i:i + 2], 16) / 255.0) for i in (0, 2, 4)) + (alpha,)


def get_collection(name, parent=None):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(col)
    return col


def remove_collection(col):
    for obj in list(col.all_objects):
        data = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        if isinstance(data, bpy.types.Mesh) and data.users == 0:
            bpy.data.meshes.remove(data)
    for child in list(col.children):
        remove_collection(child)
    bpy.data.collections.remove(col)


def surface_frame(origin_mm, normal, up=(0.0, 0.0, 1.0)):
    """Matrix whose local +Z points out of a surface, local +Y follows `up`.
    Parts and cutters are modeled with z=0 on the surface and -Z into the body."""
    z = Vector(normal).normalized()
    y = Vector(up) - z * Vector(up).dot(z)
    if y.length < 1e-6:
        y = Vector((0.0, 1.0, 0.0))
    y.normalize()
    x = y.cross(z)
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = Vector(origin_mm) * MM
    return m


def rounded_rect(length, width, radius, seg=OUTLINE_SEGMENTS):
    """Closed counter-clockwise planform outline (mm).
    radius = width/2 gives a stadium; length = width = 2*radius gives a circle."""
    r = max(min(radius, length / 2.0, width / 2.0), 1e-3)
    cx, cy = length / 2.0 - r, width / 2.0 - r
    pts = []
    for qx, qy, start in ((cx, cy, 0.0), (-cx, cy, 90.0), (-cx, -cy, 180.0), (cx, -cy, 270.0)):
        for i in range(seg + 1):
            a = math.radians(start + 90.0 * i / seg)
            p = (qx + r * math.cos(a), qy + r * math.sin(a))
            if not pts or math.dist(p, pts[-1]) > 1e-6:
                pts.append(p)
    if math.dist(pts[0], pts[-1]) < 1e-6:
        pts.pop()
    return pts


def offset_outline(length, width, radius, d, seg=OUTLINE_SEGMENTS):
    """Outline grown (d > 0) or inset (d < 0) with concentric corners."""
    return rounded_rect(length + 2.0 * d, width + 2.0 * d, radius + d, seg)


def loft_rings(bm, rings, closed=False):
    """Skin equal-length vertex rings (meters). Open lofts get end caps; closed
    lofts wrap around into a ring-shaped solid."""
    vrings = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(vrings[0])
    pairs = list(zip(vrings, vrings[1:]))
    if closed:
        pairs.append((vrings[-1], vrings[0]))
    for a, b in pairs:
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if not closed:
        bm.faces.new(list(reversed(vrings[0])))
        bm.faces.new(vrings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return vrings


def object_from_bmesh(name, bm, col, matrix=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    col.objects.link(obj)
    if matrix is not None:
        obj.matrix_world = matrix
    return obj


# =============================================================================
# MOLDED PART + CUTTER BUILDERS
# =============================================================================
def slab_part(name, col, length, width, radius, z0, z1, fillet0, fillet1,
              crown=0.0, matrix=None, subsurf=SUBSURF_LEVELS):
    """Rounded molded slab: planform outline extruded from z0 to z1 (mm).
    fillet0/fillet1 set the bottom/top rim radius through bevel weights on a
    single Bevel modifier, followed by Subdivision Surface. Support loops keep
    flat faces flat. crown domes (or dishes, if negative) the top face."""
    h = z1 - z0
    small = min(length, width)
    f0 = min(fillet0, 0.45 * h, 0.3 * small)
    f1 = min(fillet1, 0.45 * h, 0.3 * small)
    sup = min(SUPPORT_LOOP, 0.12 * small, 0.2 * h)
    s0, s1 = f0 + sup, f1 + sup

    def ring(inset, z, scale=1.0):
        return [(x * scale * MM, y * scale * MM, z * MM)
                for x, y in offset_outline(length, width, radius, -inset)]

    rings = [ring(s0, z0)]
    rim0 = len(rings)
    rings.append(ring(0.0, z0))
    if h > s0 + s1 + 0.1:
        rings += [ring(0.0, z0 + s0), ring(0.0, z1 - s1)]
    rim1 = len(rings)
    rings.append(ring(0.0, z1))
    rings.append(ring(s1, z1))
    for t in (0.72, 0.45, 0.2):
        rings.append(ring(s1, z1 + crown * (1.0 - t * t), t))

    bm = bmesh.new()
    vrings = loft_rings(bm, rings)
    layer = (bm.edges.layers.float.get("bevel_weight_edge")
             or bm.edges.layers.float.new("bevel_weight_edge"))
    wmax = max(f0, f1, 1e-6)
    for idx, fillet in ((rim0, f0), (rim1, f1)):
        vr = vrings[idx]
        for i in range(len(vr)):
            bm.edges.get((vr[i], vr[(i + 1) % len(vr)]))[layer] = fillet / wmax
    obj = object_from_bmesh(name, bm, col, matrix)

    bevel = obj.modifiers.new("Fillets", "BEVEL")
    bevel.width = wmax * MM
    bevel.segments = BEVEL_SEGMENTS
    bevel.limit_method = "WEIGHT"
    bevel.edge_weight = "bevel_weight_edge"
    bevel.profile = BEVEL_PROFILE
    bevel.use_clamp_overlap = False
    sub = obj.modifiers.new("Subdivision", "SUBSURF")
    sub.levels = sub.render_levels = subsurf
    return obj


def _cutter(obj):
    obj.display_type = "WIRE"
    obj.hide_render = True
    return obj


def flared_prism(name, col, length, width, radius, depth, chamfer=EDGE_CHAMFER, matrix=None):
    """Boolean cutter for wells, ports and windows: a pocket `depth` deep below
    local z=0 whose mouth flares at 45 degrees, leaving a chamfer on the part."""
    extra = 1.0

    def ring(off, z):
        return [(x * MM, y * MM, z * MM) for x, y in offset_outline(length, width, radius, off)]

    bm = bmesh.new()
    loft_rings(bm, [ring(0.0, -depth), ring(0.0, -chamfer), ring(chamfer + extra, extra)])
    return _cutter(object_from_bmesh(name, bm, col, matrix))


def frame_prism(name, col, length, width, radius, wall, z_top, z_bottom,
                flare=0.0, matrix=None, cutter=False):
    """Ring-shaped solid between an outline and its inset by `wall` (mm).
    Used for groove cutters (with flare) and for inserts like light pipes."""
    extra = 0.6 if flare > 0 else 0.0

    def ring(off, z):
        return [(x * MM, y * MM, z * MM) for x, y in offset_outline(length, width, radius, off)]

    profile = [ring(0.0, z_bottom), ring(0.0, z_top - flare)]
    if flare > 0:
        profile += [ring(flare + extra, z_top + extra), ring(-wall - flare - extra, z_top + extra)]
    profile += [ring(-wall, z_top - flare), ring(-wall, z_bottom)]
    bm = bmesh.new()
    loft_rings(bm, profile, closed=True)
    obj = object_from_bmesh(name, bm, col, matrix)
    return _cutter(obj) if cutter else obj


def add_cuts(obj, cutter_col):
    mod = obj.modifiers.new("Cuts", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.operand_type = "COLLECTION"
    mod.collection = cutter_col
    mod.solver = "EXACT"
    return mod


def bake(obj, material=None):
    """Apply the modifier stack into real geometry, then shade smooth with sharp
    edges above SHARP_ANGLE_DEG so chamfers stay crisp and fillets stay soft."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), depsgraph=dg)
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    bm = bmesh.new()
    bm.from_mesh(me)
    limit = math.radians(SHARP_ANGLE_DEG)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        e.smooth = len(e.link_faces) == 2 and e.calc_face_angle(0.0) <= limit
    bm.to_mesh(me)
    bm.free()
    if material is not None:
        me.materials.clear()
        me.materials.append(material)
    return obj


def text_mesh(name, col, body, size_mm, tracking=1.0, align=("CENTER", "CENTER"), matrix=None):
    """Flat mesh lettering from Blender's built-in font."""
    curve = bpy.data.curves.new(name + "_text", "FONT")
    curve.body = body
    curve.size = size_mm * MM
    curve.space_character = tracking
    curve.align_x, curve.align_y = align
    tmp = bpy.data.objects.new(name + "_text", curve)
    col.objects.link(tmp)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg), depsgraph=dg)
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.curves.remove(curve)
    me.name = name
    obj = bpy.data.objects.new(name, me)
    col.objects.link(obj)
    if matrix is not None:
        obj.matrix_world = matrix
    return obj


def wrap_decal(obj, target, material):
    """Pad-print style decal: densify flat lettering, project it onto the
    target surface along its local Z, and float it DECAL_OFFSET above."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges, cuts=2, use_grid_fill=True)
    bm.to_mesh(obj.data)
    bm.free()
    wrap = obj.modifiers.new("Wrap", "SHRINKWRAP")
    wrap.target = target
    wrap.wrap_method = "PROJECT"
    wrap.use_project_z = True
    wrap.use_negative_direction = True
    wrap.use_positive_direction = True
    wrap.offset = DECAL_OFFSET * MM
    obj["export_stl"] = False   # zero-thickness ink: keep it out of printable STL
    return bake(obj, material)


# =============================================================================
# MATERIALS
# =============================================================================
def principled(name, inputs):
    """Material whose Principled BSDF inputs are set by socket name."""
    mat = bpy.data.materials.new(name)
    if mat.node_tree is None:            # pre-5.0 Blender
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    for key, value in inputs.items():
        bsdf.inputs[key].default_value = value
    return mat, nt, bsdf


def emission_material(name, kelvin, strength):
    mat = bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    for node in [n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"]:
        nt.nodes.remove(node)
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    emit = nt.nodes.new("ShaderNodeEmission")
    body = nt.nodes.new("ShaderNodeBlackbody")
    body.inputs["Temperature"].default_value = kelvin
    emit.inputs["Strength"].default_value = strength
    nt.links.new(body.outputs["Color"], emit.inputs["Color"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


def add_mold_texture(nt, bsdf, scale, strength):
    """Fine noise bump in object space: the stippled mold texture that makes a
    molded part read as plastic instead of perfect CG."""
    coord = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 3.0
    noise.inputs["Roughness"].default_value = 0.55
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = 0.00002
    nt.links.new(coord.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])


def build_materials(colorway):
    c = COLORWAYS[colorway]
    m = {}
    mat, nt, bsdf = principled("shell_soft_touch", {
        "Base Color": hex_color(c["shell"]),
        "Roughness": c["shell_roughness"],
        "Specular IOR Level": SOFT_TOUCH["specular"],
        "Sheen Weight": SOFT_TOUCH["sheen"],
        "Sheen Roughness": SOFT_TOUCH["sheen_roughness"],
    })
    add_mold_texture(nt, bsdf, SOFT_TOUCH["texture_scale"], SOFT_TOUCH["texture_strength"])
    m["shell"] = mat
    m["button"] = principled("button_gloss", {
        "Base Color": hex_color(c["button"]),
        "Roughness": BUTTON_GLOSS["roughness"],
        "Coat Weight": BUTTON_GLOSS["coat"],
        "Coat Roughness": BUTTON_GLOSS["coat_roughness"],
    })[0]
    m["hinge"] = principled("hinge_satin", {"Base Color": hex_color(c["button"]), "Roughness": 0.4})[0]
    m["led_on"] = principled("led_lit", {
        "Base Color": (0.02, 0.02, 0.02, 1.0), "Roughness": 0.15, "Coat Weight": 0.6,
        "Emission Color": hex_color(c["led"]), "Emission Strength": LED_STRENGTH,
    })[0]
    m["led_off"] = principled("led_unlit", {
        "Base Color": (0.015, 0.015, 0.017, 1.0), "Roughness": 0.12, "Coat Weight": 0.6,
    })[0]
    m["ink"] = principled("pad_print_ink", {
        "Base Color": hex_color(c["ink"]), "Roughness": 0.42, "Specular IOR Level": 0.4,
    })[0]
    m["metal"] = principled("receptacle_steel", {
        "Base Color": (0.72, 0.72, 0.74, 1.0), "Metallic": 1.0, "Roughness": 0.3,
    })[0]
    m["port_black"] = principled("port_plastic", {"Base Color": (0.012, 0.012, 0.013, 1.0), "Roughness": 0.45})[0]
    m["display"] = principled("display_glass", {
        "Base Color": (0.004, 0.004, 0.005, 1.0), "Roughness": 0.35,
        "Coat Weight": 1.0, "Coat Roughness": 0.08, "Coat IOR": 1.5,
    })[0]
    m["screen_ui"] = principled("screen_ui", {
        "Base Color": (0.0, 0.0, 0.0, 1.0),
        "Emission Color": hex_color(c["screen_ui"]), "Emission Strength": SCREEN_UI_STRENGTH,
    })[0]
    m["screen_accent"] = principled("screen_accent", {
        "Base Color": (0.0, 0.0, 0.0, 1.0),
        "Emission Color": hex_color(c["led"]), "Emission Strength": SCREEN_UI_STRENGTH,
    })[0]
    m["backdrop"] = principled("backdrop_paper", {
        "Base Color": hex_color(c["backdrop"]), "Roughness": 0.9, "Specular IOR Level": 0.25,
    })[0]

    # --- in-context set ------------------------------------------------------
    mat, nt, bsdf = principled("tabletop_wood", {
        "Roughness": CONTEXT["wood_roughness"], "Specular IOR Level": 0.45,
    })
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (0.08, 1.0, 1.0)   # stretch grain along X
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.bands_direction = "Y"
    wave.inputs["Scale"].default_value = CONTEXT["wood_grain_scale"]
    wave.inputs["Distortion"].default_value = 12.0
    wave.inputs["Detail"].default_value = 4.0
    wave.inputs["Detail Scale"].default_value = 25.0
    grain = nt.nodes.new("ShaderNodeTexNoise")
    grain.inputs["Scale"].default_value = 150.0
    grain.inputs["Detail"].default_value = 6.0
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "FLOAT"
    mix.inputs[0].default_value = 0.4
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = hex_color(CONTEXT["wood_dark"])
    ramp.color_ramp.elements[1].color = hex_color(CONTEXT["wood_light"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.12
    bump.inputs["Distance"].default_value = 0.0002
    nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], wave.inputs["Vector"])
    nt.links.new(coord.outputs["Object"], grain.inputs["Vector"])
    nt.links.new(wave.outputs["Fac"], mix.inputs[2])
    nt.links.new(grain.outputs["Fac"], mix.inputs[3])
    nt.links.new(mix.outputs[0], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(wave.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    m["wood"] = mat
    m["wall"] = principled("cafe_wall", {"Base Color": hex_color(CONTEXT["wall_color"]), "Roughness": 0.95})[0]
    m["ceramic"] = principled("ceramic_glaze", {
        "Base Color": hex_color("#ECE7DF"), "Roughness": 0.12, "Coat Weight": 0.5,
    })[0]
    m["phone_body"] = principled("phone_aluminum", {
        "Base Color": (0.05, 0.05, 0.055, 1.0), "Metallic": 1.0, "Roughness": 0.35,
    })[0]
    m["phone_glass"] = principled("phone_glass", {
        "Base Color": (0.003, 0.003, 0.004, 1.0), "Roughness": 0.03, "Coat Weight": 1.0,
    })[0]
    m["bokeh"] = emission_material("practical_bulb", CONTEXT["bokeh_kelvin"], CONTEXT["bokeh_strength"])
    return m


# =============================================================================
# DEVICE COMPONENTS (shared by every variant)
# =============================================================================
class Device:
    """Parts of one variant while it is being built."""

    def __init__(self, name, mats):
        self.name = name
        self.mats = mats
        self.col = get_collection(f"device_{name}")
        self.cutters = get_collection(f"cutters_{name}")
        self.top_cuts = get_collection(f"cuts_top_{name}", self.cutters)
        self.bottom_cuts = get_collection(f"cuts_bottom_{name}", self.cutters)
        self.root = bpy.data.objects.new(f"{name}_root", None)
        self.col.objects.link(self.root)
        self.parts = []            # (object, material) pairs, baked in finish()
        self.decals = []           # (object, target) pairs, wrapped after baking
        self.size = (0.0, 0.0, 0.0)
        self.focus = Vector((0.0, 0.0, 0.0))   # mm; context-shot focus point
        self.top = self.bottom = None

    def add(self, obj, material_key):
        self.parts.append((obj, self.mats[material_key]))
        return obj

    def housings(self, length, width, radius, thickness, top_fillet, bottom_fillet, crown, parting_z):
        """Top and bottom housings meeting at a chamfered parting line."""
        zb = parting_z - PARTING_GAP / 2.0
        zt = parting_z + PARTING_GAP / 2.0
        self.bottom = slab_part(f"{self.name}_housing_bottom", self.col, length, width, radius,
                                0.0, zb, bottom_fillet, PARTING_CHAMFER)
        self.top = slab_part(f"{self.name}_housing_top", self.col, length, width, radius,
                             zt, thickness, PARTING_CHAMFER, top_fillet, crown=crown)
        self.add(self.bottom, "shell")
        self.add(self.top, "shell")
        self.size = (length, width, thickness)

    def finish(self):
        # Booleans go on last so ray casts during layout hit the uncut housings.
        add_cuts(self.top, self.top_cuts)
        add_cuts(self.bottom, self.bottom_cuts)
        for obj, mat in self.parts:
            bake(obj, mat)
        for obj, target in self.decals:
            wrap_decal(obj, target, self.mats["ink"])
        remove_collection(self.cutters)
        for obj in list(self.col.objects):
            if obj is not self.root and obj.parent is None:
                obj.parent = self.root
        return self


def hit(obj, origin_mm, direction):
    """Ray-cast the evaluated (subdivided) part; returns (point_mm, normal)."""
    dg = bpy.context.evaluated_depsgraph_get()
    ok, loc, normal, _ = obj.ray_cast(Vector(origin_mm) * MM, Vector(direction).normalized(), depsgraph=dg)
    if not ok:
        raise RuntimeError(f"ray from {origin_mm} missed {obj.name}")
    return loc / MM, normal


def top_frame(dev, x, y):
    point, _ = hit(dev.top, (x, y, 500.0), (0.0, 0.0, -1.0))
    return surface_frame(point, (0.0, 0.0, 1.0), up=(0.0, 1.0, 0.0)), point


def side_frame(part, origin_mm, direction):
    """Frame on a side wall, reached by a horizontal ray; local +Y stays vertical."""
    point, normal = hit(part, origin_mm, direction)
    flat = Vector((normal.x, normal.y, 0.0))
    return surface_frame(point, flat if flat.length > 1e-6 else -Vector(direction), up=(0.0, 0.0, 1.0)), point


def button(dev, frame, cuts, length, width, radius, top_z, dish=0.0):
    """Chamfered well plus a glossy cap with clearance all round."""
    c = BUTTON_CLEARANCE
    flared_prism(f"{dev.name}_well", cuts, length + 2 * c, width + 2 * c, radius + c, WELL_DEPTH, EDGE_CHAMFER, frame)
    cap = slab_part(f"{dev.name}_button", dev.col, length, width, radius,
                    -WELL_DEPTH + 0.2, top_z, 0.15, min(0.6, 0.25 * min(length, width)),
                    crown=dish, matrix=frame)
    return dev.add(cap, "button")


def led_lens(dev, frame, cuts, diameter, lit):
    flared_prism(f"{dev.name}_led_hole", cuts, diameter, diameter, diameter / 2.0, 1.0, 0.2, frame)
    d = diameter - 0.2
    lens = slab_part(f"{dev.name}_led", dev.col, d, d, d / 2.0, -0.9, -0.12, 0.05, 0.15,
                     crown=0.08, matrix=frame, subsurf=2)
    return dev.add(lens, "led_on" if lit else "led_off")


def usb_c(dev, frame, cuts):
    """Chamfered opening, steel receptacle shell, tongue and dark back plate."""
    ow, oh = USBC_OPENING
    sw, sh, wall = USBC_SHELL
    back = -PORT_DEPTH + 0.3
    flared_prism(f"{dev.name}_usbc_opening", cuts, ow, oh, oh / 2.0, PORT_DEPTH, EDGE_CHAMFER, frame)
    dev.add(frame_prism(f"{dev.name}_usbc_shell", dev.col, sw, sh, sh / 2.0, wall,
                        -USBC_SETBACK, back, matrix=frame), "metal")
    dev.add(slab_part(f"{dev.name}_usbc_tongue", dev.col, 6.6, 0.7, 0.3, back, -USBC_SETBACK - 1.2,
                      0.05, 0.15, matrix=frame, subsurf=1), "port_black")
    iw, ih = sw - 2 * wall, sh - 2 * wall
    dev.add(slab_part(f"{dev.name}_usbc_back", dev.col, iw, ih, ih / 2.0, back, back + 0.3,
                      0.05, 0.05, matrix=frame, subsurf=1), "port_black")


def pinhole(dev, frame, cuts, diameter, depth=2.0):
    flared_prism(f"{dev.name}_pinhole", cuts, diameter, diameter, diameter / 2.0, depth, 0.15, frame)


def wordmark(dev, x, y, size):
    if not WORDMARK_TEXT:
        return
    _, point = top_frame(dev, x, y)
    m = Matrix.Translation(Vector((x, y, point.z + 0.6)) * MM)
    obj = text_mesh(f"{dev.name}_wordmark", dev.col, WORDMARK_TEXT, size, tracking=1.3, matrix=m)
    dev.decals.append((obj, dev.top))


# =============================================================================
# VARIANTS
# =============================================================================
def flat_rect(name, col, w, h, matrix):
    bm = bmesh.new()
    verts = [bm.verts.new((x * MM, y * MM, 0.0))
             for x, y in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]
    bm.faces.new(verts)
    return object_from_bmesh(name, bm, col, matrix)


def screen_graphics(dev, frame, sw, sh, z):
    """Emissive status UI on the display panel, under the cover glass."""
    def at(x, y):
        return frame @ Matrix.Translation(Vector((x, y, z)) * MM)

    def ui(obj, key):
        obj["export_stl"] = False
        dev.add(obj, key)

    base = sh / 2 - 4.2
    for i in range(4):
        h = 0.9 + 0.6 * i
        ui(flat_rect(f"card_ui_bar{i}", dev.col, 0.9, h, at(-sw / 2 + 3.6 + i * 1.4, base + h / 2)), "screen_ui")
    ui(text_mesh("card_ui_lte", dev.col, "LTE", 1.9, matrix=at(sw / 2 - 4.6, sh / 2 - 3.0)), "screen_ui")
    ui(text_mesh("card_ui_guests", dev.col, "3 guests", 3.6, matrix=at(0.0, 0.2)), "screen_ui")
    ui(flat_rect("card_ui_meter", dev.col, 13.0, 0.45, at(-4.5, -sh / 2 + 5.4)), "screen_accent")
    ui(text_mesh("card_ui_data", dev.col, "1.2 GB shared", 1.8, matrix=at(0.0, -sh / 2 + 3.2)), "screen_ui")


def build_puck(mats):
    p = PUCK
    dev = Device("puck", mats)
    d, t = p["diameter"], p["thickness"]
    dev.housings(d, d, d / 2.0, t, p["top_fillet"], p["bottom_fillet"], p["crown"], p["parting_z"])

    # concave thumb button in a chamfered well, ringed by an LED light pipe
    frame, point = top_frame(dev, 0.0, 0.0)
    bd = p["button_diameter"]
    button(dev, frame, dev.top_cuts, bd, bd, bd / 2.0, -BUTTON_RECESS, dish=p["button_dish"])
    ri, rw = p["led_ring_inner"], p["led_ring_width"]
    outer = 2.0 * (ri + rw)
    ring_frame, ring_point = top_frame(dev, 0.0, -(ri + rw / 2.0))
    ring_frame.translation.y = 0.0
    frame_prism("puck_led_groove", dev.top_cuts, outer, outer, outer / 2.0, rw, 0.0, -1.2,
                flare=0.2, matrix=ring_frame, cutter=True)
    pipe = outer - 0.3
    dev.add(frame_prism("puck_light_pipe", dev.col, pipe, pipe, pipe / 2.0, rw - 0.3, -0.12, -1.1,
                        matrix=ring_frame), "led_on")
    dev.focus = Vector((0.0, -(ri + rw), ring_point.z))

    # USB-C and reset pinhole on the camera-facing (-Y) wall of the bottom housing
    frame, _ = side_frame(dev.bottom, (0.0, -200.0, p["usbc_z"]), (0.0, 1.0, 0.0))
    usb_c(dev, frame, dev.bottom_cuts)
    frame, _ = side_frame(dev.bottom, (p["pinhole_offset"], -200.0, p["usbc_z"]), (0.0, 1.0, 0.0))
    pinhole(dev, frame, dev.bottom_cuts, p["pinhole_diameter"])
    wordmark(dev, 0.0, p["wordmark_y"], p["wordmark_size"])
    return dev.finish()


def build_card(mats):
    p = CARD
    dev = Device("card", mats)
    length, width, t = p["length"], p["width"], p["thickness"]
    dev.housings(length, width, p["corner_radius"], t, p["top_fillet"], p["bottom_fillet"],
                 p["crown"], p["parting_z"])

    # recessed display: chamfered window, black panel, emissive UI, cover glass
    sx, sy = p["screen_center"]
    sw, sh = p["screen_size"]
    sr = p["screen_corner"]
    frame, _ = top_frame(dev, sx, sy)
    flared_prism("card_screen_window", dev.top_cuts, sw, sh, sr, 1.2, EDGE_CHAMFER, frame)
    # glass-fronted panel (clear-coated black) set just below the window chamfer
    dev.add(slab_part("card_display", dev.col, sw - 0.4, sh - 0.4, sr - 0.2, -1.1, -0.35, 0.05, 0.12,
                      matrix=frame, subsurf=2), "display")
    screen_graphics(dev, frame, sw, sh, z=-0.335)

    # share button and status LEDs
    bx, by = p["top_button_center"]
    bd = p["top_button_diameter"]
    frame, point = top_frame(dev, bx, by)
    button(dev, frame, dev.top_cuts, bd, bd, bd / 2.0, -BUTTON_RECESS, dish=-0.2)
    dev.focus = Vector((bx, by - bd / 2.0, point.z))
    lx, ly = p["led_center"]
    for i in range(p["led_count"]):
        x = lx + (i - (p["led_count"] - 1) / 2.0) * p["led_pitch"]
        frame, _ = top_frame(dev, x, ly)
        led_lens(dev, frame, dev.top_cuts, p["led_diameter"], lit=i < p["leds_lit"])

    # power button on the front (-Y) wall, USB-C on the left (-X) end
    bw, bh = p["side_button_size"]
    frame, _ = side_frame(dev.bottom, (p["side_button_x"], -200.0, p["side_z"]), (0.0, 1.0, 0.0))
    button(dev, frame, dev.bottom_cuts, bw, bh, bh / 2.0, SIDE_BUTTON_PROUD)
    frame, _ = side_frame(dev.bottom, (-200.0, 0.0, p["side_z"]), (1.0, 0.0, 0.0))
    usb_c(dev, frame, dev.bottom_cuts)

    # SIM tray parting outline and eject hole on the back (+Y) wall
    tw, th = p["sim_tray_size"]
    frame, _ = side_frame(dev.bottom, (p["sim_tray_x"], 200.0, p["side_z"]), (0.0, -1.0, 0.0))
    frame_prism("card_sim_groove", dev.bottom_cuts, tw, th, 0.8, 0.3, 0.0, -0.8,
                flare=0.1, matrix=frame, cutter=True)
    pinhole(dev, frame @ Matrix.Translation(Vector((tw / 2.0 - 2.2, 0.0, 0.0)) * MM), dev.bottom_cuts, 0.9)
    wordmark(dev, *p["wordmark_center"], p["wordmark_size"])
    return dev.finish()


def build_stick(mats):
    p = STICK
    dev = Device("stick", mats)
    length, width, t = p["length"], p["width"], p["thickness"]
    dev.housings(length, width, width / 2.0, t, p["top_fillet"], p["bottom_fillet"], p["crown"], p["parting_z"])

    # antenna bay and fold-out paddle hinged at its +X end
    al, aw, at_ = p["antenna_length"], p["antenna_width"], p["antenna_thickness"]
    ax = p["antenna_bay_x"]
    frame, point = top_frame(dev, ax, 0.0)
    flared_prism("stick_antenna_bay", dev.top_cuts, al + 1.0, aw + 1.0, aw / 2.0 + 0.5, at_ + 0.5,
                 EDGE_CHAMFER, frame)
    floor = point.z - (at_ + 0.5)
    paddle = slab_part("stick_antenna", dev.col, al, aw, aw / 2.0, 0.0, at_, 1.2, 2.0, crown=0.3)
    pivot_mm = Vector((ax + al / 2.0 - aw / 2.0, 0.0, floor + 0.25 + at_ / 2.0))
    pivot = pivot_mm * MM
    swing = (Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(p["antenna_open_deg"]), 4, "Y")
             @ Matrix.Translation(-pivot))
    paddle.matrix_world = swing @ Matrix.Translation(Vector((ax, 0.0, floor + 0.25)) * MM)
    dev.add(paddle, "shell")
    hinge = slab_part("stick_hinge", dev.col, at_ * 0.9, at_ * 0.9, at_ * 0.45, -aw / 2.0 - 0.2, aw / 2.0 + 0.2,
                      0.3, 0.3, matrix=surface_frame(pivot_mm, (0.0, 1.0, 0.0), up=(0.0, 0.0, 1.0)), subsurf=2)
    dev.add(hinge, "hinge")

    # LED light bar and button
    bx, by = p["led_bar_center"]
    lw, lh = p["led_bar_size"]
    frame, _ = top_frame(dev, bx, by)
    flared_prism("stick_led_slot", dev.top_cuts, lw, lh, lh / 2.0, 1.2, 0.2, frame)
    dev.add(slab_part("stick_light_bar", dev.col, lw - 0.5, lh - 0.5, (lh - 0.5) / 2.0, -1.1, -0.15,
                      0.05, 0.15, matrix=frame, subsurf=2), "led_on")
    cx, cy = p["button_center"]
    bw, bh = p["button_size"]
    frame, point = top_frame(dev, cx, cy)
    button(dev, frame, dev.top_cuts, bw, bh, 2.0, -BUTTON_RECESS, dish=-0.15)
    dev.focus = Vector((cx, cy - bh / 2.0, point.z))

    # USB-C on the rounded left (-X) end
    frame, _ = side_frame(dev.bottom, (-200.0, 0.0, p["usbc_z"]), (1.0, 0.0, 0.0))
    usb_c(dev, frame, dev.bottom_cuts)
    wordmark(dev, *p["wordmark_center"], p["wordmark_size"])
    return dev.finish()


VARIANT_BUILDERS = {"puck": build_puck, "card": build_card, "stick": build_stick}


# =============================================================================
# STUDIO + IN-CONTEXT SETS
# =============================================================================
def spherical(azimuth, elevation, distance_mm, target):
    az, el = math.radians(azimuth), math.radians(elevation)
    d = distance_mm * MM
    return target + Vector((math.sin(az) * math.cos(el) * d, -math.cos(az) * math.cos(el) * d, math.sin(el) * d))


def aim(obj, target):
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def area_light(name, col, spec, target):
    data = bpy.data.lights.new(name, "AREA")
    data.shape = "RECTANGLE"
    data.size, data.size_y = spec["size"][0] * MM, spec["size"][1] * MM
    data.energy = spec["power"]
    data.use_temperature = True
    data.temperature = spec["kelvin"]
    obj = bpy.data.objects.new(name, data)
    col.objects.link(obj)
    obj.location = spherical(spec["azimuth"], spec["elevation"], spec["distance"], target)
    aim(obj, target)
    obj.visible_camera = False
    return obj


def setup_world(scene):
    world = bpy.data.worlds.new("studio_world")
    scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    nt = world.node_tree
    out = next((n for n in nt.nodes if n.type == "OUTPUT_WORLD"), None) or nt.nodes.new("ShaderNodeOutputWorld")
    bg = next((n for n in nt.nodes if n.type == "BACKGROUND"), None) or nt.nodes.new("ShaderNodeBackground")
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    path = HDRI_PATH or os.path.join(bpy.utils.system_resource("DATAFILES", path="studiolights/world"), "studio.exr")
    if os.path.isfile(path):
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(path, check_existing=True)
        coord = nt.nodes.new("ShaderNodeTexCoord")
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Rotation"].default_value[2] = math.radians(HDRI_ROTATION_DEG)
        nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
        nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
        nt.links.new(env.outputs["Color"], bg.inputs["Color"])
        print(f"[studio] HDRI: {path}")
    else:
        bg.inputs["Color"].default_value = (0.8, 0.8, 0.8, 1.0)
        print(f"[studio] HDRI not found ({path}); using a neutral gray environment")
    return bg


def build_studio(mats):
    col = get_collection("studio_set")
    b = BACKDROP
    radius, wall_y = b["cove_radius"], b["wall_y"]
    profile = [(-b["front"], 0.0), (wall_y - radius, 0.0)]
    for i in range(1, 25):
        a = math.radians(90.0 * i / 24)
        profile.append((wall_y - radius + radius * math.sin(a), radius - radius * math.cos(a)))
    profile.append((wall_y, b["height"]))
    bm = bmesh.new()
    columns = [[bm.verts.new((x * MM, y * MM, z * MM)) for y, z in profile]
               for x in (-b["width"] / 2.0, 0.0, b["width"] / 2.0)]
    for a, c in zip(columns, columns[1:]):
        for i in range(len(profile) - 1):
            bm.faces.new((a[i], c[i], c[i + 1], a[i + 1])).smooth = True
    sweep = object_from_bmesh("backdrop_sweep", bm, col)
    sweep.data.materials.append(mats["backdrop"])
    target = Vector((0.0, 0.0, 0.01))
    area_light("key_light", col, KEY_LIGHT, target)
    area_light("rim_light", col, RIM_LIGHT, target)
    return col


def build_context_set(mats):
    col = get_collection("context_set")
    cuts = get_collection("context_cuts")
    c = CONTEXT
    tl, tw = c["table_size"]
    table = slab_part("tabletop", col, tl, tw, 6.0, -c["table_thickness"], 0.0, 2.0, 2.0, subsurf=1,
                      matrix=Matrix.Translation(Vector((0.0, 150.0, 0.0)) * MM))
    bake(table, mats["wood"])
    wall = flat_rect("back_wall", col, 7000.0, 3000.0,
                     surface_frame((0.0, c["wall_y"], 900.0), (0.0, -1.0, 0.0), up=(0.0, 0.0, 1.0)))
    wall.data.materials.append(mats["wall"])
    if c["cup"]:
        at_cup = Matrix.Translation(Vector((-150.0, 190.0, 0.0)) * MM)
        cup = slab_part("cup", col, 82.0, 82.0, 41.0, 0.0, 92.0, 3.0, 1.5, subsurf=2, matrix=at_cup)
        flared_prism("cup_cavity", cuts, 74.0, 74.0, 37.0, 84.0, 1.0,
                     matrix=Matrix.Translation(Vector((-150.0, 190.0, 92.0)) * MM))
        add_cuts(cup, cuts)
        bake(cup, mats["ceramic"])
    if c["phone"]:
        at_phone = Matrix.Translation(Vector((150.0, 150.0, 0.0)) * MM) @ Matrix.Rotation(math.radians(24.0), 4, "Z")
        bake(slab_part("phone", col, 147.0, 71.5, 9.5, 0.0, 7.8, 1.6, 1.6, matrix=at_phone), mats["phone_body"])
        bake(slab_part("phone_screen", col, 143.0, 67.5, 8.0, 7.8, 8.1, 0.05, 0.3, matrix=at_phone, subsurf=2),
             mats["phone_glass"])
    remove_collection(cuts)
    rng = random.Random(7)
    for i in range(c["bokeh_count"]):
        r = rng.uniform(*c["bokeh_radius"])
        pos = Vector((rng.uniform(-900.0, 900.0), rng.uniform(1500.0, c["wall_y"] - 150.0), rng.uniform(120.0, 480.0)))
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=r * MM)
        bulb = object_from_bmesh(f"practical_{i:02d}", bm, col, Matrix.Translation(pos * MM))
        bulb.data.materials.append(mats["bokeh"])
    area_light("window_light", col, c["window_light"], Vector((0.0, 0.0, 0.01)))
    return col


# =============================================================================
# RENDER, CAMERAS, EXPORT
# =============================================================================
def setup_render(scene):
    scene.render.engine = "CYCLES"
    cy = scene.cycles
    label = "CPU"
    if USE_GPU:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for backend in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                prefs.compute_device_type = backend
            except (TypeError, ValueError):
                continue
            prefs.refresh_devices()
            gpus = [d for d in prefs.devices if d.type == backend]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == backend
                cy.device = "GPU"
                label = f"{backend}: {', '.join(d.name for d in gpus)}"
                break
    cy.samples = MAX_SAMPLES
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = NOISE_THRESHOLD
    cy.adaptive_min_samples = MIN_SAMPLES
    cy.use_denoising = DENOISE
    if DENOISE:
        cy.denoiser = "OPENIMAGEDENOISE"
        cy.denoising_input_passes = "RGB_ALBEDO_NORMAL"
        cy.denoising_prefilter = "ACCURATE"
        cy.denoising_use_gpu = cy.device == "GPU"
    cy.sample_clamp_indirect = CLAMP_INDIRECT
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    scene.render.use_persistent_data = True       # reuse BVH/kernels between shots
    scene.render.resolution_x = RESOLUTION_X
    scene.render.resolution_y = RESOLUTION_Y
    scene.render.resolution_percentage = RESOLUTION_PERCENT
    img = scene.render.image_settings
    if hasattr(img, "media_type"):
        img.media_type = "IMAGE"
    img.file_format = "PNG"
    img.color_mode = "RGB"
    img.color_depth = "8"
    img.compression = 15
    try:
        scene.view_settings.view_transform = VIEW_TRANSFORM
        scene.view_settings.look = LOOK
    except TypeError as err:
        print(f"[render] color management fallback: {err}")
    scene.view_settings.exposure = EXPOSURE
    return label


def make_camera(scene):
    data = bpy.data.cameras.new("shot_camera")
    data.sensor_fit = "HORIZONTAL"
    data.sensor_width = SENSOR_WIDTH
    data.clip_start = 0.005
    data.clip_end = 50.0
    cam = bpy.data.objects.new("shot_camera", data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def configure_shot(cam, dev, shot, sets, world_bg):
    s = SHOT_SETTINGS[shot]
    in_context = shot == "context"
    # Snapshot the lists: changing visibility rebuilds Collection.all_objects mid-loop.
    for obj in list(sets["studio"].all_objects):
        obj.hide_render = in_context
    for obj in list(sets["context"].all_objects):
        obj.hide_render = not in_context
    world_bg.inputs["Strength"].default_value = CONTEXT["hdri_strength"] if in_context else HDRI_STRENGTH

    yaw = math.radians(s["yaw"])
    dev.root.rotation_euler = (0.0, 0.0, yaw)
    length, width, height = dev.size
    if length == width:                       # round planform: yaw doesn't change the footprint
        extent = length
    else:
        extent = length * abs(math.cos(yaw)) + width * abs(math.sin(yaw))
    distance = (extent / s["fill"]) / 2.0 / ((SENSOR_WIDTH / 2.0) / s["lens"])
    target = Vector((0.0, 0.0, height / 2.0 + s["aim_z"])) * MM
    cam.data.lens = s["lens"]
    if s["elevation"] >= 89.9:
        cam.location = Vector((0.0, 0.0, (height + distance) * MM))
        cam.rotation_euler = (0.0, 0.0, 0.0)
    else:
        cam.location = spherical(0.0, s["elevation"], distance, target)
        aim(cam, target)
    bpy.context.view_layer.update()

    dof = cam.data.dof
    dof.use_dof = s["fstop"] > 0
    if dof.use_dof:
        focus = dev.root.matrix_world @ (dev.focus * MM)
        forward = cam.rotation_euler.to_quaternion() @ Vector((0.0, 0.0, -1.0))
        dof.focus_distance = (focus - cam.location).dot(forward)
        dof.aperture_fstop = s["fstop"]


def export_device(dev, colorway):
    base = os.path.join(os.path.abspath(EXPORT_DIR), f"{dev.name}_{colorway}")
    dev.root.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    meshes = [o for o in dev.col.all_objects if o.type == "MESH"]
    written = []
    if EXPORT_STL:
        for o in list(bpy.context.view_layer.objects):
            o.select_set(o in meshes and o.get("export_stl", True))
        bpy.ops.wm.stl_export(filepath=base + ".stl", export_selected_objects=True,
                              global_scale=STL_SCALE, apply_modifiers=True, ascii_format=False)
        written.append(base + ".stl")
    if EXPORT_GLB:
        for o in list(bpy.context.view_layer.objects):
            o.select_set(o in meshes)
        bpy.ops.export_scene.gltf(filepath=base + ".glb", export_format="GLB", use_selection=True,
                                  export_apply=True, export_yup=True,
                                  export_cameras=False, export_lights=False)
        written.append(base + ".glb")
    for o in list(bpy.context.view_layer.objects):
        o.select_set(False)
    for path in written:
        print(f"[export] {path}", flush=True)


def main():
    render_enabled = apply_cli_overrides()
    wall_start = time.perf_counter()
    scene = reset_scene()
    device_label = setup_render(scene)
    os.makedirs(os.path.abspath(RENDER_DIR), exist_ok=True)
    os.makedirs(os.path.abspath(EXPORT_DIR), exist_ok=True)

    mats = build_materials(COLORWAY)
    world_bg = setup_world(scene)
    sets = {
        "studio": build_studio(mats),
        "context": build_context_set(mats) if "context" in SHOTS else get_collection("context_set"),
    }
    cam = make_camera(scene)
    width = RESOLUTION_X * RESOLUTION_PERCENT // 100
    height = RESOLUTION_Y * RESOLUTION_PERCENT // 100
    print(f"[setup] Blender {bpy.app.version_string} | Cycles on {device_label} | {width}x{height} | "
          f"<= {MAX_SAMPLES} spp adaptive @ {NOISE_THRESHOLD} | denoise={DENOISE} | colorway={COLORWAY}",
          flush=True)

    timings = []
    for name in VARIANTS:
        t0 = time.perf_counter()
        dev = VARIANT_BUILDERS[name](mats)
        faces = sum(len(o.data.polygons) for o in dev.col.all_objects if o.type == "MESH")
        parts = sum(1 for o in dev.col.all_objects if o.type == "MESH")
        print(f"[model] {name}: {parts} parts, {faces:,} faces, built in {time.perf_counter() - t0:.1f} s",
              flush=True)
        if EXPORT_STL or EXPORT_GLB:
            export_device(dev, COLORWAY)
        if render_enabled:
            for shot in SHOTS:
                configure_shot(cam, dev, shot, sets, world_bg)
                path = os.path.join(os.path.abspath(RENDER_DIR), f"{name}_{COLORWAY}_{shot}.png")
                scene.render.filepath = path
                t_frame = time.perf_counter()
                bpy.ops.render.render(write_still=True)
                dt = time.perf_counter() - t_frame
                timings.append((name, shot, dt))
                print(f"[render] {name:<5} {shot:<7} {dt:7.1f} s  -> {path}", flush=True)
        remove_collection(dev.col)

    if timings:
        total = sum(t for *_, t in timings)
        print("\n[timing] per frame (the first frame includes GPU kernel/shader setup):")
        for name, shot, dt in timings:
            print(f"           {name:<5} {shot:<7} {dt:7.1f} s")
        print(f"[timing] {len(timings)} frames, {total:.1f} s rendering, "
              f"{total / len(timings):.1f} s average per frame")
    print(f"[done] wall time {time.perf_counter() - wall_start:.1f} s", flush=True)


if __name__ == "__main__":
    main()
