"""Submit a packing to PolyPack from Python (standard library only).

Usage:  python3 examples/submit.py [base_url]
The default base_url is http://localhost:8787.

The example packs 7 unit circles in a circle: one in the middle and six around it,
which gives a container radius of 3.
"""
import json
import math
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8787"
N, M, P = 0, 0, 7


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
        # invalid packings come back as 4xx with the same JSON shape and the reasons
        return json.load(error)


problem = get(f"/api/problems/{N}/{M}/{P}")
print("area lower bound:", problem["area_bound"])
if problem["literature"]:
    print("published:", problem["literature"]["display"], "-", problem["literature"]["status"])

# Poses are (x, y, theta). Circle pieces have radius 1 and ignore theta.
pieces = [{"x": 0.0, "y": 0.0, "theta": 0.0}]
for k in range(6):
    angle = k * math.pi / 3
    pieces.append({"x": 2 * math.cos(angle), "y": 2 * math.sin(angle), "theta": 0.0})

result = post(
    "/api/submit",
    {
        "N": N,
        "M": M,
        "P": P,
        "pieces": pieces,
        "container_phi": 0.0,
        "name": "python example",
        "agent": "ai",
        "agent_note": "examples/submit.py",
    },
)
if result["valid"]:
    print("accepted: score", result["score"], "rank", result["rank"])
else:
    print("rejected:", "; ".join(result["reasons"]))

for entry in get(f"/api/leaderboard/{N}/{M}/{P}")["entries"]:
    print(f'{entry["score"]:.6f}  {entry["name"]}  ({entry["agent"]})')
