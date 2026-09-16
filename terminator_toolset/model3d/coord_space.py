"""Game <-> Blender coordinate space conversion, pure Python.

 Convention (see Docs/model_format.md):
   game:    X = forward, Y = left,  Z = up
   Blender: X = right,   Y = forward, Z = up

 Matrices are 16-float row-major tuples (file order). Vectors are 3-tuples,
 UVs 2-tuples, quaternions (w, x, y, z) tuples. No mathutils here — the
 conversion happens on plain tuples/lists at the core/blender boundary.

 Direction semantics mirror the oracle
 (Sources/warfare_model_exporter_en/utils.py:swap_coord_space):
   game -> Blender uses SPACE, Blender -> game uses SPACE_INV.
"""

SPACE = (
    0.0, -1.0, 0.0, 0.0,
    1.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
)

SPACE_INV = (
    0.0, 1.0, 0.0, 0.0,
    -1.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
)


def mat_mul(a, b):
    """4x4 row-major matrix product as a 16-tuple."""
    a = tuple(a)
    b = tuple(b)
    if len(a) != 16 or len(b) != 16:
        raise ValueError("mat_mul needs two 16-tuples")
    return tuple(
        sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
        for r in range(4)
        for c in range(4)
    )


def _swap_matrix(m, s, s_inv):
    return mat_mul(mat_mul(tuple(s), tuple(m)), tuple(s_inv))


def game_to_blender_matrix(m):
    """Node/skin matrix game -> Blender: SPACE @ M @ SPACE_INV."""
    return _swap_matrix(m, SPACE, SPACE_INV)


def blender_to_game_matrix(m):
    """Node/skin matrix Blender -> game: SPACE_INV @ M @ SPACE."""
    return _swap_matrix(m, SPACE_INV, SPACE)


def _swap_vec(v, s):
    x, y, z = v
    return (
        s[0] * x + s[1] * y + s[2] * z,
        s[4] * x + s[5] * y + s[6] * z,
        s[8] * x + s[9] * y + s[10] * z,
    )


def game_to_blender_vec(v):
    """Position/normal game -> Blender: (x, y, z) -> (-y, x, z)."""
    if len(v) != 3:
        raise ValueError("vec needs 3 components")
    return _swap_vec(v, SPACE)


def blender_to_game_vec(v):
    """Position/normal Blender -> game: (x, y, z) -> (y, -x, z)."""
    if len(v) != 3:
        raise ValueError("vec needs 3 components")
    return _swap_vec(v, SPACE_INV)


def flip_uv(uv):
    """V flip, self-inverse; same both directions: (u, v) -> (u, 1 - v)."""
    if len(uv) != 2:
        raise ValueError("uv needs 2 components")
    u, v = uv
    return (u, 1.0 - v)


def _mat3_to_quat(m):
    """Rotation matrix (3x3 row-major 9-tuple) -> (w, x, y, z). Shepard's method."""
    t = m[0] + m[4] + m[8]
    if t > 0.0:
        s = (t + 1.0) ** 0.5 * 2.0
        return (0.25 * s, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s)
    if m[0] > m[4] and m[0] > m[8]:
        s = (1.0 + m[0] - m[4] - m[8]) ** 0.5 * 2.0
        return ((m[7] - m[5]) / s, 0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s)
    if m[4] > m[8]:
        s = (1.0 + m[4] - m[0] - m[8]) ** 0.5 * 2.0
        return ((m[2] - m[6]) / s, (m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s)
    s = (1.0 + m[8] - m[0] - m[4]) ** 0.5 * 2.0
    return ((m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s)


def _quat_to_mat4(q):
    """(w, x, y, z) -> 4x4 row-major rotation matrix tuple."""
    w, x, y, z = q
    n = (w * w + x * x + y * y + z * z) ** 0.5
    if n == 0.0:
        raise ValueError("zero quaternion")
    w, x, y, z = w / n, x / n, y / n, z / n
    return (
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0.0,
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0.0,
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0.0,
        0.0, 0.0, 0.0, 1.0,
    )


def _swap_quat(q, s, s_inv):
    m = _swap_matrix(_quat_to_mat4(q), s, s_inv)
    m3 = (m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10])
    return _mat3_to_quat(m3)


def game_to_blender_quat(q):
    """Quaternion (w, x, y, z) game -> Blender via the swapped matrix."""
    if len(q) != 4:
        raise ValueError("quat needs 4 components")
    return _swap_quat(q, SPACE, SPACE_INV)


def blender_to_game_quat(q):
    """Quaternion (w, x, y, z) Blender -> game via the swapped matrix."""
    if len(q) != 4:
        raise ValueError("quat needs 4 components")
    return _swap_quat(q, SPACE_INV, SPACE)
