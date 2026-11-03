# RU↔ZH/AR: следующий эксперимент и приемка его свидетельств

Этот каталог дополняет сохраненную цепочку эксперимента от commit `edce77925eb3a892645643725924ac1c4d748940`. Исходные 361 tracked experiment files, включая код адаптера, corpus, manifests, шесть direct MT outputs, ASR, heldout и предыдущие receipts, не изменены. Их прежние SHA256 проверены после всех четырех новых jobs.

## Что лежит рядом

- `preflight.json`: источник кода, 361 исходный hash, исторические first-hop файлы и timestamps, metadata существующих моделей, план ресурсов.
- `chains.jsonl`: 218 проверенных цепочек input → фактический старый English output → новый second-hop input → output. Для каждой строки есть hashes исходного JSONL, текста, моделей, archive, target tokens, token counts, timestamps, file mtimes и unit.
- `verification.json`: результаты связывания всех 218 строк, summaries четырех направлений, SHA256 каждого raw/summary/receipt/log.
- `quality_review.json`: отдельная содержательная проверка ассистентом. Это не независимая приемка носителями; raw inference records остаются неизмененными.
- Полный вывод и решения: `../../RU_PIVOT_RESULTS_2026-11-03.md`.

Raw outputs, attempts и summaries добавлены в `../mt40/opus-original-20261103/` только под именами `ru-zh`, `zh-ru`, `ru-ar`, `ar-ru`. Новые receipts находятся в `../mt40/receipts/imonmeets-mt-ru-pivot-*`.

## Воспроизведение проверки связей

```bash
bash /home/sergey/imonmeets-translation-ru-pivot-20261103/experiments/translation_cpu/tools/run_bounded.sh ru-pivot-bindings-review 90 /usr/bin/python3 /home/sergey/imonmeets-translation-ru-pivot-20261103/experiments/translation_cpu/tools/summarize_ru_pivot.py
```

Сам verifier не запускает моделей, не обращается к сети и не меняет исходные результаты. Он проверяет существующие абсолютные origin paths из preflight; перенос worktree требует осознанного обновления механизма разрешения путей и не должен незаметно ослаблять source binding.

Время `second_hop_seconds` измерено заново. `historical_first_hop_plus_new_second_hop_seconds` — сумма двух времен, измеренных в разные запуски. Она исключает загрузку моделей, очередь, переключение/маршрутизацию, ASR, TTS и сеть и не является continuous end-to-end latency или production SLO.

Модельные blobs и виртуальная среда повторно используются из существующего artifact root через ignored symlink; в Git они не добавляются. Новых загрузок, генерации TTS или изменений production нет.
