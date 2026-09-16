"""Part-group classification for vehicle meshes (Phase 2, T2.1).

Pure Python: no bpy. Mesh name = Maya shading-group name (material_type),
secondary signal = MTRL material path. Rules live in
assets/presets/part_group_rules.json, first case-insensitive substring
match wins; unmatched meshes fall back to hull (body, intentionally
uncolored per plan).
"""
import json
import os

DEFAULT_RULES_PATH = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "presets", "part_group_rules.json"))

GROUP_NAMES = ("wheel", "track", "armor", "cage", "turret", "chassis", "hull")

# Extra-armor kinds (T2.3): extra armor splits into subtypes so each gets
# its own collection + color. Ordered, first case-insensitive substring
# match wins across mesh name, material path and parent bone name.
# "blocks" leads: armor_blocks_* bones are bolt-on ERA-style blocks
# (render-verified 09.2026); "base" is checked last among kinds because
# armor_base_* bones with a body material are block-kit mounts, not plates
# (fleet 09.2026: 1696 BODYmat vs 162 ARMORmat on armor_base bones) —
# classify_detailed() demotes those to "blocks", real plates (armor
# material, e.g. hemtt/ford) keep "base".
ARMOR_DETAIL_PATTERNS = (
    ("blocks", ("block",)),
    ("carbon", ("carbon",)),
    ("ceramic", ("ceramic", "ceram")),
    ("junk", ("junk",)),
    ("tusk", ("tusk",)),
    ("base", ("base",)),
)


def load_rules(path=None):
    """Return (ordered [(group, [patterns])], fallback). Patterns lowercased."""
    with open(path or DEFAULT_RULES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    groups = [(g["name"], [p.lower() for p in g.get("patterns", [])])
              for g in data.get("groups", [])]
    return groups, data.get("fallback", "hull")


def classify_part_group(mesh_name, material_path=None, rules=None):
    """Classify one mesh. Returns (group, explicit) where explicit is False
    when the fallback caught it."""
    groups, fallback = rules or load_rules()
    haystacks = [s for s in (mesh_name, material_path)
                 if isinstance(s, str) and s]
    for group, patterns in groups:
        for text in haystacks:
            lowered = text.lower().replace("\\", "/")
            if any(p in lowered for p in patterns):
                return group, True
    return fallback, False


def classify_model(mesh_names_with_materials, rules=None):
    """Classify a whole model. Input: iterable of (mesh_name, material_path).
    Returns list of (mesh_name, group, explicit)."""
    rules = rules or load_rules()
    return [(name,) + classify_part_group(name, mat, rules)
            for name, mat in mesh_names_with_materials]


def classify_armor_detail(mesh_name, material_path=None, bone_name=None):
    """Extra-armor subtype (T2.3). Returns e.g. 'tusk'/'ceramic'/... or ''
    when no kind pattern matches. Pure substring scan, no rules file."""
    for text in (mesh_name, material_path, bone_name):
        if not isinstance(text, str) or not text:
            continue
        lowered = text.lower().replace("\\", "/")
        for detail, patterns in ARMOR_DETAIL_PATTERNS:
            if any(p in lowered for p in patterns):
                return detail
    return ""


def classify_detailed(mesh_name, material_path=None, bone_name=None,
                      rules=None):
    """Classify one mesh into (group, detail, explicit).

    group follows classify_part_group; detail is the armor kind for
    group == 'armor' ('' otherwise and when no kind matches).

    bone_name (parent NODS node) is the tiebreaker, not a peer: Maya
    shading-group names are authoritative when explicit, but some files
    (abrams_chassis: material_type is the *material* name like
    'trucks_founders') carry no part info in the name — then the parent
    bone (st_wheel01, armor_tusk_body_18, ...) decides.
    """
    group, explicit = classify_part_group(mesh_name, material_path, rules)
    if not explicit and isinstance(bone_name, str) and bone_name:
        bgroup, bexplicit = classify_part_group(bone_name, None, rules)
        if bexplicit:
            group, explicit = bgroup, bexplicit
    detail = ""
    if group == "armor":
        detail = classify_armor_detail(mesh_name, material_path, bone_name)
        if detail == "base" and isinstance(material_path, str) \
                and material_path:
            base = material_path.lower().replace("\\", "/").rsplit("/", 1)[-1]
            if "armor" not in base:
                detail = "blocks"
    return group, detail, explicit
