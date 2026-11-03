# Коммерческий выпуск Meets: 3 ноября 2026

Поручение владельца: взять в работу весь аудит и довести проект до готовности максимально быстро. Канонический реестр: [backlog.json](backlog.json), 97 задач и 17 решений. Статусы закрываются только с точными commit и доказательством приемки.

## База

Release: `/home/sergey/imonmeets-release-20261103`, ветка `release/commercial-readiness-20261103`. База auth/mail cef80dd, объединена документация main1b52d61. Публичный runtime на старте9bb2dab.

## Направления

- Core: квота открытых комнат, обратимый архив, NAT/polling, точечная модерация и signaling gate.
- Identity: mail budget/ledger/reconciliation, Google-only подтверждение опасных действий, единая MFA.
- Translation: сохраненный MT40, точные допустимые model artifacts, реальные inference и checkpoint по направлениям.
- Integration: provider-aware readiness, exact release identity, HTTPS/TURN443, client IP, manifest моделей analysis worker, общая приемка.

Тяжелые проверки сериализуются lock, systemd ограничивает CPU1/RAM2GiB и время. PostgreSQL для тестов отдельная, loopback-only и tmpfs. Рабочие изменения живут в отдельных worktrees, затем объединяются осмысленными commits. Assertions нельзя ослаблять ради зеленого результата.

## Порядок

1. Исправления базовых сценариев и точный release.
2. Ingress443 и отзыв media grants с сохранением VPN.
3. Приемка аккаунтов, писем, звонков, устройств и емкости; запись/AI отдельно.
4. Независимые backup/alert/restore, операторские процедуры, удаления после restore.
5. Рынок, продавец, условия, тариф, денежный цикл и приемка каждой продаваемой функции.

## Внешние условия

Дополнительный IPv4/стоимость; продавец/реквизиты/рынок/политика данных; merchant/чеки; постоянный независимый backup/monitor receiver; целевые устройства и сети; принятые языки/качество/задержка переводчика. Код и проверяемые конфигурации готовятся до запроса соответствующего решения. Заготовка не является production-приемкой.

## Результаты первой волны

Readiness schema2: focused19/19 прошли через Desktop Commander в ограниченном unit. Resend учитывается без SMTP; submission не означает inbox; изменение build/provider/origin инвалидирует receipts;8443 не дает publicLaunchReady. Общая приемка будет записана после интеграции commits.
