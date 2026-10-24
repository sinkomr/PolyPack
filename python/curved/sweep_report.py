"""Markdown tables for docs/spaces/CURVED_SWEEP.md from data/curved/sweep/*.json.

    python3 python/curved/sweep_report.py data/curved/sweep > tables.md
"""
import json
import math
import os
import sys


def f(v, d=6):
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "–"
    return f"{v:.{d}f}"


def main(d):
    summ = json.load(open(os.path.join(d, "summary.json")))
    out = []
    out.append("#### Ground-state sequence (lowest branch found; K ranges on the 1/64 grid)\n")
    out.append("| problem | K range | sequence of lowest configurations (shells · symmetry, K interval) | certified |")
    out.append("|---|---|---|---|")
    for p in summ["problems"]:
        rec = json.load(open(os.path.join(d, "sweep_" + "_".join(p["id"].split("/")[1:]) + ".json")))
        gs = rec["ground_state"]
        runs = []
        for g in gs:
            lab = f"{g['family']} · {g['sym']}"
            if runs and runs[-1]["b"] == g["branch"]:
                runs[-1]["K1"] = g["K"]
            else:
                runs.append({"b": g["branch"], "lab": lab, "K0": g["K"], "K1": g["K"]})
        seq = "; ".join(f"b{r['b']} {r['lab']} [{r['K0']:.3f}, {r['K1']:.3f}]" for r in runs)
        out.append(f"| {rec['title']} | [{gs[0]['K']:.3f}, {gs[-1]['K']:.3f}] | {seq} | {p['certified']} |")
    out.append("")
    out.append("#### Events on the ground state (crossings, stability changes, and kinks of at least 5% of the slope; the viewer lists every event)\n")
    out.append("| problem | K | type | s | slope left | slope right | before → after | metastable continuation | certified |")
    out.append("|---|---|---|---|---|---|---|---|---|")
    for p in summ["problems"]:
        rec = json.load(open(os.path.join(d, "sweep_" + "_".join(p["id"].split("/")[1:]) + ".json")))
        shown = []
        for e in sorted(rec["events"], key=lambda e: e["K"]):
            k = e["kind"]
            big = e.get("slopeLeft") is not None and e.get("slopeRight") is not None and abs(e["slopeRight"] - e["slopeLeft"]) >= 0.05 * (1 + abs(e["slopeLeft"]))
            if k not in ("crossing", "kink", "stability", "gap") and not (k in ("contact", "symmetry") and e.get("kinkClass") == "kink" and big):
                continue
            # one row per location: contact/symmetry/kink rows within 5e-4 of a row already shown repeat it
            if k in ("contact", "symmetry", "kink") and any(abs(x - e["K"]) < 5e-4 for x in shown):
                continue
            shown.append(e["K"])
            b, a = e.get("before") or {}, e.get("after") or {}
            ba = f"{b.get('family')} {b.get('sym')} → {a.get('family')} {a.get('sym')}" if k == "crossing" else (e.get("text") or "")[:90]
            if k == "crossing":
                sl, sr = (b.get("slopes") or [None])[0], (a.get("slopes") or [None, None])[1]
            else:
                sl, sr = e.get("slopeLeft"), e.get("slopeRight")
            hy = "; ".join(f"b{h['branch']} {h['direction']} to {h['survivesTo']:.4f} ({h['end']})" for h in (e.get("hysteresis") or []))
            out.append(f"| {rec['title']} | {f(e['K'], 8)} | {k} | {f(e.get('s'))} | {f(sl, 4)} | {f(sr, 4)} | {ba} | {hy} | {e.get('certified') or ''} |")
    out.append("")
    out.append("#### One-sided slopes of s*(K) at K = 0 (lowest branch on each side; finite differences ±1e-4, in brackets ±2e-3)\n")
    out.append("| problem | Euclidean record | s*(0) found | slope of s* for K → 0⁻ | slope for K → 0⁺ | kink | same configuration on both sides? | contacts at 0 |")
    out.append("|---|---|---|---|---|---|---|---|")
    for p in summ["problems"]:
        rec = json.load(open(os.path.join(d, "sweep_" + "_".join(p["id"].split("/")[1:]) + ".json")))
        g = {round(x["K"] * 64): x for x in rec["ground_state"]}
        if 0 not in g or -1 not in g or 1 not in g:
            continue
        bl, br = g[-1]["branch"], g[1]["branch"]
        kl = next((k for k in rec["k0"] if k["branch"] == bl), None)
        kr = next((k for k in rec["k0"] if k["branch"] == br), None)
        if not kl or not kr:
            continue
        eu = rec.get("euclidean_record") or {}
        kink = kr["right"] - kl["left"]
        copies = any(e["kind"] == "coincide" and {e.get("from"), e.get("to")} == {bl, br} for e in rec["events"])
        same = "yes" if bl == br else ("yes (relabelled copy)" if copies else "no (crossing at 0)")
        out.append(
            f"| {rec['title']} | {f(eu.get('value'))} | {f(g[0]['s'])} | {f(kl['left'], 4)} ({f(kl['leftFar'], 4)}) | {f(kr['right'], 4)} ({f(kr['rightFar'], 4)}) | {kink:+.4f} | {same} | {kl.get('contacts')} |"
        )
    out.append("")
    out.append("#### Asymptote at the negative end (polygon containers): s ≈ −α ln(K − K∞) + β\n")
    out.append("| problem | last K reached | s there | K∞ (fit) | K∞ = −a*² (kPolish) | α (fit) | 1/√−K∞ | rms |")
    out.append("|---|---|---|---|---|---|---|---|")
    for p in summ["problems"]:
        a = p.get("asymptote")
        if not a or not a.get("fit"):
            continue
        rec_title = p["title"]
        kp = a.get("kPolish") or {}
        out.append(
            f"| {rec_title} | {f(a['lastK'], 6)} | {f(a['lastS'], 3)} | {f(a['fit']['Kinf'], 7)} | {f(kp.get('K'), 7)} | {f(a['fit']['alpha'], 4)} | {f(a.get('theoryAlpha'), 4)} | {f(a['fit']['rms'], 4)} |"
        )
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/curved/sweep")
