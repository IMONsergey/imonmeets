"""Boundary tests for official archive ingestion; these are not model quality tests."""
import pathlib, stat, sys, tempfile, unittest, zipfile
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'tools'))
from convert_opus_release import archive_members, local_artifact

class OpusReleaseSafetyTests(unittest.TestCase):
    def members(self,*extra):
        return [zipfile.ZipInfo(n) for n in ['LICENSE','decoder.yml','source.spm','target.spm',*extra]]
    def test_archive_hooks_are_not_selected(self):
        selected=archive_members(self.members('preprocess.sh','postprocess.sh','weights.npz','vocab.yml'))
        self.assertEqual({x.filename for x in selected},{'LICENSE','decoder.yml','source.spm','target.spm','weights.npz','vocab.yml'})
    def test_path_traversal_absolute_and_backslash_are_rejected(self):
        for name in ['../escape.npz','/tmp/escape.npz','nested/weights.npz','..\\escape.npz']:
            with self.subTest(name=name), self.assertRaises(ValueError): archive_members(self.members(name))
    def test_symlink_is_rejected(self):
        member=zipfile.ZipInfo('weights.npz');member.external_attr=(stat.S_IFLNK|0o777)<<16
        with self.assertRaises(ValueError): archive_members(self.members()+[member])
    def test_duplicate_is_rejected(self):
        with self.assertRaises(ValueError): archive_members(self.members('LICENSE'))
    def test_missing_license_is_rejected(self):
        with self.assertRaises(ValueError): archive_members([zipfile.ZipInfo('weights.npz')])
    def test_member_size_is_bounded(self):
        member=zipfile.ZipInfo('weights.npz');member.file_size=769*1024*1024
        with self.assertRaises(ValueError): archive_members(self.members()+[member])
    def test_decoder_cannot_escape_directory(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)
            for name in ['../weights.npz','/tmp/weights.npz','..\\weights.npz']:
                with self.subTest(name=name), self.assertRaises(ValueError): local_artifact(root,name)
    def test_decoder_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);(root/'real').write_text('data');(root/'weights.npz').symlink_to(root/'real')
            with self.assertRaises(ValueError): local_artifact(root,'weights.npz')

if __name__=='__main__':unittest.main()
