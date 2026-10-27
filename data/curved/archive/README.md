# Archived: curved-space records of disks of radius 1

Archived 2026-10-27. Not served by the site or the API.

On 2026-10-27 disk pieces (N = 0) changed from radius 1 to diameter 1 (radius 1/2). Everything in this folder is the
data of the OLD problems, disks of radius 1, unchanged and in its original units (geodesic lengths at curvature K,
disks of radius 1). It is kept for reference.

A disk packing of radius 1 at curvature K is the packing of disks of diameter 1 at curvature 4 K, with every length
halved (lengths scale by 1/2, curvature by 4). So these records are equivalent to disks of diameter 1 at K = +-4 (and
the near-flat K = +-1e-6 ones to K = +-4e-6). They are not records of the problems now offered, disks of diameter 1 at
K = -1 and K = 1 (and the other curvatures): those are open, without records.

What is here (the same layout and schemas as data/curved):

- `records.json`: the 52 records (41 best known, 11 infeasible) and 12 catalogue entries with N = 0
  (M = 0, 3, 4, 5, 6, 8 at K = +-1; M = 0 at K = +-1e-6);
- `certification.json`: their 41 certificates; `bounds.json` and `ideal.json`: the 12 and 6 entries with N = 0;
- `sweep/`: the curvature sweeps of disks in a disk (`sweep_0_0_P.json`, 15 files), their 633 records in
  `sweep/records.json` and their 15 summaries in `sweep/summary.json`. The sweeps of disks of diameter 1 are not yet
  made (K runs over 4 times the range, [-8, 2.6]).

Polygon-piece data (N >= 3) was not touched: those problems are unchanged. `python/curved/archive_disks.py` made the
split. The archived certificates were made by the certifier for disks of radius 1 (git history before this date);
`python/curved/certify.py` now certifies disks of diameter 1.

Sizes in this folder: for a disk container (M = 0) the archived `size`/score is the container's geodesic RADIUS (the
served polygon-piece M = 0 records are scored by the DIAMETER since 2026-10-27).
