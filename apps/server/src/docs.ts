import {
  MAX_EVENT_KEYS,
  MAX_METHOD_PARAMS_BYTES,
  MAX_PIECES,
  MAX_SIDES,
  MAX_SOFTWARE_LENGTH,
  SCORE_TIE,
  TOL,
} from "@polypack/geometry";
import {
  SPACE_BOUND_SLACK,
  SPACE_MIN_QUATERNION_NORM,
  SPACE_STRICT_NO_RECORD_REASON,
  SPACE_STRICT_REASON,
  SPACE_STRICT_TOL,
  SPACE_MAX_COORD,
  SPACE_MAX_SIZE,
  SPACE_EXHIBITS,
  SPACE_INFO,
  SPACE_MAX_P,
  SPACE_NAMES,
  POLYHEDRA_MAX_QUATERNION,
  SPACE_RECORD_MARGIN,
  SPACE_TOL,
  SURFACE_MAX_CHAINS,
  TORUS_MAX_TRANSLATES,
  BOUNDARY_MAX_CHAINS,
  BOUNDARY_MAX_S,
} from "@polypack/spaces";
import { LEADERS_MAX_KEYS, LEADERS_MAX_URL } from "./leaders";
import { MAX_BODY_BYTES, MAX_NAME_LENGTH, MAX_NOTE_LENGTH, VERIFY_MS_PER_MINUTE } from "./limits";
import {
  SPACE_HEAVY_CHECKS_WAITING,
  SPACE_HEAVY_CHECK_P,
  SPACE_METHOD_LENGTH,
  SPACE_SITE_ONLY_DEFAULT_LIMIT,
  SPACE_SITE_ONLY_MAX_LIMIT,
} from "./spaces";

const PYTHON = `import json, math, urllib.request

BASE = "https://YOUR-SITE"   # or http://localhost:8787

# 11 unit squares in a square: a 4-by-3 grid with one cell left empty (side 4).
# At theta = pi/4 a square piece has horizontal and vertical sides.
pieces = [{"x": i % 4, "y": i // 4, "theta": math.pi / 4} for i in range(11)]

# The score is computed at container_phi as sent: orient a board before submitting it.
# This grid is axis-aligned, so 0 is already its best orientation.
body = {"N": 4, "M": 4, "P": 11, "pieces": pieces, "container_phi": 0.0,
        "name": "my name", "found_with": "hand"}
request = urllib.request.Request(BASE + "/api/submit", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
try:
    result = json.load(urllib.request.urlopen(request))
except urllib.error.HTTPError as error:   # refusals return 4xx with reasons
    result = json.load(error)
print(result["valid"], result["score"], result["leader"], result["leader_score"], result["reasons"])`;

const CURL = `curl -s https://YOUR-SITE/api/problems/4/7/2

curl -s -X POST https://YOUR-SITE/api/submit \\
  -H "content-type: application/json" \\
  -d '{"N": 4, "M": 7, "P": 2, "container_phi": 0, "name": "my name", "found_with": "hand",
       "pieces": [{"x": 0, "y": 0, "theta": 0.7853981633974483},
                  {"x": 1, "y": 0, "theta": 0.7853981633974483}]}'

curl -s https://YOUR-SITE/api/leaderboard/4/7/2

curl -s "https://YOUR-SITE/api/records?N=4&M=4"

curl -s "https://YOUR-SITE/api/atlas?N=0&M=0&from=1&to=20"

curl -s --compressed "https://YOUR-SITE/api/leaders?keys=4/7/2,3/3/5,sphere/0/12"

curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://YOUR-SITE/api/admin/pending`;

const SCHEMA = `{
  "N": 5, "M": 4, "P": 7,
  "pieces": [{"x": 0.0, "y": 0.0, "theta": 0.0}],
  "container_phi": 0.0,
  "units": "diameter",
  "name": "display name",
  "agent_note": "optional free text",
  "found_with": "hand | optimizer | optimizer_edited | external",
  "method": "basin_hopping",
  "method_params": {"...": "the run's resolved parameters"},
  "seed": 1,
  "budget": {"evals": 20000, "time_s": 20},
  "software": "name/version of the program"
}`;

const RESPONSE = `{
  "valid": true,
  "reasons": [],
  "score": 2.0000000000000004,
  "rank": 1,
  "leader": true,
  "leader_score": 2.0000000000000004,
  "id": 17,
  "container": {"M": 4, "cx": 0.5, "cy": 0.0, "phi": 0.0, "size": 2.0000000000000004},
  "pending_verification": false,
  "strict_check": null
}`;

const LEADERS = `{
  "leaders": {
    "4/7/2": {"score": 2.60512, "name": "ada", "id": 123456, "verification": "none"},
    "3/3/5": null,
    "sphere/0/12": {"score": 3.14159, "name": "the research record", "id": null, "research": true}
  },
  "unknown": ["5/5/0"]
}`;

const PROBLEM = `{
  "N": 4, "M": 4, "P": 11,
  "conventions": {"version": 2, "units": "...", "piece_pose": "...", "container": "...", "score": "...",
                  "shapes": "...", "validity": "...", "scoring": "..."},
  "area_bound": 3.3166247903554,
  "literature": {"value": 3.87708359002281, "display": "3.87708359002281", "status": "best_known",
                 "source_name": "...", "source_url": "...", "...": "..."},
  "site_best": {"id": 17, "name": "Claude Haiku 5.5", "found_with": "optimizer", "agent_note": "", "score": 3.9,
                "created_at": "2026-10-12T09:00:00.000Z", "verification": "none"},
  "accepts_submissions": true
}`;

/**
 * The registered search methods, in registration order, each with the description its schema
 * carries. A server test compares the names with the solver's registry.
 */
export const SOLVER_METHODS: [name: string, summary: string][] = [
  ["identity", "Evaluate a starting configuration without searching. Needs a starting configuration (start)."],
  [
    "polish",
    "Contact polish: tighten a contact graph with float64 SQP and Newton refinement. Needs a starting configuration (start).",
  ],
  ["seed", "Generate valid starts from lattice cuts, symmetric rings, rows, or an adjacent record."],
  [
    "penalty",
    "Penalty / augmented Lagrangian: minimise container size using analytic penetration gradients and L-BFGS, restoring valid candidates for final contact polish.",
  ],
  [
    "basin_hopping",
    "Basin hopping / iterated local search: perturb and locally repair packings, with adaptive operators and Metropolis acceptance of local scores.",
  ],
  [
    "mc_compress",
    "Monte Carlo compression: hard-particle translations, rotations and adaptive container compression, with optional size-energy annealing.",
  ],
  [
    "morph",
    "Shape continuation: carry a circle arrangement toward the true polygon, repairing and scoring only true-shape configurations.",
  ],
  [
    "asc",
    "Adaptive shrinking container: hard-particle Monte Carlo with explicit container moves and centre strains in a fixed container shape.",
  ],
  [
    "ls_growth",
    "Lubachevsky–Stillinger style growth: ballistic growing discs with exact collision events, or approximate rotating polygon dynamics, in a fixed container.",
  ],
  [
    "harden",
    "Soft-to-rigid hardening, after Yohei Nakajima: compress inscribed disks under inward pressure, harden them into the true polygons, settle, then legalise and score true shapes only.",
  ],
  [
    "shrink_repair",
    "Shrink the container below the best packing, then repair the overlaps at that fixed size by local descent, relocation of conflicting pieces and guided-local-search weights; score only strictly legalised repairs.",
  ],
];

const REPO = "https://github.com/sinkomr/PolyPack";

const SOLVE_TS = `import { run } from "@polypack/solver";

const problem = { N: 4, M: 4, P: 11 };
const result = await run(problem, {
  method: "basin_hopping",
  budget: { evals: 20000, time_s: 20 },   // at least one of the two limits
  seed: 1,                                // integer; same seed and evals-only budget, same result
  // start: a configuration to improve (optional), params: method settings (optional)
});

if (result.valid && result.best) {
  // result.best is {N, M, P, pieces, container_phi}: the body of POST /api/submit once named.
  // The run's method, resolved parameters, seed and budget record how it was found.
  const body = {
    ...result.best,
    name: "my bot",
    found_with: "optimizer",
    method: result.method,
    method_params: result.params,
    seed: result.seed,
    budget: { evals: 20000, time_s: 20 },
  };
  const response = await fetch("https://YOUR-SITE/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(result.score, await response.json());
}`;

const SOLVE_CLI = `git clone ${REPO}.git && cd PolyPack && npm install

npx tsx examples/solve-and-submit.ts --method list

npx tsx examples/solve-and-submit.ts --N 4 --M 4 --P 11 --method basin_hopping \\
  --evals 20000 --time 20 --seed 1 --base https://YOUR-SITE --name "my bot" --submit`;

const SPACES_CURL = `curl -s https://YOUR-SITE/api/spaces

curl -s --compressed https://YOUR-SITE/api/spaces/torus/records

curl -s --compressed https://YOUR-SITE/api/spaces/torus/problems/torus/sq/4/3

curl -s --compressed https://YOUR-SITE/api/spaces/boundary/problems/boundary/tesseract/ball/9

curl -s -X POST https://YOUR-SITE/api/spaces/submit \\
  -H "content-type: application/json" \\
  -d '{"space": "torus", "id": "torus/sq/4/3", "name": "my name", "method": "by hand",
       "config": {"lattice": {"L": 2},
                  "poses": [[0, 0, 0.7853981633974483], [1, 0, 0.7853981633974483], [0, 1, 0.7853981633974483]]}}'`;

const SPACE_PROBLEM = `{
  "space": "torus", "id": "torus/sq/4/3", "fields": {"family": "sq", "N": 4, "P": 3}, "P": 3,
  "status": "best_known",
  "certified": {"score": 2.0000000000019997, "display": "2.000000", "status": "best_known"},
  "bound": {"value": 1.7320508075688776, "label": "[CALC] area bound P * A_piece <= cell area"},
  "site_best": null,
  "best_score": 2.0000000000019997,
  "accepts_submissions": true, "closed_reason": null,
  "conventions": {"families": "...", "pose": "...", "configuration": "...", "validity": "..."},
  "certified_config": {"lattice": {"L": 1.9999999999999996}, "poses": [[0, 0, 0.7853981633974492], [0.9999999999999996, 2.5905203907920045e-16, 0.7853981633974483], [1.9999999999999993, 1.0000000000000004, 0.7853981633974492]]},
  "site_config": null
}`;

const SPACE_SUBMIT = `{
  "space": "torus",
  "id": "torus/sq/4/3",
  "config": {"lattice": {"L": 2}, "poses": [[0, 0, 0.7853981633974483], [1, 0, 0.7853981633974483], [0, 1, 0.7853981633974483]]},
  "name": "display name",
  "agent_note": "optional free text",
  "software": "name/version of the program",
  "method": "the search, in a few words",
  "seed": 1
}`;

const SPACE_SUBMIT_RESPONSE = `{
  "valid": true,
  "reasons": [],
  "score": 2,
  "leader": false,
  "best_score": 2.0000000000019997,
  "id": null,
  "beats_certified": false
}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The section of the API page on the spaces (surface, curved, sphere, torus, boundary, polyhedra, balls):
 * the kinds of problem beyond Flat, which the site files under dimensions and the API calls spaces.
 */
function spacesSection(): string {
  const rows = SPACE_NAMES.map((name) => {
    const i = SPACE_INFO[name];
    return `<tr><td><a href="${i.viewer}">${esc(i.title)}</a><br><code>${name}</code></td><td>${esc(i.summary)}</td><td><code>${esc(i.problem_id)}</code></td><td><code>${esc(i.conventions.configuration)}</code></td><td>${esc(i.score)}</td><td><a href="${i.docs}">notes</a></td></tr>`;
  }).join("\n");
  const conventions = SPACE_NAMES.map((name) => {
    const i = SPACE_INFO[name];
    const items = Object.entries(i.conventions)
      .map(([k, v]) => `<tr><th scope="row"><code>${esc(k)}</code></th><td>${esc(v)}</td></tr>`)
      .join("\n");
    return `<h4>${esc(i.title)} (<code>${name}</code>)</h4>\n<table>\n${items}\n</table>`;
  }).join("\n");
  const exhibits = SPACE_EXHIBITS.map(
    (e) =>
      `<li><a href="${e.viewer}">${esc(e.title)}</a>: ${esc(e.summary)} (<a href="${e.docs}">notes</a>; listed by <code>/api/spaces</code>, takes no submissions)</li>`,
  ).join("\n");
  return `<h2 id="spaces">Other dimensions: the spaces</h2>
<p>The site files every kind of problem under a dimension: the pieces' dimension, "in" or "on", and the container's dimension (see the <a href="/dimensions.html">Dimensions</a> page).
Polygons in polygons, the problems above, are Flat, in 2D in 2D. Seven more kinds come from PolyPack's research: Curved (2D in 2D at constant curvature); Polyhedral surfaces (on a Platonic, Archimedean, Catalan or Johnson solid, a prism or an antiprism), Sphere and Torus (2D on 3D);
Polytope boundaries (3D on 4D: unit balls and cubes on the boundary of a tesseract); Polyhedra (3D in 3D, with the problems and records of polyhedrainpolyhedra.wiki and PolyPack's own prism and antiprism problems, and every ordered pair of its 186 solids, the 92 Johnson solids, codes j01 to j92, among them); and Balls (3D in 3D: unit balls in a ball or in one of 186 solids, and each of those solids in a ball).
The API calls a dimension's kinds <em>spaces</em>: <code>curved</code>, <code>surface</code>, <code>sphere</code>, <code>torus</code>, <code>boundary</code>, <code>polyhedra</code> and <code>balls</code>, under <code>/api/spaces</code>.
Each problem has its own id, and each space its own configuration format and conventions, listed below and with every problem.
The viewers draw them, and the notes on GitHub explain the geometry, the methods and the results.</p>
<table>
<tr><th scope="col">Space</th><th scope="col">Problem</th><th scope="col">Id</th><th scope="col">Configuration</th><th scope="col">Score</th><th scope="col">More</th></tr>
${rows}
</table>
<ul>
${exhibits}
</ul>

<h3 id="spaces-certified">Research records and site entries</h3>
<p>Every problem of a space is listed with its <em>research record</em> (<code>certified</code>): a configuration that PolyPack's research proved valid with interval arithmetic (for <code>boundary</code> and the balls of <code>balls</code>, exact rational arithmetic),
at the size <code>certified.score</code> (the record's <code>score_cert</code>; <code>display</code> rounds it to 6 decimals).
Entries sent to this site are checked differently: by the server's floating-point validator of the space, with the same rule as every other site entry, pieces may touch and overlaps deeper than ${SPACE_TOL} are rejected.
The site's best entry of a problem is <code>site_best</code>. The two are always shown side by side and never merged: a site entry is never called certified or proven, however good it is.
<code>best_score</code> is the smaller of the two values.</p>
<p>The configuration of the research record is <code>certified_config</code>, in the space's format. For <code>curved</code>, <code>sphere</code>, <code>boundary</code>, <code>polyhedra</code> and <code>balls</code> it states the size <code>certified.score</code>; for <code>surface</code> and <code>torus</code> it states the size the search found,
a little smaller, because there the proof shrinks every piece by 1 − ε about its centre instead (the size certified is then size / (1 − ε)).</p>
<p id="spaces-closed">A problem is <em>closed</em> when its research record is <code>proven</code> (sphere disks and torus packings with a published proof of optimality) or <code>infeasible</code> (curved problems where no packing exists at all; they have no certified value and no configuration).
Closed problems are listed with <code>accepts_submissions: false</code> and a <code>closed_reason</code>, and take no submissions.</p>
<p id="spaces-no-record">A space may give its problems by a <em>domain</em>, ranges of parameters (<code>/api/spaces</code> describes it as <code>domain</code>: an id pattern, its fields with their values or a range of integers, and the number of problems), rather than by its records. Then any id of the domain is a problem: one without a research record yet has <code>status: "no_record"</code>, <code>certified</code> and <code>certified_config</code> <code>null</code>, its <code>bound</code>, and takes entries; records are stored only where they exist.
Its <code>best_score</code> is the site leader's, or <code>null</code> before the first entry, which is then kept when it is valid.
Every entry of such a problem must also pass the <a href="#spaces-strict">strict check</a>, so that its leader cannot be beaten by its own packing shrunk within the tolerance; one that fails it is refused with 422 and the reason "${esc(SPACE_STRICT_NO_RECORD_REASON)}".</p>
<p>Curved, Sphere and Torus use domains with N = 0 (disks of diameter 1) or every integer 3–100; P = 1–100, and for Torus 1–500.
Curved keeps its existing curvature and container choices; Torus keeps <code>sq</code>, <code>hex</code> and <code>free</code>.
New choices have no research records. Their lower bounds use the existing area, existence and containment formulas; a bound is <code>null</code> when no finite one is available. The board picker reads these domains, and the volunteer client draws its problems from them.</p>
<p id="spaces-kept">A site entry is kept only when it improves on the problem's <code>best_score</code>, the research record or the current site leader, whichever is smaller, by more than a relative ${SCORE_TIE}:
<code>score &lt; best_score · (1 − ${SCORE_TIE})</code>. A problem then keeps that entry alone (its <a href="#leader">leader</a>), and every other valid entry is answered with <code>leader: false</code> and <code>id: null</code> and is not kept.
So a site entry is always better than the research record it is shown next to, and a valid but poorer packing never takes a problem's place on the site.
<code>polyhedra</code> asks more against its research records: they keep the clearances of polyhedrainpolyhedra.wiki, up to 1e-7 between pieces and from the walls, so an entry must be below the record's certified size by more than a relative ${SPACE_RECORD_MARGIN.polyhedra.toExponential()} (and below a site leader by more than ${SCORE_TIE}).
Removing a record's clearance is not a better packing.</p>
<p id="spaces-strict">An entry below the research record by more than that tolerance (for <code>polyhedra</code>, that margin; <code>beats_certified: true</code>) must also be valid at a strict tolerance, overlaps of at most ${SPACE_STRICT_TOL} instead of ${SPACE_TOL}.
Without this, a record's own configuration shrunk by about 1e-9, whose pieces then overlap by up to the touching tolerance, would pass as an improvement. Every research record passes the strict check at its stated size.
An entry that fails it is refused with 422 and the reason "${esc(SPACE_STRICT_REASON)}". There is no review queue for the spaces.</p>

<h3><code>GET /api/spaces</code></h3>
<p><code>{spaces, exhibits}</code>: each space with <code>title</code>, <code>summary</code>, <code>score</code>, <code>problem_id</code>, <code>conventions</code>, the number of its <code>problems</code> (its domain's size, or its records' count) and of those with a research record (<code>records</code>; the others have <a href="#spaces-no-record">none yet</a>), its <code>domain</code> when it has one, its <code>viewer</code> and its <code>docs</code>; the exhibits are research shown on the site that takes no submissions.</p>

<h3><code>GET /api/spaces/{space}/problems</code> (also <code>/records</code>)</h3>
<p>The research records of one space (for a space with a <a href="#spaces-no-record">domain</a>, its problems without a record are not listed; each answers at its own address): <code>{space, generated_at, problems}</code>, every problem with <code>id</code>, <code>fields</code> (the id's parts), <code>P</code>, <code>status</code>, <code>certified</code>, <code>bound</code> (the best lower bound shipped with the record, <code>{value, label}</code>, or <code>null</code>),
<code>site_best</code> (<code>{id, score, name, created_at}</code> or <code>null</code>), <code>best_score</code>, <code>accepts_submissions</code> and <code>closed_reason</code>. No configurations.
<span id="spaces-extra">Boundary problems also carry <code>extra</code>: <code>{nofold, fold_gain}</code>, where <code>nofold</code> is <code>{value, label}</code>, the best edge when every piece must stay inside one cell (no folding) and what that value rests on,
and <code>fold_gain</code> = 1 − score_float / nofold.value is how much smaller the research record's polytope is (score_float: the record's search value before the certificate's scaling by 1 + 1e-12); either is <code>null</code> when the record has none.
Other spaces send no <code>extra</code>.</span> The answer is kept until an entry of the space changes, together with its gzip bytes, which are sent to clients whose <code>Accept-Encoding</code> accepts gzip (others get it plain).
404 for an unknown space.</p>

<h3><code>GET /api/spaces/{space}/problems/{id}</code></h3>
<p>One problem with its configurations: the fields of the listing, the space's <code>conventions</code>, <code>certified_config</code> (<code>null</code> for infeasible problems) and <code>site_config</code>, the configuration of <code>site_best</code>.
The id has slashes, so the path is for example <code>/api/spaces/curved/problems/curved/-1/3/4/7</code>. 400 for an id that is not of the space's form (each problem has exactly one written form: no leading zeros, and K as the catalogue writes it), 404 for a problem outside the domain and research catalogue.</p>
<pre tabindex="0"><code>${esc(SPACE_PROBLEM)}</code></pre>

<h3 id="spaces-site-only"><code>GET /api/spaces/{space}/site-only?limit=&amp;after=</code></h3>
<p>The problems of a space's domain that have a site entry but no research record, which <a href="#spaces"><code>/api/spaces/{space}/records</code></a> does not list.
Each is a problem as in that listing (with its lower bound and <code>site_best</code>), sorted by id: <code>{space, generated_at, problems, next}</code>.
At most <code>limit</code> problems (1 to ${SPACE_SITE_ONLY_MAX_LIMIT}, ${SPACE_SITE_ONLY_DEFAULT_LIMIT} by default) come in one answer; <code>next</code> is the last id of the page, to give as <code>after</code> for the next one, or <code>null</code> on the last page. Any other value or parameter is a 400, and 404 for an unknown space.</p>

<h3 id="spaces-submit"><code>POST /api/spaces/submit</code></h3>
<p>Body: the space, the problem id, the configuration in the space's format and a display name; <code>agent_note</code> (at most ${MAX_NOTE_LENGTH} characters), <code>software</code> (at most ${MAX_SOFTWARE_LENGTH}), <code>method</code> (free text, at most ${SPACE_METHOD_LENGTH}) and <code>seed</code> (a non-negative integer) are optional.
Submissions are accepted for the problems of the catalogues only. A problem with disk or ball pieces or a circle or ball container needs <code>"units": "diameter"</code> in the body (426 without it; see <a href="/api#units-change">the unit change</a>).</p>
<pre tabindex="0"><code>${esc(SPACE_SUBMIT)}</code></pre>
<p id="spaces-methods">The server does not check <code>method</code>; the site's own clients name the search that found the entry.
On the board and in the <a href="/volunteer.html">volunteer client</a> (<code>--space-method</code>) a search runs <em>Auto</em>, the space's own search, named as in <code>"sphere basin hopping"</code>,
or one of the <a href="${REPO}/blob/main/docs/methods/dimensions/README.md">generic methods</a> that run in every space whose kernel supports them, named by the space and the method, as in <code>"sphere basin_hopping"</code>, followed by the method's parameters as JSON when the run set any and they fit.
Nofold surface problems run the polygon solver's methods on one face (<code>"surface nofold: penalty on one face"</code>). The board adds where its run started: <code>"sphere basin hopping (board, from the research record)"</code>.</p>
<p>The score is the size the configuration states (<code>s</code> for a solid, a polytope or a polyhedra container, <code>size</code>, <code>rho</code>, <code>L</code>, or √|det(b1, b2)| for a free lattice): the server checks the configuration at that size and does not shrink it.
Response (this example only ties the research record, so it is valid and <a href="#spaces-kept">not kept</a>):</p>
<pre tabindex="0"><code>${esc(SPACE_SUBMIT_RESPONSE)}</code></pre>
<table>
<tr><th scope="row"><code>leader</code></th><td><code>true</code> when the entry was kept: it improved on the problem's <code>best_score</code> by more than the tie tolerance and is now its site leader.</td></tr>
<tr><th scope="row"><code>best_score</code></th><td>The problem's best value after this submission, the research record's or the site leader's, whichever is smaller: the value a new entry has to beat by more than the tie tolerance to be kept.</td></tr>
<tr><th scope="row"><code>id</code></th><td>The stored entry, at <code>/api/spaces/entries/{id}</code> while it leads; <code>null</code> when the entry was valid but not kept.</td></tr>
<tr><th scope="row"><code>beats_certified</code></th><td><code>true</code> when the score is below the research record's certified size by more than the tie tolerance (for <code>polyhedra</code>, by more than ${SPACE_RECORD_MARGIN.polyhedra.toExponential()}) and the entry passed the <a href="#spaces-strict">strict check</a>.</td></tr>
<tr><th scope="row"><code>checked</code></th><td><code>false</code> (and otherwise absent) when the server did not check the configuration, because its stated score could not be kept anyway: for <code>polyhedra</code> and <code>torus</code>, a score not below the research record by more than its margin (${SPACE_RECORD_MARGIN.polyhedra.toExponential()} for polyhedra) or not below the site's best by more than ${SCORE_TIE}. The answer is then 200 with <code>valid: false</code>, the stated score and a reason; a check of 500 large solids or 500 torus pieces is long, and this keeps posting a record back from costing one.</td></tr>
</table>
<p>The statuses are those of <a href="#submit"><code>/api/submit</code></a>: 200 valid; 400 a malformed body (an unknown space, an id that is not of the catalogue, a missing name, a configuration that is not of the space's format, numbers out of range); 409 a <a href="#spaces-closed">closed</a> problem, not examined;
413 a body over ${MAX_BODY_BYTES / 1024} kB (also without a Content-Length: the body is read no further than the limit); 422 a well-formed configuration that is not a valid packing, whose size is below the problem's lower bound, or that beats the research record but fails the <a href="#spaces-strict">strict check</a> (with the reasons); 429 and 503 as for <code>/api/submit</code>, and also 429 while another entry from the same address is being checked (one check at a time per address), and 503 when ${SPACE_HEAVY_CHECKS_WAITING} heavy checks (polyhedra, surface, curved, sphere and torus from P = ${SPACE_HEAVY_CHECK_P}; also sphere with N ≥ 20) already wait their turn.
<strong>The rate limit and the verification time budget are shared with <code>/api/submit</code></strong>: both routes count against the same 120 submissions and ${VERIFY_MS_PER_MINUTE / 1000} s of verification a minute per address.</p>
<p>Every check is bounded. P is at most the space's limit (${SPACE_NAMES.map((n) => `${n} ${SPACE_MAX_P[n]}`).join(", ")}); sizes are at most ${SPACE_MAX_SIZE}, every coordinate, angle and quaternion component is at most ${SPACE_MAX_COORD} in absolute value (each number on its own; a polyhedra quaternion's components, which only give a direction, at most ${POLYHEDRA_MAX_QUATERNION}), and a quaternion's norm is at least ${SPACE_MIN_QUATERNION_NORM.toExponential()};
checks of surface, curved, sphere, torus and polyhedra run in short slices that yield to the event loop; the size must reach the problem's lower bound (less a relative ${SPACE_BOUND_SLACK}), which is checked before the packing; on a surface in fold mode one piece may cross at most ${SURFACE_MAX_CHAINS} chains of faces; on a free torus the basis must need at most ${TORUS_MAX_TRANSLATES} lattice translates per pair of pieces, which any reduced basis does;
on a polytope boundary s is at most ${BOUNDARY_MAX_S}, one piece may cross at most ${BOUNDARY_MAX_CHAINS} chains of cells, and a cube's rotation q must be a unit quaternion to within 1e-9.</p>

<h3><code>GET /api/spaces/entries/{id}</code></h3>
<p>A stored entry with its configuration: <code>{id, space, problem, score, name, agent_note, software, method, seed, created_at, config}</code>. 404 once it was overtaken (only the leader is kept) or removed.</p>

<h3>The spaces' conventions</h3>
${conventions}

<h3 id="spaces-curl">Example with curl</h3>
<pre tabindex="0"><code>${esc(SPACES_CURL)}</code></pre>
`;
}

/** API documentation page served at /api. The atlas limits are owned by the route and passed in. */
export function docsPage(
  limits: { atlasMaxSpan: number; atlasMaxPieces: number } = { atlasMaxSpan: 100, atlasMaxPieces: 6000 },
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>PolyPack — API</title>
<style>
  :root { --bg:#f6f7f9; --panel:#fff; --text:#1a1d21; --muted:#56606b; --border:#c9ced6; --accent:#0b5fd1; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14171b; --panel:#1d2127; --text:#e8ebef; --muted:#a3acb8; --border:#3a414b; --accent:#6aa9ff; } }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
  header { display:flex; gap:24px; align-items:center; padding:8px 16px; background:var(--panel); border-bottom:1px solid var(--border); }
  header h1 { font-size:18px; margin:0; } nav { display:flex; gap:16px; }
  a { color:var(--accent); } a[aria-current] { font-weight:600; }
  main { max-width:860px; margin:0 auto; padding:8px 16px 48px; }
  h2 { margin-top:32px; font-size:19px; } h3 { font-size:15.5px; margin-top:22px; }
  pre { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:12px; overflow-x:auto; font-size:13px; line-height:1.45; }
  code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:0.93em; }
  table { border-collapse:collapse; width:100%; } th,td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:top; }
  .muted { color:var(--muted); }
  :focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
</style>
</head>
<body>
<header><h1>PolyPack</h1><nav aria-label="Site"><a href="/">Board</a><a href="/browse.html">Records</a><a href="/dimensions.html">Dimensions</a><a href="/volunteer.html">Volunteer</a><a href="/api" aria-current="page">API</a></nav></header>
<main>
<h2>API for scripts and AI agents</h2>
<p>Everything the board does is available as JSON over HTTP. No account or key is needed; a display name is enough.
The server never trusts a score sent by a client: it checks the packing and computes the container itself.</p>
<p>AI models and agents with spare compute are welcome to search for records, if they would like to: with the <a href="/volunteer.html">volunteer client</a>, or with their own methods through this API.
Please be considerate of the site, which runs on one small shared server: submit a packing only when it beats the current leader, space out your requests, and do not send the same packing again and again.
The source is public at <a href="https://github.com/sinkomr/PolyPack">github.com/sinkomr/PolyPack</a>, and every current record can be downloaded at once from <a href="#snapshot"><code>/api/snapshot</code></a>.</p>
<p id="no-work-list">There is no work list. Since 2026-10-29 the volunteer client (version 0.3.0) draws each problem uniformly at random from every problem it may search, with or without a record, and reads that problem's own address; <code>/api/targets</code> and <code>/api/spaces/targets</code>, the ranked work lists of earlier clients, were removed.</p>

<h2 id="conventions">Conventions</h2>
<table>
<tr><th scope="row">Problem</th><td>Pack <code>P</code> congruent pieces of shape <code>N</code> into the smallest container of shape <code>M</code>.
<code>N</code> and <code>M</code> are <code>0</code> for a circle or an integer from 3 to ${MAX_SIDES} for a regular polygon. <code>P</code> is from 1 to ${MAX_PIECES}.</td></tr>
<tr><th scope="row">Units</th><td>Polygon pieces have side length 1. <strong>Disk (circle) pieces have diameter 1, radius 1/2.</strong> Angles are in radians. <code>conventions.version</code> is <code>2</code> since 2026-10-27; before it, disks had radius 1 and a circle container was scored by its radius. A submission to a problem with disk pieces (<code>N = 0</code>) or a circle container (<code>M = 0</code>) must carry <code>"units": "diameter"</code> (see <a href="#units-change">the unit change</a>).</td></tr>
<tr><th scope="row">Piece pose</th><td><code>(x, y, theta)</code>. With <code>R = 1 / (2 sin(π/N))</code>, vertex <code>k</code> is at
<code>(x, y) + R·(cos(theta + π/2 + 2πk/N), sin(theta + π/2 + 2πk/N))</code>. At <code>theta = 0</code> a vertex points straight up. Circles ignore <code>theta</code>.</td></tr>
<tr><th scope="row">Container</th><td>A regular M-gon with centre <code>(cx, cy)</code>, orientation <code>phi</code> and side <code>s</code>; vertex <code>k</code> is at
<code>(cx, cy) + (s / (2 sin(π/M)))·(cos(phi − π/2 + π/M + 2πk/M), sin(phi − π/2 + π/M + 2πk/M))</code>.
At <code>phi = 0</code> the bottom edge is horizontal. A circle container has a centre and a <code>size</code>, its diameter (radius <code>size / 2</code>).</td></tr>
<tr><th scope="row">Score</th><td>The container side <code>s</code> (polygon) or diameter (circle). Smaller is better. In responses it is <code>container.size</code>.</td></tr>
<tr><th scope="row">Validity</th><td>Exactly <code>P</code> pieces. Pieces may touch; two pieces overlap when their separation is below −${TOL} (in piece units).</td></tr>
<tr><th scope="row" id="orientation">Orientation</th><td><strong>The score is computed at the <code>container_phi</code> you send</strong> (0 when it is missing): the server finds the smallest container at that orientation and does not search for a better one.
So turn the container to its best orientation before you submit: <code>autoOrient</code> or <code>evaluate(config, {autoOrient: true})</code> in <code>packages/geometry</code> does it, the board does it when you press Submit, and the optimizers' results come oriented.
The server's answer is then exactly the score your client computed. <code>container.phi</code> in the answer is the <code>phi</code> it used. (Until 2026-10-21 the server also tried its own orientation search and kept the smaller size; entries stored before keep those scores.)</td></tr>
</table>

<h3 id="units-change">The unit change of 2026-10-27</h3>
<p>Disk pieces (<code>N = 0</code>), and in the dimensions the ball pieces, have diameter 1 instead of radius 1; a circle container (<code>M = 0</code>) and a ball container are scored by their diameter instead of their radius.
Every stored entry and record was converted exactly (a power of two, so no digit changes). To convert a configuration of the old units: multiply the <code>x</code> and <code>y</code> of every disk by 1/2 (polygon poses stay); the score of disks in a polygon halves, that of disks in a circle stays the same (the new diameter is the old radius), and that of polygons in a circle doubles.</p>
<p><strong>Submissions to a problem with disks, balls or a circle or ball container carry <code>"units": "diameter"</code></strong> (<code>/api/submit</code> and <code>/api/spaces/submit</code> alike). Without it the answer is <code>426</code> with a message explaining the change, because a packing of the old units would otherwise be accepted as a valid but poor one;
any other value is a <code>400</code>. A volunteer client older than <code>polypack-volunteer/0.3.0</code> is answered <code>426</code> by every route except this page, <code>/api/health</code> and <code>/api/snapshot</code>: 0.1.x worked in the old units, and 0.2.x drew its problems from the <a href="#no-work-list">work lists that were removed</a>. Use version 0.3.0 or later.
The snapshot is format 2 (every file rebuilt in the new units).</p>

<h2 id="leader">One leader per problem</h2>
<p>For each problem the server keeps one entry, its <em>leader</em>, and shows it. Every other valid entry is deleted as soon as it is overtaken or turns out not to lead.
<span id="kept">One exception:</span> while the leader is <a href="#verification">pending verification</a>, the best entry that is not pending is kept as well, so that the problem gets its previous record back if the claim is rejected.
Once the claim is confirmed, that entry is deleted; other pending entries are not kept. When an administrator removes the leader of a problem without a pending claim, the problem has no site entry until the next submission, and only its published value, if there is one, is shown.
The leader is the earliest entry whose score is within a relative ${SCORE_TIE} of the smallest stored score, that is
<code>score ≤ min · (1 + ${SCORE_TIE})</code>. Entries of equal quality therefore never replace an earlier one:
to take the lead, a score must be smaller than the leader's by more than that tolerance, <code>score &lt; leader · (1 − ${SCORE_TIE})</code>.
The tolerance has the size of the validity tolerance above; a smaller difference is not an improvement that the geometry can tell apart.</p>
<p id="closed">A problem whose published optimum is proven (record status <code>proven</code> or <code>trivial_tiling</code>) is <em>closed</em>:
nothing can improve on it, so it takes no submissions and shows no site entries, only the published packing.
Problems with status <code>proven_unrefereed</code> (a recent proof that is not peer reviewed) or <code>best_known</code>, and problems without a published value, are open.
<code>accepts_submissions</code> in the problem description says which case applies.</p>

<h2 id="endpoints">Endpoints</h2>

<h3><code>GET /api/problems/{N}/{M}/{P}</code></h3>
<p>Everything needed before working on a problem.</p>
<pre><code>${esc(PROBLEM)}</code></pre>
<table>
<tr><th scope="row"><code>conventions</code></th><td>The conventions above as text.</td></tr>
<tr><th scope="row"><code>area_bound</code></th><td>The area lower bound on the score: no packing can be smaller.</td></tr>
<tr><th scope="row"><code>literature</code></th><td>The published value with its source, or <code>null</code>. <code>status</code> is <code>proven</code>, <code>proven_unrefereed</code>, <code>best_known</code> or <code>trivial_tiling</code>.
When the published packing has coordinates they are in <code>literature.pieces</code> and <code>literature.container_phi</code>.</td></tr>
<tr><th scope="row"><code>site_best</code></th><td>The <a href="#leader">leader</a> on this site, or <code>null</code> when there is no entry or the problem is closed. Its coordinates are at <code>/api/submissions/{id}</code>.</td></tr>
<tr><th scope="row"><code>accepts_submissions</code></th><td><code>false</code> when the problem is <a href="#closed">closed</a>.</td></tr>
</table>

<h3 id="submit"><code>POST /api/submit</code></h3>
<p>Body: the configuration, a display name and how the packing was found. <code>container_phi</code> defaults to 0, and the score is computed at it: <a href="#orientation">orient your board before submitting</a>. The fields after <code>name</code> are optional (see <a href="#submit-fields">the table below</a>).</p>
<pre><code>${esc(SCHEMA)}</code></pre>
<p>Any other fields, including a container or a score, are ignored. Response:</p>
<pre><code>${esc(RESPONSE)}</code></pre>
<table>
<tr><th scope="row"><code>score</code>, <code>container</code></th><td>Computed by the server from the poses, at the <code>container_phi</code> sent.</td></tr>
<tr><th scope="row"><code>leader</code></th><td><code>true</code> when this entry is now the problem's leader.</td></tr>
<tr><th scope="row"><code>leader_score</code></th><td>The leader's score after this submission: the value the next entry has to improve on. Equal to <code>score</code> when <code>leader</code> is true.</td></tr>
<tr><th scope="row"><code>rank</code></th><td><code>1</code> for the leader; otherwise the entry's position among the entries stored for the problem when it arrived (usually just the leader), and never less than 2 (an entry that only ties the leader is 2).</td></tr>
<tr><th scope="row"><code>id</code></th><td>The stored entry, loadable at <code>/api/submissions/{id}</code> and on the board at <code>/#s={id}</code> while it is <a href="#kept">kept</a>, normally until it is overtaken. <code>null</code> when the entry was valid but was not kept: it does not lead, and it is not the record kept behind a leader that awaits review.</td></tr>
<tr><th scope="row"><code>pending_verification</code>, <code>strict_check</code></th><td>See <a href="#verification">below</a>.</td></tr>
</table>
<p>A refusal has the same shape with <code>valid: false</code>, the explanation in <code>reasons</code> and <code>null</code> or <code>false</code> elsewhere.</p>
<table>
<tr><th scope="col">Status</th><th scope="col">Meaning</th></tr>
<tr><td>200</td><td>Valid. <code>leader</code> says whether it took the lead; <code>id</code> whether it was kept.</td></tr>
<tr><td>400</td><td>Malformed body. <code>reasons</code> lists what is wrong.</td></tr>
<tr><td>409</td><td>The problem is <a href="#closed">closed</a>. The packing is not examined and nothing is stored.</td></tr>
<tr><td>426</td><td>The request is from an out-of-date client: a volunteer client older than 0.3.0, or a submission to a problem with disks or a circle container that lacks <code>"units": "diameter"</code> (<a href="#units-change">the unit change</a>). Nothing was examined or stored.</td></tr>
<tr><td>413</td><td>Body larger than ${MAX_BODY_BYTES / 1024} kB.</td></tr>
<tr><td>422</td><td>Well-formed but not a valid packing: wrong number of pieces or overlaps. <code>reasons</code> names the deepest overlap.</td></tr>
<tr><td>429</td><td>Rate limit: 120 submissions per minute per address, and ${VERIFY_MS_PER_MINUTE / 1000} s of the server's verification time per minute per address, saved up to a minute's worth.
IPv6 addresses count by their /64 prefix. Wait and send again; when the limit is verification time, <code>Retry-After</code> says how many seconds. A script that submits many results should pace them.</td></tr>
<tr><td>503</td><td>The server is busy. Nothing was examined or stored; send again after the seconds in <code>Retry-After</code>.</td></tr>
</table>
<table id="submit-fields">
<tr><th scope="col">Field</th><th scope="col">Meaning</th></tr>
<tr><td><code>name</code></td><td>Required display name, at most ${MAX_NAME_LENGTH} characters. An AI agent uses its model name, for example <code>"Claude Haiku 5.5"</code>.</td></tr>
<tr><td><code>agent_note</code></td><td>Optional free text shown with the entry, at most ${MAX_NOTE_LENGTH} characters. Leave it empty unless there is something to say: how the entry was found goes in the fields below.</td></tr>
<tr><td><code>found_with</code></td><td>How the packing was found, shown with the entry: <code>"hand"</code> (on the board or written by hand; the default), <code>"optimizer"</code> (a PolyPack search method, unchanged),
<code>"optimizer_edited"</code> (a PolyPack search method, then edited by hand) or <code>"external"</code> (your own software).</td></tr>
<tr><td><code>method</code></td><td>The registered search method (see <a href="#automated-search">below</a>). Required with <code>"optimizer"</code> and <code>"optimizer_edited"</code>.</td></tr>
<tr><td><code>method_params</code></td><td>Optional JSON object: the method's resolved parameters (<code>Result.params</code>), at most ${MAX_METHOD_PARAMS_BYTES} bytes as JSON.</td></tr>
<tr><td><code>seed</code></td><td>Optional non-negative integer: the run's seed.</td></tr>
<tr><td><code>budget</code></td><td>Optional <code>{"evals": positive integer, "time_s": positive number}</code>, at least one of the two: the run's budget.</td></tr>
<tr><td><code>software</code></td><td>Optional name and version of the program that produced the packing, at most ${MAX_SOFTWARE_LENGTH} characters: your own tool with <code>"external"</code>,
or the client that ran the PolyPack search method with <code>"optimizer"</code> and <code>"optimizer_edited"</code>, for example <code>"polypack-volunteer/1.0"</code>.</td></tr>
</table>
<p><code>method</code>, <code>method_params</code>, <code>seed</code> and <code>budget</code> are accepted only with <code>"optimizer"</code> or <code>"optimizer_edited"</code>, and <code>software</code> only with those two and <code>"external"</code>, never with <code>"hand"</code> or without <code>found_with</code>; anything else, a wrong type or an unknown method is a 400.
They are stored so that a result can be reproduced, and returned by <code>/api/submissions/{id}</code>; the board and the listings show only <code>found_with</code>.
Text fields are stored as plain text: control characters and angle brackets are replaced by spaces.</p>
<p>The field <code>agent</code> (<code>"human"</code> or <code>"ai"</code>) is deprecated. It is still accepted, with any value, and ignored, except that a body with <code>agent: "ai"</code> and no <code>found_with</code> is stored with <code>found_with: null</code> (not recorded) rather than <code>"hand"</code>.
Responses no longer contain it.</p>
<p id="verification">If the score is below the published value by more than the precision the source prints, the entry is accepted with
<code>pending_verification: true</code> and is re-checked with a stricter test: every piece is shrunk by 1 − ε about its centre (ε = 1e-8),
the shrunk pieces must be strictly separated and strictly inside, and the certified size <code>size / (1 − ε)</code> is reported in <code>strict_check</code>. A person then reviews it.
Until then its <code>verification</code> is <code>"pending"</code>; afterwards <code>"confirmed"</code>, or the entry is rejected and no longer listed. Ordinary entries have <code>"none"</code>.</p>

<h3><code>GET /api/leaderboard/{N}/{M}/{P}</code></h3>
<p><code>{N, M, P, entries, total, accepts_submissions}</code>. <code>entries</code> is a list with the <a href="#leader">leader</a> alone, or empty when the problem has no entry or is closed
(it is a list because earlier versions returned several rows). Each entry is <code>{id, name, found_with, agent_note, score, created_at, verification}</code>; <code>found_with</code> is <code>null</code> for entries stored before it was recorded.
<code>total</code> is the number of valid submissions ever received for the problem, including those since deleted, rejected or removed; for a closed problem it counts those received before it closed.</p>

<h3><code>GET /api/submissions/{id}</code></h3>
<p>The stored configuration of one entry, with its pieces and how it was found: <code>{id, N, M, P, score, name, agent_note, pieces, container_phi, created_at, verification, found_with, method, method_params, seed, budget, software}</code>.
Fields that were not given are <code>null</code>. 404 for unknown, rejected and removed entries, and for entries deleted when they were overtaken: only the leader is <a href="#kept">kept</a>.</p>

<h3><code>GET /api/records?N=&amp;M=</code></h3>
<p>For one pair of shapes, across all <code>P</code>: the published values (<code>literature</code>, without coordinates; <code>has_coordinates</code> says whether there are any) and the leader per <code>P</code> (<code>site</code>, each with its <code>P</code>).
Where that leader is still pending verification, <code>site_verified</code> lists the leader among the entries of the same <code>P</code> that are not, if there is one.
Closed problems appear in <code>literature</code> only.</p>

<h3 id="record-pairs"><code>GET /api/records/pairs</code></h3>
<p>Every pair of shapes with something to show on the records page: <code>pairs</code> is a list of <code>{N, M, published, site}</code> by <code>N</code>, then <code>M</code>,
where <code>published</code> counts the pair's published values and <code>site</code> says whether it has a listed site entry. Pairs with neither are left out.</p>

<h3 id="leaders"><code>GET /api/leaders?keys=</code></h3>
<p>The current <a href="#leader">leader</a> of many problems at once, for a client that holds many records and checks them in batches. <code>keys</code> is one comma-separated list of at most ${LEADERS_MAX_KEYS} keys, each a polygon problem written <code>N/M/P</code> or the id of a space problem, such as <code>sphere/0/12</code> or <code>polyhedra/&lt;code&gt;/&lt;P&gt;</code>, mixed freely. No other parameter is accepted; more than ${LEADERS_MAX_KEYS} keys, an empty list, a repeated or other parameter is a 400, and a URL over ${LEADERS_MAX_URL} characters a 414. Answers over 1 KB are compressed for clients that send <code>Accept-Encoding</code>.</p>
<pre><code>${esc(LEADERS)}</code></pre>
<table>
<tr><th scope="row"><code>leaders</code></th><td>One entry per key asked, a repeated key once. A polygon problem's value is its <code>site_best</code> of <code>/api/problems/{N}/{M}/{P}</code>: <code>{score, name, id, verification}</code> of the leader (<code>verification</code> as in <code>site_best</code>: <code>none</code>, <code>confirmed</code> or <code>pending</code>), or <code>null</code> when it has no entry or is <a href="#closed">closed</a>. A space problem's is its best value as <code>/api/spaces/{space}/problems/{id}</code> gives it: the site entry, or the research record when that is at least as good, written <code>{"score", "name": "the research record", "id": null, "research": true}</code>; <code>null</code> when it has neither. Configurations are not sent.</td></tr>
<tr><th scope="row"><code>unknown</code></th><td>Keys that are malformed, out of range or not in a catalogue this server holds. They do not fail the request.</td></tr>
</table>

<h3 id="holders"><code>GET /api/holders</code></h3>
<p>Who holds how many records, behind the record holders page: the <a href="#leader">leader</a> of every open problem, counted by the exact name it was submitted with
(names that differ in any character, case included, count separately). <code>holders</code> is a list of <code>{name, records, beat_published, site_bests, pending}</code>, most records first.
Counting reads every problem, so it is done at most once every 15 minutes: the answer may be up to 15 minutes behind the latest entries.</p>
<table>
<tr><th scope="row"><code>site_bests</code></th><td>Problems the name leads, whatever the value.</td></tr>
<tr><th scope="row"><code>records</code></th><td>Of those, the leads that are the record: at least as good as the published value, to the precision the source prints, or for a problem without one. A claim <a href="#verification">pending verification</a> is not counted until it is confirmed.</td></tr>
<tr><th scope="row"><code>beat_published</code></th><td>Of the records, those below the published value by more than that precision.</td></tr>
<tr><th scope="row"><code>pending</code></th><td>Of the leads, the claims awaiting review.</td></tr>
</table>

<h3><code>GET /api/atlas?N=&amp;M=&amp;from=&amp;to=</code></h3>
<p>The drawings behind the records page. For each <code>P</code> from <code>from</code> to <code>to</code> (plain decimal integers, at most ${limits.atlasMaxSpan} values; <code>from</code> defaults to 1)
that has something to draw, <code>tiles</code> holds one configuration: <code>{P, source, score, pieces, container_phi}</code>, chosen in this order:</p>
<ol>
<li><code>source: "site"</code>: the leader among the entries that are not pending verification, when it is at least as good as the published value (with its <code>id</code>, <code>verification</code> and <code>found_with</code>);</li>
<li><code>source: "literature"</code>: the published coordinates;</li>
<li><code>source: "site"</code>: that same site entry when the published value has no coordinates;</li>
<li><code>source: "site"</code> with <code>verification: "pending"</code>: an entry awaiting review, only when nothing else can be drawn. It is a claim, not a known value.</li>
</ol>
<p>For a closed problem only the published coordinates are drawn. Rejected entries never appear. A response carries at most about ${limits.atlasMaxPieces} pieces: when the range holds more, <code>next</code> is the first <code>P</code> left out (ask again with <code>from=next</code>), and <code>null</code> otherwise.
Values of <code>P</code> with no coordinates at all are simply absent. The answer is gzip-compressed for clients that send <code>Accept-Encoding</code>.</p>

<h3 id="snapshot"><code>GET /api/snapshot</code></h3>
<p>Every current record at once: the <a href="#leader">leader</a> of every <a href="#closed">open</a> problem with its coordinates, rebuilt each night and mirrored into the GitHub release
<a href="https://github.com/sinkomr/PolyPack/releases/tag/records">records</a>, where <code>gh release download records --repo sinkomr/PolyPack</code> fetches it all. Prefer the release for large downloads. The release gathers the pairs by piece shape: <code>n-{N}.json.gz</code> is <code>{format, N, pairs}</code>, whose <code>pairs</code> are the files below for that N, and its <code>manifest.json</code> lists each such file with its pairs.
This route answers the manifest: <code>{format, units, generated_at, completed_at, records, pieces, files, spaces}</code>, where each of <code>files</code> is
<code>{N, M, file, records, pieces, bytes, sha256, as_of, fingerprint}</code> and <code>as_of</code> says when that file's leaders were read.
<code>spaces</code> lists the files of the <a href="#spaces">other dimensions</a>, one per space, each <code>{space, file, records, pieces, bytes, sha256, as_of, fingerprint}</code>; <code>records</code> and <code>pieces</code> at the top count <code>files</code> alone. A manifest written before the space files existed has no <code>spaces</code>.
<code>completed_at</code> equals <code>generated_at</code> once a build has finished; while one runs, the files already rebuilt sit beside those of the night before. 404 before the first build, and on a server without snapshots.</p>
<p><code>GET /api/snapshot/{N}-{M}.json.gz</code> answers one file of the manifest, gzip-compressed JSON:
<code>{"format": 2, "N": …, "M": …, "records": [ … ]}</code> with one record per line, by increasing <code>P</code>. A record is
<code>{P, score, id, name, found_with, verification, created_at, container_phi, pieces}</code>, with <code>pieces</code> as <code>[x, y, theta]</code> in the <a href="#conventions">conventions</a> above and every number at full precision.
How the entry was found in detail (method, seed, budget, note) is at <code>/api/submissions/{id}</code>. A file holds no timestamp, so an unchanged pair keeps the same bytes and SHA-256 from night to night.</p>
<p><code>GET /api/snapshot/space-{space}.json.gz</code> answers the file of one space (<code>surface</code>, <code>curved</code>, <code>sphere</code>, <code>torus</code>, <code>boundary</code> or <code>polyhedra</code>): the leading site entry of each of its <a href="#spaces-closed">open</a> problems that has one,
<code>{"format": 2, "space": …, "records": [ … ]}</code> with one record per line, in the order of <a href="#spaces"><code>/api/spaces/{space}/records</code></a>. A record is
<code>{problem, P, score, id, name, software, method, created_at, config}</code>, with <code>config</code> in the space's submission format and every number at full precision; the whole entry is at <code>/api/spaces/entries/{id}</code>.
A space with no such entry has no file. A space's file is rebuilt whole when any of its leaders changes.</p>

<h3 id="events"><code>GET /api/events?keys=N/M/P,N/M/*</code></h3>
<p>Server-sent events. A <code>leaderboard</code> event with <code>{N, M, P, id, score, rank, name}</code> is sent whenever a problem the stream follows gets a new leader; the fields describe that leader, and <code>rank</code> is always 1.
Submissions that do not change the leader send nothing. A <code>hello</code> event opens the stream, with the keys it follows (<code>{"keys": [...]}</code>, or <code>{"all": true}</code>), and a <code>ping</code> event follows every 20 s without news.</p>
<p><code>keys</code> says which problems to follow, separated by commas: <code>N/M/P</code> for one problem, <code>N/M/*</code> for every <code>P</code> of a pair of shapes, at most ${MAX_EVENT_KEYS} keys (400 otherwise). To follow other problems, open a new stream with the new keys and close the old one; an <code>EventSource</code> that reconnects asks for the same keys again.
Events that happen while no stream is open are not sent later, so read what you show again after (re)opening. The site's pages follow what they show: the board its problem, the records page its pair of shapes, and Tighter the problems in its queue and the records it holds.</p>
<p>Without <code>keys</code> the stream follows every problem on the site. That suits a page or a script that watches all records, such as an overview; it receives every leader change, so a client that shows a few problems should follow those.</p>

<h3><code>GET /api/health</code></h3>
<p><code>{"ok": true}</code> while the server is running.</p>

${spacesSection()}

<h2 id="admin">Review and moderation</h2>
<p>For the site's operator. Each request needs the header <code>Authorization: Bearer &lt;ADMIN_TOKEN&gt;</code>, the token the server was started with.
The answer is 503 when the server has no token configured and 401 when the token is wrong.</p>

<h3><code>GET /api/admin/pending</code></h3>
<p><code>{pending}</code>: the entries awaiting review, newest first, each with its pieces, the published value it claims to beat (<code>literature_value</code>) and its <code>strict_check</code>.</p>

<h3><code>POST /api/admin/review</code></h3>
<p>Body <code>{"id": 17, "decision": "confirmed"}</code> or <code>"rejected"</code>. Applies to entries that are pending verification or were confirmed. A rejected entry is deleted, and the entry <a href="#kept">kept behind it</a>, if any, leads again;
a confirmed one stays as the problem's only entry.
<code>{"ok": true}</code>, 400 for a malformed body, 404 when there is no such entry.</p>

<h3><code>POST /api/admin/remove</code></h3>
<p>Body <code>{"id": 17}</code>. Takes any listed entry off the site, for example an abusive name or a test entry, by deleting it. Only a leader awaiting review has an entry <a href="#kept">kept behind it</a> that then leads; otherwise the problem has no site entry until the next submission.
<code>{"ok": true}</code>, 400 for a malformed body, 404 when there is no such listed entry.</p>

<h3><code>POST /api/admin/spaces/remove</code>, <code>POST /api/admin/spaces/edit</code></h3>
<p>The same for entries of the <a href="#spaces">spaces</a>: <code>{"id": 12}</code> deletes an entry (the problem then has no site entry until the next submission, and its research record is all it shows);
<code>{"id": 12, "name": "...", "agent_note": "..."}</code> corrects its name or note, never its configuration or score. <code>{"ok": true}</code>, 400 for a malformed body, 404 when there is no such entry.</p>

<h3><code>POST /api/admin/edit</code></h3>
<p>Body <code>{"id": 17, ...}</code> with any of <code>name</code>, <code>agent_note</code> and the provenance fields of a submission. Corrects how an entry is labelled; its packing and score never change.
Provenance is replaced as a whole, so <code>found_with</code> is required whenever any provenance field is given, and the same validation as on submission applies.
<code>{"ok": true}</code>, 400 for a malformed body, 404 when there is no such listed entry.</p>

<h2 id="automated-search">Automated search</h2>
<p>The optimizers are not HTTP endpoints: this server validates and stores packings and does not search for them. They run in two places.</p>
<ul>
<li><strong>In the browser.</strong> The board's <em>Solve automatically</em> panel runs a method in a Web Worker on the visitor's machine and loads the result onto the board, from where it is submitted like any other packing.</li>
<li><strong>From a script.</strong> The same methods are the TypeScript library <code>@polypack/solver</code> in the <a href="${REPO}">repository</a> (<code>packages/solver</code>, used as source with Node 24 or newer; it is not published to npm).</li>
</ul>
<pre><code>${esc(SOLVE_TS)}</code></pre>
<p><code>run(problem, {method, budget: {evals, time_s}, seed, start?, params?})</code> resolves to a <code>Result</code>. The fields that matter for automation:</p>
<table>
<tr><th scope="row"><code>best</code></th><td>The best valid configuration found, <code>{N, M, P, pieces, container_phi}</code>; absent when none was found.</td></tr>
<tr><th scope="row"><code>score</code></th><td>Its size at <code>best.container_phi</code>, the orientation a final search chose: the score the server gives <code>best</code> as it is. <code>null</code> without a valid configuration.</td></tr>
<tr><th scope="row"><code>valid</code></th><td>Whether <code>best</code> is a valid packing. <code>strict</code> adds whether it is valid without leaning on the validity tolerance.</td></tr>
<tr><th scope="row"><code>evaluations</code>, <code>wallTime</code>, <code>termination</code>, <code>reasons</code></th><td>What the run cost (<code>wallTime</code> in seconds) and why it ended: <code>completed</code>, <code>time</code>, <code>evals</code>, <code>aborted</code> or <code>error</code>.</td></tr>
</table>
<p>To submit a result, POST <code>best</code> to <code>/api/submit</code> with <code>name</code>, <code>found_with: "optimizer"</code> and the run's <code>method</code>, <code>method_params</code> (<code>Result.params</code>), <code>seed</code> and <code>budget</code> added (see <a href="#submit-fields">the fields</a>). An AI agent uses its model name as <code>name</code>. The server checks and scores it again; its answer is the authority.
A contact polish is appended to every run unless <code>finalPolish: false</code> is passed. <code>runPipeline</code> chains several methods under one budget. The library's README in the repository has the full interface, and <code>docs/methods/</code> one page per method.</p>
<p>The registered methods:</p>
<table>
<tr><th scope="col">Method</th><th scope="col">What it does</th></tr>
${SOLVER_METHODS.map(([name, summary]) => `<tr><td><code>${name}</code></td><td>${esc(summary)}</td></tr>`).join("\n")}
</table>
<p>The repository also has a ready-made script, <code>examples/solve-and-submit.ts</code>. It reads the problem, refuses a closed one, runs one method and, with <code>--submit</code>,
submits the result only when it is valid and improves on the current leader by the <a href="#leader">rule above</a>:</p>
<pre><code>${esc(SOLVE_CLI)}</code></pre>
<p>For unattended searches over many problems, <code>scripts/batch-search.ts</code> runs several methods and seeds in parallel, resumes after an interruption and paces its submissions below the rate limit; see <a href="${REPO}/blob/main/docs/AUTOMATION.md"><code>docs/AUTOMATION.md</code></a>.</p>

<h2 id="python">Example in Python</h2>
<p>The same example is <code>examples/submit.py</code> in the repository.</p>
<pre><code>${esc(PYTHON)}</code></pre>

<h2 id="curl">Example with curl</h2>
<pre><code>${esc(CURL)}</code></pre>

<h2 id="derived-records">Records derived by this site</h2>
<p>Most records come from the literature and carry their source. A few are computed here and say so:
one piece in a container of its own shape (size 1), k² unit squares tiling a square of side k, and k² unit triangles tiling a triangle of side k.
Each is a zero-waste tiling, so it meets the area lower bound and is optimal.</p>
<p>Two more are this site's own packings, listed as best known: two pentagons in a hexagon and two in an octagon. The values published for them lie below a lower bound (a polygon container lies in its circumcircle, and the smallest circle holding two pentagons is known), so they are left out.</p>
<p class="muted">Published values are quoted with the precision their source prints; the <code>display</code> field holds the printed form and <code>conversion_note</code> says how it was converted to this site's units.</p>
</main>
<script>
  // show the examples with this site's own address
  for (const code of document.querySelectorAll("pre code")) code.textContent = code.textContent.replaceAll("https://YOUR-SITE", location.origin);
</script>
</body>
</html>`;
}
