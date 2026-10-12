"""Refine an exported contact system at 50-digit working precision."""

import argparse
import json
import sys
from pathlib import Path

try:
    import mpmath as mp
except ImportError:
    raise SystemExit(
        "mpmath is required; use a virtual environment and python/requirements.txt"
    )

from geometry_reference import evaluate as float_evaluate

mp.mp.dps = 50


def D(value):
    """Preserve the exact binary value of JSON float64 inputs."""
    return mp.mpf(value)


def points(n, poses):
    if n == 0:
        return [[(p[0], p[1])] for p in poses]
    radius = 1 / (2 * mp.sin(mp.pi / n))
    return [
        [
            (
                p[0] + radius * mp.cos(p[2] + mp.pi / 2 + 2 * mp.pi * k / n),
                p[1] + radius * mp.sin(p[2] + mp.pi / 2 + 2 * mp.pi * k / n),
            )
            for k in range(n)
        ]
        for p in poses
    ]


def geometry(config, variables):
    poses = [variables[3 * i : 3 * i + 3] for i in range(config["P"])]
    return poses, points(config["N"], poses)


def pair_feature(n, a, b, pa, pb):
    """Gap and translation/rotation derivatives on the selected SAT face."""
    if n == 0:
        dx, dy = a[0] - b[0], a[1] - b[1]
        distance = mp.sqrt(dx * dx + dy * dy)
        nx, ny = (dx / distance, dy / distance) if distance else (D(1), D(0))
        return distance - 2, (nx, ny, D(0)), (-nx, -ny, D(0))
    best = -mp.inf
    derivatives = None
    for reverse, (owner, other, poly, opposite) in enumerate(
        ((a, b, pa, pb), (b, a, pb, pa))
    ):
        for k, vertex in enumerate(poly):
            following = poly[(k + 1) % n]
            ux, uy = following[1] - vertex[1], vertex[0] - following[0]
            norm = mp.sqrt(ux * ux + uy * uy)
            ux, uy = ux / norm, uy / norm
            support = min(opposite, key=lambda v: v[0] * ux + v[1] * uy)
            gap = (support[0] - vertex[0]) * ux + (support[1] - vertex[1]) * uy
            if gap > best:
                best = gap
                # The owner's edge and its normal rotate together. Its support
                # stays at the inradius; only the other support and normal vary.
                odx, ody = support[0] - other[0], support[1] - other[1]
                d_owner = (
                    -ux,
                    -uy,
                    -(support[0] - owner[0]) * uy + (support[1] - owner[1]) * ux,
                )
                d_other = (ux, uy, -ody * ux + odx * uy)
                derivatives = (d_other, d_owner) if reverse else (d_owner, d_other)
    return best, *derivatives


def residuals(config, variables, contacts, derivatives=False):
    n, m = config["N"], config["M"]
    poses, vertices = geometry(config, variables)
    cx, cy, phi, size = variables[-4:]
    gaps, rows = [], []
    walls = {}
    for contact in contacts:
        row = [D(0)] * len(variables) if derivatives else None
        i = contact["i"]
        if contact["kind"] == "pair":
            j = contact["j"]
            gap, da, db = pair_feature(n, poses[i], poses[j], vertices[i], vertices[j])
            if derivatives:
                row[3 * i : 3 * i + 3], row[3 * j : 3 * j + 3] = da, db
        else:
            x, y = vertices[i][contact.get("vertex", 0)]
            dx, dy = x - cx, y - cy
            vx, vy = x - poses[i][0], y - poses[i][1]
            pad = 1 if n == 0 else 0
            if contact["kind"] == "radial":
                distance = mp.sqrt(dx * dx + dy * dy)
                ux, uy = (dx / distance, dy / distance) if distance else (D(0), D(0))
                gap = size - distance - pad
                dphi, dsize = D(0), D(1)
            else:
                edge = contact["edge"]
                if edge not in walls:
                    angle = phi - mp.pi / 2 + 2 * mp.pi * edge / m
                    walls[edge] = mp.cos(angle), mp.sin(angle)
                ux, uy = walls[edge]
                dsize = 1 / (2 * mp.tan(mp.pi / m))
                gap = size * dsize - dx * ux - dy * uy - pad
                dphi = dx * uy - dy * ux
            if derivatives:
                row[3 * i : 3 * i + 3] = (-ux, -uy, vy * ux - vx * uy)
                row[-4:] = (ux, uy, dphi, dsize)
        gaps.append(gap)
        if derivatives:
            rows.append(row)
    return (gaps, rows) if derivatives else gaps


class FeasibilityContacts:
    """Cache only potentially colliding pairs, with a conservative motion skin.

    Excluded pairs have centre distance greater than 2R + skin. A rebuild is
    required before either centre can move skin/2 from its cached position.
    Boundary constraints always include every vertex and every container edge.
    """

    def __init__(self, config):
        self.config = config
        self.anchor = None
        self.skin = D("0.25")
        self.radius = 1 if config["N"] == 0 else 1 / (2 * mp.sin(mp.pi / config["N"]))
        self.boundary = []
        for i in range(config["P"]):
            for vertex in range(config["N"] or 1):
                extra = {} if config["N"] == 0 else {"vertex": vertex}
                if config["M"] == 0:
                    self.boundary.append({"kind": "radial", "i": i, **extra})
                else:
                    self.boundary.extend(
                        {"kind": "wall", "i": i, "edge": edge, **extra}
                        for edge in range(config["M"])
                    )

    def get(self, variables):
        poses = [variables[3 * i : 3 * i + 3] for i in range(self.config["P"])]
        if self.anchor is None or any(
            mp.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) >= self.skin / 2
            for a, b in zip(poses, self.anchor)
        ):
            reach = 2 * self.radius + self.skin + D("1e-40")
            self.pairs = [
                {"kind": "pair", "i": i, "j": j}
                for i, a in enumerate(poses)
                for j, b in enumerate(poses[i + 1 :], i + 1)
                if (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 <= reach * reach
            ]
            self.anchor = [pose[:] for pose in poses]
        return self.pairs + self.boundary


def initial_container(config):
    n, m = config["N"], config["M"]
    poses = [[D(p[k]) for k in ("x", "y", "theta")] for p in config["pieces"]]
    cx = sum(p[0] for p in poses) / len(poses)
    cy = sum(p[1] for p in poses) / len(poses)
    phi = D(config.get("container_phi", 0))
    vertices = [point for polygon in points(n, poses) for point in polygon]
    pad = 1 if n == 0 else 0
    if m == 0:
        size = max(mp.sqrt((x - cx) ** 2 + (y - cy) ** 2) + pad for x, y in vertices)
    else:
        apothem = max(
            (x - cx) * mp.cos(phi - mp.pi / 2 + 2 * mp.pi * edge / m)
            + (y - cy) * mp.sin(phi - mp.pi / 2 + 2 * mp.pi * edge / m)
            + pad
            for x, y in vertices
            for edge in range(m)
        )
        size = 2 * apothem * mp.tan(mp.pi / m)
    return {"cx": cx, "cy": cy, "phi": phi, "size": size}


def validate_input(data):
    config = data["config"]
    n, m, p = config["N"], config["M"], config["P"]
    if any(
        not isinstance(shape, int)
        or isinstance(shape, bool)
        or (shape != 0 and not 3 <= shape <= 100)
        for shape in (n, m)
    ):
        raise ValueError("invalid shape codes")
    if (
        not isinstance(p, int)
        or isinstance(p, bool)
        or not 1 <= p <= 100
        or len(config["pieces"]) != p
    ):
        raise ValueError("high-precision tool requires exactly P pieces, 1 <= P <= 100")
    if p * (p - 1) // 2 + p * (n or 1) * (m or 1) > 50000:
        raise ValueError("complete contact validation exceeds 50000 constraints")
    for pose in config["pieces"]:
        for key in ("x", "y", "theta"):
            if type(pose[key]) not in (int, float) or not mp.isfinite(D(pose[key])):
                raise ValueError("poses must contain finite numeric values")
            if key in ("x", "y") and abs(D(pose[key])) > 1e6:
                raise ValueError("poses must be within coordinate limits")
    if not isinstance(data["contacts"], list) or len(data["contacts"]) > 2048:
        raise ValueError("contacts must be an array with at most 2048 entries")
    for contact in data["contacts"]:
        kind, i = contact.get("kind"), contact.get("i")
        if (
            kind not in ("pair", "wall", "radial")
            or type(i) is not int
            or not 0 <= i < p
        ):
            raise ValueError("invalid contact")
        if kind == "pair":
            j = contact.get("j")
            if type(j) is not int or not i < j < p:
                raise ValueError("invalid pair index")
        else:
            if (kind == "wall") != (m != 0):
                raise ValueError("contact does not match container")
            if kind == "wall" and (
                type(contact.get("edge")) is not int or not 0 <= contact["edge"] < m
            ):
                raise ValueError("invalid wall edge")
            if n != 0 and (
                type(contact.get("vertex")) is not int or not 0 <= contact["vertex"] < n
            ):
                raise ValueError("polygon contact requires vertex index")
            if n == 0 and "vertex" in contact:
                raise ValueError("circle contact cannot have vertex")
    return config


def minimum_norm_correction(rows, rhs):
    """Independent rows give a nonsingular Gram system without gauge fixing."""
    orthogonal, selected, targets = [], [], []
    for row, target in zip(rows, rhs):
        reduced = row[:]
        for basis in orthogonal:
            coefficient = sum(x * y for x, y in zip(reduced, basis))
            reduced = [x - coefficient * y for x, y in zip(reduced, basis)]
        norm = mp.sqrt(sum(x * x for x in reduced))
        if norm > D("1e-20"):
            orthogonal.append([x / norm for x in reduced])
            selected.append(row)
            targets.append(target)
    if not selected:
        return None
    gram = mp.matrix(
        [[sum(x * y for x, y in zip(a, b)) for b in selected] for a in selected]
    )
    weights = mp.lu_solve(gram, mp.matrix(targets))
    return [
        sum(weights[k] * row[j] for k, row in enumerate(selected))
        for j in range(len(rows[0]))
    ]


def solve(data, iterations):
    config = validate_input(data)
    container = data.get("container") or initial_container(config)
    variables = [D(p[k]) for p in config["pieces"] for k in ("x", "y", "theta")]
    variables.extend(D(container[k]) for k in ("cx", "cy", "phi", "size"))
    if not all(mp.isfinite(v) for v in variables) or variables[-1] <= 0:
        raise ValueError("container must be finite with positive size")
    cache = FeasibilityContacts(config)
    safety = D("1e-44")
    convergence = D("1e-40")
    conversion = 1 if config["M"] == 0 else 2 * mp.tan(mp.pi / config["M"])
    baseline_valid, baseline_score = float_evaluate(config)

    def restore(trial):
        for _ in range(30):
            pairs = [c for c in cache.get(trial) if c["kind"] == "pair"]
            gaps, rows = residuals(config, trial, pairs, True)
            if min(gaps, default=D(0)) >= -safety:
                break
            for gap, row in zip(gaps, rows):
                if gap >= -safety:
                    continue
                # Translation-only pair repair is exact for a fixed SAT face.
                i = next(j for j in range(config["P"]) if row[3 * j] or row[3 * j + 1])
                norm2 = 2 * (row[3 * i] ** 2 + row[3 * i + 1] ** 2)
                if norm2:
                    amount = (-gap + safety) / norm2
                    trial = [
                        v + amount * d if j % 3 != 2 and j < 3 * config["P"] else v
                        for j, (v, d) in enumerate(zip(trial, row))
                    ]
        boundary_gaps = residuals(config, trial, cache.boundary)
        shortage = max(D(0), -min(boundary_gaps, default=D(0)))
        trial[-1] += (shortage + safety) * conversion
        return trial

    # Tight float64 seeds usually violate exact contacts by a few ulps. Solve
    # those equations before pair restoration, which converges only linearly.
    initial_complete = cache.get(variables)
    initial_gaps = residuals(config, variables, initial_complete)
    initial_newton_steps = 0
    initial_active = [
        contact
        for contact, gap in zip(initial_complete, initial_gaps)
        if abs(gap) < D("1e-7")
    ]
    supplied_gaps = residuals(config, variables, data["contacts"])
    for contact, gap in zip(data["contacts"], supplied_gaps):
        if abs(gap) < D("1e-7") and contact not in initial_active:
            initial_active.append(contact)
    initial_trial = variables[:]
    for _ in range(10):
        gaps, rows = residuals(config, initial_trial, initial_active, True)
        if max((abs(gap) for gap in gaps), default=D(0)) < convergence:
            break
        correction = minimum_norm_correction(rows, [-gap for gap in gaps])
        if correction is None or max(map(abs, correction)) > D("0.01"):
            break
        initial_trial = [v + delta for v, delta in zip(initial_trial, correction)]
        initial_newton_steps += 1
    if (
        min(residuals(config, initial_trial, cache.get(initial_trial)), default=D(0))
        >= -convergence
    ):
        variables = initial_trial
    variables = restore(variables)
    best = (
        variables[:]
        if min(residuals(config, variables, cache.get(variables)), default=D(0))
        >= -safety
        else None
    )
    trust = D("0.05")
    completed = 0
    for step in range(iterations):
        completed = step + 1
        complete = cache.get(variables)
        gaps, rows = residuals(config, variables, complete, True)
        tight_rows = [row for gap, row in zip(gaps, rows) if abs(gap) < D("1e-7")]
        if tight_rows:
            correction = minimum_norm_correction(
                tight_rows, [row[-1] for row in tight_rows]
            )
            if correction is not None and abs(D(1) - correction[-1]) < D("1e-25"):
                break
        selected = [i for i, gap in enumerate(gaps) if gap < max(D("0.01"), trust * 4)]
        active_rows = [rows[i] for i in selected]
        active_gaps = [gaps[i] for i in selected]
        direction = [D(0)] * len(variables)
        direction[-1] = -trust
        multipliers = [D(0)] * len(selected)
        norms = [sum(v * v for v in row) for row in active_rows]
        # The contraction stage needs modest accuracy. High precision is reached
        # by the Newton contact solve below rather than thousands of QP sweeps.
        for _ in range(100):
            largest = D(0)
            for k, row in enumerate(active_rows):
                if norms[k] < D("1e-45"):
                    continue
                new = max(
                    D(0),
                    multipliers[k]
                    + (
                        -active_gaps[k]
                        + safety
                        - sum(v * d for v, d in zip(row, direction))
                    )
                    / norms[k],
                )
                delta = new - multipliers[k]
                multipliers[k] = new
                largest = max(largest, abs(delta))
                direction = [d + delta * v for d, v in zip(direction, row)]
            if largest < max(D("1e-18"), trust * D("1e-8")):
                break
        accepted = False
        for line in range(12):
            trial = restore([v + d / (2**line) for v, d in zip(variables, direction)])
            if min(
                residuals(config, trial, cache.get(trial)), default=D(0)
            ) >= -safety and (best is None or trial[-1] < best[-1]):
                best, variables = trial[:], trial
                accepted = True
                break
        if not accepted:
            trust /= 4
        if trust < D("1e-16"):
            break

    # Project near contacts to zero with minimum-norm Newton steps. Overlapping
    # or worse projections are rejected; the verified feasible best is retained.
    newton_steps = initial_newton_steps
    active_residual = None
    if best is not None:
        complete = cache.get(best)
        gaps = residuals(config, best, complete)
        active = [
            contact for contact, gap in zip(complete, gaps) if abs(gap) < D("1e-7")
        ]
        trial = best[:]
        for _ in range(16):
            gaps, rows = residuals(config, trial, active, True)
            active_residual = max((abs(gap) for gap in gaps), default=D(0))
            if active_residual < convergence:
                break
            correction = minimum_norm_correction(rows, [-gap for gap in gaps])
            if correction is None or max(map(abs, correction)) > D("0.01"):
                break
            trial = [v + d for v, d in zip(trial, correction)]
            newton_steps += 1
        trial_gaps = residuals(config, trial, cache.get(trial))
        # A tiny outward restoration preserves contact residuals to working
        # precision while avoiding rejection for 50-digit roundoff.
        if (
            min(trial_gaps, default=D(0)) >= -convergence
            and trial[-1] <= best[-1] + convergence
        ):
            trial = restore(trial)
            if min(residuals(config, trial, cache.get(trial)), default=D(0)) >= -safety:
                best = trial
        final_active = residuals(config, best, active)
        active_residual = (
            max((abs(gap) for gap in final_active), default=D(0)) if active else None
        )
    if best is None:
        return {
            "config": config if baseline_valid else None,
            "valid": baseline_valid,
            "container_size_50_digits": None,
            "reason": "no feasible high-precision contact solution found",
        }
    refined = {
        **config,
        "container_phi": float(best[-2]),
        "pieces": [
            dict(zip(("x", "y", "theta"), map(float, best[3 * i : 3 * i + 3])))
            for i in range(config["P"])
        ],
    }
    representable = mp.isfinite(D(refined["container_phi"])) and all(
        mp.isfinite(D(pose[key])) and (key == "theta" or abs(pose[key]) <= 1e6)
        for pose in refined["pieces"]
        for key in ("x", "y", "theta")
    )
    valid, score = float_evaluate(refined) if representable else (False, None)
    if not valid or (baseline_valid and score > baseline_score):
        return {
            "config": config if baseline_valid else None,
            "valid": baseline_valid,
            "container_size_50_digits": None,
            "reason": "float64 validity/score fallback; revalidate in TypeScript",
        }
    digits = (
        max(0, min(50, int(-mp.log10(active_residual))))
        if active_residual
        else (50 if active_residual == 0 else 0)
    )
    return {
        "config": refined,
        "valid": True,
        "container": dict(zip(("cx", "cy", "phi", "size"), map(float, best[-4:]))),
        "container_size_50_digits": mp.nstr(best[-1], 50),
        "variables_50_digits": [mp.nstr(v, 50) for v in best],
        "working_precision_digits": 50,
        "achieved_contact_residual_digits": digits,
        "maximum_active_contact_residual": mp.nstr(active_residual, 50)
        if active_residual is not None
        else None,
        "minimum_constraint_gap": mp.nstr(
            min(residuals(config, best, cache.get(best)), default=D(0)), 50
        ),
        "iterations": completed,
        "newton_steps": newton_steps,
        "note": "Residual digits measure the contact equations, not correct score digits or optimality. Revalidate through scripts/validate-polish.ts.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "input", help="configuration/contact-system JSON file; - reads stdin"
    )
    parser.add_argument("--out", help="output JSON path; default stdout")
    parser.add_argument("--iterations", type=int, default=80)
    args = parser.parse_args()
    if not 0 <= args.iterations <= 1000:
        parser.error("--iterations must be between 0 and 1000")
    try:
        data = (
            json.load(sys.stdin)
            if args.input == "-"
            else json.loads(Path(args.input).read_text())
        )
        result = solve(data, args.iterations)
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        parser.error(str(exc))
    output = json.dumps(result, indent=2) + "\n"
    if args.out:
        Path(args.out).write_text(output)
    else:
        sys.stdout.write(output)


if __name__ == "__main__":
    main()
