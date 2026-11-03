"""A local JSON-lines model worker whose CPU work can be terminated on cancellation."""
from __future__ import annotations
import asyncio,json,os,signal

class StageProtocolError(RuntimeError):pass
class StageExecutionError(RuntimeError):pass
class StageBusyError(RuntimeError):pass

class ProcessStage:
    def __init__(self,command,*,timeout_seconds=45,max_input_bytes=4*1024*1024,max_output_bytes=128*1024,max_pending=4,terminate_grace_seconds=.25):
        if not command or not all(isinstance(x,str) and x for x in command):raise ValueError('Explicit executable argv required')
        if min(timeout_seconds,max_input_bytes,max_output_bytes,max_pending,terminate_grace_seconds)<=0:raise ValueError('Positive limits required')
        self.command=tuple(command);self.timeout_seconds=timeout_seconds;self.max_input_bytes=max_input_bytes;self.max_output_bytes=max_output_bytes
        self.max_pending=max_pending;self.terminate_grace_seconds=terminate_grace_seconds
        self._lock=asyncio.Lock();self._process=None;self._closed=False;self._pending=0;self._sequence=0;self._active_call=None

    @property
    def pid(self):return self._process.pid if self._process is not None else None

    async def _start(self):
        if self._process is not None:return self._process
        environment={k:os.environ[k] for k in ['PATH','LANG','LC_ALL','TZ'] if k in os.environ}
        environment.update({'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1','NUMEXPR_NUM_THREADS':'1','CUDA_VISIBLE_DEVICES':'','HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','TOKENIZERS_PARALLELISM':'false','PYTHONUNBUFFERED':'1','PYTHONNOUSERSITE':'1'})
        spawn=asyncio.create_task(asyncio.create_subprocess_exec(*self.command,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,limit=self.max_output_bytes+1,start_new_session=True,env=environment))
        try:self._process=await asyncio.shield(spawn)
        except asyncio.CancelledError:
            # Retain ownership even when cancellation races OS process creation.
            while not spawn.done():
                try:await asyncio.shield(spawn)
                except asyncio.CancelledError:continue
            self._process=spawn.result()
            raise
        return self._process

    async def _stop(self):
        process,self._process=self._process,None
        if process is None:return
        try:os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        try:await asyncio.wait_for(process.wait(),self.terminate_grace_seconds)
        except asyncio.TimeoutError:pass
        # Terminate descendants even when their parent exited on SIGTERM.
        try:os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        await asyncio.wait_for(process.wait(),1)

    async def _cleanup(self):
        task=asyncio.create_task(self._stop())
        while not task.done():
            try:await asyncio.shield(task)
            except asyncio.CancelledError:continue
        task.result()

    async def request(self,payload):
        if self._closed:raise RuntimeError('stage is closed')
        if self._pending>=self.max_pending:raise StageBusyError('stage admission limit')
        if not isinstance(payload,dict):raise TypeError('payload must be an object')
        wire_payload=json.dumps(payload,ensure_ascii=False,separators=(',',':'))
        if len(wire_payload.encode())+64>self.max_input_bytes:raise ValueError('stage input byte cap')
        self._pending+=1
        try:
            async with asyncio.timeout(self.timeout_seconds):
                async with self._lock:
                    self._active_call=asyncio.current_task()
                    try:
                        if self._closed:raise RuntimeError('stage is closed')
                        process=await self._start()
                        if self._closed:raise RuntimeError('stage closed during startup')
                        self._sequence+=1;request_id=self._sequence
                        wire=('{"id":'+str(request_id)+',"payload":'+wire_payload+'}\n').encode()
                        process.stdin.write(wire);await process.stdin.drain()
                        try:line=await process.stdout.readline()
                        except ValueError as error:raise StageProtocolError('worker output byte cap') from error
                        if not line or len(line)>self.max_output_bytes or not line.endswith(b'\n'):raise StageProtocolError('missing or oversized worker response')
                        try:response=json.loads(line)
                        except (ValueError,UnicodeDecodeError) as error:raise StageProtocolError('invalid worker JSON') from error
                        if not isinstance(response,dict) or response.get('id')!=request_id:raise StageProtocolError('worker response identity mismatch')
                        if self._closed:raise RuntimeError('stage closed before result')
                        if response.get('ok') is not True:raise StageExecutionError(str(response.get('error_type','WorkerError')))
                        if not isinstance(response.get('result'),dict):raise StageProtocolError('worker result must be an object')
                        return response['result']
                    except BaseException:
                        # Keep the ownership lock until the old process is reaped.
                        # A queued request must never inherit, or lose, this worker.
                        await self._cleanup()
                        raise
                    finally:self._active_call=None
        finally:self._pending-=1

    async def close(self):
        self._closed=True
        active=self._active_call
        if active is not None and active is not asyncio.current_task():active.cancel()
        async with self._lock:await self._cleanup()
