"""Reader for game .model files -> ParsedModel.

 Layout: see Docs/model_format.md. Sections have no lengths, so after the
 sequential NODS/MSHS blocks the optional sections (MTRL/CONS/PCNS/IKSY)
 are located with find(), mirroring the oracle.
 Pure Python, no Blender dependency.
"""

from dataclasses import dataclass, field

from .binary_io import BinaryIOError, BinaryReader
from .constraints import (
    CONS_MAGIC,
    IKSY_MAGIC,
    PCNS_MAGIC,
    ConsEntry,
    IksyEntry,
    PcnsEntry,
    read_cons_section,
    read_iksy_section,
    read_pcns_section,
)

ROOT_PARENT = 0xFFFFFFFF

HEADER_MAGIC = b"MODL"
NODS_MAGIC = b"NODS"
MSHS_MAGIC = b"MSHS"
MESH_MAGIC = b"MESH"
MTRL_MAGIC = b"MTRL"
CLDR_MAGIC = b"CLDR"
CLDR_ENTRY_SIZE = 48


@dataclass
class Node:
    name: str
    parent: int
    matrix: tuple
    flags: int
    unknown: str | None  # None = marker record without unknown (infantry tail)


@dataclass
class NodsExtra:
    """Infantry interleave block: u32 index + 16f matrix + u8 flag.

    Vehicle files have none; infantry (Bip01) files alternate
    node, extra, node, ... ending with a node. Semantics open (Q6).
    """
    index: int
    matrix: tuple
    flag: int


@dataclass
class SkinJoint:
    name: str
    inv_bind: tuple


@dataclass
class Mesh:
    parent: int
    material_id: int
    mesh_version: int
    material_type: str
    indices: list
    verts: list
    normals: list
    tangents: list
    uvs: list
    unk: list
    weights: list
    joint_indices: list
    joints: list = field(default_factory=list)
    aux: list = field(default_factory=list)  # v1 only: u32 + 2-float rows
    # after uvs (opaque round-trip; semantics open, Q9). v6/7: empty.


@dataclass
class CldrEntry:
    raw: bytes  # 48 bytes, opaque (semantics open, Q7)


@dataclass
class ParsedModel:
    version: int
    nodes: list = field(default_factory=list)
    meshes: list = field(default_factory=list)
    mtrl: list = field(default_factory=list)
    # Declared MTRL entry count, verbatim from file. Stale counts exist in
    # the wild (bmpt MTRL declares 2, stores 1 path) — the game tolerates
    # them, so the reader keeps them for a byte-exact round-trip.
    mtrl_declared_count: int = 0
    cons: list = field(default_factory=list)
    cons_version: int = 0
    pcns: list = field(default_factory=list)
    pcns_version: int = 0
    iksy: list = field(default_factory=list)
    iksy_skip: bytes = b"\x00\x00\x00\x00"  # 4 raw bytes after IKSY magic (NOT zeros: 00 02 00 00 seen)
    cldr_version: int = 0
    cldr: list = field(default_factory=list)
    nods_extras: list = field(default_factory=list)
    path: str = ""
    # Section presence: a file lacking a section must not gain an empty one.
    has_mtrl: bool = False
    has_cons: bool = False
    has_pcns: bool = False
    has_iksy: bool = False
    has_cldr: bool = False


def _read_f32_array(r: BinaryReader, stride: int) -> list:
    count = r.u32()
    return [tuple(r.f32() for _ in range(stride)) for _ in range(count)]


# Magics that may directly follow NODS (a node without unknown is a
# marker only if one of these comes next — otherwise the string belongs
# to the node). Used by the infantry variant.
SECTION_MAGICS = (MSHS_MAGIC, MTRL_MAGIC, CONS_MAGIC, PCNS_MAGIC, IKSY_MAGIC, CLDR_MAGIC)


def _read_node_head(r: BinaryReader):
    name = r.string()
    parent = r.u32()
    matrix = r.matrix16()
    flags = r.u8()
    return name, parent, matrix, flags


def _read_nods(r: BinaryReader, model: ParsedModel) -> None:
    start = r.pos
    count = r.u32()
    if model.version == 1:
        # Variant 0 (statics, ver 1): name + parent + matrix16 only —
        # no flags byte, no unknown string (proven on all 121 v1 files).
        for _ in range(count):
            model.nodes.append(Node(r.string(), r.u32(), r.matrix16(), 0, None))
        if r.peek(4) != MSHS_MAGIC:
            raise BinaryIOError(
                "v1 NODS: no MSHS after %d entries at offset %d in %s"
                % (count, r.pos, model.path))
        return
    # Variant 1 (vehicles): every entry is a plain node.
    for _ in range(count):
        name, parent, matrix, flags = _read_node_head(r)
        model.nodes.append(Node(name, parent, matrix, flags, r.string()))
    if r.peek(4) == MSHS_MAGIC:
        return
    # Variant 2 (infantry): node, extra, node, ... ending with a node;
    # the trailing marker node has no unknown (a section magic follows).
    r.seek(start)
    model.nodes.clear()
    model.nods_extras.clear()
    r.u32()  # count
    for i in range(count):
        if i % 2 == 1:
            model.nods_extras.append(NodsExtra(r.u32(), r.matrix16(), r.u8()))
            continue
        name, parent, matrix, flags = _read_node_head(r)
        if r.peek(4) in SECTION_MAGICS:
            unknown = None
        else:
            unknown = r.string()
        model.nodes.append(Node(name, parent, matrix, flags, unknown))
    if r.peek(4) != MSHS_MAGIC:
        raise BinaryIOError(
            "NODS variant detection failed in %s: no MSHS after %d entries at offset %d"
            % (model.path, count, r.pos))


def _read_mesh(r: BinaryReader, model: ParsedModel) -> Mesh:
    parent = r.u32()
    material_id = r.u32()
    magic = r.magic(4)
    if magic != MESH_MAGIC:
        raise BinaryIOError("expected MESH magic at offset %d, got %r" % (r.pos - 4, magic))
    mesh_version = r.u32()
    material_type = r.string()
    if model.version == 1:
        # Variant 0 (statics, ver 1, mesh ver 1): every vertex block has
        # its own count and indices are NOT 1:1 with verts (shared verts).
        # After uvs: u32 + 2-float aux rows (opaque, Q9). No unk/weights/
        # joint_indices/skin joints. Proven on all 121 v1 files (exact EOF).
        if mesh_version != 1:
            raise BinaryIOError("v1 file with mesh version %d in %s"
                                % (mesh_version, model.path))
        indices = [r.u32() for _ in range(r.u32())]
        verts = _read_f32_array(r, 3)
        normals = _read_f32_array(r, 3)
        tangents = _read_f32_array(r, 4)
        uvs = _read_f32_array(r, 2)
        aux = _read_f32_array(r, 2)
        return Mesh(parent, material_id, mesh_version, material_type,
                    indices, verts, normals, tangents, uvs,
                    [], [], [], [], aux)
    indices = [r.u32() for _ in range(r.u32())]
    verts = _read_f32_array(r, 3)
    normals = _read_f32_array(r, 3)
    tangents = _read_f32_array(r, 4)
    uvs = _read_f32_array(r, 2)
    unk = _read_f32_array(r, 2)
    weights = _read_f32_array(r, 4)
    joint_count = r.u32()
    joint_indices = [tuple(int(r.f32()) for _ in range(4)) for _ in range(joint_count)]
    joints = []
    for _ in range(r.u32()):
        joints.append(SkinJoint(r.string(), r.matrix16()))
    return Mesh(parent, material_id, mesh_version, material_type,
                indices, verts, normals, tangents, uvs, unk,
                weights, joint_indices, joints)


def _read_mtrl(r: BinaryReader, model: ParsedModel) -> None:
    if r.find(MTRL_MAGIC) == -1:
        return
    model.has_mtrl = True
    declared = r.u32()
    model.mtrl_declared_count = declared
    # Stale counts exist (bmpt: declares 2, stores 1): stop at EOF or at
    # the next section magic instead of raising or swallowing its bytes.
    for _ in range(declared):
        if r.at_end or r.peek(4) in SECTION_MAGICS:
            break
        model.mtrl.append(r.string())


def _read_cons(r: BinaryReader, model: ParsedModel) -> None:
    if r.find(CONS_MAGIC) == -1:
        return
    model.has_cons = True
    model.cons_version, model.cons = read_cons_section(r)


def _read_pcns(r: BinaryReader, model: ParsedModel) -> None:
    if r.find(PCNS_MAGIC) == -1:
        return
    model.has_pcns = True
    model.pcns_version, model.pcns = read_pcns_section(r)


def _read_iksy(r: BinaryReader, model: ParsedModel) -> None:
    if r.find(IKSY_MAGIC) == -1:
        return
    model.has_iksy = True
    model.iksy_skip, model.iksy = read_iksy_section(r)


def _read_cldr(r: BinaryReader, model: ParsedModel, after_meshes: int) -> None:
    r.seek(after_meshes)
    if r.find(CLDR_MAGIC) == -1:
        return
    model.has_cldr = True
    model.cldr_version = r.u32()
    count = r.u32()
    for _ in range(count):
        model.cldr.append(CldrEntry(r.raw(CLDR_ENTRY_SIZE)))
    if not r.at_end:
        raise BinaryIOError(
            "CLDR is not the last section at offset %d (%d trailing bytes) in %s"
            % (r.pos, r.remaining, model.path))


def read_model(path) -> ParsedModel:
    """Parse a .model file. Raises BinaryIOError on truncated/invalid data."""
    with open(path, "rb") as f:
        data = f.read()
    r = BinaryReader(data)
    if r.magic(4) != HEADER_MAGIC:
        raise BinaryIOError("bad header magic in %s" % path)
    model = ParsedModel(version=r.u32(), path=str(path))
    if r.magic(4) != NODS_MAGIC:
        raise BinaryIOError("missing NODS magic in %s" % path)
    _read_nods(r, model)
    if r.find(MSHS_MAGIC) == -1:
        raise BinaryIOError("missing MSHS magic in %s" % path)
    model.meshes = [_read_mesh(r, model) for _ in range(r.u32())]
    after_meshes = r.pos
    _read_mtrl(r, model)
    r.seek(after_meshes)
    _read_cons(r, model)
    r.seek(after_meshes)
    _read_pcns(r, model)
    _read_iksy(r, model)
    _read_cldr(r, model, after_meshes)
    return model
