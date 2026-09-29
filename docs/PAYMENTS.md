# Платежи: ЮKassa / ЮMoney (Горизонт)

Онлайн-эквайринг **не обязателен** для локальной студии. По умолчанию `PAYMENT_DRIVER=stub` и `BILLING_ENABLED=false`: стоимость job считается и пишется в meta, списаний нет. При `BILLING_ENABLED=true` нужны available ≥ quote; баланс начисляется admin credit / промокодом.

См. также чеклист владельца (вне репозитория / в Project store): `yoomoney-handoff.md`.

## ЮKassa vs ЮMoney

| Env `PAYMENT_DRIVER` | Сервис | Секреты |
|---|---|---|
| `stub` | Нет сети | — |
| `yookassa` | **ЮKassa** (магазин / эквайринг) | `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY` |
| `yoomoney` | **ЮMoney** (кошелёк) | `YOOMONEY_ACCOUNT`, `YOOMONEY_OAUTH_TOKEN` |

Интерфейс кода: `tools/billing/payments.mjs` → `PaymentProvider` (`createPayment`, `getStatus`, `refund`). Без секретов драйвер деградирует в stub — **реальных списаний нет**.

## Webhook URL (нужен публичный HTTPS)

- ЮKassa: `POST https://<host>/api/webhooks/yookassa`
- ЮMoney: `POST https://<host>/api/webhooks/yoomoney`

Redirect после оплаты **не** доказывает успех; зачисление — только после reconcile статуса у провайдера (идемпотентно по `provider` + `provider_payment_id`).

## Локальный баланс без эквайринга

```bash
node tools/billing/admin-cli.mjs credit --amount-rub 100 --reason "тест"
node tools/billing/admin-cli.mjs promo-create --code WELCOME50 --type bonus_credit --bonus-kopecks 5000
BILLING_ENABLED=true npm start
```

Хранилище MVP: **файловый ledger** `BILLING_ROOT` / `.local-billing/ledger.json` (не PostgreSQL). Выбор зафиксирован, пока PG не в стеке preview.

## Фискализация

Отдельный `FiscalProvider` (фаза D). Не смешивать с `PaymentProvider`. «Чеки от ЮKassa» / касса «Юмани» — уточнить у владельца до live.
