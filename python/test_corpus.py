"""Run from the repository root: python3 python/test_corpus.py."""

import json
import math
import unittest
from pathlib import Path

from geometry_reference import evaluate

ROOT = Path(__file__).resolve().parents[1]


class CorpusAgreement(unittest.TestCase):
    def test_every_configuration(self):
        files = sorted((ROOT / "data/corpus").rglob("*.json"))
        self.assertGreater(len(files), 0)
        for file in files:
            with self.subTest(file=str(file.relative_to(ROOT))):
                saved = json.loads(file.read_text())
                valid, score = evaluate(saved["config"])
                self.assertEqual(valid, saved["expected_valid"])
                if saved["expected_score"] is None:
                    self.assertIsNone(score)
                else:
                    self.assertTrue(
                        math.isclose(
                            score, saved["expected_score"], rel_tol=1e-10, abs_tol=1e-9
                        ),
                        f"{score} != {saved['expected_score']}",
                    )
        print(f"Checked {len(files)} corpus configurations, including invalid cases.")


if __name__ == "__main__":
    unittest.main()
