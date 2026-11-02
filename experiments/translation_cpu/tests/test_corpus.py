import json
import unittest
from pathlib import Path

class CorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((Path(__file__).resolve().parents[1] / "data" / "corpus.json").read_text(encoding="utf-8"))
    def test_unique_cases_and_required_stages(self):
        cases = self.data["cases"]
        ids = [item["id"] for item in cases]
        self.assertEqual(len(ids), len(set(ids)))
        stages = {item["stage"] for item in cases}
        self.assertTrue({"ASR", "ASR+MT", "MT", "VAD", "stream"}.issubset(stages))
    def test_silence_and_interruption_are_explicit(self):
        slots = [item["slots"] for item in self.data["cases"]]
        self.assertTrue(any(item.get("silence") for item in slots))
        self.assertTrue(any(item.get("interruption") for item in slots))
    def test_tts_cases_cover_all_four_languages(self):
        tts = self.data["tts_cases"]
        self.assertGreaterEqual(len(tts), 4)
        self.assertTrue({"en", "ru", "zh", "ar"}.issubset({item["language"] for item in tts}))
    def test_known_quality_regressions_remain_open(self):
        ids = {item["id"] for item in self.data["known_regressions"] if item["status"] == "open"}
        self.assertTrue({"reg-base-name-price", "reg-zh-amount-loss", "reg-ar-semantic-loss"}.issubset(ids))

if __name__ == "__main__": unittest.main()
