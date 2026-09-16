"""Constraint sections: CONS / PCNS / IKSY (Phase 3, T3.1).

Pure Python, no bpy. Layouts confirmed by T3.0 probe
(tools/probe_constraints.py): CONS 19/19, PCNS 23/23, IKSY 6/6 walks land
exactly on the next marker.

PCNS tail: 4 raw bytes overlapping the source terminator (first byte is
shared, always 0x00 so far). Stored opaque as bytes — NOT a float (the old
f32 read produced meaningless 2.35e-38). Reader resumes at tail_pos + 4.
"""
from dataclasses import dataclass

from .binary_io import BinaryIOError, BinaryReader, BinaryWriter

CONS_MAGIC = b"CONS"
PCNS_MAGIC = b"PCNS"
IKSY_MAGIC = b"IKSY"


@dataclass
class ConsEntry:
    type: str
    vector: tuple
    # aim_lock: source_node (int) + target (str); others: target_count + min/max angle
    source_node: int = -1
    target: str = ""
    target_count: int = 0
    min_angle: float = 0.0
    max_angle: float = 0.0
    pad: int = 0  # trailing skip byte, stored for byte-exact round-trip


@dataclass
class PcnsEntry:
    type: str
    target_node: int
    source: str
    tail: bytes = b"\x00\x00\x00\x01"  # 4 raw bytes @ terminator; semantics open (Q5)


@dataclass
class IksyEntry:
    name: str
    end_effector: str
    start_joint: str
    pad: int = 0  # trailing skip byte, stored for byte-exact round-trip


def read_cons_section(r: BinaryReader):
    version = r.u32()
    entries = []
    for _ in range(r.u32()):
        ctype = r.string()
        vector = tuple(r.f32() for _ in range(3))
        if ctype == "aim_lock":
            source_node = r.u32()
            tail = r.raw(8)
            if tail != b"\x00" * 8:
                raise BinaryIOError("aim_lock tail != 8x00 at offset %d" % (r.pos - 8))
            entries.append(ConsEntry(ctype, vector, source_node=source_node,
                                     target=r.string()))
        else:
            entries.append(ConsEntry(ctype, vector, target_count=r.u32(),
                                     min_angle=r.f32(), max_angle=r.f32(),
                                     pad=r.u8()))
    return version, entries


def write_cons_section(w: BinaryWriter, version, entries) -> None:
    w.u32(version)
    w.u32(len(entries))
    for c in entries:
        w.string(c.type)
        for v in c.vector:
            w.f32(v)
        if c.type == "aim_lock":
            w.u32(c.source_node)
            w.raw(b"\x00" * 8)
            w.string(c.target)
        else:
            w.u32(c.target_count)
            w.f32(c.min_angle)
            w.f32(c.max_angle)
            w.u8(c.pad)


def read_pcns_section(r: BinaryReader):
    version = r.u32()
    entries = []
    for _ in range(r.u32()):
        ctype = r.string()
        target_node = r.u32()
        source = r.string()
        tail_pos = r.pos - 1  # terminator doubles as the tail's first byte
        r.seek(tail_pos)
        tail = r.raw(4)
        r.seek(tail_pos + 4)
        entries.append(PcnsEntry(ctype, target_node, source, tail))
    return version, entries


def write_pcns_section(w: BinaryWriter, version, entries) -> None:
    w.u32(version)
    w.u32(len(entries))
    for p in entries:
        if len(p.tail) != 4:
            raise BinaryIOError("PCNS tail must be 4 bytes, got %d" % len(p.tail))
        w.string(p.type)
        w.u32(p.target_node)
        w.string(p.source, null_terminated=False)
        w.raw(p.tail)


def read_iksy_section(r: BinaryReader):
    skip = r.raw(4)
    entries = []
    for _ in range(r.u32()):
        entries.append(IksyEntry(r.string(), r.string(), r.string(), pad=r.u8()))
    return skip, entries


def write_iksy_section(w: BinaryWriter, skip, entries) -> None:
    if len(skip) != 4:
        raise BinaryIOError("IKSY skip must be 4 bytes")
    w.raw(skip)
    w.u32(len(entries))
    for e in entries:
        w.string(e.name)
        w.string(e.end_effector)
        w.string(e.start_joint)
        w.u8(e.pad)
