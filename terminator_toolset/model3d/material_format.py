"""Read/write/validate for game `.material` files (JSON, see Docs/material_format.md).

Pure Python, no bpy. Unknown keys/values are preserved as-is so an untouched
material round-trips byte-identical (indent=4, no trailing newline, original
line endings kept — 10 shipped files use CRLF; one texture is a .png).
"""
import json

SHADERS = {
    "StandardMaterial",
    "FrameMaterial",
    "TrailMaterial",
    "GlobalMapRoadMaterial",
    "OutlineMaterial",
    "HighlightMaterial",
}
RASTERIZER_STATES = {"CullClockwise", "CullNone"}
TEXTURE_EXTENSIONS = (".dds", ".png")
KNOWN_TEXTURE_SLOTS = {"albedo", "normal", "rough", "emission", "fill", "image", "alpha"}


class MaterialError(Exception):
    pass


class MaterialDef:
    """Thin typed view over the raw `.material` dict; owns the data."""

    def __init__(self, data, newline="\n"):
        if not isinstance(data, dict):
            raise MaterialError("material root must be a JSON object, got %s"
                                % type(data).__name__)
        self.data = data
        self.newline = newline  # original line ending, restored on write

    @property
    def shader(self):
        return self.data.get("_Material")

    @property
    def textures(self):
        return self.data.get("Textures") or {}

    @property
    def bools(self):
        return self.data.get("Bools") or {}

    @property
    def floats(self):
        return self.data.get("Floats") or {}

    @property
    def colors(self):
        return self.data.get("Colors")

    @property
    def is_transparent(self):
        return bool(self.data.get("IsTransparent", False))

    @property
    def rasterizer_state(self):
        return self.data.get("RasterizerState")

    @property
    def ps(self):
        return self.data.get("PS")

    @property
    def vs(self):
        return self.data.get("VS")

    @property
    def gs(self):
        return self.data.get("GS")

    @property
    def render_priority(self):
        return self.data.get("RenderPriority", 0)

    def to_dict(self):
        return self.data

    def to_json(self):
        return json.dumps(self.data, indent=4, ensure_ascii=False)

    def __repr__(self):
        return "MaterialDef(shader=%r, textures=%d)" % (self.shader, len(self.textures))


def read_material(path):
    """Parse a `.material` file. Raises MaterialError on bad JSON / non-object root."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        raise MaterialError("cannot read %s: %s" % (path, e))
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise MaterialError("bad JSON in %s: %s" % (path, e))
    newline = "\r\n" if b"\r\n" in raw else "\n"
    return MaterialDef(data, newline=newline)


def write_material(path, mat):
    """Write back byte-stable (same layout the game ships: indent=4, no trailing
    newline, original line endings)."""
    if not isinstance(mat, MaterialDef):
        raise MaterialError("write_material expects MaterialDef, got %s"
                            % type(mat).__name__)
    try:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(mat.to_json().replace("\n", mat.newline))
    except OSError as e:
        raise MaterialError("cannot write %s: %s" % (path, e))


def validate_material(mat):
    """Return a list of problems (empty = ok). Unknown shaders/slots are NOT
    problems — the game ships 6 shaders and 7 slots; only corruption is flagged."""
    if not isinstance(mat, MaterialDef):
        return ["not a MaterialDef"]
    d = mat.data
    problems = []
    if not isinstance(d.get("_Material"), str):
        problems.append("_Material missing or not a string")
    elif d["_Material"] not in SHADERS:
        problems.append("unknown shader %r" % d["_Material"])
    tex = d.get("Textures")
    if tex is not None:
        if not isinstance(tex, dict):
            problems.append("Textures is not an object")
        else:
            for slot, val in tex.items():
                if slot not in KNOWN_TEXTURE_SLOTS:
                    problems.append("unknown texture slot %r" % slot)
                if not isinstance(val, str) or not val.lower().endswith(TEXTURE_EXTENSIONS):
                    problems.append("texture %r is not a .dds/.png path: %r" % (slot, val))
    for key in ("Bools", "Floats", "Colors"):
        val = d.get(key)
        if val is not None and not isinstance(val, dict):
            problems.append("%s is not an object" % key)
    if isinstance(d.get("Bools"), dict):
        for k, v in d["Bools"].items():
            if not isinstance(v, bool):
                problems.append("Bools.%s is not bool" % k)
    if isinstance(d.get("Floats"), dict):
        for k, v in d["Floats"].items():
            if not isinstance(v, (int, float)):
                problems.append("Floats.%s is not a number" % k)
    if "IsTransparent" in d and not isinstance(d["IsTransparent"], bool):
        problems.append("IsTransparent is not bool")
    if "RasterizerState" in d and d["RasterizerState"] not in RASTERIZER_STATES:
        problems.append("unknown RasterizerState %r" % d.get("RasterizerState"))
    if "RenderPriority" in d and not isinstance(d["RenderPriority"], int):
        problems.append("RenderPriority is not int")
    for key in ("PS", "VS", "GS"):
        if key in d and not isinstance(d[key], str):
            problems.append("%s is not a string" % key)
    return problems
