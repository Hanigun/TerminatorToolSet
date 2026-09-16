"""Node hierarchy helpers, pure Python.

 compose_world_matrices() turns parent-local NODS matrices into model-space
 matrices. Unlike the oracle (which requires parents before children and
 valid indices), this resolves out-of-order parents iteratively and treats
 dangling indices (infantry encodes parents outside the node table — Q6)
 as roots, collecting warnings instead of failing.
"""

from .coord_space import mat_mul

ROOT_PARENT = 0xFFFFFFFF


def mat_inverse(m):
    """4x4 row-major inverse (Gauss-Jordan). Raises ValueError if singular."""
    a = [list(m[r * 4:(r + 1) * 4]) for r in range(4)]
    inv = [[1.0 if r == c else 0.0 for c in range(4)] for r in range(4)]
    for col in range(4):
        piv = max(range(col, 4), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-12:
            raise ValueError("singular matrix")
        a[col], a[piv] = a[piv], a[col]
        inv[col], inv[piv] = inv[piv], inv[col]
        scale = a[col][col]
        a[col] = [x / scale for x in a[col]]
        inv[col] = [x / scale for x in inv[col]]
        for r in range(4):
            if r != col and a[r][col] != 0.0:
                factor = a[r][col]
                a[r] = [x - factor * y for x, y in zip(a[r], a[col])]
                inv[r] = [x - factor * y for x, y in zip(inv[r], inv[col])]
    return tuple(x for row in inv for x in row)


def resolve_node_parents(nodes, has_extras):
    """Map raw NODS parent values to node indices (or None for root level).

    Vehicle/plain files: values are node indices (0xFFFFFFFF = root).
    Infantry files WITH interleave extras: values index RECORDS
    (nodes + extras); record r belongs to node r // 2. Self links and
    out-of-range values resolve to None with a warning (oracle: crash
    or silent mislink).
    """
    n = len(nodes)
    resolved = []
    warnings = []
    for i, node in enumerate(nodes):
        p = node.parent
        if p == ROOT_PARENT:
            resolved.append(None)
            continue
        target = p // 2 if has_extras else p
        if not (0 <= target < n):
            warnings.append("node %d (%s): parent %d out of range, root level"
                            % (i, node.name, p))
            resolved.append(None)
        elif target == i:
            warnings.append("node %d (%s): self parent, root level" % (i, node.name))
            resolved.append(None)
        else:
            resolved.append(target)
    return resolved, warnings


def compose_world_matrices(nodes, resolved=None):
    """Return (worlds, warnings). worlds[i] is the model-space matrix.

    nodes: sequence with .parent (int) and .matrix (16-tuple).
    resolved: optional output of resolve_node_parents() (None = root);
    when given, it overrides .parent. Unresolved parents, out-of-range
    indices and cycles become roots with warnings (oracle: silent garbage).
    """
    n = len(nodes)
    worlds = [None] * n
    warnings = []

    def valid_parent(i):
        if resolved is not None:
            p = resolved[i]
            return p is not None and 0 <= p < n
        p = nodes[i].parent
        return p != ROOT_PARENT and 0 <= p < n

    def parent_of(i):
        if resolved is not None:
            return resolved[i]
        return nodes[i].parent

    pending = set(range(n))
    while pending:
        progressed = False
        for i in sorted(pending):
            p = parent_of(i)
            if not valid_parent(i):
                if resolved is None and p != ROOT_PARENT:
                    warnings.append("node %d (%s): dangling parent %d, treated as root"
                                    % (i, nodes[i].name, p))
                worlds[i] = tuple(nodes[i].matrix)
                pending.discard(i)
                progressed = True
            elif worlds[p] is not None:
                # Row-vector file convention (translation in the last row):
                # v_world = v_local @ L @ P, so W = L @ P (matches the
                # oracle's column-vector P @ L after the boundary transpose;
                # proven 0.0 diff on buldozer_chassis, 178 nodes).
                worlds[i] = mat_mul(tuple(nodes[i].matrix), worlds[p])
                pending.discard(i)
                progressed = True
        if not progressed:
            # Cycle: break it at the lowest index, report honestly.
            i = min(pending)
            warnings.append("node %d (%s): parent cycle, treated as root"
                            % (i, nodes[i].name))
            worlds[i] = tuple(nodes[i].matrix)
            pending.discard(i)
    return worlds, warnings
