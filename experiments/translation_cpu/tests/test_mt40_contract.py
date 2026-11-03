"""Corpus and target-token contract tests; real quality is evaluated in saved MT outputs."""
import pathlib, sys, unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'tools'))
from run_mt40 import cases_for, source_tokens

class Tokenizer:
    def encode(self,text,out_type): return [text]

class MT40ContractTests(unittest.TestCase):
    def test_all_directions_preserve_exact_ids_and_gold_target(self):
        wanted=[1661,1669,1677,1687,1697,1709,1717,1725,1733,1741,1748,1757,1766,1773,1782,1793,1800,1809,1818,1826,1835,1842,1853,1863,1872,1883,1894,1901,1910,1917,1928,1939,1947,1956,1964,1974,1982,1991,2001,2009]
        for source in ['en','ru','zh','ar']:
            for target in ['en','ru','zh','ar']:
                if source==target:continue
                cases=cases_for(source+'-'+target)
                self.assertEqual([x['sentence_id'] for x in cases if x['kind']=='fleurs_gold_text'],wanted)
                self.assertTrue(all(x['input'] and x['reference'] for x in cases[:40]))
    def test_target_tokens_are_literal_prefixes(self):
        self.assertEqual(source_tokens('hello',Tokenizer(),'en-zh'),['>>cmn_Hans<<','hello'])
        self.assertEqual(source_tokens('hello',Tokenizer(),'en-ar'),['>>ara<<','hello'])
        self.assertEqual(source_tokens('hello',Tokenizer(),'en-ru'),['hello'])
    def test_pivot_input_identity_matches_real_first_hop_cases(self):
        for source in ['ru','zh','ar']:
            first={c['case_id']:c['input'] for c in cases_for(source+'-en')}
            for target in ['ru','zh','ar']:
                if source==target:continue
                for case in cases_for(source+'-'+target):self.assertEqual(first[case['case_id']],case['input'])
    def test_no_empty_silence_is_sent_to_mt(self):
        self.assertTrue(all(c['input'] for c in cases_for('en-ru')))
    def test_self_translation_rejected(self):
        with self.assertRaises(ValueError):cases_for('en-en')

if __name__=='__main__':unittest.main()
