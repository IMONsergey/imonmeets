import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'tools'))
from run_asr40 import edit_distance,metrics

class Asr40MetricsTests(unittest.TestCase):
    def test_deletion_insertion_and_substitution_count(self):
        self.assertEqual(edit_distance('abc','adc'),1)
        self.assertEqual(edit_distance('abc','ac'),1)
        self.assertEqual(edit_distance('abc','abxc'),1)
    def test_negation_deletion_is_visible(self):
        m=metrics('We do not approve payment.','We do approve payment.','en')
        self.assertEqual(m['word_errors'],1);self.assertEqual(m['reference_words'],5)
    def test_chinese_uses_characters_not_whitespace_words(self):
        m=metrics('不要付款。','要付款。','zh')
        self.assertIsNone(m['word_errors']);self.assertEqual(m['character_errors'],1)
    def test_number_and_currency_changes_remain_errors(self):
        m=metrics('twelve thousand dollars','twelve hundred euros','en')
        self.assertEqual(m['word_errors'],2)
    def test_case_and_punctuation_do_not_count_as_recognition_error(self):
        self.assertEqual(metrics('Hello, Alex!','hello alex','en')['word_errors'],0)

if __name__=='__main__':unittest.main()
