#!/usr/bin/env python3
"""Builds data/polyhedra/records.json (offline tool; standard library only, certification by certify.py).

usage: python3 python/polyhedra/build_records.py --upstream DIR --site FILE [--ours DIR] [--search DIR ...]
                                                 [--polypack DIR] [--nmax 100] [--jobs 2] [--no-certify]
                                                 [--skip FILE] [--out data/polyhedra/records.json]
       python3 python/polyhedra/build_records.py --keep data/polyhedra/records.json [--polypack DIR] [--search DIR ...]
                                                 [--jobs 2]

  --upstream  a checkout of github.com/alejandrozu/platonic-packing at commit cbf76f2f (records/, docs/)
  --site      polyhedrainpolyhedra.wiki's data bundle /data/records.json of the same build (the site's selection of
              the best record per case and the published reference values it shows; not in the repository)
  --ours      PolyPack research results: a directory with results/improvements.csv and the files it names
              (upstream record format), whose packings of m pieces cover every n <= m by deleting pieces
  --polypack  the records of PolyPack's own problems (catalogue.py, not in WIKI_PROBLEMS): <code>.json per problem,
              {code, piece, container, records: [{P, s, config: [P poses], method, seed[, start, runs, date]}]}; each
              is certified and becomes a PolyPack research record after the wiki's problems (start and runs, when
              given, are origin.start and origin.runs as they are; otherwise they are read from the method; date,
              when given, is origin.date, else 2026-10-25)
  --keep      an existing records.json whose records are kept exactly as they are (index entries and
              configs/<code>.jsonl untouched), except those of the PolyPack problems that have a file in --polypack,
              which are built from it, and those of the wiki's problems that a result in --search replaces: a
              result started from the kept record (start "warm", record_file its origin.file; its runs, when given,
              become origin.runs), certified, replaces a PolyPack research record when it is smaller at all and a
              record of the wiki's only when smaller by more than 1e-5 relative (as in a full build); the
              configuration files of those problems are rewritten

For every problem of catalogue.py and n = 2..nmax the candidates are every upstream record file of the case
(records/<p>/, records/community/<p>/, records/external/<p>/ and the files the site lists) and, from --ours, a
packing of m >= n pieces of the problem with m - n pieces deleted. The upstream candidate with the smallest s_full
is the wiki's record; ours replaces it only when it is smaller by more than 1e-5 relative (the wiki floors s at 5
decimals; smaller gains are the clearance convention, not a better packing). The chosen configuration is stored exactly as its file gives it
(PolyPack changes only the format), except that a subset of one of our packings gets the smallest container
scale with wall clearance 1e-7 at the same centres. It must then pass certify.certify_config, else the next
candidate is taken.

Provenance: each record keeps upstream's found_by and credit strings and lists the sources its geometry rests on
(`sources`, keys of the file's `sources` table) with a citation sentence (`source`); see docs/spaces/POLYHEDRA.md.
"""
import argparse
import csv
import glob
import json
import math
import os
import re
import sys
import time
from decimal import ROUND_HALF_EVEN, Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalogue  # noqa: E402
import certify  # noqa: E402

UPSTREAM_COMMIT = 'cbf76f2f6fb33a0380b9a283c00c6e62cce22e78'
UPSTREAM = 'https://github.com/alejandrozu/platonic-packing'
KAMP_COMMIT = '27f71632d8655ae4b6a049410a401976748b94e3'
HYRA_COMMIT = '09b2d2e3c362c67a78f544c836bd8e4b54a05527'
SHEPARD_COMMIT = 'c107fda33c2f02df83e9d549fb839b4fd5a7bfbc'
TRONFORD_COMMIT = '1f0c75401b2da4850b7e9f14de7d7b9cbe5e461a'
NAKAJIMA_COMMIT = 'efe7a920142350a4f0678633490c3e3dbed71fa0'
RYXU_COMMIT = '9535d65d84cc33f20f4e26329f8da12bdcef216e'
OUR_MARGIN = 1e-5                 # the wiki shows s floored at 5 decimals; smaller gains are clearance conventions
WIKI_METHOD = {
    'platonic': 'soft-to-rigid homotopy (inscribed balls hardened into the solid under inward pressure), then SLSQP '
                'tightening with per-pair separating planes',
    'families': 'generalized soft-to-rigid homotopy (r-rounding of the solid hardened under inward pressure), basin '
                'hopping, then sequential-LP / SLSQP tightening with per-pair separating planes',
}
WIKI_CREDIT_FAMILIES = ('soft-to-rigid method by Yohei Nakajima (2026); generalization to Archimedean, Catalan, prism and '
                        'antiprism solids, basin-hopping search and certification developed with Claude (Anthropic) '
                        'under Alejandro Zarzuelo\'s direction')
WIKI_CREDIT = ('soft-to-rigid method by Yohei Nakajima (2026); generalization to Platonic solids, basin-hopping '
               'search and exact certification developed with Claude (Anthropic) under Alejandro Zarzuelo\'s direction')
CLEAR = 1e-7

# The sources a record's geometry can rest on. `licence` says on what terms the data is used here.
SOURCES = {
    'wiki': {
        'title': 'polyhedrainpolyhedra.wiki (records of alejandrozu/platonic-packing)',
        'authors': 'Alejandro Zarzuelo; soft-to-rigid method by Yohei Nakajima',
        'url': f'{UPSTREAM}/tree/{UPSTREAM_COMMIT}',
        'commit': UPSTREAM_COMMIT,
        'licence': 'MIT (THIRD_PARTY_NOTICES.md)',
        'credit': {'platonic': WIKI_CREDIT, 'families': WIKI_CREDIT_FAMILIES},
        'method': WIKI_METHOD,
        'note': 'a wiki record without a credit or method field has the standard one of its family (platonic or the '
                'other families) given here',
        'files': f'{UPSTREAM}/blob/{UPSTREAM_COMMIT}/<origin.file>',
    },
    'kamp': {
        'title': 'T. Berthold, D. Kamp, G. Mexi, S. Pokutta, I. Polik, Out-of-the-Box Global Optimization for Packing '
                 'Problems: New Models and Improved Solutions, submitted to the Journal of Global Optimization, 2026, '
                 'arXiv:2605.04850; online supplement',
        'authors': 'Timo Berthold, Dominik Kamp, Gioni Mexi, Sebastian Pokutta, Imre Polik',
        'url': f'https://github.com/DominikKamp/Packing/tree/{KAMP_COMMIT}/platonic',
        'commit': KAMP_COMMIT,
        'licence': 'the repository states no licence; used with citation to the paper and the repository',
    },
    'hyra': {
        'title': 'Hyra-results, AI4Science/packing_records (Haowei Lin, Tencent Hunyuan)',
        'authors': 'Haowei Lin (Tencent Hunyuan)',
        'url': f'https://github.com/Tencent-Hunyuan/Hyra-results/tree/{HYRA_COMMIT}/AI4Science/packing_records/records',
        'commit': HYRA_COMMIT,
        'licence': 'Apache License 2.0, Copyright (C) 2026 Tencent (LICENSES/Apache-2.0.txt); modified, see notes',
    },
    'shepard5': {
        'title': 'hyra-packing-audit, tightened/ (Sam Scott)',
        'authors': 'Sam Scott',
        'url': f'https://github.com/shepard5/hyra-packing-audit/tree/{SHEPARD_COMMIT}/tightened',
        'commit': SHEPARD_COMMIT,
        'licence': 'MIT, Copyright (c) 2026 Sam Scott; derived from Apache-2.0 data of Tencent (its NOTICE is in '
                   'THIRD_PARTY_NOTICES.md)',
    },
    'tronford': {
        'title': 'cubes-in-cube-n13 (@BuilderOfAgents)',
        'authors': '@BuilderOfAgents; soft-to-rigid method by Yohei Nakajima',
        'url': f'https://github.com/tronford/cubes-in-cube-n13/tree/{TRONFORD_COMMIT}/claims',
        'commit': TRONFORD_COMMIT,
        'licence': 'MIT, Copyright (c) 2026 Yohei Nakajima and Copyright (c) 2026 @BuilderOfAgents',
    },
    'nakajima': {
        'title': 'soft-to-rigid-packing, claims/cubincub_n12 (Yohei Nakajima)',
        'authors': 'Yohei Nakajima',
        'url': f'https://github.com/yoheinakajima/soft-to-rigid-packing/tree/{NAKAJIMA_COMMIT}/claims',
        'commit': NAKAJIMA_COMMIT,
        'licence': 'MIT, Copyright (c) 2026 Yohei Nakajima',
    },
    'ryxu': {
        'title': 'square_packing, cube_packing_records.json (Ryan Xu)',
        'authors': 'Ryan Xu',
        'url': f'https://github.com/ry-xu/square_packing/blob/{RYXU_COMMIT}/cube_packing_records.json',
        'commit': RYXU_COMMIT,
        'licence': 'the repository states no licence; used with citation',
    },
    'konoha_issue1': {
        'title': 'exact certificates for cubes in a cube posted by konoha-ily2 (Hirotaka Nakano) in '
                 'alejandrozu/platonic-packing issue #1',
        'authors': 'konoha-ily2 (Hirotaka Nakano)',
        'url': f'{UPSTREAM}/issues/1',
        'commit': None,
        'licence': 'no licence stated with the post; used with citation',
    },
    'community': {
        'title': 'community submissions to polyhedrainpolyhedra.wiki (GitHub issues of alejandrozu/platonic-packing)',
        'authors': 'the submitters named in found_by and certificate_refined_by',
        'url': f'{UPSTREAM}/issues',
        'commit': None,
        'licence': 'MIT (each submission carries the form\'s permission to publish it under the repository\'s MIT '
                   'licence)',
    },
    'friedman': {
        'title': "Erich Friedman's Packing Center (constructions reconstructed by upstream; images not copied)",
        'authors': 'Erich Friedman',
        'url': 'https://erich-friedman.github.io/packing/',
        'commit': None,
        'licence': 'upstream-made coordinates (MIT); the construction is credited to Erich Friedman',
    },
    'polypack': {
        'title': 'PolyPack research (crystal cuts and searches, 2026-10-23; constructions and searches for PolyPack\'s '
                 'prism and antiprism problems, 2026-10-25)',
        'authors': 'PolyPack research',
        'url': 'https://github.com/sinkomr/PolyPack/blob/main/docs/spaces/POLYHEDRA.md',
        'commit': None,
        'licence': 'MIT (this repository)',
    },
}
KAMP_CITE = ('Berthold, Kamp, Mexi, Pokutta and Polik 2026 (arXiv:2605.04850; supplement '
             f'https://github.com/DominikKamp/Packing at {KAMP_COMMIT[:7]})')
HYRA_CITE = (f'Haowei Lin, Tencent Hunyuan, Hyra-results at {HYRA_COMMIT[:7]} (Copyright (C) 2026 Tencent, Apache-2.0)')


def display(x):
    return str(Decimal(x).quantize(Decimal('0.000001'), rounding=ROUND_HALF_EVEN))


def text_of(r):
    s = r.get('search') or {}
    con = r.get('contribution') or {}
    return ' '.join(str(x) for x in (r.get('found_by'), r.get('credit'), s.get('lineage'), s.get('source'),
                                     r.get('certificate_refined_by'), con.get('credit'), con.get('issue'),
                                     r.get('attribution'), r.get('source_credit')) if x)


def provenance(path, r, code, n):
    """Source keys of an upstream file's geometry, in citation order."""
    t = text_of(r)
    keys = ['wiki']
    if 'Berthold' in t or 'Kamp' in t or '_kamp' in path:
        keys.append('kamp')
    if 'Sam Scott' in t or 'shepard5' in path:
        keys += ['hyra', 'shepard5']
    elif 'Hyra' in t or 'Haowei Lin' in t or 'H. Lin' in t or '_hyra' in path:
        keys.append('hyra')
    if 'BuilderOfAgents' in t or '_builderofagents' in path:
        keys.append('tronford')
    if '/external/' in path and 'Yohei Nakajima' in str(r.get('found_by')):
        keys.append('nakajima')
    if 'Ryan Xu' in t:
        keys.append('ryxu')
    if 'konoha' in t and code == 'cubincub' and n in (28, 34, 35, 36) and 'issues/98' not in t:
        keys.append('konoha_issue1')
    if any(w in t for w in ('PingYou', 'konoha', 'Stian', 'trivial: subset')) or '/community/' in path:
        if 'konoha_issue1' not in keys or 'PingYou' in t:
            keys.append('community')
    if 'Friedman' in t and 'reconstruction' in t:
        keys.append('friedman')
    return list(dict.fromkeys(keys))


def citation(keys, r):
    """One sentence naming what the geometry rests on."""
    parts = ['from polyhedrainpolyhedra.wiki (alejandrozu/platonic-packing, MIT, commit cbf76f2f)']
    if 'kamp' in keys:
        parts.append('derived from ' + KAMP_CITE)
    if 'hyra' in keys:
        parts.append('derived from ' + HYRA_CITE + ('; tightened by Sam Scott (hyra-packing-audit, MIT)'
                                                    if 'shepard5' in keys else ''))
    if 'tronford' in keys:
        parts.append('packing by @BuilderOfAgents (tronford/cubes-in-cube-n13, MIT)')
    if 'nakajima' in keys:
        parts.append('packing by Yohei Nakajima (soft-to-rigid-packing, MIT)')
    if 'ryxu' in keys:
        parts.append('derived from Ryan Xu, square_packing (no licence stated)')
    if 'konoha_issue1' in keys:
        parts.append('construction by konoha-ily2 posted in upstream issue #1 (no licence stated)')
    if 'friedman' in keys:
        parts.append("construction of Erich Friedman's Packing Center, coordinates reconstructed upstream")
    return '; '.join(parts)


def apache_note(keys):
    if 'hyra' not in keys:
        return None
    return ('Apache-2.0 data modified: Haowei Lin\'s published arrangement was converted by upstream to unit-edge '
            'coordinates with the container centred at the origin and 1e-7 clearance'
            + (', tightened by Sam Scott' if 'shepard5' in keys else '')
            + ' and re-tightened by upstream\'s search where its found_by says so; PolyPack converted the result to '
            'its own record format without changing the coordinates.')


class Case:
    def __init__(self, code, n):
        self.code, self.n = code, n
        self.piece, self.container, self.family = catalogue.PROBLEMS[code]


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def upstream_candidates(U, code, n, row):
    files = set()
    for pat in (f'records/{code}/{code}_n{n:02d}.json', f'records/community/{code}/{code}_n{n:02d}_*.json',
                f'records/external/{code}/{code}_n{n:02d}_*.json'):
        files.update(os.path.relpath(f, U) for f in glob.glob(os.path.join(U, pat)))
    if row:
        for x in [row] + list(row.get('alternatives') or []):
            if x.get('file'):
                files.add(x['file'])
    out = []
    for f in sorted(files):
        r = load(os.path.join(U, f))
        if not r or r.get('n') != n or not isinstance(r.get('pieces'), list) or len(r['pieces']) != n:
            continue
        cc = r.get('container_center', [0, 0, 0])
        if any(c != 0 for c in cc):
            continue                                   # none in this commit; a translation would change the floats
        out.append({'file': f, 'rec': r, 's': float(r['s_full'])})
    return out


def our_candidates(ours, code, n, upstream_rows):
    """Our packings of m >= n pieces listed in improvements.csv for (code, n)."""
    if not ours:
        return []
    out = []
    for row in upstream_rows.get((code, n), []):
        r = load(os.path.join(ours, row['source']))
        if not r or r.get('problem') != code or len(r.get('pieces', [])) < n:
            continue
        out.append({'file': row['source'], 'rec': r, 's': float(r['s_full'])})
    return out


def load_search(dirs, label=None):
    """PolyPack search results (packages/polyhedra/scripts/improve.ts): code -> list of candidates. Their origin
    file is search/<file>, or <label of the directory>/<file> with label=True (--keep mode)."""
    out = {}
    for d in dirs or []:
        prefix = os.path.basename(os.path.normpath(d)) if label else 'search'
        for f in sorted(glob.glob(os.path.join(d, '*.json'))):
            r = load(f)
            if not r or r.get('code') not in catalogue.PROBLEMS or not isinstance(r.get('pieces'), list):
                continue
            rec = dict(r, problem=r['code'], method=r.get('method'))
            out.setdefault(r['code'], []).append({'file': f'{prefix}/{os.path.basename(f)}', 'rec': rec,
                                                  's': float(r['s_full'])})
    return out


def study_runs(ours):
    """The compute study's search runs, read from its logs runs/main/<code>_nNN_<method>_<seed>.log: case -> runs.

    Each run has its method, seed, base file, the record's s, its initial best and its new bests with their times.
    A log line starts with a clock time HH:MM:SS; the study ran from one evening into the night (23:25 to 01:15),
    so a time before noon is on the next day."""
    runs = {}
    for path in sorted(glob.glob(os.path.join(ours or '', 'runs', 'main', '*.log'))):
        run = None
        for line in open(path):
            m = re.match(r'(\d\d):(\d\d):(\d\d) (.*)$', line.rstrip('\n'))
            if not m:
                continue
            h, msg = int(m.group(1)), m.group(4).strip()
            t = ((h + 24 if h < 12 else h) * 60 + int(m.group(2))) * 60 + int(m.group(3))
            if msg.startswith('start '):
                f = dict(kv.split('=', 1) for kv in msg.split()[2:])
                run = {'method': f['method'], 'seed': int(f['seed']), 'n': int(f['n']),
                       'base': None if f['base'] == 'None' else f['base'],
                       'record': None if f['record'] == 'None' else float(f['record']), 'start': t, 'bests': []}
                runs.setdefault(f"{msg.split()[1]}_n{int(f['n']):02d}", []).append(run)
            elif run and msg.startswith('initial best '):
                run['initial'] = float(msg.split()[2])
            elif run and msg.startswith('NEW BEST '):
                run['bests'].append((t, float(msg.split()[2])))
    return runs


def study_lineage(runs, key, s):
    """How the compute study found its best packing of a case (key <code>_nNN, scale s), traced through the logs.

    Returns (start, path, steps): start 'record' with upstream's file that the study's search read (the record of
    the case, or of n -+ 1 for plus1 / minus1), 'file' with the base packing of an insert / subset run, or
    'random' with None; steps are the runs from that start on. The run that logged s found the best; a hop
    started from the best on file at the time, the latest earlier new best of any run of the case, else from the
    run's initial best, which is the record when no best existed yet."""
    code, n = key.rsplit('_n', 1)[0], int(key.rsplit('_n', 1)[1])
    events = sorted((t, v, i) for i, r in enumerate(runs.get(key, [])) for t, v in r['bests'])
    found = [e for e in events if abs(e[1] - s) <= 1e-8 * s]
    if not found:
        raise ValueError(f'{key}: no logged run reached s = {s}')
    t, v, i = found[-1]
    steps = []
    while True:
        run = runs[key][i]
        step = f"{run['method']} (seed {run['seed']}, n = {n})"
        if not steps or steps[0] != step:
            steps.insert(0, step)
        if run['method'] == 'random':
            return 'random', None, steps
        if run['method'] in ('plus1', 'minus1'):
            return 'record', f"records/{code}/{code}_n{n - 1 if run['method'] == 'plus1' else n + 1:02d}.json", steps
        if run['method'] in ('insert', 'subset'):
            return 'file', run['base'], steps
        if run['method'] != 'hop':
            raise ValueError(f'{key}: method {run["method"]} has no known start')
        earlier = [e for e in events if e[0] < t and e[1] > v]
        if earlier:
            t, v, i = earlier[-1]
            continue
        if run.get('initial') is not None and run['record'] is not None and run['initial'] == run['record']:
            return 'record', f'records/{code}/{code}_n{n:02d}.json', steps
        raise ValueError(f'{key}: the start of {step} is not in the logs')


def study_chain(ours, runs, file):
    """study_lineage of a compute-study best file, followed through bases that are other cases' best files."""
    r = load(os.path.join(ours, file))
    key = os.path.basename(file)[:-len('_best.json')]
    start, path, steps = study_lineage(runs, key, float(r['s_full']))
    if start == 'file' and path.startswith('runs/main/'):
        base_key = os.path.basename(path)[:-len('_best.json')]
        used = min(x['start'] for x in runs[key] if x['base'] == path)
        if any(t >= used for x in runs.get(base_key, []) for t, _ in x['bests']):
            raise ValueError(f'{key}: its base {path} changed after the run read it')
        start, path, pre = study_chain(ours, runs, path)
        steps = pre + steps
    return start, path, steps


def start_of(U, ours, runs, code, m, record_file):
    """(source keys, credit, record) of the packing a PolyPack search started from."""
    if record_file and record_file.startswith('records/'):
        r = load(os.path.join(U, record_file))
        if r:
            return provenance(record_file, r, code, m), f"{r.get('found_by')}, {record_file}", r
    if record_file and record_file.startswith('runs/main/'):
        # a compute-study packing: credit what its own search started from (its run logs), if that was upstream's
        start, path, _ = study_chain(ours, runs, record_file)
        if start == 'record':
            r = load(os.path.join(U, path))
            return (['polypack'] + provenance(path, r, code, r['n']),
                    f"PolyPack research, which started from {r.get('found_by')}, {path}", r)
    return ['polypack'], 'PolyPack research', None


def subset(case, r):
    """n pieces of a packing of m >= n, and the smallest scale with wall clearance 1e-7 at the same centres."""
    import certify_general as cg
    P, C = cg.get_solid(case.piece), cg.get_solid(case.container)
    pieces = [list(map(float, p)) for p in r['pieces']]
    Nf = [[(c[0] + c[1]) / 2 / cg.ONE for c in m] for m in C.N]
    Bf = [(b[0] + b[1]) / 2 / cg.ONE for b in C.B]
    lens = [math.sqrt(sum(x * x for x in m)) for m in Nf]
    Nu = [[x / l for x in m] for m, l in zip(Nf, lens)]
    bu = [b / l for b, l in zip(Bf, lens)]

    def ratio(p):
        w, x, y, z = p[3:]
        q = math.sqrt(w * w + x * x + y * y + z * z)
        w, x, y, z = w / q, x / q, y / q, z / q
        R = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
             [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
             [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]]
        best = 0.0
        for v in P.Vf:
            X = [p[k] + sum(R[k][j] * v[j] for j in range(3)) for k in range(3)]
            for nu, b in zip(Nu, bu):
                best = max(best, (sum(a * c for a, c in zip(nu, X)) + CLEAR) / b)
        return best

    keep = list(range(len(pieces)))
    while len(keep) > case.n:
        worst = max(keep, key=lambda i: ratio(pieces[i]))
        keep.remove(worst)
    sel = [pieces[i] for i in keep]
    s = max(ratio(p) for p in sel) * (1 + 1e-12)
    return sel, min(s, float(r['s_full']))


def tight_scale(case, pieces):
    """Float container scale of the stored poses (pieces keep their pair clearance): max N_f.x / b_f."""
    import certify_general as cg
    P, C = cg.get_solid(case.piece), cg.get_solid(case.container)
    Nf = [[(c[0] + c[1]) / 2 / cg.ONE for c in m] for m in C.N]
    Bf = [(b[0] + b[1]) / 2 / cg.ONE for b in C.B]
    best = 0.0
    for p in pieces:
        w, x, y, z = p[3:]
        q = math.sqrt(w * w + x * x + y * y + z * z)
        w, x, y, z = w / q, x / q, y / q, z / q
        R = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
             [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
             [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]]
        for v in P.Vf:
            X = [p[k] + sum(R[k][j] * v[j] for j in range(3)) for k in range(3)]
            for nf, b in zip(Nf, Bf):
                best = max(best, sum(a * c for a, c in zip(nf, X)) / b)
    return best


def literature_of(code, n, row, external):
    """Published values of the case without coordinates: the site's reference value and catalogue entries."""
    out = []
    if row and isinstance(row.get('ref'), (int, float)):
        out.append({'value': float(row['ref']), 'source': row.get('refsrc') or 'published value',
                    'url': row.get('refurl'), 'precision': row.get('ref_quantum'),
                    'kind': 'published', 'coordinates': False})
    for e in external.get((code, n), []):
        if e.get('kind') not in ('catalogue', 'author_report') or not isinstance(e.get('published_value'), (int, float)):
            continue
        v = float(e['published_value'])
        if any(abs(x['value'] - v) <= 1e-12 * v and x['source'] == e.get('author') for x in out):
            continue
        out.append({'value': v, 'source': e.get('author'), 'url': e.get('url'), 'reference': e.get('original_reference'),
                    'precision': e.get('display_quantum'), 'kind': e['kind'], 'coordinates': False})
    return out


START_CREDIT = "PolyPack research (search started from the wiki's packing: "


def make_record(case, cand, mine, wiki_best, row, literature, volumes):
    r = cand['rec']
    code, n = case.code, case.n
    if mine:
        pieces, s = cand['pieces'], cand['s_cert']
        start = cand.get('start_keys') or []
        keys = ['polypack'] + [k for k in start if k != 'polypack']
        found_by = 'PolyPack research'
        credit = START_CREDIT + f"{cand['start_credit']})" if cand.get('start_credit') else 'PolyPack research'
        method = r.get('method', 'PolyPack research')
        if len(r['pieces']) > n:
            method += f'; {len(r["pieces"]) - n} of its {len(r["pieces"])} pieces deleted, container rescaled to wall clearance 1e-7'
        src = {'file': cand['file'], 'date': r.get('date', '2026-10-23')}
        if r.get('seed') is not None:
            src.update(seed=r['seed'], evaluations=r.get('evals'))
        if r.get('start') == 'warm' and r.get('record_file'):
            src['start'] = r['record_file']                  # the record the search started from
        if r.get('runs'):
            src['runs'] = list(r['runs'])                    # its steps from that start, when the result names them
        src.update(cand.get('study') or {})                  # a compute-study search: its start and runs
        upstream_keys = [k for k in start if k != 'polypack']
        cite = 'PolyPack research' + ('; started from a packing ' + citation(upstream_keys, cand['start_rec'])
                                      if upstream_keys else '')
    else:
        pieces, s = [list(map(float, p)) for p in r['pieces']], float(r['s_full'])
        keys = provenance(cand['file'], r, code, n)
        found_by = r.get('found_by') or 'Alejandro Zarzuelo'
        # upstream's standard credit and method of the family are kept once, in the wiki source
        fam = 'platonic' if case.family == 'platonic' else 'families'
        std_credit = WIKI_CREDIT if fam == 'platonic' else WIKI_CREDIT_FAMILIES
        credit = r.get('credit') if r.get('credit') != std_credit else None
        method = r.get('method') if r.get('method') != WIKI_METHOD[fam] else None
        src = {'file': cand['file'], 'date': r.get('date')}
        cite = citation(keys, r)
    rec = {
        'id': f'polyhedra/{code}/{n}', 'code': code, 'piece': case.piece, 'container': case.container,
        'family': case.family, 'P': n,
        'score_float': tight_scale(case, pieces), 'score_cert': s, 'display': display(s), 'status': 'best_known',
        'config': {'s': s, 'pieces': pieces},
        'bound': {'value': certify.volume_bound(case.piece, case.container, n, volumes), 'kind': 'volume'},
        'found_by': found_by, 'credit': credit,
        'lineage': (r.get('search') or {}).get('lineage') if not mine else None,
        'certificate_refined_by': r.get('certificate_refined_by') if not mine else None,
        'method': method, 'sources': keys, 'source': cite, 'origin': src,
        'wiki': {'s_full': wiki_best['s'], 'url': catalogue_wiki(code, n),
                 **({'file': wiki_best['file']} if wiki_best['file'] != cand['file'] else {})},
        'literature': literature,
    }
    if not mine and isinstance(r.get('s_tight'), (int, float)):
        rec['s_tight'] = float(r['s_tight'])
    notes = [x for x in (apache_note(keys),) if x]
    if s / rec['bound']['value'] - 1 < 1e-6:
        notes.append('[CALC] meets its volume bound to 1e-6 (the pieces tile the container), so it is optimal by the '
                     'volume argument; the status stays best_known (PolyPack marks proven only with a published proof)')
    if notes:
        rec['notes'] = ' '.join(notes)
    return {k: v for k, v in rec.items() if v is not None}


def catalogue_wiki(code, n):
    return f'https://polyhedrainpolyhedra.wiki/#{code}_n{n:02d}'


def certify_case(args):
    case, cands, volumes = args
    for cand in cands:
        try:
            c = certify.certify_config(case.piece, case.container, cand['s_cert'], cand['pieces'])
        except certify.CertError as e:
            c = {'ok': False, 'err': str(e)}
        if c['ok']:
            return cand, c
    return None, None


POLYPACK_SEARCH = 'PolyPack polyhedra search ('
POLYPACK_DATE = '2026-10-25'


def polypack_steps(method):
    """The steps of a --polypack record's method, from its start on: (start, runs). start is the construction the
    lineage begins with, or None for a search from random positions; runs are the searches and subset steps."""
    m = method.strip()
    if m.startswith('the configuration of ') and m.endswith(' of them, at the same s'):
        head, _, tail = m.partition(' pieces (')
        base, sep, rest = tail.rpartition(') less ')
        if not sep:
            raise ValueError(f'unreadable subset method: {m[:80]}')
        start, runs = polypack_steps(base)
        return start, runs + [f'subset of the configuration of {head.split()[-1]} pieces, at its s']
    if m.startswith('from the configuration of '):
        head, _, tail = m.partition(' pieces (')
        base, sep, rest = tail.rpartition(') by removing pieces one at a time, ')
        if not sep:
            raise ValueError(f'unreadable subset method: {m[:80]}')
        start, runs = polypack_steps(base)
        return start, runs + [f'subset of the configuration of {head.split()[-1]} pieces: pieces removed one at a '
                              f'time, {rest}']
    if m.startswith(POLYPACK_SEARCH):
        what, sep, budget = m.rpartition('; seed ')
        if not sep:
            raise ValueError(f'unreadable search method: {m[:80]}')
        step = f'search: {{}}, seed {budget}'
        if ': polish and hops started from ' in what:
            inner = what.split(': polish and hops started from ', 1)[1]
            start, runs = polypack_steps(inner)
            return start, runs + [step.format('polish and hops')]
        if 'soft-to-rigid run from random balls' in what:
            return None, [step.format('soft-to-rigid run from random balls, polish and hops')]
        raise ValueError(f'unreadable search method: {m[:80]}')
    return m, []


def polypack_short(start, runs):
    """origin.start and origin.runs in short (the method states them in full)."""
    st = None
    if start and start.startswith('layered construction: '):
        st = start.split(' by PolyPack', 1)[0]
    elif start and start.startswith('crystal cut '):
        m = re.search(r'of columns of stacked (prisms|antiprisms) over the densest (double-lattice|lattice) packing '
                      r'found of (the \d+-gon|their projection) \((?:2D )?density ([0-9.]+)\)(, every other piece turned '
                      r'by pi/n)?, columns along the container\'s (\w) axis', start)
        if not m:
            raise ValueError(f'unreadable crystal cut: {start[:80]}')
        st = (f'crystal cut of {m.group(1)} in columns over a {m.group(2)} packing of {m.group(3)} (density '
              f'{m.group(4)}){" with every other piece turned" if m.group(5) else ""}, columns along {m.group(6)}')
    elif start:
        raise ValueError(f'unknown start: {start[:80]}')
    out = []
    for r in runs:
        if r.startswith('search: soft-to-rigid run from random balls'):
            out.append('search from random positions, seed ' + r.split(', seed ', 1)[1])
        elif r.startswith('search: polish and hops'):
            out.append('search, seed ' + r.split(', seed ', 1)[1])
        elif r.startswith('subset of the configuration of ') and r.endswith(', at its s'):
            out.append(r)
        elif r.startswith('subset of the configuration of '):
            out.append(r.split(':', 1)[0] + ', seed 1 (8000 evaluations a step for P <= 30, 3000 above)')
        else:
            raise ValueError(f'unknown step: {r[:80]}')
    return st, out


def polypack_codes(d):
    """PolyPack's problems (catalogue order) that have a file in the --polypack directory d."""
    return [c for c in catalogue.PROBLEMS if c not in catalogue.WIKI_PROBLEMS and os.path.exists(os.path.join(d, f'{c}.json'))]


def polypack_candidates(d, nmax, codes=None):
    """The --polypack records: (case, candidate) for every given PolyPack problem (default all) and P = 2..nmax, all
    required."""
    out = []
    label = os.path.basename(os.path.normpath(d))
    for code in codes if codes is not None else [c for c in catalogue.PROBLEMS if c not in catalogue.WIKI_PROBLEMS]:
        doc = load(os.path.join(d, f'{code}.json'))
        if not doc:
            raise ValueError(f'--polypack: {code}.json is missing or unreadable')
        piece, container, _ = catalogue.PROBLEMS[code]
        if doc.get('code') != code or doc.get('piece') != piece or doc.get('container') != container:
            raise ValueError(f'--polypack {code}.json: code, piece or container differ from the catalogue')
        by_p = {r['P']: r for r in doc['records']}
        for n in range(2, nmax + 1):
            r = by_p.get(n)
            if not r or not isinstance(r.get('config'), list) or len(r['config']) != n:
                raise ValueError(f'--polypack {code}.json has no configuration of {n} pieces')
            pieces = [[float(x) for x in pose] for pose in r['config']]
            out.append((Case(code, n), {'file': f'{label}/{code}.json', 'rec': r, 'pieces': pieces,
                                        's_cert': float(r['s']), 'mine': True}))
    return out


def make_polypack_record(case, cand, volumes):
    """A PolyPack research record of one of PolyPack's own problems (there is no wiki record to compare with)."""
    r = cand['rec']
    pieces, s = cand['pieces'], cand['s_cert']
    if 'runs' in r:
        start, runs = r.get('start'), list(r['runs'])
    else:
        start, runs = polypack_short(*polypack_steps(r['method']))
    origin = {'file': cand['file'], 'date': r.get('date', POLYPACK_DATE)}
    if r.get('seed') is not None:
        origin['seed'] = r['seed']
    if start:
        origin['start'] = start
    if runs:
        origin['runs'] = runs
    rec = {
        'id': f'polyhedra/{case.code}/{case.n}', 'code': case.code, 'piece': case.piece, 'container': case.container,
        'family': case.family, 'P': case.n,
        'score_float': tight_scale(case, pieces), 'score_cert': s, 'display': display(s), 'status': 'best_known',
        'config': {'s': s, 'pieces': pieces},
        'bound': {'value': certify.volume_bound(case.piece, case.container, case.n, volumes), 'kind': 'volume'},
        'found_by': 'PolyPack research', 'credit': 'PolyPack research', 'method': r['method'],
        'sources': ['polypack'], 'source': 'PolyPack research', 'origin': origin, 'literature': [],
    }
    if s / rec['bound']['value'] - 1 < 1e-6:
        rec['notes'] = ('[CALC] meets its volume bound to 1e-6 (the pieces tile the container), so it is optimal by the '
                        'volume argument; the status stays best_known (PolyPack marks proven only with a published proof)')
    return rec


def polypack_records(d, nmax, jobs, volumes, no_certify=False, codes=None):
    """The certified records of PolyPack's problems from --polypack, in catalogue order; and the failures."""
    cands = polypack_candidates(d, nmax, codes)
    work = [(case, [cand], volumes) for case, cand in cands]
    if no_certify:
        results = [(cand, None) for _, [cand], _ in work]
    elif jobs > 1:
        import multiprocessing as mp
        with mp.Pool(jobs) as pool:
            results = pool.map(certify_case, work, chunksize=4)
    else:
        results = [certify_case(w) for w in work]
    records, failed = [], []
    for (case, _), (cand, _) in zip(cands, results):
        if cand is None:
            failed.append(f'{case.code}/{case.n}')
        else:
            records.append(make_polypack_record(case, cand, volumes))
    return records, failed


SCOPE_NOTE = ('the 3D problems of polyhedrainpolyhedra.wiki (Platonic, Archimedean, Catalan, prisms, antiprisms, '
              'elongated prisms) with 2 to %d pieces; 4D-6D are not included')
SCOPE_NOTE_POLYPACK = (SCOPE_NOTE + '; then PolyPack\'s own problems in the same scheme (prisms and antiprisms with 7, '
                       '9, 10 and 11 sides in themselves and in a cube, and their prisms of height 1.5, 2 and 3 in a '
                       'cube; bipyramids and trapezohedra, the canonical duals of the prisms and antiprisms, in '
                       'themselves and in a cube), whose records are PolyPack research only')
POLYPACK_CONVENTION = ('records of PolyPack\'s own problems (no wiki record): origin.file is the PolyPack research '
                       'file, origin.start the construction the configuration\'s lineage starts from (none for a '
                       'search from random positions), origin.runs the searches and subset steps after it and '
                       'origin.seed the last step\'s seed, in short; method states the whole lineage in full')


def search_replacements(records, dirs, jobs, volumes, no_certify):
    """--keep with --search: the records of the wiki's problems that the results in `dirs` replace (see the usage),
    as {id: new record}, and the ids whose result was not certified. A result must start from the kept record."""
    by_id = {r['id']: r for r in records}
    work, olds, seen = [], [], set()
    for code, cands in load_search(dirs, label=True).items():
        if code not in catalogue.WIKI_PROBLEMS:
            raise ValueError(f'--search with --keep: {code} is not one of the wiki\'s problems (they come from --polypack)')
        for c in cands:
            r, n = c['rec'], len(c['rec']['pieces'])
            old = by_id.get(f'polyhedra/{code}/{n}')
            if old is None or r.get('start') != 'warm' or r.get('record_file') != old['origin']['file']:
                raise ValueError(f'{c["file"]}: not started from the kept record of {code}/{n} (start "warm", '
                                 f'record_file its origin.file)')
            if old['id'] in seen:
                raise ValueError(f'{c["file"]}: a second result for {old["id"]}')
            seen.add(old['id'])
            c['pieces'], c['s_cert'], c['mine'] = [list(map(float, p)) for p in r['pieces']], c['s'], True
            ours = old['found_by'] == 'PolyPack research'
            # a PolyPack record is replaced by any gain; the wiki's only by more than OUR_MARGIN, as in a full build
            limit = old['score_cert'] if ours else old['wiki']['s_full'] * (1 - OUR_MARGIN)
            if not c['s_cert'] < limit:
                print(f'{c["file"]}: s = {c["s_cert"]!r} does not replace {old["id"]} (s = {old["score_cert"]!r})')
                continue
            # the lineage's sources are the kept record's; its credit names the wiki packing the lineage starts from
            c['start_keys'], c['start_rec'] = old['sources'], old
            if not ours:
                c['start_credit'] = f"{old['found_by']}, {old['origin']['file']}"
            elif old['credit'].startswith(START_CREDIT):
                c['start_credit'] = old['credit'][len(START_CREDIT):-1]
            work.append((Case(code, n), [c], volumes))
            olds.append(old)
    if no_certify:
        results = [(cands[0], None) for _, cands, _ in work]
    elif jobs > 1 and len(work) > 1:
        import multiprocessing as mp
        with mp.Pool(jobs) as pool:
            results = pool.map(certify_case, work, chunksize=1)
    else:
        results = [certify_case(w) for w in work]
    replaced, failed = {}, []
    for (case, _, _), old, (cand, _) in zip(work, olds, results):
        if cand is None:
            failed.append(old['id'])
            continue
        wiki_best = {'s': old['wiki']['s_full'], 'file': old['wiki'].get('file', old['origin']['file'])}
        replaced[old['id']] = make_record(case, cand, True, wiki_best, None, old['literature'], volumes)
    return replaced, failed


def attach_configs(cdir, records):
    """Reads each record's configuration back from configs/<code>.jsonl (the line its config_at locates)."""
    raw = {}
    for r in records:
        if r['code'] not in raw:
            with open(os.path.join(cdir, f'{r["code"]}.jsonl'), 'rb') as f:
                raw[r['code']] = f.read()
        o, n = r.pop('config_at')
        line = json.loads(raw[r['code']][o:o + n])
        if line.get('P') != r['P'] or line['config']['s'] != r['score_cert']:
            raise ValueError(f'{r["id"]}: its configuration line does not match')
        r['config'] = line['config']


def keep_and_add(keep, polypack, search, nmax, jobs, no_certify):
    """--keep mode: the records of `keep` untouched, except PolyPack's problems built from --polypack and the
    records of the wiki's problems that results in --search replace."""
    with open(keep) as f:
        doc = json.load(f)
    codes = polypack_codes(polypack) if polypack else []
    old = [r for r in doc['records'] if r['code'] not in codes]
    if len(old) != len(doc['records']):
        print(f'{len(doc["records"]) - len(old)} records of PolyPack\'s problems in {keep} are replaced')
    if not all(isinstance(r.get('config_at'), list) for r in old):
        raise ValueError('--keep: every kept record must have its configuration apart (config_at)')
    volumes = certify.solid_volumes()
    t0 = time.time()
    cdir = os.path.join(os.path.dirname(keep), 'configs')
    new, failed = polypack_records(polypack, nmax, jobs, volumes, no_certify, codes) if polypack else ([], [])
    nfiles, total = write_configs(cdir, new)
    replaced, bad = search_replacements(old, search, jobs, volumes, no_certify) if search else ({}, [])
    failed += bad
    if replaced:
        # the configuration files of the problems with a replaced record are written again, every line in its place
        changed = {r['code'] for r in replaced.values()}
        old = [replaced.get(r['id'], r) for r in old]
        rewrite = [r for r in old if r['code'] in changed]
        attach_configs(cdir, [r for r in rewrite if r['id'] not in replaced])
        n2, t2 = write_configs(cdir, rewrite)
        nfiles, total = nfiles + n2, total + t2
    # catalogue order: kept and new records by problem, then P
    order = {c: i for i, c in enumerate(catalogue.PROBLEMS)}
    doc['records'] = sorted(old + new, key=lambda r: (order[r['code']], r['P']))
    if polypack:
        doc['scope'] = {'P': [2, nmax], 'problems': len(catalogue.PROBLEMS), 'note': SCOPE_NOTE_POLYPACK % nmax}
        doc['sources']['polypack'] = SOURCES['polypack']
        doc['conventions']['polypack'] = POLYPACK_CONVENTION
    with open(keep, 'w') as f:
        json.dump(doc, f, separators=(',', ':'), ensure_ascii=False)
        f.write('\n')
    print(f'kept {len(old) - len(replaced)} records; wrote {len(new)} of PolyPack\'s problems, replaced '
          f'{len(replaced)} of the wiki\'s problems {sorted(replaced)[:20]} and wrote {nfiles} configuration files '
          f'({total / 1e6:.2f} MB); {len(failed)} not certified {failed[:10]}; {time.time() - t0:.0f} s')
    return 0 if not failed else 1


CONFIGS_CONVENTION = ('the configurations are kept apart, one file per problem: configs/<code>.jsonl has one line '
                      'per P, in increasing P, each {"P", "config": {s, pieces}}; config_at = [offset, length] gives '
                      'the byte offset and length of the record\'s line (without its newline), so that a reader can '
                      'read that one configuration alone')


def write_configs(cdir, records):
    """Moves each record's configuration to configs/<code>.jsonl (one line per P, in increasing P) and gives the
    record config_at = [offset, length] of its line. Returns the number of files and their total size."""
    by_code = {}
    for r in records:
        by_code.setdefault(r['code'], []).append(r)
    os.makedirs(cdir, exist_ok=True)
    total = 0
    for code, recs in by_code.items():
        path = os.path.join(cdir, f'{code}.jsonl')
        offset = 0
        with open(path, 'wb') as f:
            for r in sorted(recs, key=lambda x: x['P']):
                line = json.dumps({'P': r['P'], 'config': r.pop('config')}, separators=(',', ':')).encode('ascii')
                f.write(line + b'\n')
                r['config_at'] = [offset, len(line)]
                offset += len(line) + 1
        total += os.path.getsize(path)
    return len(by_code), total


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--upstream')
    ap.add_argument('--site')
    ap.add_argument('--polypack', help='records of PolyPack\'s own problems: <code>.json per problem (see above)')
    ap.add_argument('--keep', help='keep this records.json\'s records as they are, except PolyPack\'s problems from '
                                   '--polypack and the wiki\'s problems\' records that --search results replace')
    ap.add_argument('--ours')
    ap.add_argument('--search', action='append', help='a directory of PolyPack search results (repeatable)')
    ap.add_argument('--nmax', type=int, default=100)
    ap.add_argument('--no-certify', action='store_true',
                    help='take the best candidate of each case without certifying it here (certify.py certifies the '
                         'written files; a failure is then excluded with --skip and the build run again)')
    ap.add_argument('--skip', help='a file of lines "<id> <origin file>": candidates not to use (failed certification)')
    ap.add_argument('--jobs', type=int, default=1)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.dirname(HERE)), 'data', 'polyhedra',
                                                  'records.json'))
    a = ap.parse_args(argv)
    if a.keep:
        if not a.polypack and not a.search:
            ap.error('--keep needs --polypack or --search')
        return keep_and_add(a.keep, a.polypack, a.search, a.nmax, a.jobs, a.no_certify)
    if not a.upstream or not a.site:
        ap.error('--upstream and --site are required (or --keep with --polypack or --search)')
    U = a.upstream
    site = json.load(open(a.site))
    rows = {(p['id'], r['n']): r for p in site['problems'] for r in p['rows']}
    ext = {}
    for e in json.load(open(os.path.join(U, 'docs', 'external_records.json')))['entries']:
        ext.setdefault((e['problem'], e['n']), []).append(e)
    ours_rows = {}
    if a.ours:
        for r in csv.DictReader(open(os.path.join(a.ours, 'results', 'improvements.csv'))):
            ours_rows.setdefault((r['problem'], int(r['n'])), []).append(r)
    volumes = certify.solid_volumes()
    search = load_search(a.search)
    runs = study_runs(a.ours)
    jobs, meta = [], []
    t0 = time.time()
    for code in [c for c in catalogue.PROBLEMS if c in catalogue.WIKI_PROBLEMS]:   # the wiki's problems only
        for n in range(2, a.nmax + 1):
            case = Case(code, n)
            row = rows.get((code, n))
            ups = upstream_candidates(U, code, n, row)
            if not ups:
                print('no upstream candidate for', code, n)
                continue
            for c in ups:
                c['pieces'] = [list(map(float, p)) for p in c['rec']['pieces']]
                c['s_cert'] = c['s']
            site_file = row.get('file') if row else None
            ups.sort(key=lambda c: (c['s'], c['file'] != site_file))
            mine = []
            found = [c for c in search.get(code, []) if len(c['rec']['pieces']) >= n]
            for c in our_candidates(a.ours, code, n, ours_rows) + [dict(c) for c in found]:
                if len(c['rec']['pieces']) > n:
                    c['pieces'], c['s_cert'] = subset(case, c['rec'])
                else:
                    c['pieces'], c['s_cert'] = [list(map(float, p)) for p in c['rec']['pieces']], c['s']
                if c['s_cert'] < ups[0]['s'] * (1 - OUR_MARGIN):
                    if c['file'].startswith('search/'):
                        keys, credit, st = start_of(U, a.ours, runs, code, len(c['rec']['pieces']),
                                                    c['rec'].get('record_file') if c['rec'].get('start') == 'warm' else None)
                        if keys != ['polypack']:
                            c['start_keys'], c['start_credit'], c['start_rec'] = keys, credit, st
                    # the compute study's searches (runs/main): their start and runs, traced through the run logs
                    elif c['file'].startswith('runs/main/'):
                        start, path, steps = study_chain(a.ours, runs, c['file'])
                        c['study'] = {**({'start': path} if path else {}), 'runs': steps}
                        if start == 'record':
                            st = load(os.path.join(U, path))
                            c['start_keys'] = provenance(path, st, code, st['n'])
                            c['start_rec'] = st
                            c['start_credit'] = f"{st.get('found_by')}, {path}"
                    c['mine'] = True
                    mine.append(c)
            mine.sort(key=lambda c: c['s_cert'])
            jobs.append((case, mine + ups, volumes))
            meta.append((case, ups[0], row))
    if a.skip:
        skip = {tuple(line.split(None, 1)) for line in open(a.skip).read().splitlines() if line.strip()}
        jobs = [(case, [c for c in cands if (f'polyhedra/{case.code}/{case.n}', c['file']) not in skip], vol)
                for case, cands, vol in jobs]
    print(f'{len(jobs)} cases, {sum(1 for j in jobs if j[1] and j[1][0].get("mine"))} with a PolyPack candidate'
          + ('' if a.no_certify else '; certifying'), flush=True)
    if a.no_certify:
        results = [(cands[0], None) if cands else (None, None) for _, cands, _ in jobs]
    elif a.jobs > 1:
        import multiprocessing as mp
        with mp.Pool(a.jobs) as pool:
            results = pool.map(certify_case, jobs, chunksize=8)
    else:
        results = [certify_case(j) for j in jobs]
    records, failed = [], []
    for (case, wiki_best, row), (cand, cert) in zip(meta, results):
        if cand is None:
            failed.append(f'{case.code}/{case.n}')
            continue
        lit = literature_of(case.code, case.n, row, ext)
        records.append(make_record(case, cand, bool(cand.get('mine')), wiki_best, row, lit, volumes))
    if a.polypack:
        new, bad = polypack_records(a.polypack, a.nmax, a.jobs, volumes, a.no_certify)
        records += new
        failed += bad
    doc = {
        'space': 'polyhedra',
        'title': '3D in 3D',
        'generated': time.strftime('%Y-%m-%d'),
        'scope': {'P': [2, a.nmax], 'problems': len(catalogue.PROBLEMS if a.polypack else catalogue.WIKI_PROBLEMS),
                  'note': (SCOPE_NOTE_POLYPACK if a.polypack else SCOPE_NOTE) % a.nmax},
        'upstream': {'repository': UPSTREAM, 'commit': UPSTREAM_COMMIT, 'site': 'https://polyhedrainpolyhedra.wiki/',
                     'site_build': site.get('built')},
        'conventions': {
            'problem_id': 'polyhedra/<code>/<P>: P copies of the piece solid in s times the container solid; code is '
                          'upstream\'s <piece>in<container> (e.g. cubintet)',
            'solids': 'canonical solids of python/polyhedra/solids_exact.json (upstream src/solids_exact.json), '
                      'centred at the origin; unit edges except Catalan solids (polar reciprocals of the unit-edge '
                      'Archimedean solids about the midsphere) and elongated prisms (lateral edges 1.5, 2, 3)',
            'pose': '[x, y, z, qw, qx, qy, qz]: the canonical piece rotated by q / |q| (rotation H(q) / |q|^2) and '
                    'centred at (x, y, z); the container s C is centred at the origin in its canonical orientation',
            'score': 's (score_cert = config.s, proven valid by python/polyhedra/certify.py); smaller is better',
            'score_float': 'the float container scale of the stored poses at the same centres (pieces keep their '
                           'clearance); s_tight, where given, is upstream\'s uncertified touching limit',
            'clearance': 'records from the wiki keep its convention: every pair and wall at least 1e-7 apart (some '
                         'wall gaps were cut to about 1e-10 by certified wall-padding refinements)',
            'display': 'score_cert rounded to the nearest at 6 decimals from its exact binary64 value',
            'bound': 'kind volume: [EST] n vol(piece) <= s^3 vol(container), so s >= (n vol(piece) / vol(container))^(1/3)',
            'origin': 'the file the configuration comes from: upstream\'s records/... at commit cbf76f2f (sources.wiki.files) '
                      'or a PolyPack research file (sources.polypack); for a PolyPack search, start is the packing it '
                      'started from (none for a start from random positions) and, for a search of the compute study, '
                      'runs are its runs from that start, as its run logs show them',
            'wiki': 'the wiki\'s record of the case (its smallest certified s_full in the repository) and its page; '
                    'file is given when the configuration here comes from elsewhere',
            'literature': 'published values without coordinates (value, source, url, printed precision)',
            'configs': CONFIGS_CONVENTION,
            **({'polypack': POLYPACK_CONVENTION} if a.polypack else {}),
        },
        'sources': SOURCES,
        'records': records,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    nfiles, total = write_configs(os.path.join(os.path.dirname(a.out), 'configs'), records)
    with open(a.out, 'w') as f:
        json.dump(doc, f, separators=(',', ':'), ensure_ascii=False)
        f.write('\n')
    print(f'wrote {a.out}: {len(records)} records, {os.path.getsize(a.out) / 1e6:.2f} MB, and {nfiles} '
          f'configuration files, {total / 1e6:.2f} MB; {len(failed)} cases without a candidate {failed[:10]}, '
          f'{time.time() - t0:.0f} s')
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
