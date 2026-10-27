"""Submit a packing to PolyPack from Python (standard library only).

Usage:  python3 examples/submit.py [base_url]
The default base_url is http://localhost:8787.

The example packs 11 unit squares in a square as a 4-by-3 grid with one cell left
empty, which gives a container side of 4. The best known packing is smaller, so the
problem is open. Problems whose optimum is proven are closed: the server takes no
entries for them (HTTP 409), and "accepts_submissions" in the problem says so.

Each problem shows one entry, its leader: the earliest of the best. A valid packing
that does not improve on the leader is stored but does not replace it.
"""
import json
import math
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8787"
N, M, P = 4, 4, 11


def get(path):
    with urllib.request.urlopen(BASE + path) as response:
        return json.load(response)


def post(path, body):
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # refusals come back as 4xx with the same JSON shape and the reasons
        return json.load(error)


problem = get(f"/api/problems/{N}/{M}/{P}")
print("area lower bound:", problem["area_bound"])
if problem["literature"]:
    print("published:", problem["literature"]["display"], "-", problem["literature"]["status"])
if problem["site_best"]:
    print("leader:", problem["site_best"]["score"], "by", problem["site_best"]["name"])
if not problem["accepts_submissions"]:
    sys.exit("this problem is closed: its optimum is proven")

# Poses are (x, y, theta). Square pieces have side 1; at theta = pi/4 their sides are
# horizontal and vertical, so centres one unit apart touch.
pieces = [{"x": float(i % 4), "y": float(i // 4), "theta": math.pi / 4} for i in range(P)]

# The server scores the container at container_phi as sent and does not search for a better
# orientation, so orient a board before submitting it. This grid is axis-aligned: 0 is already
# its best orientation.

result = post(
    "/api/submit",
    {
        "N": N,
        "M": M,
        "P": P,
        "pieces": pieces,
        "container_phi": 0.0,
        # disk pieces have diameter 1 and a circle container is scored by its diameter (conventions version 2); the server
        # answers 426 to a problem with disks or a circle container unless the body says so. Harmless for polygons.
        "units": "diameter",
        "name": "python example",
        # a hand-written arrangement; scripts that run an optimizer send "optimizer" with the method
        "found_with": "hand",
    },
)
if result["valid"] and result["leader"]:
    print("accepted: score", result["score"], "- now the leader of this problem")
elif result["valid"]:
    print("not kept: score", result["score"], "does not improve on the leader's", result["leader_score"])
else:
    print("rejected:", "; ".join(result["reasons"]))

for entry in get(f"/api/leaderboard/{N}/{M}/{P}")["entries"]:
    print(f'{entry["score"]:.6f}  {entry["name"]}  ({entry["found_with"] or "not recorded"})')
