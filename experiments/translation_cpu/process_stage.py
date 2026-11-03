"""A local JSON-lines model worker whose CPU work can be terminated on cancellation."""
from __future__ import annotations
import asyncio,json,math,os,signal

class StageProtocolError(RuntimeError):pass
class StageExecutionError(RuntimeError):pass
class StageBusyError(RuntimeError):pass
class StageCleanupError(RuntimeError):
    """Worker retirement is unproven; this stage must never admit again."""
    worker_quarantined=True

class ProcessStage:
    def __init__(self,command,*,timeout_seconds=45,max_input_bytes=4*1024*1024,max_output_bytes=128*1024,max_pending=4,max_pending_bytes=8*1024*1024,max_queue_seconds=10,terminate_grace_seconds=.25,reap_timeout_seconds=1):
        if not command or not all(isinstance(x,str) and x for x in command):raise ValueError('Explicit executable argv required')
        limits=(timeout_seconds,max_input_bytes,max_output_bytes,max_pending,max_pending_bytes,max_queue_seconds,terminate_grace_seconds,reap_timeout_seconds)
        if any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) or x<=0 for x in limits):raise ValueError('Positive finite limits required')
        if any(not isinstance(x,int) for x in (max_input_bytes,max_output_bytes,max_pending,max_pending_bytes)):raise ValueError('Byte/count limits must be integers')
        self.command=tuple(command);self.timeout_seconds=timeout_seconds;self.max_input_bytes=max_input_bytes;self.max_output_bytes=max_output_bytes
        self.max_pending=max_pending;self.max_pending_bytes=max_pending_bytes;self.max_queue_seconds=max_queue_seconds;self.terminate_grace_seconds=terminate_grace_seconds
        self._lock=asyncio.Lock();self._process=None;self._closed=False;self._pending=0;self._sequence=0;self._active_call=None
        self._pending_bytes=0;self._requests=set();self._close_task=None
        self._quarantined_count=0;self._quarantined_bytes=0;self._cleanup_failure=None
        self.reap_timeout_seconds=reap_timeout_seconds

    @property
    def pid(self):return self._process.pid if self._process is not None else None

    @property
    def stats(self):
        return {'pending':self._pending,'pending_bytes':self._pending_bytes,'active':int(self._active_call is not None),'pid':self.pid,'closed':self._closed,'quarantined':bool(self._cleanup_failure and self._process is not None),'cleanup_failure':self._cleanup_failure}

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
        process=self._process
        if process is None:return
        try:
            try:os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:await asyncio.wait_for(process.wait(),self.terminate_grace_seconds)
            except asyncio.TimeoutError:pass
            # Terminate descendants even when their parent exited on SIGTERM.
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            await asyncio.wait_for(process.wait(),self.reap_timeout_seconds)
        except BaseException as error:
            # Never lose a native worker handle on failed wait/reap (including
            # uninterruptible kernel I/O). A new request must not spawn beside it.
            self._closed=True;self._cleanup_failure=type(error).__name__
            for task in tuple(self._requests):
                if task is not self._active_call:task.cancel()
            raise StageCleanupError('worker retirement unproven; stage quarantined') from error
        self._process=None
        self._pending-=self._quarantined_count;self._pending_bytes-=self._quarantined_bytes
        self._quarantined_count=0;self._quarantined_bytes=0

    async def _cleanup(self):
        task=asyncio.create_task(self._stop())
        while not task.done():
            try:await asyncio.shield(task)
            except asyncio.CancelledError:continue
        task.result()

    async def request(self,payload,*,deadline=None):
        if self._closed:raise RuntimeError('stage is closed')
        if self._pending>=self.max_pending:raise StageBusyError('stage admission count limit')
        if not isinstance(payload,dict):raise TypeError('payload must be an object')
        now=asyncio.get_running_loop().time()
        if deadline is None:deadline=now+self.timeout_seconds
        if isinstance(deadline,bool) or not isinstance(deadline,(int,float)) or not math.isfinite(deadline):raise ValueError('Finite local monotonic deadline required')
        expires=min(deadline,now+self.timeout_seconds)
        if expires<=now:raise TimeoutError('stage request already expired')
        wire_payload=json.dumps(payload,ensure_ascii=False,separators=(',',':'),allow_nan=False)
        reservation=len(wire_payload.encode())+64
        if reservation>self.max_input_bytes:raise ValueError('stage input byte cap')
        if self._pending_bytes+reservation>self.max_pending_bytes:raise StageBusyError('stage aggregate byte limit')
        request_task=asyncio.current_task()
        self._requests.add(request_task);self._pending+=1;self._pending_bytes+=reservation
        acquired=False
        try:
            # Queue expiry must never terminate the worker owned by another call.
            async with asyncio.timeout_at(min(expires,now+self.max_queue_seconds)):
                await self._lock.acquire()
                acquired=True
            self._active_call=request_task
            async with asyncio.timeout_at(expires):
                try:
                    if self._closed:raise RuntimeError('stage is closed')
                    process=await self._start()
                    if self._closed:raise RuntimeError('stage closed during startup')
                    self._sequence+=1;request_id=self._sequence
                    wire=('{'+'"id":'+str(request_id)+',"payload":'+wire_payload+'}\n').encode()
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
                    # Keep ownership until the old process group has been reaped.
                    await self._cleanup()
                    raise
        finally:
            if acquired:
                self._active_call=None
                self._lock.release()
            self._requests.discard(request_task)
            if acquired and self._cleanup_failure and self._process is not None:
                # Retain the native input reservation until a later successful
                # cleanup proves reaping. Queued-only callers release normally.
                self._quarantined_count+=1;self._quarantined_bytes+=reservation
            else:
                self._pending-=1;self._pending_bytes-=reservation

    async def _finish_close(self):
        requests=tuple(self._requests)
        for task in requests:task.cancel()
        if requests:await asyncio.gather(*requests,return_exceptions=True)
        async with self._lock:await self._cleanup()

    async def close(self):
        retry=self._close_task is not None and self._close_task.done() and (self._close_task.cancelled() or self._close_task.exception() is not None)
        if self._close_task is None or retry:
            self._closed=True
            self._close_task=asyncio.create_task(self._finish_close())
            self._close_task.add_done_callback(lambda done:None if done.cancelled() else done.exception())
        # A cancelled closer cannot abandon a live child or queued reservations.
        await asyncio.shield(self._close_task)
