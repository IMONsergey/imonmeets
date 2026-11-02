import asyncio
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from streaming_adapter import BackpressureError, StaleFrameError, TranslationStreamAdapter, UnknownTrackError
class FakeEngines:
    def __init__(self): self.gate=None; self.calls=[]
    async def asr(self,audio,language):
        self.calls.append(("asr",audio,language))
        if self.gate is not None: await self.gate.wait()
        return audio.decode()
    async def mt(self,text,source,target):
        self.calls.append(("mt",source,target)); return f"{source}>{target}:{text}"
    async def tts(self,text,language):
        self.calls.append(("tts",language)); return text.encode()
class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engines=FakeEngines(); self.results=[]
        self.adapter=TranslationStreamAdapter(self.engines.asr,self.engines.mt,self.engines.tts,queue_size=2,on_result=self.results.append)
        self.adapter.register_track("p1","mic-1","en","ru"); self.adapter.register_track("p2","mic-2","zh","en"); self.adapter.start()
    async def asyncTearDown(self): await self.adapter.close()
    async def test_routes_participant_track_and_language(self):
        a=await self.adapter.submit("p1","mic-1",b"hello"); b=await self.adapter.submit("p2","mic-2",b"nihao")
        x,y=await asyncio.gather(a,b)
        self.assertEqual((x.participant_id,x.track_id,x.translated_text),("p1","mic-1","en>ru:hello"))
        self.assertEqual((y.participant_id,y.track_id,y.translated_text),("p2","mic-2","zh>en:nihao"))
    async def test_unknown_identity(self):
        with self.assertRaises(UnknownTrackError): await self.adapter.submit("p1","other",b"x")
    async def test_backpressure(self):
        self.engines.gate=asyncio.Event(); a=await self.adapter.submit("p1","mic-1",b"1"); await asyncio.sleep(0)
        b=await self.adapter.submit("p2","mic-2",b"2"); c=await self.adapter.submit("p1","mic-1",b"3")
        with self.assertRaises(BackpressureError): await self.adapter.submit("p2","mic-2",b"4")
        self.engines.gate.set(); await asyncio.gather(a,b,c,return_exceptions=True)
    async def test_stale_never_published(self):
        self.engines.gate=asyncio.Event(); a=await self.adapter.submit("p1","mic-1",b"old"); await asyncio.sleep(0)
        b=await self.adapter.submit("p1","mic-1",b"new"); self.engines.gate.set()
        old,new=await asyncio.gather(a,b,return_exceptions=True)
        self.assertIsInstance(old,StaleFrameError); self.assertEqual(new.source_text,"new")
        self.assertEqual([x.source_text for x in self.results],["new"])
    async def test_cancel_active_and_queued(self):
        self.engines.gate=asyncio.Event(); a=await self.adapter.submit("p1","mic-1",b"active"); await asyncio.sleep(0)
        b=await self.adapter.submit("p1","mic-1",b"queued"); self.adapter.cancel_track("p1","mic-1")
        x,y=await asyncio.gather(a,b,return_exceptions=True)
        self.assertTrue(isinstance(x,asyncio.CancelledError) or x is None); self.assertIsInstance(y,StaleFrameError)
        self.assertEqual(self.results,[])
    async def test_tts_loopback_suppressed(self):
        self.adapter.mark_tts_playback("output-1")
        self.assertIsNone(await self.adapter.submit("p1","mic-1",b"echo",playback_id="output-1"))
        f=await self.adapter.submit("p1","mic-1",b"real"); self.assertEqual((await f).source_text,"real")
if __name__=="__main__": unittest.main()
