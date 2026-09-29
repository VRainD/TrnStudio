/**
 * Promo codes (plan §3.4). MVP: bonus_credit / bonus_minutes / welcome → wallet credit.
 * percent_off / fixed_off: preview as bonus_credit on full nominal (locked default:
 * full payment + bonus_credit; no quote discount in MVP).
 */
import { randomUUID } from 'node:crypto';
import { withBillingLock, demoUserId, pushAudit } from './store.mjs';
import { creditWallet } from './wallet.mjs';
import { DEFAULT_TARIFF_KOPECKS_PER_MINUTE } from './cost.mjs';

const TYPES = new Set([
  'percent_off',
  'fixed_off',
  'bonus_credit',
  'bonus_minutes',
  'welcome',
]);

export function normalizePromoCode(raw) {
  const s = String(raw ?? '').normalize('NFKC').trim().toUpperCase();
  return s;
}

function assertAdmin(db, actorId) {
  const user = db.users.find((u) => u.id === actorId);
  if (!user || (user.role !== 'admin' && user.role !== 'support')) {
    const err = new Error('Требуются права администратора.');
    err.code = 'FORBIDDEN';
    throw err;
  }
}

function isExpired(promo, now = Date.now()) {
  if (promo.validUntil && Date.parse(promo.validUntil) < now) return true;
  if (promo.validFrom && Date.parse(promo.validFrom) > now) return true;
  return false;
}

function redemptionCount(db, promoId, userId = null) {
  return db.promoRedemptions.filter(
    (r) => r.promoId === promoId && (userId == null || r.userId === userId),
  ).length;
}

function publicError() {
  const err = new Error('Промокод недоступен.');
  err.code = 'PROMO_UNAVAILABLE';
  return err;
}

function effectBonusKopecks(promo, { topupKopecks = null } = {}) {
  const type = promo.effectType === 'welcome' ? (promo.welcomeAs || 'bonus_credit') : promo.effectType;
  if (type === 'bonus_credit') return Number(promo.bonusKopecks) || 0;
  if (type === 'bonus_minutes') {
    const minutes = Number(promo.bonusMinutes) || 0;
    return Math.ceil(minutes * (promo.tariffSnapshot || DEFAULT_TARIFF_KOPECKS_PER_MINUTE));
  }
  if (type === 'percent_off') {
    // Locked default: full nominal payment + bonus_credit (= percent of top-up).
    const base = topupKopecks != null ? topupKopecks : Number(promo.referenceTopupKopecks) || 0;
    const pct = Number(promo.percentOff) || 0;
    return Math.floor((base * pct) / 100);
  }
  if (type === 'fixed_off') {
    const base = topupKopecks != null ? topupKopecks : Number(promo.referenceTopupKopecks) || 0;
    const off = Number(promo.fixedOffKopecks) || 0;
    return Math.min(base, off);
  }
  return 0;
}

export async function createPromo({
  actorId = demoUserId(),
  code,
  effectType,
  status = 'active',
  bonusKopecks = null,
  bonusMinutes = null,
  percentOff = null,
  fixedOffKopecks = null,
  welcomeAs = 'bonus_credit',
  referenceTopupKopecks = 30_000,
  maxRedemptionsGlobal = null,
  maxRedemptionsPerUser = 1,
  validFrom = null,
  validUntil = null,
  audience = 'all_users',
  minTopupKopecks = null,
  note = null,
}) {
  if (!TYPES.has(effectType)) throw new Error(`Unknown effectType: ${effectType}`);
  const normalized = normalizePromoCode(code);
  if (!normalized || normalized.length < 3) throw new Error('code too short');

  return withBillingLock((db) => {
    assertAdmin(db, actorId);
    if (db.promoCodes.some((p) => p.normalizedCode === normalized)) {
      throw new Error('Промокод с таким кодом уже существует.');
    }
    const promo = {
      id: randomUUID(),
      code: normalized,
      normalizedCode: normalized,
      effectType,
      status,
      bonusKopecks,
      bonusMinutes,
      percentOff,
      fixedOffKopecks,
      welcomeAs,
      referenceTopupKopecks,
      tariffSnapshot: DEFAULT_TARIFF_KOPECKS_PER_MINUTE,
      maxRedemptionsGlobal,
      maxRedemptionsPerUser,
      validFrom,
      validUntil,
      audience,
      minTopupKopecks,
      note,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.promoCodes.push(promo);
    pushAudit(db, {
      action: 'promo.create',
      actorId,
      entityType: 'promo',
      entityId: promo.id,
      detail: { code: normalized, effectType, status },
    });
    return promo;
  });
}

export async function listPromos({ actorId = demoUserId() } = {}) {
  return withBillingLock((db) => {
    assertAdmin(db, actorId);
    return db.promoCodes.slice().reverse();
  });
}

export async function setPromoStatus({ actorId = demoUserId(), promoId, status }) {
  const allowed = new Set(['draft', 'active', 'paused', 'expired', 'revoked']);
  if (!allowed.has(status)) throw new Error('invalid status');
  return withBillingLock((db) => {
    assertAdmin(db, actorId);
    const promo = db.promoCodes.find((p) => p.id === promoId);
    if (!promo) throw new Error('Промокод не найден.');
    const prev = promo.status;
    promo.status = status;
    promo.updatedAt = new Date().toISOString();
    pushAudit(db, {
      action: 'promo.status',
      actorId,
      entityType: 'promo',
      entityId: promo.id,
      detail: { from: prev, to: status },
    });
    return promo;
  });
}

/**
 * Validate without redeeming. Uniform user-facing errors.
 */
export async function validatePromo({
  userId = demoUserId(),
  code,
  topupKopecks = null,
}) {
  const normalized = normalizePromoCode(code);
  return withBillingLock((db) => {
    const promo = db.promoCodes.find((p) => p.normalizedCode === normalized);
    if (!promo || promo.status !== 'active' || isExpired(promo)) {
      throw publicError();
    }
    if (promo.maxRedemptionsGlobal != null
      && redemptionCount(db, promo.id) >= promo.maxRedemptionsGlobal) {
      throw publicError();
    }
    if (promo.maxRedemptionsPerUser != null
      && redemptionCount(db, promo.id, userId) >= promo.maxRedemptionsPerUser) {
      throw publicError();
    }
    if (promo.minTopupKopecks != null && topupKopecks != null
      && topupKopecks < promo.minTopupKopecks) {
      throw publicError();
    }
    const bonus = effectBonusKopecks(promo, { topupKopecks });
    return {
      ok: true,
      promoId: promo.id,
      effectType: promo.effectType,
      bonusKopecks: bonus,
      preview: {
        // Locked: full nominal + bonus_credit (no payment reduction in MVP).
        payKopecks: topupKopecks,
        creditKopecks: topupKopecks != null ? topupKopecks + bonus : bonus,
        bonusKopecks: bonus,
      },
    };
  });
}

/**
 * Redeem bonus onto wallet (idempotent business_key).
 * For percent/fixed_off without payment: grants bonus_credit equivalent (MVP admin/local).
 */
export async function redeemPromo({
  userId = demoUserId(),
  code,
  topupKopecks = null,
  businessKey = null,
}) {
  const normalized = normalizePromoCode(code);
  const key = businessKey || `promo:redeem:${userId}:${normalized}`;

  // Validate + record redemption inside lock, then credit (credit has its own lock —
  // so do credit via nested pattern carefully). We credit inside same lock by
  // duplicating minimal credit path to keep atomicity.
  return withBillingLock(async (db) => {
    const existingRedemption = db.promoRedemptions.find((r) => r.businessKey === key);
    if (existingRedemption) {
      return {
        idempotent: true,
        redemption: existingRedemption,
        bonusKopecks: existingRedemption.bonusKopecks,
      };
    }

    const promo = db.promoCodes.find((p) => p.normalizedCode === normalized);
    if (!promo || promo.status !== 'active' || isExpired(promo)) throw publicError();
    if (promo.maxRedemptionsGlobal != null
      && redemptionCount(db, promo.id) >= promo.maxRedemptionsGlobal) {
      throw publicError();
    }
    if (promo.maxRedemptionsPerUser != null
      && redemptionCount(db, promo.id, userId) >= promo.maxRedemptionsPerUser) {
      throw publicError();
    }

    const bonus = effectBonusKopecks(promo, { topupKopecks });
    if (!Number.isInteger(bonus) || bonus <= 0) throw publicError();

    const redemption = {
      id: randomUUID(),
      userId,
      promoId: promo.id,
      paymentId: null,
      jobId: null,
      discountKopecks: 0,
      bonusKopecks: bonus,
      businessKey: key,
      createdAt: new Date().toISOString(),
    };
    db.promoRedemptions.push(redemption);

    // Inline credit for atomicity with redemption
    const ledgerKey = `credit:promo:${redemption.id}`;
    let w = db.wallets.find((x) => x.userId === userId);
    if (!w) {
      w = { userId, balanceKopecks: 0, updatedAt: new Date().toISOString() };
      db.wallets.push(w);
    }
    w.balanceKopecks += bonus;
    w.updatedAt = new Date().toISOString();
    db.ledger.push({
      id: randomUUID(),
      userId,
      type: 'credit',
      amountKopecks: bonus,
      businessKey: ledgerKey,
      reason: `Промокод ${promo.normalizedCode}`,
      promoId: promo.id,
      bonusKopecks: bonus,
      jobId: null,
      createdAt: new Date().toISOString(),
    });
    pushAudit(db, {
      action: 'promo.redeem',
      actorId: userId,
      entityType: 'promo_redemption',
      entityId: redemption.id,
      detail: { promoId: promo.id, bonusKopecks: bonus },
    });

    return {
      idempotent: false,
      redemption,
      bonusKopecks: bonus,
      balanceKopecks: w.balanceKopecks,
    };
  });
}

// Re-export for admin tooling that may want creditWallet after external payment.
export { creditWallet };
