/**
 * PaymentProvider interface + drivers (stub | yookassa | yoomoney).
 *
 * Locked product path (2026-09-29):
 * - Preferred online top-up: PAYMENT_DRIVER=yoomoney (ЮMoney + касса / fiscal cabinet path).
 * - YooKassa remains an alternate acquiring adapter.
 * - On payment success: credit tokens 1:1 with paid RUB
 *   (credit_kopecks = amount_rub * 100; 1 display token = 1 ₽).
 * - Fiscal receipts: separate FiscalProvider (phase D); wire through ЮMoney касса
 *   once owner secrets/cabinet details arrive — do not mix with PaymentProvider.
 *
 * No real HTTP charges without secrets. Feature flag / driver default = stub.
 */
import { randomUUID } from 'node:crypto';
import { withBillingLock, demoUserId, pushAudit } from './store.mjs';
import { rubToTokenMinor, kopecksToTokenDisplay, TOKEN_MINOR_UNITS } from './cost.mjs';
import { creditWallet } from './wallet.mjs';

export const TOPUP_PRESETS_RUB = [100, 300, 1000];
/** Preferred driver when owner enables online payments + касса. */
export const PREFERRED_PAYMENT_DRIVER = 'yoomoney';

export function paymentDriverName() {
  const d = String(process.env.PAYMENT_DRIVER || 'stub').toLowerCase();
  if (d === 'yookassa' || d === 'yoomoney' || d === 'stub') return d;
  return 'stub';
}

export function paymentsConfigured() {
  const driver = paymentDriverName();
  if (driver === 'stub') return false;
  if (driver === 'yookassa') {
    return Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY);
  }
  if (driver === 'yoomoney') {
    return Boolean(process.env.YOOMONEY_ACCOUNT && process.env.YOOMONEY_OAUTH_TOKEN);
  }
  return false;
}

/**
 * @typedef {object} CreatePaymentInput
 * @property {number} amountKopecks
 * @property {string} currency
 * @property {string} idempotenceKey
 * @property {string} [description]
 * @property {string} [returnUrl]
 * @property {string} [userId]
 */

/**
 * @typedef {object} PaymentProvider
 * @property {string} name
 * @property {(input: CreatePaymentInput) => Promise<object>} createPayment
 * @property {(providerPaymentId: string) => Promise<object>} getStatus
 * @property {(providerPaymentId: string, amountKopecks?: number) => Promise<object>} refund
 */

/** @returns {PaymentProvider} */
export function createPaymentProvider() {
  const name = paymentDriverName();
  if (name === 'yookassa' && paymentsConfigured()) return yookassaProvider();
  if (name === 'yoomoney' && paymentsConfigured()) return yoomoneyProvider();
  return stubProvider(name === 'stub' ? 'stub' : `${name}-unconfigured`);
}

function stubProvider(name = 'stub') {
  return {
    name,
    async createPayment(input) {
      return {
        provider: name,
        providerPaymentId: `stub_${randomUUID()}`,
        status: 'pending',
        amountKopecks: input.amountKopecks,
        currency: input.currency || 'RUB',
        confirmationUrl: null,
        message: 'Онлайн-оплата не подключена (stub). Используйте admin credit или задайте секреты ЮMoney.',
        creditRule: '1_token_per_rub',
      };
    },
    async getStatus(providerPaymentId) {
      return {
        provider: name,
        providerPaymentId,
        status: 'pending',
      };
    },
    async refund(providerPaymentId) {
      return {
        provider: name,
        providerPaymentId,
        status: 'unsupported',
        message: 'Stub does not refund.',
      };
    },
  };
}

/**
 * YooKassa-shaped adapter (alternate). Without network call until secrets exist.
 */
function yookassaProvider() {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secret = process.env.YOOKASSA_SECRET_KEY;
  return {
    name: 'yookassa',
    async createPayment(input) {
      if (!shopId || !secret) return stubProvider('yookassa-unconfigured').createPayment(input);
      return {
        provider: 'yookassa',
        providerPaymentId: `yk_pending_${randomUUID()}`,
        status: 'pending',
        amountKopecks: input.amountKopecks,
        currency: 'RUB',
        confirmationUrl: null,
        message: 'YooKassa driver selected; live HTTP create is not enabled in this build. See docs/PAYMENTS.md.',
        shopId,
        creditRule: '1_token_per_rub',
      };
    },
    async getStatus(providerPaymentId) {
      return { provider: 'yookassa', providerPaymentId, status: 'pending' };
    },
    async refund(providerPaymentId, amountKopecks) {
      return {
        provider: 'yookassa',
        providerPaymentId,
        amountKopecks: amountKopecks ?? null,
        status: 'pending',
        message: 'Refund API not wired in this build.',
      };
    },
  };
}

/**
 * YooMoney provider (preferred). Payment + fiscal касса path documented in PAYMENTS.md;
 * FiscalProvider remains phase D (cabinet / related API — secrets from owner).
 */
function yoomoneyProvider() {
  const account = process.env.YOOMONEY_ACCOUNT;
  return {
    name: 'yoomoney',
    async createPayment(input) {
      if (!account || !process.env.YOOMONEY_OAUTH_TOKEN) {
        return stubProvider('yoomoney-unconfigured').createPayment(input);
      }
      return {
        provider: 'yoomoney',
        providerPaymentId: `ym_pending_${randomUUID()}`,
        status: 'pending',
        amountKopecks: input.amountKopecks,
        currency: 'RUB',
        confirmationUrl: null,
        message: 'YooMoney driver selected (preferred + касса). Live HTTP create awaits secrets. See docs/PAYMENTS.md.',
        account,
        fiscalNote: 'FiscalProvider / касса via ЮMoney cabinet — phase D; not mixed into PaymentProvider.',
        creditRule: '1_token_per_rub',
      };
    },
    async getStatus(providerPaymentId) {
      return { provider: 'yoomoney', providerPaymentId, status: 'pending' };
    },
    async refund(providerPaymentId) {
      return {
        provider: 'yoomoney',
        providerPaymentId,
        status: 'unsupported',
        message: 'Wallet refunds depend on YooMoney API capabilities; not wired.',
      };
    },
  };
}

/**
 * Record a top-up payment intent (does not credit until webhook/reconcile).
 * amountRub maps 1:1 to tokens on success (stored as amountRub * 100 minor units).
 */
export async function createTopupPayment({
  userId = demoUserId(),
  amountRub,
  idempotenceKey,
  description = 'Пополнение токенов Горизонт (1 токен = 1 ₽)',
}) {
  const amount = Number(amountRub);
  if (![100, 300, 1000].includes(amount) && !(Number.isInteger(amount) && amount >= 100 && amount <= 100_000)) {
    throw new Error('Сумма пополнения: 100, 300, 1000 ₽ (= токены 1:1) или целое от 100 до 100 000.');
  }
  const amountKopecks = rubToTokenMinor(amount);
  const key = idempotenceKey || `payment:topup:${userId}:${amountKopecks}:${randomUUID()}`;
  const provider = createPaymentProvider();

  return withBillingLock(async (db) => {
    const existing = db.payments.find((p) => p.idempotenceKey === key);
    if (existing) {
      return {
        idempotent: true,
        payment: existing,
        providerResult: null,
        creditTokensOnSuccess: kopecksToTokenDisplay(existing.amountKopecks),
      };
    }

    const providerResult = await provider.createPayment({
      amountKopecks,
      currency: 'RUB',
      idempotenceKey: key,
      description,
      returnUrl: process.env.YOOMONEY_RETURN_URL || process.env.YOOKASSA_RETURN_URL || null,
      userId,
    });

    const payment = {
      id: randomUUID(),
      userId,
      amountKopecks,
      amountTokens: kopecksToTokenDisplay(amountKopecks),
      currency: 'RUB',
      creditRule: '1_token_per_rub',
      status: providerResult.status || 'pending',
      provider: providerResult.provider,
      providerPaymentId: providerResult.providerPaymentId,
      idempotenceKey: key,
      confirmationUrl: providerResult.confirmationUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.payments.push(payment);
    pushAudit(db, {
      action: 'payment.create',
      actorId: userId,
      entityType: 'payment',
      entityId: payment.id,
      detail: {
        provider: payment.provider,
        amountKopecks,
        amountTokens: payment.amountTokens,
        status: payment.status,
        creditRule: '1_token_per_rub',
      },
    });
    return {
      idempotent: false,
      payment,
      providerResult,
      creditTokensOnSuccess: payment.amountTokens,
    };
  });
}

/**
 * Webhook reconcile: on succeeded, credit tokens 1:1 with paid RUB
 * (ledger minor units = payment.amountKopecks = amount_rub * 100).
 * Idempotent on provider + provider_payment_id / ledger business_key.
 */
export async function reconcilePaymentWebhook({ provider, providerPaymentId, status }) {
  if (status !== 'succeeded') {
    return { credited: false, reason: 'not_succeeded' };
  }
  return withBillingLock(async (db) => {
    const payment = db.payments.find(
      (p) => p.provider === provider && p.providerPaymentId === providerPaymentId,
    );
    if (!payment) return { credited: false, reason: 'unknown_payment' };
    if (payment.status === 'succeeded') {
      return {
        credited: false,
        reason: 'already_succeeded',
        payment,
        creditTokens: kopecksToTokenDisplay(payment.amountKopecks),
      };
    }

    const businessKey = `credit:payment:${payment.id}`;
    if (db.ledger.some((e) => e.businessKey === businessKey)) {
      payment.status = 'succeeded';
      return {
        credited: false,
        reason: 'already_credited',
        payment,
        creditTokens: kopecksToTokenDisplay(payment.amountKopecks),
      };
    }
    let w = db.wallets.find((x) => x.userId === payment.userId);
    if (!w) {
      w = { userId: payment.userId, balanceKopecks: 0, updatedAt: new Date().toISOString() };
      db.wallets.push(w);
    }
    // 1:1: amount already stored as amount_rub * TOKEN_MINOR_UNITS at create time.
    w.balanceKopecks += payment.amountKopecks;
    w.updatedAt = new Date().toISOString();
    const creditTokens = kopecksToTokenDisplay(payment.amountKopecks);
    db.ledger.push({
      id: randomUUID(),
      userId: payment.userId,
      type: 'credit',
      amountKopecks: payment.amountKopecks,
      businessKey,
      reason: `Пополнение ${payment.provider} (+${creditTokens} ток., 1:1)`,
      promoId: null,
      bonusKopecks: null,
      jobId: null,
      createdAt: new Date().toISOString(),
    });
    payment.status = 'succeeded';
    payment.updatedAt = new Date().toISOString();
    pushAudit(db, {
      action: 'payment.credit',
      actorId: payment.userId,
      entityType: 'payment',
      entityId: payment.id,
      detail: {
        amountKopecks: payment.amountKopecks,
        creditTokens,
        creditRule: '1_token_per_rub',
        minorPerToken: TOKEN_MINOR_UNITS,
      },
    });
    return { credited: true, payment, creditTokens, creditRule: '1_token_per_rub' };
  });
}

export function paymentStatusPublic() {
  return {
    driver: paymentDriverName(),
    preferredDriver: PREFERRED_PAYMENT_DRIVER,
    configured: paymentsConfigured(),
    presetsRub: TOPUP_PRESETS_RUB,
    creditRule: '1_token_per_rub',
    tokenUnit: { tokensPerRub: 1, minorPerToken: TOKEN_MINOR_UNITS },
    fiscalNote: 'Касса / FiscalProvider via ЮMoney cabinet — phase D; PaymentProvider does not issue receipts.',
    webhookPaths: {
      yookassa: '/api/webhooks/yookassa',
      yoomoney: '/api/webhooks/yoomoney',
    },
  };
}

// creditWallet kept available for admin/local paths; webhook uses inline credit for lock atomicity.
void creditWallet;
