#!/usr/bin/env python3
"""Summarize only persisted completed receipts; model completion is not a quality pass."""
from __future__ import annotations
import datetime,json,pathlib,re,subprocess
from fetch_opus_release import ROOT,atomic_json

def read(path):return json.loads(path.read_text())
def summaries(directory):return [read(p) for p in sorted(directory.glob('*.summary.json'))] if directory.exists() else []
def pct(value):return '—' if value is None else f'{100*value:.2f}%'
def cell(value):return str(value).replace('|','/').replace('\n',' ')
def table(headers,rows):return '\n'.join(['| '+' | '.join(headers)+' |','| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(cell(x) for x in row)+' |' for row in rows])

def main():
    data=ROOT/'data';mt=summaries(data/'mt40/opus-original-20261103');seg=summaries(data/'mt40/opus-core-sentences-20261103');whole_hold=summaries(data/'mt40/opus-heldout-whole-20261103');seg_hold=summaries(data/'mt40/opus-heldout-sentences-20261103')
    asr=[read(p) for p in sorted((data/'asr40').glob('*/*.summary.json'))]
    smoke=read(data/'process_pipeline/results.json') if (data/'process_pipeline/results.json').exists() else {'results':[],'cancellations':[]}
    review=read(data/'mt40/quality_review.json')
    receipts=[]
    for p in sorted((data/'mt40/receipts').glob('*translation-suite*.json')):
        r=read(p);log=p.with_suffix('.log').read_text();found=re.search(r'Ran (\d+) tests',log);r['tests']=int(found.group(1)) if found else None;receipts.append(r)
    status={'generated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'git_head_at_generation':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'direct_mt_complete':len(mt)==6 and all(s['errors']==0 and s['successful_inference']==s['expected_cases'] for s in mt),'direct_mt_outputs':sum(s['successful_inference'] for s in mt),'direct_gold_outputs':sum(s['gold_cases'] for s in mt),'asr_completed_language_model_jobs':len(asr),'asr_outputs':sum(s['successful_inference'] for s in asr),'asr_complete':len(asr)==8 and all(s['successful_inference']==40 for s in asr),'sentence_wrapper_jobs':len(seg),'holdout_whole_jobs':len(whole_hold),'holdout_sentence_jobs':len(seg_hold),'wrapper_complete':len(seg)==len(whole_hold)==len(seg_hold)==6,'real_process_pipeline_outputs':len(smoke['results']),'real_native_cancel_checks':len(smoke['cancellations']),'process_smoke_complete':len(smoke['results'])==12 and len(smoke['cancellations'])==4,'last_control_test_receipt':receipts[-1] if receipts else None,'voice_translation_release_gate':'blocked','quality_review':review,'production_changed':False}
    atomic_json(data/'verification_status.json',status)
    sections=['# Реальные результаты переводчика — 3 ноября 2026',
    'Коммерческий голосовой перевод пока не принят: в реальных переводах остаются ошибки чисел, валют, времени и пропуски смысла; разрешённая цепочка прав на четыре голоса не подтверждена. Успех inference ниже означает завершённое вычисление. Внешний звонок, микрофон пользователя, TTS и production не использовались.',
    '## Проверяемая граница',
    f"Срез: {status['generated_at']}. Commit перед генерацией отчёта: `{status['git_head_at_generation']}`. Сохранены те же 40 общих FLEURS IDs; SHA-256 selection: `caf155b7d8b440132295416f7d0ebd210061add74672e39d7e929dffb60ae62a`. Разрешение данных CC-BY-4.0, revision `70bb2e84b976b7e960aa89f1c648e09c59f894dd`. Все тяжёлые операции выполняются под общим flock и systemd CPUQuota=100%, MemoryMax=2GiB, TasksMax=128, конечным RuntimeMaxSec, KillMode=control-group. Очередь ожидания общего lock не включена в inference latency. CPUQuota ограничивает бюджет, но не резервирует выделенное физическое ядро: результаты относятся к этой рабочей станции и не являются production SLO.",
    '## MT на правильных исходных текстах',
    table(['Направление','Вычислено','FLEURS','p50,с','p95,с','Max,с','PeakRSS,MiB','Targettoken'],[[s['direction'],s['successful_inference'],s['gold_cases'],s['stage_seconds']['p50'],s['stage_seconds']['p95'],s['stage_seconds']['max'],round(s['max_rss_kib']/1024,1),s['fingerprints']['target_token'] or '—'] for s in mt]),
    'Это MT-only после готового текста, batch 1, beam 6, INT8, один поток CPU; загрузка модели вынесена в summary отдельно. Это не speech-to-speech или первая озвученная порция. Все raw input/output, reference, model SHA, token, timing и errors сохранены в `data/mt40/opus-original-20261103/`. 40 gold IDs плюс авторские/старые контрасты. Argos не сравнивался с потенциально тем же OPUS checkpoint как независимая модель.',
    '## Проверка явной сегментации предложений',
    'Это wrapper ablation на тех же model SHA. Baseline не перезаписывается. Никакие суммы/валюты/отрицания после перевода не подменяются. Дополнительные 6 сценариев на каждом языке зафиксированы в `data/mt40_holdout.json` до сегментатора, SHA `a8b8bc9fb819288f607e189ab787772ea5e4232ddfe37425e767999415404dff`.',
    table(['Направление','Core outputs','MT p50,с','MT p95,с'],[[s['direction'],s['successful_inference'],s['stage_seconds']['p50'],s['stage_seconds']['p95']] for s in seg]),
    f"Отдельных heldout jobs: whole={len(whole_hold)}, sentences={len(seg_hold)} из 6 каждого типа. Raw artifacts: `data/mt40/opus-core-sentences-20261103/`, `opus-heldout-whole-20261103/`, `opus-heldout-sentences-20261103/`. Нативная независимая приёмка не выполнена.",
    '## Найденные критические дефекты',
    table(['Пара','Case','Проверенное наблюдение'],[[x['direction'],x['case_id'],x['finding']] for x in review['baseline_findings']]),
    '### Что изменил wrapper',
    table(['Пара','Case','Проверенное наблюдение'],[[x['direction'],x['case_id'],x['finding']] for x in review.get('wrapper_findings',[])]),
    '### Отложенные сценарии',
    table(['Пара','Case','Проверенное наблюдение'],[[x['direction'],x['case_id'],x['finding']] for x in review.get('heldout_findings',[])]),
    'Лингвистическая проверка здесь выполнена ассистентом и не заменяет приёмку носителями. Отдельно остаются имена, самокоррекции, точные десятичные значения, условия и валюты в живом разговоре.',
    '## Реальный ASR на сохранённом аудио',
    table(['Модель','Язык','Clips','Audio,с','WER','CER','ASRp95,с','Max,с','RTF','PeakRSS,MiB'],[[s['model'],s['language'],s['successful_inference'],s['audio_seconds'],pct(s['word_error_rate']),pct(s['character_error_rate']),s['per_clip_seconds']['p95'],s['per_clip_seconds']['max'],round(s['aggregate_real_time_factor'],3) if s['aggregate_real_time_factor'] is not None else '—',round(s['max_rss_kib']/1024,1)] for s in asr]),
    'Официальные test.tar.gz прочитаны потоком; полный SHA совпадает с LFS объекта pinned revision. На диске только 160 выбранных WAV, их SHA, frames, mono, 16000 Hz проверены против сохранённого manifest. Архивы и посторонние clips не сохранены. Голос пользователя не записывался. `data/fleurs_subset/audio-*.json` содержит provenance; `data/asr40/` — gold/hypothesis/segments/timing/errors.',
    'ASR explicit-language, beam 5, temperature 0, condition_on_previous_text=False, без VAD, целый заранее нарезанный WAV. Нормализация WER/CER: NFKC, lowercase, знаки пунктуации/символы заменены пробелами, whitespace схлопнут; CER без пробелов. Для китайского только CER. Числа не приведены к одному словесному/цифровому виду, поэтому часть WER может отражать формат записи; смысловые ошибки сумм и отрицаний всё равно требуют отдельной проверки. Это 40 фраз на язык из FLEURS, не приёмка шумных совещаний, overlapping speakers или микрофонов.',
    '## Изоляция реального вычисления и smoke',
    f"Сохранено {len(smoke['results'])}/12 реальных audio→ASR→MT traces и {len(smoke['cancellations'])}/4 проверок отмены запроса к прогретому реальному ASR worker с проверенным reap PID. `process_stage.py` ограничивает request/response/pending count, проверяет request ID и завершает process group при timeout/cancel. Ownership lock удерживается до reap старого worker; ожидающий запрос не наследует старый процесс. Новая очередь не отменяет активный запрос только из-за отмены ожидающего. `model_worker.py` читает только проверенные локальные модели и не выполняет сеть или платные API.",
    table(['Направление','FLEURS ID','Cold','ASRwall,с','MTwall,с','Totalafterutterance,с'],[[x['direction'],x['sentence_id'],x['cold_workers'],round(x['asr_wall_seconds'],3),round(x['mt_wall_seconds'],3),round(x['total_after_full_utterance_seconds'],3)] for x in smoke['results']]),
    table(['Язык','Прогретый ASR worker reaped','Оценка задержки отмены,с'],[[x['language'],x['worker_reaped'],round(x['cancel_to_reaped_seconds'],4)] for x in smoke['cancellations']]),
    'Граница cancellation evidence: после трёх реальных распознаваний новый запрос к прогретому ASR worker отменён через запланированные 100 мс; проверено исчезновение PID. Отдельный marker входа в native decoder не снимался. Историческое поле cancel_to_reaped_seconds вычислено как полное wall time минус номинальные 100 мс и может включать scheduler overshoot; это консервативная оценка задержки, а не точное измерение cancel-to-reap. Raw результаты сохранены без изменений.',
    'Здесь нет TTS, LiveKit или потоковой нарезки микрофона. Smoke использует фактический ASR output как MT input, не подставляет gold transcript. Fixtures OS-process tests проверяют жизненный цикл и ограничения; они не доказывают качество моделей.',
    '## Артефакты и права',
    'Original OPUS archives содержат CC-BY-4.0 LICENSE; источники, закреплённые revisions model cards, hash каждого исходного и преобразованного файла и target token сохранены в `data/provenance/opus/`. EN→AR исходная ссылка из HF card вернула 404; выбран официальный standard transformer `eng-ara/opus-2021-02-23` из pinned Tatoeba-Challenge README. NPZ загружается с allow_pickle=False; нет remote code и запуска archive hooks. Whisper base/small verified local revisions и hashes сверены с сохранённым inventory перед каждым ASR job.',
    'Attribution: University of Helsinki Language Technology Research Group / OPUS-MT, Tiedemann and Thottingal (2020); exact release URL в source records. Конверсия Marian NPZ → CTranslate2 INT8 отмечена как изменение. FLEURS: Google, https://huggingface.co/datasets/google/fleurs, CC-BY-4.0. Полные условия и исходные cards сохранены, а не заменены общим repo badge.',
    'TTS: Ruslan — NC, Huayan — Unknown, Kareem grant не найден; Lessac 2013 первичный research licence прямо исключает commercial development. Denis/Dmitri имеют CC0 dataset, но cards сообщают finetuned from Lessac, поэтому отдельно требуется валидная цепочка прав на base weights. Новые голоса не запускались. Подробности и URLs: `LICENSE_MANIFEST.md` и `data/provenance/tts_candidates/`.',
    '## Проверки и остаток',
    json.dumps({'last_control_test_receipt':status['last_control_test_receipt'],'direct_mt_complete':status['direct_mt_complete'],'asr_complete':status['asr_complete'],'wrapper_complete':status['wrapper_complete'],'process_smoke_complete':status['process_smoke_complete']},ensure_ascii=False,indent=2),
    'Остаются блокирующие задачи для функции голосового перевода: качество MT на критических сущностях; независимая нативная приёмка; разрешённые голоса на 4 языка; настоящий VAD/audio framing/LiveKit ingress и egress; listener routing и room lifecycle; отсутствие acoustic echo; измерение first transcript / first audio; нагрузка и admission control; серверные entitlements / usage / privacy. Эта работа не меняет production и не закрывает эти gates одним успешным тестом.'
    ]
    (ROOT/'RESULTS_2026-11-03.md').write_text('\n\n'.join(sections)+'\n')
    print(json.dumps({k:v for k,v in status.items() if k not in {'quality_review','last_control_test_receipt'}},ensure_ascii=False))

if __name__=='__main__':main()
