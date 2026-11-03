import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from sentence_segments import split_sentences

class SentenceSegmentsTests(unittest.TestCase):
    def test_independent_final_command_survives_segmentation(self):
        self.assertEqual(split_sentences('The transfer is ... no, cancel that. Send only ten euros.'),['The transfer is ... no, cancel that.','Send only ten euros.'])
    def test_decimal_points_and_initialisms_are_not_sentences(self):
        self.assertEqual(split_sentences('The U.S. price is 12.50 dollars. Check it.'),['The U.S. price is 12.50 dollars.','Check it.'])
    def test_titles_and_clock_abbreviations(self):
        self.assertEqual(split_sentences('Dr. Smith comes at 4:20 p.m. Wait for him.'),['Dr. Smith comes at 4:20 p.m.','Wait for him.'])
    def test_arabic_and_chinese_endings(self):
        self.assertEqual(split_sentences('你好。价格是多少？请确认。'),['你好。','价格是多少？','请确认。'])
        self.assertEqual(split_sentences('هل توافق؟ لا توافق.'),['هل توافق؟','لا توافق.'])
    def test_does_not_rewrite_numbers_negation_or_punctuation(self):
        text='No, 1050.05 EUR! Not 1500.50 EUR.'
        self.assertEqual(' '.join(split_sentences(text)),text)
    def test_limits_reject_instead_of_silently_dropping_content(self):
        with self.assertRaises(ValueError):split_sentences('One. Two. Three.',max_segments=2)
        with self.assertRaises(ValueError):split_sentences('a'*8001)
    def test_whitespace_only_has_no_model_input(self):self.assertEqual(split_sentences(' \n '),[])

if __name__=='__main__':unittest.main()
