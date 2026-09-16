"""Little-endian binary reader/writer for game formats.

 Pure Python, no Blender dependency. Covers every primitive used by
 `.model` (see Docs/model_format.md): u8/u16/u32/i32/f32, null-terminated
 latin-1 strings, raw bytes, 16-float matrices.

 Out-of-bounds reads raise BinaryIOError (with offset) instead of
 returning garbage — silent truncation is how corrupt assets slip through.
"""

import struct


class BinaryIOError(Exception):
    """Raised on truncated reads or undecodable data, with byte offset."""


_U8 = struct.Struct("<B")
_U16 = struct.Struct("<H")
_U32 = struct.Struct("<I")
_I32 = struct.Struct("<i")
_F32 = struct.Struct("<f")


class BinaryReader:
    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0

    @property
    def pos(self) -> int:
        return self._pos

    @property
    def remaining(self) -> int:
        return len(self._data) - self._pos

    @property
    def at_end(self) -> bool:
        return self._pos >= len(self._data)

    def _take(self, size: int) -> bytes:
        if size < 0:
            raise BinaryIOError("negative read size %d at offset %d" % (size, self._pos))
        chunk = self._data[self._pos:self._pos + size]
        if len(chunk) != size:
            raise BinaryIOError(
                "truncated read: wanted %d bytes at offset %d, %d remain"
                % (size, self._pos, len(self._data) - self._pos)
            )
        self._pos += size
        return chunk

    def u8(self) -> int:
        return _U8.unpack(self._take(1))[0]

    def u16(self) -> int:
        return _U16.unpack(self._take(2))[0]

    def u32(self) -> int:
        return _U32.unpack(self._take(4))[0]

    def i32(self) -> int:
        return _I32.unpack(self._take(4))[0]

    def f32(self) -> float:
        return _F32.unpack(self._take(4))[0]

    def raw(self, size: int) -> bytes:
        return self._take(size)

    def magic(self, size: int) -> bytes:
        """Raw chunk magic (e.g. b'MODL'), no decoding."""
        return self._take(size)

    def string(self) -> str:
        """Null-terminated latin-1 string (game convention)."""
        end = self._data.find(b"\x00", self._pos)
        if end == -1:
            raise BinaryIOError("unterminated string at offset %d" % self._pos)
        chunk = self._data[self._pos:end]
        self._pos = end + 1
        try:
            return chunk.decode("latin-1")
        except UnicodeDecodeError as exc:
            raise BinaryIOError("bad latin-1 string at offset %d: %s" % (self._pos, exc))

    def matrix16(self) -> tuple:
        """16 little-endian floats, row-major (NODS transform)."""
        return struct.unpack("<%df" % 16, self._take(4 * 16))

    def skip(self, size: int) -> None:
        self._take(size)

    def seek(self, pos: int) -> None:
        """Absolute seek (used to rewind to a saved section offset)."""
        if not 0 <= pos <= len(self._data):
            raise BinaryIOError("seek out of range: %d (size %d)" % (pos, len(self._data)))
        self._pos = pos

    def peek(self, size: int) -> bytes:
        """Look at the next bytes without advancing."""
        return self._data[self._pos:self._pos + size]

    def find(self, pattern: bytes) -> int:
        """Seek past the next occurrence of pattern; return its offset, -1 if absent.

        Mirrors the oracle's find_bytes(): sections have no lengths, so the
        reader scans for the next magic. Position lands AFTER the pattern.
        """
        idx = self._data.find(pattern, self._pos)
        if idx == -1:
            return -1
        self._pos = idx + len(pattern)
        return idx


class BinaryWriter:
    def __init__(self):
        self._buf = bytearray()

    def u8(self, value: int) -> None:
        self._buf += _U8.pack(value)

    def u16(self, value: int) -> None:
        self._buf += _U16.pack(value)

    def u32(self, value: int) -> None:
        self._buf += _U32.pack(value)

    def i32(self, value: int) -> None:
        self._buf += _I32.pack(value)

    def f32(self, value: float) -> None:
        self._buf += _F32.pack(value)

    def raw(self, data: bytes) -> None:
        self._buf += data

    def magic(self, pattern: bytes) -> None:
        self._buf += pattern

    def string(self, value: str, null_terminated: bool = True) -> None:
        try:
            encoded = value.encode("latin-1")
        except UnicodeEncodeError as exc:
            raise BinaryIOError("string not latin-1 encodable: %r (%s)" % (value, exc))
        self._buf += encoded
        if null_terminated:
            self._buf += b"\x00"

    def matrix16(self, values) -> None:
        values = tuple(values)
        if len(values) != 16:
            raise BinaryIOError("matrix16 needs 16 floats, got %d" % len(values))
        self._buf += struct.pack("<16f", *values)

    def getvalue(self) -> bytes:
        return bytes(self._buf)

    def __len__(self) -> int:
        return len(self._buf)
