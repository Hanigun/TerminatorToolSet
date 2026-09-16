"""Mount-chain planning for turrets / MG / RWS modules (Phase 3).

Pure Python: no bpy. Game convention (verified on real files, 09.2026):
a module armature root bone sits at file origin (bashnya_*, ...,
fnd_small_turret_*) and mounts onto a host bone (*_mount_point on the
hull like tower_mount_point, gunnerturret_mount_point /
missile_launcher_mount_point / smoke_launchers on turrets).

Rules live in assets/presets/mount_rules.json, first case-insensitive
substring match wins. plan_chain() orders assembly: turrets (role
'both') onto hull hosts first, then plain modules onto turret mounts,
falling back to a free hull mount. One module per mount; unmatched
modules land in leftover for the manual panel fallback.
"""
import json
import os

DEFAULT_RULES_PATH = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "presets", "mount_rules.json"))


def load_mount_rules(path=None):
    """Return (ordered [host_group_names], ordered [root_group_names])."""
    with open(path or DEFAULT_RULES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    host = [h["name"] for h in data.get("host_mounts", [])]
    roots = [r["name"] for r in data.get("module_roots", [])]
    patterns = ({h["name"]: [p.lower() for p in h.get("patterns", [])]
                 for h in data.get("host_mounts", [])},
                {r["name"]: [p.lower() for p in r.get("patterns", [])]
                 for r in data.get("module_roots", [])})
    return host, roots, patterns


def _match(name, groups, patterns):
    lowered = name.lower()
    for group in groups:
        if any(p in lowered for p in patterns[group]):
            return group
    return None


def is_host_mount(name, rules=None):
    """True when the bone is a mount point modules snap onto."""
    host, _, patterns = rules or load_mount_rules()
    return _match(name, host, patterns[0]) is not None


def is_module_root(name, rules=None):
    """True when the bone is a module root sitting at file origin."""
    _, roots, patterns = rules or load_mount_rules()
    return _match(name, roots, patterns[1]) is not None


def find_host_mounts(nodes, rules=None):
    """Host mount bones in node order (tower_mount_point first by rules)."""
    host, _, patterns = rules or load_mount_rules()
    found = []
    for group in host:
        for name in nodes:
            if name not in found and _match(name, [group], patterns[0]):
                found.append(name)
    return found


def find_module_root(nodes, rules=None):
    """Module root bone name or None (first node-order match)."""
    _, roots, patterns = rules or load_mount_rules()
    for name in nodes:
        if _match(name, roots, patterns[1]):
            return name
    return None


def find_module_roots(nodes, rules=None):
    """Все корни модуля по порядку групп правил (как find_host_mounts).

    Игровое соглашение: корень арматуры модуля сидит в начале
    координат файла — сервис выбирает из этого списка ноду
    в origin, иначе первую (прежнее поведение).
    """
    _, roots, patterns = rules or load_mount_rules()
    found = []
    for group in roots:
        for name in nodes:
            if name not in found and _match(name, [group], patterns[1]):
                found.append(name)
    return found


def role_of(nodes, rules=None):
    """One of 'host' (mounts, no module root), 'module' (root, no mounts),
    'both' (turret: mounts a gun/MG on top), 'static' (neither)."""
    rules = rules or load_mount_rules()
    mounts = find_host_mounts(nodes, rules)
    root = find_module_root(nodes, rules)
    if mounts and root:
        return "both"
    if mounts:
        return "host"
    if root:
        return "module"
    return "static"


def plan_chain(models, rules=None):
    """Order assembly for {model_id: [node_names]}.

    Returns (steps, leftover) where steps = [(module_id, host_id,
    host_bone)] in attach order and leftover = [model_id] with no free
    mount (manual panel fallback). One module per mount bone.
    """
    rules = rules or load_mount_rules()
    roles = {mid: role_of(nodes, rules) for mid, nodes in models.items()}
    mounts = {mid: find_host_mounts(nodes, rules)
              for mid, nodes in models.items()}
    used = {mid: set() for mid in models}

    def free_mount(mid):
        for bone in mounts[mid]:
            if bone not in used[mid]:
                return bone
        return None

    steps, leftover = [], []
    hosts_only = [mid for mid, r in roles.items() if r == "host"]
    both = [mid for mid, r in roles.items() if r == "both"]
    modules = [mid for mid, r in roles.items() if r == "module"]

    def attach(mid, candidates):
        for host_id in candidates:
            bone = free_mount(host_id)
            if bone is not None:
                used[host_id].add(bone)
                steps.append((mid, host_id, bone))
                return True
        return False

    # Turrets first: onto hull hosts (tower_mount_point lives there).
    for mid in both:
        if not attach(mid, hosts_only + both):
            leftover.append(mid)
    # Plain modules: prefer turret mounts, fall back to hull mounts.
    for mid in modules:
        if not attach(mid, both + hosts_only):
            leftover.append(mid)
    return steps, leftover
