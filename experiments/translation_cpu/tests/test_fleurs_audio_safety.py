"""Verify streaming selection boundaries without network or model execution."""
import io, pathlib, sys, tarfile, unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'tools'))
from fetch_selected_fleurs_audio import BoundedHashReader, selected_member

class FleursAudioSafetyTests(unittest.TestCase):
    def test_only_selected_wav_is_kept(self):
        self.assertEqual(selected_member(tarfile.TarInfo('test/42.wav'),{'42.wav'}),'42.wav')
        self.assertIsNone(selected_member(tarfile.TarInfo('test/43.wav'),{'42.wav'}))
    def test_paths_links_and_devices_are_rejected(self):
        for name in ['../42.wav','/test/42.wav','test\\42.wav']:
            with self.subTest(name=name),self.assertRaises(ValueError):selected_member(tarfile.TarInfo(name),{'42.wav'})
        for kind in [tarfile.SYMTYPE,tarfile.LNKTYPE,tarfile.CHRTYPE]:
            info=tarfile.TarInfo('test/42.wav');info.type=kind
            with self.subTest(kind=kind),self.assertRaises(ValueError):selected_member(info,{'42.wav'})
    def test_wrong_directory_cannot_masquerade_as_selected_clip(self):
        with self.assertRaises(ValueError):selected_member(tarfile.TarInfo('train/42.wav'),{'42.wav'})
    def test_size_cap_stops_stream(self):
        reader=BoundedHashReader(io.BytesIO(b'12345'),4)
        with self.assertRaises(ValueError):reader.read(5)
    def test_hash_covers_all_compressed_bytes(self):
        import hashlib
        reader=BoundedHashReader(io.BytesIO(b'12345'),5)
        self.assertEqual(reader.read(2),b'12');self.assertEqual(reader.read(3),b'345')
        self.assertEqual(reader.digest.hexdigest(),hashlib.sha256(b'12345').hexdigest())

if __name__=='__main__':unittest.main()
