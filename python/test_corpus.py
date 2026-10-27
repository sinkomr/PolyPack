"""Run from the repository root: python3 python/test_corpus.py."""

import json
import math
import unittest
from pathlib import Path

from geometry_reference import evaluate

ROOT = Path(__file__).resolve().parents[1]


# UNITS-DATA: reads data/corpus/**, which the units change (Part 10) converts to diameter units. Until then every
# file with a circle piece or a circle container fails here; polygon-only files pass.
class CorpusAgreement(unittest.TestCase):
    def assertScore(self, score, expected):
        if expected is None:
            self.assertIsNone(score)
        else:
            self.assertTrue(
                math.isclose(score, expected, rel_tol=1e-10, abs_tol=1e-9),
                f"{score} != {expected}",
            )

    def test_every_configuration(self):
        files = sorted((ROOT / "data/corpus").rglob("*.json"))
        self.assertGreater(len(files), 0)
        for file in files:
            with self.subTest(file=str(file.relative_to(ROOT))):
                saved = json.loads(file.read_text())
                # the server's rule: the container at the configuration's own container_phi
                valid, score = evaluate(saved["config"], auto_orient=False)
                self.assertEqual(valid, saved["expected_valid"])
                self.assertScore(score, saved["expected_score"])
                # what a client gets by turning the container before submitting
                _, oriented = evaluate(saved["config"])
                self.assertScore(oriented, saved["oriented_score"])
        print(f"Checked {len(files)} corpus configurations, including invalid cases.")


if __name__ == "__main__":
    unittest.main()
