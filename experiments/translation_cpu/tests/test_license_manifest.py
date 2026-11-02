import unittest
from pathlib import Path

class LicenseManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (Path(__file__).resolve().parents[1] / "LICENSE_MANIFEST.md").read_text(encoding="utf-8")
    def test_piper_180_runtime_license_is_gpl_and_separate_from_voice_assets(self):
        self.assertIn("piper-tts", self.text)
        self.assertIn("GPL-3.0-or-later", self.text)
        self.assertIn("voice/model file and its training data", self.text)
        self.assertNotIn("Upstream Piper source license is MIT", self.text)
    def test_kokoro_v1_includes_mandarin_but_not_ru_or_ar(self):
        self.assertIn("8 languages / 54 voices", self.text)
        self.assertIn("Mandarin Chinese", self.text)
        self.assertIn("does not list Russian or Arabic voices", self.text)
        self.assertNotIn("Plausible English-only TTS candidate", self.text)
    def test_unknown_voice_rights_are_not_marked_approved(self):
        self.assertIn("dataset license is Unknown", self.text)
        self.assertIn("remain unverified", self.text)
        self.assertIn("not approved", self.text.lower())

if __name__ == "__main__":
    unittest.main()
