/**
 * PaymentProvider interface + drivers (stub | yookassa | yoomoney).
 *
 * Naming:
 * - YooKassa (ЮKassa) — acquiring shop (SPEC default candidate).
 * - YooMoney (ЮMoney) — wallet API; often confused with YooKassa in speech («Юмани»).
 *
 * No real HTTP charges without secrets. Feature flag / driver default = stub.
 */
import { randomUUID } from 'node:crypto';
import { withBillingLock, demoUserId, pushAudit } from './store.mjs';
import { creditWallet } from './wallet.mjs';

export const TOPUP_PRESETS_RUB = [100, 300, 1000];

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
        message: 'Онлайн-оплата не подключена (stub). Используйте admin credit или задайте секреты.',
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
 * YooKassa-shaped adapter. Without network call until secrets exist;
 * createPayment refuses if not configured (caller should use stub).
 */
function yookassaProvider() {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secret = process.env.YOOKASSA_SECRET_KEY;
  return {
    name: 'yookassa',
    async createPayment(input) {
      // Real HTTP integration is follow-up (Phase C). Keep interface stable.
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
        message: 'YooMoney wallet driver selected; live HTTP create is not enabled in this build. See docs/PAYMENTS.md.',
        account,
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
 */
export async function createTopupPayment({
  userId = demoUserId(),
  amountRub,
  idempotenceKey,
  description = 'Пополнение баланса Горизонт',
}) {
  const amount = Number(amountRub);
  if (![100, 300, 1000].includes(amount) && !(Number.isInteger(amount) && amount >= 100 && amount <= 100_000)) {
    throw new Error('Сумма пополнения: 100, 300, 1000 ₽ или целое от 100 до 100 000.');
  }
  const amountKopecks = amount * 100;
  const key = idempotenceKey || `payment:topup:${userId}:${amountKopecks}:${randomUUID()}`;
  const provider = createPaymentProvider();

  return withBillingLock(async (db) => {
    const existing = db.payments.find((p) => p.idempotenceKey === key);
    if (existing) return { idempotent: true, payment: existing, providerResult: null };

    const providerResult = await provider.createPayment({
      amountKopecks,
      currency: 'RUB',
      idempotenceKey: key,
      description,
      returnUrl: process.env.YOOKASSA_RETURN_URL || process.env.YOOMONEY_RETURN_URL || null,
      userId,
    });

    const payment = {
      id: randomUUID(),
      userId,
      amountKopecks,
      currency: 'RUB',
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
      detail: { provider: payment.provider, amountKopecks, status: payment.status },
    });
    return { idempotent: false, payment, providerResult };
  });
}

/**
 * Webhook reconcile stub: only credits when explicitly marked succeeded
 * and secrets path is used in future. Safe no-op for unknown providers.
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
    if (payment.status === 'succeeded') return { credited: false, reason: 'already_succeeded', payment };

    // Credit outside would nest locks; do inline like promos.
    const businessKey = `credit:payment:${payment.id}`;
    if (db.ledger.some((e) => e.businessKey === businessKey)) {
      payment.status = 'succeeded';
      return { credited: false, reason: 'already_credited', payment };
    }
    let w = db.wallets.find((x) => x.userId === payment.userId);
    if (!w) {
      w = { userId: payment.userId, balanceKopecks: 0, updatedAt: new Date().toISOString() };
      db.wallets.push(w);
    }
    w.balanceKopecks += payment.amountKopecks;
    w.updatedAt = new Date().toISOString();
    db.ledger.push({
      id: randomUUID(),
      userId: payment.userId,
      type: 'credit',
      amountKopecks: payment.amountKopecks,
      businessKey,
      reason: `Пополнение ${payment.provider}`,
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
      detail: { amountKopecks: payment.amountKopecks },
    });
    return { credited: true, payment };
  });
}

export function paymentStatusPublic() {
  return {
    driver: paymentDriverName(),
    configured: paymentsConfigured(),
    presetsRub: TOPUP_PRESETS_RUB,
    webhookPaths: {
      yookassa: '/api/webhooks/yookassa',
      yoomoney: '/api/webhooks/yoomoney',
    },
  };
}

// silence unused import lint if creditWallet unused in this file path
void creditWallet;
