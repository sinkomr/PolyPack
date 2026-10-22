# Independent geometry and high-precision polish

**[EST]** `geometry_reference.py` uses Python's standard library: vertex SAT, a primal three-variable enclosure LP, exhaustive support circles, and its own orientation search. Conventions follow [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#conventions); touching uses the shared `1e-9` tolerance. It does not call TypeScript or consume its exported orientation. The polygon LP precomputes inverses for primal bases and checks every candidate against all inequalities. Orientation search samples at least 512 angles per period, refines every sampled local minimum with golden-section search, and includes the submitted phi. This numerical search is not a proof of a global orientation minimum.

`test_corpus.py` checks every JSON file recursively under `data/corpus`, including invalid inputs, twice. `evaluate(config, auto_orient=False)` at the configuration's own `container_phi` must give `expected_score`: that is how the server scores a submission (since 2026-10-21 it does not search for a better orientation). `evaluate(config)`, with its independent orientation search, must give `oriented_score`: what a client gets by turning the container before submitting. Validity must match exactly; score agreement uses absolute `1e-9` and relative `1e-10` tolerances.

Run the standard-library corpus check from the repository root:

```sh
node --import tsx scripts/export-corpus.ts
python3 python/test_corpus.py
```

The exporter also guards known target scores stored in fixtures. Its `auto_oriented_phi` remains diagnostic metadata and is never an input to Python's corpus evaluation.

## Optional high-precision tool

**[EST]** `polish_mp.py` was executed with Python 3.14.6 and mpmath 1.3.0 inside a local `python/.venv`. Source formatting and lint checks used Ruff 0.16.9.

For a fresh environment, install the single runtime dependency locally and run the complete export/refine/revalidate sequence:

```sh
python3 -m venv python/.venv
python/.venv/bin/python -m pip install -r python/requirements.txt
node --import tsx scripts/polish-contacts.ts config.json > /tmp/contacts.json
python/.venv/bin/python python/polish_mp.py /tmp/contacts.json --out /tmp/refined.json
node --import tsx scripts/validate-polish.ts /tmp/contacts.json /tmp/refined.json > /tmp/accepted.json
python/.venv/bin/python -m unittest discover -s python -p 'test_*.py'
python/.venv/bin/python scripts/measure-python.py
```

**[CALC]** The tool accepts `{config, contacts, container?}`. Exported near contacts seed the initial contact solve, and newly near constraints are found during contraction. It runs at 50 decimal digits of working precision and converts JSON floats directly with `mp.mpf(float)`, preserving their exact binary values. Analytic derivatives use the selected SAT face/support vertex. Modest-accuracy constrained contraction is followed by a minimum-norm Newton solve on independent active contact equations. Full vertex/container constraints are checked, while pair checks use a conservative cached bounding-circle list: excluded pairs cannot overlap before a centre moves half the cache skin, at which point the list rebuilds.

The supplied container uses the server's orientation and centre. Without one, the tool creates a feasible enclosure centred at the mean of piece centres. It accepts at most 100 pieces, 2048 supplied contacts and 50000 complete validation constraints; larger inputs are rejected explicitly. `--iterations` controls contraction iterations (default 80, maximum 1000); bounded Newton and feasibility restoration also run. Input `-` reads stdin; `--out` selects a file instead of stdout.

Output includes a float64-compatible `config`, a container and 50-significant-digit decimal strings for the variables. `working_precision_digits` states arithmetic precision. `maximum_active_contact_residual` and `achieved_contact_residual_digits` report what the final equations actually reached; they do **not** assert that the score has that many correct digits, or that the packing is optimal. `minimum_constraint_gap` reports feasibility to working roundoff. If refinement fails or worsens the independently auto-oriented float64 score, the tool retains a valid input or returns no configuration. A fallback has no high-precision size.

**[CALC]** The recorded run in [measurements.json](measurements.json) used expanded five-square and seven-circle starts (factor 1.03) and the exact jittered ten-hexagon configuration from [data/corpus/N6-M0-P10.json](../data/corpus/N6-M0-P10.json), including its submitted orientation. Python runtimes, including startup and its own float64 validation, were 2.478 s, 0.479 s and 98.443 s respectively. TypeScript accepted strict improvements for the square and circle cases: their scores matched the known targets in float64, with final contact residuals reaching 43 and 41 decimal digits. The actual hexagon corpus run returned its valid input through the float64 validity/score fallback; TypeScript retained score 3.8255588437382846 and accepted no refinement. Its high-precision size and residual fields are therefore null. That run used the default 80-iteration contraction limit; its optimum and correct score digits remain unknown.

**[EST]** `scripts/validate-polish.ts` is required before using a result: it checks problem equality, parses the output and recomputes input/output with the shared TypeScript evaluator and auto-orientation. It accepts only a valid strict improvement, otherwise retains a valid input or records no configuration. High precision remains an optional command-line tool outside the browser and is never invoked implicitly by a solver run.
