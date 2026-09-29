/**
 * Wallet + ledger + holds (SPEC §5, plan §3.2–3.3).
 * Amounts are bigint-style integers (JS number, whole kopecks / token-minor only).
 * Display unit: tokens where 1 token = 1 ₽ = 100 minor units.
 */
import { randomUUID } from 'node:crypto';
import {
  withBillingLock, demoUserId, pushAudit, billingEnabled,
} from './store.mjs';
import {
  quoteCost, QUOTE_TTL_MS, costSnapshotFromSeconds, kopecksToTokenDisplay, TOKEN_MINOR_UNITS,
} from './cost.mjs';
import { isMaintenanceBlocking } from './admin.mjs';

function walletOf(db, userId) {
  let w = db.wallets.find((x) => x.userId === userId);
  if (!w) {
    w = { userId, balanceKopecks: 0, updatedAt: new Date().toISOString() };
    db.wallets.push(w);
  }
  return w;
}

function activeHoldsSum(db, userId) {
  return db.holds
    .filter((h) => h.userId === userId && h.status === 'active')
    .reduce((s, h) => s + h.amountKopecks, 0);
}

export function availableOf(db, userId) {
  const w = walletOf(db, userId);
  return w.balanceKopecks - activeHoldsSum(db, userId);
}

function assertIntKopecks(n, label = 'amount') {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer (kopecks)`);
}

/**
 * Append ledger entry; unique business_key.
 */
function appendLedger(db, entry) {
  if (db.ledger.some((e) => e.businessKey === entry.businessKey)) {
    return db.ledger.find((e) => e.businessKey === entry.businessKey);
  }
  db.ledger.push(entry);
  return entry;
}

export async function getWalletView(userId = demoUserId()) {
  return withBillingLock((db) => {
    const w = walletOf(db, userId);
    const held = activeHoldsSum(db, userId);
    const available = w.balanceKopecks - held;
    return {
      userId,
      balanceKopecks: w.balanceKopecks,
      heldKopecks: held,
      availableKopecks: available,
      /** Spendable tokens (1 token = 1 ₽); same scale as kopecks/100. */
      balanceTokens: kopecksToTokenDisplay(w.balanceKopecks),
      heldTokens: kopecksToTokenDisplay(held),
      availableTokens: kopecksToTokenDisplay(available),
      tokenUnit: { tokensPerRub: 1, minorPerToken: TOKEN_MINOR_UNITS },
      billingEnabled: billingEnabled(),
      currency: 'RUB',
      displayUnit: 'tokens',
    };
  });
}

export async function listTransactions(userId = demoUserId(), { limit = 50 } = {}) {
  return withBillingLock((db) => {
    const rows = db.ledger
      .filter((e) => e.userId === userId)
      .slice()
      .reverse()
      .slice(0, limit);
    return rows.map((e) => ({
      id: e.id,
      type: e.type,
      amountKopecks: e.amountKopecks,
      businessKey: e.businessKey,
      reason: e.reason || null,
      promoId: e.promoId || null,
      bonusKopecks: e.bonusKopecks ?? null,
      jobId: e.jobId || null,
      createdAt: e.createdAt,
    }));
  });
}

/**
 * Admin / local credit. Idempotent on businessKey.
 */
export async function creditWallet({
  userId = demoUserId(),
  amountKopecks,
  reason,
  businessKey,
  actorId = demoUserId(),
  promoId = null,
  bonusKopecks = null,
}) {
  assertIntKopecks(amountKopecks, 'amountKopecks');
  if (!reason || !String(reason).trim()) throw new Error('reason is required for credit');
  const key = businessKey || `credit:${userId}:${amountKopecks}:${Date.now()}:${randomUUID()}`;

  return withBillingLock((db) => {
    const existing = db.ledger.find((e) => e.businessKey === key);
    if (existing) {
      const w = walletOf(db, userId);
      return {
        idempotent: true,
        entry: existing,
        balanceKopecks: w.balanceKopecks,
        availableKopecks: availableOf(db, userId),
      };
    }
    const w = walletOf(db, userId);
    w.balanceKopecks += amountKopecks;
    w.updatedAt = new Date().toISOString();
    const entry = appendLedger(db, {
      id: randomUUID(),
      userId,
      type: 'credit',
      amountKopecks,
      businessKey: key,
      reason: String(reason).trim(),
      promoId,
      bonusKopecks,
      jobId: null,
      createdAt: new Date().toISOString(),
    });
    pushAudit(db, {
      action: 'wallet.credit',
      actorId,
      entityType: 'ledger',
      entityId: entry.id,
      detail: { amountKopecks, reason: entry.reason, promoId },
    });
    return {
      idempotent: false,
      entry,
      balanceKopecks: w.balanceKopecks,
      availableKopecks: availableOf(db, userId),
    };
  });
}

export async function createQuote({
  userId = demoUserId(),
  durationSeconds,
  uploadId = null,
  fileHash = null,
}) {
  const snap = costSnapshotFromSeconds(durationSeconds);
  const now = Date.now();
  return withBillingLock((db) => {
    const quote = {
      id: randomUUID(),
      userId,
      uploadId,
      fileHash,
      ...snap,
      expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
      createdAt: new Date(now).toISOString(),
    };
    db.quotes.push(quote);
    return {
      id: quote.id,
      costKopecks: quote.cost_kopecks,
      durationSamples: quote.duration_samples,
      sampleRate: quote.sample_rate,
      tariffKopecksPerMinute: quote.tariff_kopecks_per_minute,
      tariffVersion: quote.tariff_version,
      formulaId: quote.formula_id,
      expiresAt: quote.expiresAt,
      ttlSeconds: Math.floor(QUOTE_TTL_MS / 1000),
    };
  });
}

/**
 * Place hold for a job when billing is enabled.
 * When billing is off, returns snapshot only (no hold).
 */
export async function reserveForJob({
  userId = demoUserId(),
  jobId,
  durationSeconds,
  idempotencyKey,
}) {
  if (await isMaintenanceBlocking()) {
    const err = new Error('Студия на обслуживании: новые резервы временно недоступны.');
    err.code = 'MAINTENANCE';
    throw err;
  }
  const snap = costSnapshotFromSeconds(durationSeconds);
  const cost = snap.cost_kopecks;
  const key = idempotencyKey || `hold:job:${jobId}`;

  return withBillingLock((db) => {
    const existingHold = db.holds.find((h) => h.businessKey === key);
    if (existingHold) {
      return {
        costSnapshot: snap,
        hold: existingHold,
        billingEnabled: billingEnabled(),
        skipped: false,
        idempotent: true,
      };
    }

    if (!billingEnabled()) {
      return {
        costSnapshot: snap,
        hold: null,
        billingEnabled: false,
        skipped: true,
        idempotent: false,
      };
    }

    // Maintenance check is async; callers should gate jobs before reserve.
    // Sync path: env flag only inside lock (store flag checked by createJob).

    const available = availableOf(db, userId);
    if (available < cost) {
      const err = new Error(
        `Недостаточно средств. Нужно ${cost} коп., доступно ${available} коп.`,
      );
      err.code = 'INSUFFICIENT_FUNDS';
      err.costKopecks = cost;
      err.availableKopecks = available;
      throw err;
    }

    const hold = {
      id: randomUUID(),
      userId,
      jobId,
      amountKopecks: cost,
      status: 'active',
      businessKey: key,
      costSnapshot: snap,
      createdAt: new Date().toISOString(),
      closedAt: null,
    };
    db.holds.push(hold);
    pushAudit(db, {
      action: 'hold.create',
      actorId: userId,
      entityType: 'hold',
      entityId: hold.id,
      detail: { jobId, amountKopecks: cost },
    });
    return {
      costSnapshot: snap,
      hold,
      billingEnabled: true,
      skipped: false,
      idempotent: false,
      availableKopecks: availableOf(db, userId),
    };
  });
}

export async function captureHoldForJob({ userId = demoUserId(), jobId }) {
  return withBillingLock((db) => {
    const hold = db.holds.find((h) => h.jobId === jobId && h.userId === userId);
    if (!hold) return { status: 'none' };
    if (hold.status === 'captured') return { status: 'already_captured', hold };
    if (hold.status === 'released') return { status: 'already_released', hold };

    const debitKey = `debit:job:${jobId}`;
    const existingDebit = db.ledger.find((e) => e.businessKey === debitKey);
    if (existingDebit) {
      hold.status = 'captured';
      hold.closedAt = new Date().toISOString();
      return { status: 'already_captured', hold, entry: existingDebit };
    }

    const w = walletOf(db, userId);
    w.balanceKopecks -= hold.amountKopecks;
    w.updatedAt = new Date().toISOString();
    hold.status = 'captured';
    hold.closedAt = new Date().toISOString();
    const entry = appendLedger(db, {
      id: randomUUID(),
      userId,
      type: 'debit',
      amountKopecks: hold.amountKopecks,
      businessKey: debitKey,
      reason: `Транскрибация job ${jobId}`,
      promoId: null,
      bonusKopecks: null,
      jobId,
      createdAt: new Date().toISOString(),
    });
    pushAudit(db, {
      action: 'hold.capture',
      actorId: userId,
      entityType: 'hold',
      entityId: hold.id,
      detail: { jobId, amountKopecks: hold.amountKopecks },
    });
    return { status: 'captured', hold, entry };
  });
}

export async function releaseHoldForJob({ userId = demoUserId(), jobId }) {
  return withBillingLock((db) => {
    const hold = db.holds.find((h) => h.jobId === jobId && h.userId === userId);
    if (!hold) return { status: 'none' };
    if (hold.status === 'released') return { status: 'already_released', hold };
    if (hold.status === 'captured') return { status: 'already_captured', hold };
    hold.status = 'released';
    hold.closedAt = new Date().toISOString();
    pushAudit(db, {
      action: 'hold.release',
      actorId: userId,
      entityType: 'hold',
      entityId: hold.id,
      detail: { jobId, amountKopecks: hold.amountKopecks },
    });
    return { status: 'released', hold };
  });
}

export { quoteCost, costSnapshotFromSeconds };
