"""No model/TTS inference: lexical false positives and blocked voice are intentional."""
import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from quality_gate import EXPERIMENTAL_ROUTES, MAX_TEXT_CHARS, assess_translation
from streaming_adapter import TranslationStreamAdapter


class QualityGateTests(unittest.TestCase):
    def test_all_six_required_routes_are_experimental_and_never_voice_granted(self):
        expected = {("ru", "en"), ("en", "ru"), ("ru", "zh"), ("zh", "ru"), ("ru", "ar"), ("ar", "ru")}
        self.assertEqual(EXPERIMENTAL_ROUTES, expected)
        for source, target in expected:
            with self.subTest(route=(source, target)):
                result = assess_translation("hello", "hello", source, target)
                self.assertEqual(result.route_status, "experimental")
                self.assertFalse(result.speech_allowed)
                self.assertIn("route_experimental_voice_blocked", result.reasons)

    def test_other_routes_are_not_silently_added_to_the_product(self):
        for source, target in (("en", "zh"), ("zh", "ar"), ("ru", "ru"), ("xx", "ru")):
            with self.subTest(route=(source, target)):
                result = assess_translation("hello", "hello", source, target)
                self.assertEqual(result.route_status, "unsupported")
                self.assertFalse(result.speech_allowed)

    def test_unambiguous_local_digits_separators_and_currency_aliases_match(self):
        cases = [
            ("Сумма 1\u202f050,05 EUR.", "Amount EUR 1050.05.", "ru", "en"),
            ("المبلغ ١٬٠٥٠٫٠٥ EUR", "Сумма 1050,05 евро.", "ar", "ru"),
            ("المبلغ ۱۲٫۵۰ EUR", "Сумма 12,50 EUR.", "ar", "ru"),
            ("Сумма 12000 CNY", "金额为１２０００人民币", "ru", "zh"),
            ("Amount USD1,050.05", "Сумма 1.050,05 USD", "en", "ru"),
            ("Amount -0.05 EUR", "Сумма -0,05 EUR", "en", "ru"),
        ]
        for source, target, sl, tl in cases:
            with self.subTest(source=source, target=target):
                result = assess_translation(source, target, sl, tl)
                self.assertEqual(result.numeric_check, "match")
                self.assertEqual(result.currency_check, "match")
                self.assertEqual(result.status, "no_risk_detected")
                self.assertFalse(result.speech_allowed)

    def test_digit_amount_or_sign_change_is_suspect(self):
        for original, corrupted in (("1050.05", "1500.05"), ("-12", "12"), ("12000", "1200")):
            with self.subTest(original=original):
                result = assess_translation("Сумма " + original + " EUR", "Amount " + corrupted + " EUR", "ru", "en")
                self.assertEqual(result.numeric_check, "mismatch")
                self.assertIn("numeric_values_mismatch", result.reasons)

    def test_currency_changed_or_dropped_even_with_same_number(self):
        for translated in ("Amount 1200 USD", "Amount 1200"):
            result = assess_translation("Сумма 1200 EUR", translated, "ru", "en")
            self.assertEqual(result.currency_check, "mismatch")
            self.assertIn("currency_markers_mismatch", result.reasons)

    def test_generic_dollar_yen_and_cent_do_not_invent_currency_identity(self):
        for text in ("$1200", "¥1200", "1200 dollars", "5 cents", "1200元"):
            with self.subTest(text=text):
                result = assess_translation(text, text, "ru", "en")
                self.assertIn("currency_identity_ambiguous", result.reasons)
                self.assertEqual(result.status, "needs_review")

    def test_ambiguous_formats_are_not_guessed_or_rtl_reversed(self):
        for value in ("1,050", "1.050", "000 125", "1 05", ".5", "12:30", "01", "1/2"):
            with self.subTest(value=value):
                result = assess_translation(value + " EUR", value + " EUR", "ru", "ar")
                self.assertEqual(result.numeric_check, "unresolved")
                self.assertEqual(result.status, "needs_review")
                self.assertFalse(result.speech_allowed)

    def test_spelled_out_numbers_are_reviewed_without_claiming_a_complete_parser(self):
        for source, language in (
            ("one thousand fifty euros", "en"),
            ("тысяча пятьдесят евро", "ru"),
            ("十二万五千元", "zh"),
            ("ألف وخمسون يورو", "ar"),
        ):
            with self.subTest(language=language):
                result = assess_translation(source, "1500 EUR", language, "ru")
                self.assertEqual(result.numeric_check, "unresolved")
                self.assertIn("numeric_form_unresolved", result.reasons)

    def test_two_amount_bindings_cannot_pass_by_equal_number_and_currency_bags(self):
        result = assess_translation("USD 12; EUR 20", "USD 20; EUR 12", "ru", "en")
        self.assertEqual(result.numeric_check, "match")
        self.assertEqual(result.currency_check, "match")
        self.assertIn("multiple_numeric_bindings_unverified", result.reasons)
        self.assertIn("multiple_currency_bindings_unverified", result.reasons)
        self.assertEqual(result.status, "needs_review")

    def test_percent_unit_loss_is_suspect(self):
        result = assess_translation("Скидка 5%", "Discount 5", "ru", "en")
        self.assertIn("percent_marker_mismatch", result.reasons)

    def test_missing_or_added_negation_across_all_four_languages(self):
        pairs = [
            ("Не одобряйте платеж.", "Approve payment.", "ru", "en"),
            ("Approve payment.", "Не одобряйте платеж.", "en", "ru"),
            ("不要批准付款。", "Одобрите платеж.", "zh", "ru"),
            ("لا توافق على الدفع.", "Одобрите платеж.", "ar", "ru"),
            ("We don't approve.", "Одобряем.", "en", "ru"),
        ]
        for source, target, sl, tl in pairs:
            with self.subTest(source=source):
                result = assess_translation(source, target, sl, tl)
                self.assertEqual(result.negation_check, "mismatch")
                self.assertIn("negation_cue_missing_or_added", result.reasons)

    def test_matching_negation_is_not_semantic_scope_acceptance(self):
        result = assess_translation("Не одобряйте платеж.", "Do not approve the payment.", "ru", "en")
        self.assertEqual(result.negation_check, "scope_unverified")
        self.assertIn("negation_scope_unverified", result.reasons)
        self.assertEqual(result.status, "needs_review")

    def test_cancellation_has_its_own_cue_and_no_recovery_of_missing_instruction(self):
        for source, sl in (("Отмените перевод.", "ru"), ("取消转账。", "zh"), ("ألغِ التحويل.", "ar")):
            with self.subTest(sl=sl):
                result = assess_translation(source, "Send the transfer.", sl, "en")
                self.assertIn("cancellation_cue_missing_or_added", result.reasons)

    def test_bidi_controls_are_not_treated_as_harmless_numeric_equivalence(self):
        result = assess_translation("EUR 1200", "EUR \u202e1200\u202c", "ru", "en")
        self.assertIn("format_controls_need_review", result.reasons)
        self.assertEqual(result.status, "needs_review")

    def test_bounded_text_and_numeric_entity_limits(self):
        for bad in ("", " ", None, "a" * (MAX_TEXT_CHARS + 1)):
            with self.subTest(bad_type=type(bad)):
                with self.assertRaises(ValueError):
                    assess_translation(bad, "text", "ru", "en")
        numbers = "; ".join(str(i + 1) for i in range(33))
        result = assess_translation(numbers, numbers, "ru", "en")
        self.assertIn("lexical_budget_exceeded", result.reasons)

    def test_all_13_frozen_critical_pivot_rows_require_review_without_inference(self):
        review = json.loads((ROOT / "data/ru_pivot_20261103/quality_review.json").read_text())
        findings = [r for r in review["findings"] if r["severity"] == "critical"]
        self.assertEqual(len(findings), 13)
        for finding in findings:
            with self.subTest(route=finding["direction"], case=finding["case_id"]):
                source_language, target_language = finding["direction"].split("-")
                result = assess_translation(finding["input"], finding["output"], source_language, target_language)
                self.assertEqual(result.status, "needs_review")
                self.assertFalse(result.speech_allowed)


class AdapterQualityGateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.adapters = []

    async def asyncTearDown(self):
        for adapter in self.adapters:
            await adapter.close()

    def make(self, translated):
        calls, publications = [], []
        async def asr(audio, language):
            return audio.decode()
        async def mt(text, source, target):
            return translated
        async def tts(text, language):
            calls.append((text, language))
            raise AssertionError("unaccepted route must not reach TTS")
        adapter = TranslationStreamAdapter(asr, mt, tts, on_result=publications.append)
        self.adapters.append(adapter)
        return adapter, calls, publications

    def track(self, adapter, source="ru", target="en"):
        participant = adapter.register_participant("p", session=adapter.session)
        return adapter.register_track(participant, "mic", source, target)

    async def test_all_six_routes_return_marked_text_and_never_invoke_tts(self):
        text = {"ru": "Привет", "en": "Hello", "zh": "你好", "ar": "مرحبا"}
        for source, target in sorted(EXPERIMENTAL_ROUTES):
            with self.subTest(route=(source, target)):
                adapter, calls, publications = self.make(text[target])
                future = await adapter.submit(self.track(adapter, source, target), text[source].encode(),
                                              sequence=1, duration_seconds=.1)
                result = await asyncio.wait_for(future, 1)
                self.assertEqual(result.source_text, text[source])
                self.assertEqual(result.translated_text, text[target])
                self.assertEqual(result.audio, b"")
                self.assertTrue(result.speech_blocked)
                self.assertEqual(result.quality.route_status, "experimental")
                self.assertEqual(calls, [])
                self.assertEqual(publications, [result])

    async def test_corruption_is_marked_and_original_candidate_not_rewritten(self):
        source, candidate = "Сумма 1050.05 EUR", "Amount 1500.05 EUR"
        adapter, calls, _ = self.make(candidate)
        future = await adapter.submit(self.track(adapter), source.encode(), sequence=1, duration_seconds=.1)
        result = await asyncio.wait_for(future, 1)
        self.assertEqual((result.source_text, result.translated_text), (source, candidate))
        self.assertEqual(result.quality.status, "needs_review")
        self.assertIn("numeric_values_mismatch", result.quality.reasons)
        self.assertEqual(result.audio, b"")
        self.assertEqual(calls, [])

    async def test_gate_failure_does_not_fall_back_to_tts_or_publish_unmarked_text(self):
        adapter, calls, publications = self.make("Hello")
        with patch("streaming_adapter.assess_translation", side_effect=ValueError("invalid gate input")):
            future = await adapter.submit(self.track(adapter), "Привет".encode(), sequence=1, duration_seconds=.1)
            with self.assertRaisesRegex(ValueError, "invalid gate input"):
                await asyncio.wait_for(future, 1)
        self.assertEqual(calls, [])
        self.assertEqual(publications, [])

    async def test_cancellation_at_quality_boundary_keeps_freshness_gate(self):
        adapter, calls, publications = self.make("Hello")
        handle = self.track(adapter)
        original = assess_translation
        def cancel_then_assess(*args):
            adapter.cancel_track(handle)
            return original(*args)
        with patch("streaming_adapter.assess_translation", side_effect=cancel_then_assess):
            future = await adapter.submit(handle, "Привет".encode(), sequence=1, duration_seconds=.1)
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(future, 1)
        self.assertEqual(calls, [])
        self.assertEqual(publications, [])


if __name__ == "__main__":
    unittest.main()
