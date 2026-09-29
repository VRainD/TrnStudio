# Платежи: ЮMoney (+ касса) / ЮKassa (Горизонт)

Онлайн-эквайринг **не обязателен** для локальной студии. По умолчанию `PAYMENT_DRIVER=stub` и `BILLING_ENABLED=false`: стоимость job считается и пишется в meta, списаний нет. При `BILLING_ENABLED=true` нужны available ≥ quote; баланс начисляется admin credit / промокодом / успешным платежом.

См. также чеклист владельца (Project store): `yoomoney-handoff.md`.

## Зачёт в токены 1∶1 (зафиксировано)

| Понятие | Значение |
|---|---|
| Display | **токены** (экран «Баланс») |
| Курс | **1 токен = 1 ₽** face value |
| Ledger | целые **minor units** (= копейки): `1 токен = 100 minor` |
| Пополнение | `credit_tokens = amount_rub` → `credit_kopecks = amount_rub * 100` |
| Тариф | **0,06 ток./мин** (= 0,06 ₽/мин, R = 6 minor/мин) |
| Промо | бонусы в тех же minor / токенах |

Пример: оплата **100 ₽** → зачисление **100 токенов** (10 000 minor). Повтор webhook не зачисляет дважды.

## Предпочтительный провайдер

**`PAYMENT_DRIVER=yoomoney`** — ЮMoney: приём оплаты + путь **кассы** (фискализация через кабинет / связанный FiscalProvider, фаза D). ЮKassa остаётся альтернативным слотом эквайринга.

| Env `PAYMENT_DRIVER` | Сервис | Секреты |
|---|---|---|
| `stub` | Нет сети (по умолчанию) | — |
| `yoomoney` | **ЮMoney** (предпочтительно) + касса отдельно | `YOOMONEY_ACCOUNT`, `YOOMONEY_OAUTH_TOKEN`, (опц.) notification secret |
| `yookassa` | **ЮKassa** (альтернатива) | `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY` |

Интерфейс: `tools/billing/payments.mjs` → `PaymentProvider` (`createPayment`, `getStatus`, `refund`). Без секретов драйвер деградирует в stub — **реальных списаний нет**.

`FiscalProvider` **не** смешивать с `PaymentProvider`. Чеки — фаза D по маршруту кассы ЮMoney.

## Webhook URL (нужен публичный HTTPS)

- ЮMoney: `POST https://<host>/api/webhooks/yoomoney`
- ЮKassa: `POST https://<host>/api/webhooks/yookassa`

Redirect после оплаты **не** доказывает успех; зачисление токенов — только после reconcile (`status=succeeded`), идемпотентно по `provider` + `provider_payment_id`.

## Локальный баланс без эквайринга

```bash
node tools/billing/admin-cli.mjs credit --amount-rub 100 --reason "тест"
# → +100 токенов (10 000 minor)
node tools/billing/admin-cli.mjs promo-create --code WELCOME50 --type bonus_credit --bonus-kopecks 5000
# → +50 токенов
BILLING_ENABLED=true npm start
```

Или в UI: вход как `admin` → навигация **Админ** → Пользователи / Промокоды. API: `POST /api/admin/credit` (reason обязателен), `GET|POST /api/admin/promos`, `GET /api/admin/audit`.

Хранилище MVP: **файловый ledger** `BILLING_ROOT` / `.local-billing/ledger.json` (не PostgreSQL). Аудит финансовых действий — в `ledger.json` → `audit[]`.

## Фискализация / касса

Отдельный `FiscalProvider` (фаза D). Зафиксированный маршрут: **касса через ЮMoney** (кабинет / связанный API владельца). Не подключать автоматически «Чеки от ЮKassa», пока владелец не подтвердит иное. `PAYMENT_DRIVER=yoomoney` готовит слот оплаты; чеки — после secrets + схемы НДС/СНО.
