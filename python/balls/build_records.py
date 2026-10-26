#!/usr/bin/env python3
"""Builds data/balls/records.json and data/balls/configs/<code>.jsonl from the search results.

usage: python3 python/balls/build_records.py <results dir> [--literature packomania_values.json] [--generated DATE]

<results dir> holds <code>.jsonl files of the search sweep (packages/balls/scripts/sweep.ts): one row per
improvement {code, P, score, config, chain, at}. For every problem and P = 2 to 100 the row with the smallest score
is the record; its configuration is stored exactly as the search wrote it. The literature file gives Packomania's
published values for balls in a ball and in a cube (1 / radius, from the radius printed at 12 decimals). Proven
optima are listed below with their sources; a record is `proven` only when such a proof covers its exact case and
the record attains the optimum to within 1e-9 relative (its clearance).
"""
import argparse
import json
import math
import os
import sys
from decimal import ROUND_HALF_EVEN, Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import balls_catalogue as catalogue  # noqa: E402

S2, S3, S5 = math.sqrt(2), math.sqrt(3), math.sqrt(5)

SOURCES = {
    'packomania_ssp': {
        'title': 'E. Specht, Packomania: The best known packings of equal spheres in a sphere',
        'link': 'https://www.packomania.com/ssp/ssp.html',
        'terms': 'values cited; no coordinates copied (the pages carry no licence; (c) E. Specht)',
        'read': '2026-10-25 (page of 13-Jul-2026)',
    },
    'packomania_scu': {
        'title': 'E. Specht, Packomania: The best known packings of equal spheres in a cube',
        'link': 'https://www.packomania.com/scu/scu.html',
        'terms': 'values cited; no coordinates copied (the pages carry no licence; (c) E. Specht)',
        'read': '2026-10-25 (page of 17-Oct-2026)',
    },
    'schaer1966a': {
        'title': 'J. Schaer, On the densest packing of spheres in a cube, Canad. Math. Bull. 9 (1966) 265-270',
        'doi': '10.4153/CMB-1966-033-0',
    },
    'schaer1966b': {
        'title': 'J. Schaer, The densest packing of five spheres in a cube, Canad. Math. Bull. 9 (1966) 271-274',
        'doi': '10.4153/CMB-1966-034-8',
    },
    'schaer1966c': {
        'title': 'J. Schaer, The densest packing of six spheres in a cube, Canad. Math. Bull. 9 (1966) 275-280',
        'doi': '10.4153/CMB-1966-035-5',
    },
    'schaer1994': {
        'title': 'J. Schaer, The densest packing of ten congruent spheres in a cube, in: Intuitive Geometry (Szeged, 1991), '
                 'Colloq. Math. Soc. Janos Bolyai 63, North-Holland (1994) 403-424',
    },
    'joos2009': {
        'title': 'A. Joos, On the packing of fourteen congruent spheres in a cube, Geom. Dedicata 140 (2009) 49-80',
        'doi': '10.1007/s10711-008-9308-3',
    },
    'gensane2004': {
        'title': 'Th. Gensane, Dense packings of equal spheres in a cube, Electron. J. Combin. 11 (2004) #R33',
        'doi': '10.37236/1786',
    },
    'tatarevic2015': {
        'title': 'M. Tatarevic, On limits of dense packing of equal spheres in a cube, Electron. J. Combin. 22 (2015) #P1.35',
        'doi': '10.37236/3784',
    },
    'teich2016': {
        'title': 'E. G. Teich, G. van Anders, D. Klotsa, J. Dshemuchadse, S. C. Glotzer, Clusters of polyhedra in '
                 'spherical confinement, PNAS 113 (2016) E669-E678',
        'doi': '10.1073/pnas.1524875113',
    },
}

# Unit balls in a cube: s = 2 + 2 / d_n, d_n the largest smallest distance of n points in the unit cube.
# The proofs (sources as Gensane 2004, section 3, and Tatarevic 2015, introduction, cite them; not read here):
PROVEN = {
    ('ballincub', 2): (2 + 2 / S3, 'schaer1966a', 'Schaer 1966', 'd_2 = sqrt 3'),
    ('ballincub', 3): (2 + S2, 'schaer1966a', 'Schaer 1966', 'd_3 = sqrt 2'),
    ('ballincub', 4): (2 + S2, 'schaer1966a', 'Schaer 1966', 'd_4 = sqrt 2'),
    ('ballincub', 5): (2 + 4 / S5, 'schaer1966b', 'Schaer 1966', 'd_5 = sqrt 5 / 2'),
    ('ballincub', 6): (2 + 4 * S2 / 3, 'schaer1966c', 'Schaer 1966', 'd_6 = 3 sqrt 2 / 4'),
    ('ballincub', 8): (4.0, 'schaer1966a', 'Schaer 1966', 'd_8 = 1'),
    ('ballincub', 9): (2 + 4 / S3, 'schaer1966a', 'Schaer 1966', 'd_9 = sqrt 3 / 2'),
    ('ballincub', 10): (14 / 3, 'schaer1994', 'Schaer 1994', 'd_10 = 3 / 4'),
    ('ballincub', 14): (2 + 2 * S2, 'joos2009', 'Joos 2009', 'd_14 = sqrt 2 / 2'),
}

METHOD = 'balls penalty basin hopping'
PLURAL = {'tetrahedron': 'tetrahedra', 'cube': 'cubes', 'octahedron': 'octahedra', 'dodecahedron': 'dodecahedra',
          'icosahedron': 'icosahedra'}


def display(x):
    return str(Decimal(x).quantize(Decimal('0.000001'), rounding=ROUND_HALF_EVEN))


def bound_of(code, P):
    """The bound as problems.ts labels it (value from the catalogue; kind of the largest)."""
    prob = catalogue.PROBLEMS[code]
    value = catalogue.bound(code, P)
    piece, ball = prob['piece'], prob['container'] == 'ball'
    v = 4 * math.pi / 3 if piece == 'ball' else catalogue.SOLIDS[piece][0]
    volume = (3 * P * v / (4 * math.pi)) ** (1 / 3) if ball else (P * v) ** (1 / 3)
    if volume >= value:
        return {'value': value, 'kind': 'volume', 'label': '[EST] elementary: the pieces\' total volume is at most the container\'s'}
    if piece == 'ball':
        what = ('two unit balls have centres at least 2 apart in the ball of radius s - 1' if ball
                else 'two unit balls have centres at least 2 apart in the cube of edge s - 2, of diameter (s - 2) sqrt 3')
    else:
        R, r = catalogue.SOLIDS[piece][1:]
        what = (f'one {piece} needs a ball of its circumradius' if value == R
                else f'two {PLURAL[piece]} contain disjoint balls of their inradius, so s >= twice that')
    return {'value': value, 'kind': 'two-piece' if 'two' in what else 'one piece', 'label': f'[EST] elementary: {what}'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('results')
    ap.add_argument('--literature')
    ap.add_argument('--generated', default='2026-10-25')
    ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'balls'))
    a = ap.parse_args()
    lit = json.load(open(a.literature)) if a.literature else {}
    best = {}
    for code in catalogue.CODES:
        fn = os.path.join(a.results, f'{code}.jsonl')
        if not os.path.exists(fn):
            continue
        for line in open(fn):
            if not line.strip():
                continue
            r = json.loads(line)
            k = (r['code'], r['P'])
            if k not in best or r['score'] < best[k]['score']:
                best[k] = r
    os.makedirs(os.path.join(a.out, 'configs'), exist_ok=True)
    records, missing = [], []
    for code in catalogue.CODES:
        prob = catalogue.PROBLEMS[code]
        lines = []
        offset = 0
        for P in range(catalogue.MIN_P, catalogue.MAX_P + 1):
            row = best.get((code, P))
            if row is None:
                missing.append(f'balls/{code}/{P}')
                continue
            cfg = row['config']
            line = json.dumps({'P': P, 'config': cfg}, separators=(',', ':')).encode()
            s = cfg['s']
            rec = {
                'id': f'balls/{code}/{P}', 'code': code, 'piece': prob['piece'], 'container': prob['container'], 'P': P,
                'config_at': [offset, len(line)], 'score_cert': s, 'display': display(s), 'status': 'best_known',
                'bound': bound_of(code, P),
                'origin': {'method': METHOD, 'by': 'PolyPack research', 'search': 'packages/balls/scripts/sweep.ts',
                           'chain': row['chain'], 'found': row.get('at')},
                'literature': [],
            }
            pk = lit.get(code, {}).get(str(P))
            if pk:
                src = 'packomania_ssp' if code == 'ballinball' else 'packomania_scu'
                rec['literature'].append({
                    'value': float(pk['value']), 'source': src, 'short': 'Packomania',
                    'printed': f'radius {pk["radius"]} (12 decimals)', 'found_by': pk['author'],
                    'link': SOURCES[src]['link'],
                })
            pr = PROVEN.get((code, P))
            if pr:
                value, src, short, what = pr
                entry = {'value': value, 'source': src, 'short': short, 'proof': f'{SOURCES[src]["title"]}: {what}'}
                if 'doi' in SOURCES[src]:
                    entry['doi'] = SOURCES[src]['doi']
                rec['literature'].append(entry)
                if s <= value * (1 + 1e-9):
                    rec['status'] = 'proven'
                else:
                    print(f'warning: balls/{code}/{P} = {s} is above the proven optimum {value}; kept best_known')
            lines.append(line)
            offset += len(line) + 1
            records.append(rec)
        with open(os.path.join(a.out, 'configs', f'{code}.jsonl'), 'wb') as f:
            for line in lines:
                f.write(line + b'\n')
    doc = {
        'space': 'balls',
        'generated': a.generated,
        'description': 'P unit balls in the smallest ball or cube and P unit-edge Platonic solids in the smallest ball, '
                       'P = 2 to 100; configurations in configs/<code>.jsonl at each record\'s config_at',
        'clearance': 1e-10,
        'sources': SOURCES,
        'records': records,
    }
    with open(os.path.join(a.out, 'records.json'), 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    print(f'{len(records)} records, {len(missing)} missing' + (f': {missing[:10]}' if missing else ''))


if __name__ == '__main__':
    main()
