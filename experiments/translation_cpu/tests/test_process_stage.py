import asyncio,json,os,pathlib,signal,sys,tempfile,time,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from process_stage import ProcessStage,StageProtocolError,StageBusyError

ECHO="import sys,json\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({'id':r['id'],'ok':True,'result':r['payload']}),flush=True)"
HANG="import sys,time,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nsys.stdin.readline()\ntime.sleep(60)"

class ProcessStageTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_process_reuse_and_correlated_responses(self):
        stage=ProcessStage([sys.executable,'-u','-c',ECHO])
        try:
            self.assertEqual(await stage.request({'text':'one'}),{'text':'one'});pid=stage.pid
            self.assertEqual(await stage.request({'text':'two'}),{'text':'two'});self.assertEqual(stage.pid,pid)
        finally:await stage.close()
        with self.assertRaises(ProcessLookupError):os.kill(pid,0)
    async def test_timeout_kills_sigterm_resistant_process(self):
        stage=ProcessStage([sys.executable,'-u','-c',HANG],timeout_seconds=.15,terminate_grace_seconds=.05)
        task=asyncio.create_task(stage.request({}))
        while stage.pid is None:await asyncio.sleep(.005)
        pid=stage.pid;started=time.monotonic()
        with self.assertRaises(TimeoutError):await task
        self.assertLess(time.monotonic()-started,1.5)
        with self.assertRaises(ProcessLookupError):os.kill(pid,0)
        self.assertIsNone(stage.pid);await stage.close()
    async def test_cancel_kills_worker_and_prevents_late_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            marker=pathlib.Path(directory)/'late.txt'
            code="import sys,time,pathlib\nsys.stdin.readline()\ntime.sleep(.5)\npathlib.Path(sys.argv[1]).write_text('late')"
            stage=ProcessStage([sys.executable,'-u','-c',code,str(marker)])
            task=asyncio.create_task(stage.request({}))
            while stage.pid is None:await asyncio.sleep(.005)
            pid=stage.pid;await asyncio.sleep(.05);task.cancel()
            with self.assertRaises(asyncio.CancelledError):await task
            with self.assertRaises(ProcessLookupError):os.kill(pid,0)
            await asyncio.sleep(.55);self.assertFalse(marker.exists());await stage.close()
    async def test_oversized_input_is_rejected_before_process_start(self):
        stage=ProcessStage([sys.executable,'-c',ECHO],max_input_bytes=100)
        with self.assertRaises(ValueError):await stage.request({'x':'x'*200})
        self.assertIsNone(stage.pid);await stage.close()
    async def test_wrong_response_id_kills_worker(self):
        code="import sys,json\nsys.stdin.readline()\nprint(json.dumps({'id':999,'ok':True,'result':{}}),flush=True)"
        stage=ProcessStage([sys.executable,'-u','-c',code])
        with self.assertRaises(StageProtocolError):await stage.request({})
        self.assertIsNone(stage.pid);await stage.close()
    async def test_oversized_output_is_rejected_and_worker_killed(self):
        code="import sys,time\nsys.stdin.readline()\nprint('x'*10000,flush=True)\ntime.sleep(60)"
        stage=ProcessStage([sys.executable,'-u','-c',code],max_output_bytes=1024)
        with self.assertRaises(StageProtocolError):await stage.request({})
        self.assertIsNone(stage.pid);await stage.close()
    async def test_close_cancels_running_work_and_rejects_new_work(self):
        stage=ProcessStage([sys.executable,'-u','-c',HANG],terminate_grace_seconds=.05)
        task=asyncio.create_task(stage.request({}))
        while stage.pid is None:await asyncio.sleep(.005)
        await stage.close()
        with self.assertRaises((StageProtocolError,RuntimeError,asyncio.CancelledError)):await task
        with self.assertRaises(RuntimeError):await stage.request({})
    async def test_pending_cap_and_cancelled_waiter_do_not_kill_active_worker(self):
        stage=ProcessStage([sys.executable,'-u','-c',HANG],max_pending=2,terminate_grace_seconds=.05)
        first=asyncio.create_task(stage.request({}))
        while stage.pid is None:await asyncio.sleep(.005)
        pid=stage.pid;second=asyncio.create_task(stage.request({}));await asyncio.sleep(.01)
        with self.assertRaises(StageBusyError):await stage.request({})
        second.cancel()
        with self.assertRaises(asyncio.CancelledError):await second
        self.assertEqual(stage.pid,pid);os.kill(pid,0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):await first
        await stage.close()

class ProcessStageConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_queued_request_survives_active_cancellation(self):
        code="import sys,json,time\nfor line in sys.stdin:\n r=json.loads(line)\n if r['payload'].get('hang'):time.sleep(60)\n print(json.dumps({'id':r['id'],'ok':True,'result':r['payload']}),flush=True)"
        stage=ProcessStage([sys.executable,'-u','-c',code],timeout_seconds=3,terminate_grace_seconds=.05)
        first=asyncio.create_task(stage.request({'hang':True}))
        while stage.pid is None:await asyncio.sleep(.005)
        second=asyncio.create_task(stage.request({'text':'next'}));await asyncio.sleep(.02);first.cancel()
        with self.assertRaises(asyncio.CancelledError):await first
        try:self.assertEqual(await second,{'text':'next'})
        finally:await stage.close()

if __name__=='__main__':unittest.main()
