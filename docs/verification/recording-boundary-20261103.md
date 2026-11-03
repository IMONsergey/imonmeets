# REC-09: границы Egress и encrypted backup

Дата: 2026-11-03. База: `d46de552200c87c16b4d8c604170c47f113cde54`. Изолированная ветка: `fix/recording-boundary-20261103`. Все действия на сервере выполнены через Remote Desktop Commander. Production, его комнаты, записи и конфигурация не изменялись.

## Вывод и статус

Подтверждено несоответствие: настройка Egress `file_output_max_size` является периодически проверяемым порогом остановки, а прежний backup принимал ее за жесткий предел размера готового MP4. Настоящий короткий Egress произвел воспроизводимый файл больше этого порога. Исправлен hard ceiling backup и неточное сообщение, которое называло любую такую остановку ограничением длительности.

Проверены короткие duration/size сценарии настоящего Egress, полный decode файлов, их шифрование/восстановление и отдельный реальный crypto→receiver→restore файла ровно 512 MiB. **REC-09 остается частично открытым:** абсолютная граница 30 минут/350 MiB для RoomComposite с целевым S3, работа после внедрения и внешний offsite-получатель здесь не принимались.

## Первичный код и действующая конфигурация

Проверен официальный Egress `v1.15.0`, commit `171423b0b3e7c6531de270b16f1db4f7a6bd2084`, и тот же установленный image `sha256:ac244a40268ce1dd1510fbff6eb529609ec68aceff1602343f79be8ca08c355b`.

В [controller.go](https://github.com/livekit/egress/blob/171423b0b3e7c6531de270b16f1db4f7a6bd2084/pkg/pipeline/controller.go) монитор раз в 15 секунд считает сумму файлов временного каталога задания. При достижении `file_output_max_size` он устанавливает `EGRESS_LIMIT_REACHED` и отправляет EOS. После этого pipeline завершает mux; [file sink](https://github.com/livekit/egress/blob/171423b0b3e7c6531de270b16f1db4f7a6bd2084/pkg/pipeline/sink/file.go) получает окончательные размер и location при закрытии/upload. Настройка не является пределом последнего байта готового MP4. Duration timer запускается до ожидания start signal, поэтому длительность media может быть меньше настроенного времени.

Оба случая имеют общий публичный статус/error `EGRESS_LIMIT_REACHED` / `Session limit reached`. Прежнее сообщение API «по лимиту длительности» выдавало неизвестную точную причину за установленный факт.

Read-only Docker inspect подтвердил:

| Параметр | Значение |
|---|---|
| Egress capture stop | 30 минут; 367001600 bytes = 350 MiB |
| Текущий worker | 2 CPU, 4 GiB RAM, readonly rootfs |
| `/home/egress/tmp` | Hard tmpfs 512 MiB |
| `/home/egress` и `/tmp` | По128 MiB |
| Backup cache | Hard aggregate 1 GiB с консервативным CMS reserve |
| Старый backup object ceiling | 350 MiB |

Сохранены [хеши первичных исходников](recording-boundary-20261103/source-review.json) и [несекретный результат inspect](recording-boundary-20261103/live-egress-storage-bounds.json). Ни credentials, ни приватная конфигурация в отчет не включены.

## Минимальное исправление

`recording-backup.py` теперь допускает готовый объект до 512 MiB — существующего жесткого предела staging tmpfs. Профиль кодирования, stop threshold350 MiB, длительность30 минут, параллельность записи, S3 filesystem и общий backup cache не меняются. Тест связывает per-object ceiling с фактическим размером staging mount в `compose.recording.yml`.

Оценка полной суммы ciphertext производится до загрузок. Две записи по512 MiB превышают резерв cache1 GiB и отвергаются до первого download. Две записи по350 MiB с измеренным коротким overshoot укладываются в backup budget. Это проверка отдельного backup cache; она не утверждает, что два таких объекта поместятся в целевой SeaweedFS с его metadata/volume/compaction ограничениями. Backup только читает источник и пишет отдельный cache.

Reserve свободного места64 MiB сверх исходного объекта покрывает консервативное CMS расширение на пределе512 MiB. Guard недостаточного свободного места проверен до открытия источника. Объект размером hard limit+1 по-прежнему отвергается.

В `recordingTransition` сохранен matching-output и lifecycle контракт. Сообщение ограниченного завершения теперь: «Запись завершена по лимиту длительности или размера файла».

Нужно согласованно установить обновленный `recording-backup.py` на server worker, exporter и receiver. Старый receiver отвергает объекты больше350 MiB. Эта ветка не обновляет установленные копии и не меняет ключи.

## Real Egress: короткие границы

Использованы отдельные Redis, LiveKit, fixture page и точный Egress image внутри Docker internal network. Опубликованных портов нет; служебный RPC выполняется внутри этой сети. Страница рисует синтетический движущийся canvas и генерирует тон440 Hz. Физические устройства, production комнаты, аккаунты и внешние службы не используются.

WebEgress проходит тот же pinned MP4 file pipeline и size monitor. Encoding совпадает с приложением: H.264 Main,1280×720,15fps,1200kbit/s; AAC48kHz64kbit/s. Для bounded test снижена только стоимость admission в disposable worker; это не capacity acceptance production RoomComposite.

Все процессы и контейнеры Egress-прогона находятся в одном transient cgroup: CPU100%, MemoryMax2 GiB, TasksMax512, один последовательный worker. Использован общий `verify.lock`, timeout360s и проверяемый cleanup только объектов данного run ID. Старые evidence запрещено перезаписывать тем же run ID.

| Прогон | Ограничение | Итоговый MP4 | Media duration | Превышение size stop |
|---|---|---:|---:|---:|
| `rec09d20261103`, duration | 12s, size64MiB | 1320948 bytes | 10.602s | 0 |
| `rec09d20261103`, size | 1MiB, duration90s | 1482622 bytes | 13.546667s | 434046 bytes |
| **`rec09e20261103`, duration** | 12s, size64MiB | **1275174 bytes** | **10.548s** | 0 |
| **`rec09e20261103`, size** | 1MiB, duration90s | **1640898 bytes** | **13.546667s** | **592322 bytes** |

Финальный `rec09e` выполнен с новым backup validator. Оба файла имеют ожидаемые H.264/AAC и metadata size, полностью декодируются `ffmpeg -xerror`; проверен ненулевой audio RMS. Файлы реально зашифрованы и восстановлены с совпадающими SHA-256 и длиной. При scaled hard ceiling, равном1MiB stop threshold, настоящий size-output корректно отвергается валидатором. Это negative evidence против равенства soft stop и final-file ceiling, а не производственная запись350MiB.

[Финальный receipt](recording-boundary-20261103/run-rec09e20261103/receipt.json) содержит hashes, ffprobe, status observations и cleanup. [Backup receipt](recording-boundary-20261103/run-rec09e20261103/backup-receipt.json) содержит результат восстановления. `productionBoundaryAccepted` намеренно `false`.

Сохранены предыдущие неудачи:

- `rec09a`: alias локального Node image не разрешился; переход на имеющийся immutable ID.
- `rec09b`: host-клиент не достиг API внутренней сети; RPC перенесен внутрь нее, опубликованный порт убран.
- `rec09c`: получен завершенный limit-result, но `docker cp` не забрал файл из tmpfs fixture. Последующие прогоны используют проверку размера и bounded `docker exec cat`.

Эти ошибки приемочного контура не названы дефектами production Egress. Все три cleanup подтверждены.

## Реальный backup/receiver/restore на hard ceiling512MiB

К настоящему короткому Egress MP4 добавлен корректный ISO BMFF `free` atom до размера536870912bytes. Полученный файл сохраняет исходные аудио/видео и полностью декодируется. Такой fixture проверяет обработку объема данных; он не выдается за длинную запись Egress.

На этом фактическом файле исходный validator возвращает `Invalid recording size`. Новый выполняет production `snapshot`, receiver `sync` и `restore`, включая настоящее CMS шифрование/расшифрование и hash verification. Transport fixture читает ciphertext локально; внешний HTTPS/offsite маршрут не проверяется.

| Результат | Значение |
|---|---:|
| Plaintext MP4 | 536870912 bytes |
| Ciphertext | 537395644 bytes |
| Консервативный cipher reserve | 542305157 bytes |
| Cache limit каждого получателя | 1073741824 bytes |
| Server cache ciphertext | 537395644 bytes |
| Receiver cache ciphertext | 537395644 bytes |
| Восстановление | Точные размер и SHA-256 совпадают |
| Время | 36.28s внутри bounded job |

[Полный receipt](recording-boundary-20261103/hard-bound-512-20261103.json). Две записи максимального размера не помещаются в1GiB даже по фактическому ciphertext; aggregate guard остается обязательным. Этот тест не меняет primary recording filesystem и не обещает места для дополнительных записей.

## Targeted red → green

Исходный код: два из трех новых backup regressions failed; новый API regression failed на duration-only сообщении. После исправления полный backup suite **18/18**, recording lifecycle suite **5/5**, skipped0. Проверены соответствие hard mount, объект на границе и+1, две записи и общий cipher budget, отказ до download, free-space reserve, а также существующие crypto/delete/expiry/restore сценарии.

[RED](recording-boundary-20261103/targeted-red/receipt.json), [GREEN](recording-boundary-20261103/targeted-green/receipt.json). SHA-256 production source файлов совпадают с итоговым деревом. Это targeted acceptance; полный combined release gate выполняется после интеграции отдельно.

## Воспроизведение и остаток

Короткий isolated runner на текущем workstation с уже установленными image IDs:

```sh
IMON_ISOLATED_EGRESS_ACCEPTANCE=1 python3 scripts/run-egress-boundary.py rec09followup001
```

Runner берет `/home/sergey/.local/state/imonmeets-commercial-20261103/verify.lock`, создает собственную aggregate slice и удаляет только свои контейнеры/сеть. Raw MP4 и полные state artifacts хранятся в `.../recording-boundary-20261103/run-rec09e20261103/`; в Git сохраняются receipts и logs. Большой synthetic MP4 и crypto artifacts находятся в `.../recording-boundary-20261103/hard-bound-512-20261103/` и воспроизводятся `scripts/verify-recording-backup-hard-bound.py` из указанного short clip. Приватный synthetic ключ удален после теста.

Открыты: целевой30min/350MiB RoomComposite с S3 и итоговым mux; полный/почти полный recording filesystem и его compaction; сбои Egress/API/upload и восстановление; установка согласованного server/exporter/receiver validator; внешний nonempty backup/restore и приемка на deploy release. Production-ready статус не заявляется.
