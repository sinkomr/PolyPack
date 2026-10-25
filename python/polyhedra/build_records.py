#!/usr/bin/env python3
"""Builds data/polyhedra/records.json (offline tool; standard library only, certification by certify.py).

usage: python3 python/polyhedra/build_records.py --upstream DIR --site FILE [--ours DIR] [--search DIR ...]
                                                 [--nmax 100] [--jobs 2] [--no-certify] [--skip FILE]
                                                 [--out data/polyhedra/records.json]

  --upstream  a checkout of github.com/alejandrozu/platonic-packing at commit cbf76f2f (records/, docs/)
  --site      polyhedrainpolyhedra.wiki's data bundle /data/records.json of the same build (the site's selection of
              the best record per case and the published reference values it shows; not in the repository)
  --ours      PolyPack research results: a directory with results/improvements.csv and the files it names
              (upstream record format), whose packings of m pieces cover every n <= m by deleting pieces

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
        'title': 'PolyPack research (crystal cuts and searches, 2026-10-23)',
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
        return json.load(open(path))
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


def load_search(dirs):
    """PolyPack search results (packages/polyhedra/scripts/improve.ts): code -> list of candidates."""
    out = {}
    for d in dirs or []:
        for f in sorted(glob.glob(os.path.join(d, '*.json'))):
            r = load(f)
            if not r or r.get('code') not in catalogue.PROBLEMS or not isinstance(r.get('pieces'), list):
                continue
            rec = dict(r, problem=r['code'], method=r.get('method'))
            out.setdefault(r['code'], []).append({'file': 'search/' + os.path.basename(f), 'rec': rec,
                                                  's': float(r['s_full'])})
    return out


def start_of(U, rows, code, m, record_file):
    """(source keys, credit) of the record a PolyPack search started from."""
    if record_file and record_file.startswith('records/'):
        r = load(os.path.join(U, record_file))
        if r:
            return provenance(record_file, r, code, m), f"{r.get('found_by')}, {record_file}", r
    if record_file and record_file.startswith('runs/main/'):
        own = upstream_candidates(U, code, m, rows.get((code, m)))
        own.sort(key=lambda x: x['s'])
        if own:
            st = own[0]
            return (['polypack'] + provenance(st['file'], st['rec'], code, m),
                    f"PolyPack research, which started from {st['rec'].get('found_by')}, {st['file']}", st['rec'])
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


def make_record(case, cand, mine, wiki_best, row, literature, volumes):
    r = cand['rec']
    code, n = case.code, case.n
    if mine:
        pieces, s = cand['pieces'], cand['s_cert']
        start = cand.get('start_keys') or []
        keys = ['polypack'] + [k for k in start if k != 'polypack']
        found_by = 'PolyPack research'
        credit = 'PolyPack research' + (f" (search started from the wiki's packing: {cand['start_credit']})"
                                        if cand.get('start_credit') else '')
        method = r.get('method', 'PolyPack research')
        if len(r['pieces']) > n:
            method += f'; {len(r["pieces"]) - n} of its {len(r["pieces"])} pieces deleted, container rescaled to wall clearance 1e-7'
        src = {'file': cand['file'], 'date': r.get('date', '2026-10-23')}
        if r.get('seed') is not None:
            src.update(seed=r['seed'], evaluations=r.get('evals'))
        if r.get('start') == 'warm' and r.get('record_file'):
            src['start'] = r['record_file']                  # the record the search started from
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
    ap.add_argument('--upstream', required=True)
    ap.add_argument('--site', required=True)
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
    jobs, meta = [], []
    t0 = time.time()
    for code in catalogue.PROBLEMS:
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
                        keys, credit, st = start_of(U, rows, code, len(c['rec']['pieces']),
                                                    c['rec'].get('record_file') if c['rec'].get('start') == 'warm' else None)
                        if keys != ['polypack']:
                            c['start_keys'], c['start_credit'], c['start_rec'] = keys, credit, st
                    # our searches (runs/main) started from the wiki's record of the file's own piece count
                    elif c['file'].startswith('runs/main/'):
                        m = len(c['rec']['pieces'])
                        own = upstream_candidates(U, code, m, rows.get((code, m)))
                        own.sort(key=lambda x: x['s'])
                        if own:
                            start = own[0]
                            c['start_keys'] = provenance(start['file'], start['rec'], code, m)
                            c['start_rec'] = start['rec']
                            c['start_credit'] = f"{start['rec'].get('found_by')}, {start['file']}"
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
    doc = {
        'space': 'polyhedra',
        'title': '3D in 3D',
        'generated': time.strftime('%Y-%m-%d'),
        'scope': {'P': [2, a.nmax], 'problems': len(catalogue.PROBLEMS),
                  'note': 'the 3D problems of polyhedrainpolyhedra.wiki (Platonic, Archimedean, Catalan, prisms, '
                          'antiprisms, elongated prisms) with 2 to %d pieces; 4D-6D are not included' % a.nmax},
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
                      'or a PolyPack research file (sources.polypack)',
            'wiki': 'the wiki\'s record of the case (its smallest certified s_full in the repository) and its page; '
                    'file is given when the configuration here comes from elsewhere',
            'literature': 'published values without coordinates (value, source, url, printed precision)',
            'configs': CONFIGS_CONVENTION,
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
