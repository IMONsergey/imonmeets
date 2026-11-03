"""Experimental real ASR/MT callables for the adapter; no commercially cleared TTS yet."""
from __future__ import annotations
import base64,pathlib
from process_stage import ProcessStage
ROOT=pathlib.Path(__file__).resolve().parent

class ASRProcessEngine:
    def __init__(self,python,language,*,model='base',timeout_seconds=45):
        if language not in {'en','ru','zh','ar'} or model not in {'base','small'}:raise ValueError('Unsupported ASR configuration')
        self.language=language;self.last_result=None
        self.stage=ProcessStage([str(python),str(ROOT/'tools/model_worker.py'),'asr','--language',language,'--model',model],timeout_seconds=timeout_seconds)
    async def __call__(self,audio,language):
        if language!=self.language:raise ValueError('ASR route language mismatch')
        if not isinstance(audio,bytes) or len(audio)>3*1024*1024:raise ValueError('Audio byte cap')
        self.last_result=await self.stage.request({'audio_base64':base64.b64encode(audio).decode('ascii')})
        return self.last_result['text']
    async def close(self):await self.stage.close()

class MTProcessEngine:
    def __init__(self,python,source,target,*,timeout_seconds=45):
        self.source=source;self.target=target;self.last_result=None
        direction=source+'-'+target
        if direction not in {'en-ru','ru-en','en-zh','zh-en','en-ar','ar-en'}:raise ValueError('Direct MT route required')
        self.stage=ProcessStage([str(python),str(ROOT/'tools/model_worker.py'),'mt','--direction',direction],timeout_seconds=timeout_seconds)
    async def __call__(self,text,source,target):
        if (source,target)!=(self.source,self.target):raise ValueError('MT route mismatch')
        if not isinstance(text,str) or len(text)>8000:raise ValueError('Text character cap')
        self.last_result=await self.stage.request({'text':text})
        return self.last_result['text']
    async def close(self):await self.stage.close()
