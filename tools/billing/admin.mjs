/**
 * Admin-facing billing helpers: users+wallets, audit, maintenance.
 * Financial actions already write audit via pushAudit in wallet/promos.
 */
import { withBillingLock, getDbSnapshot, pushAudit, billingEnabled } from './store.mjs';
import { withAuthLock, publicUser } from '../auth/store.mjs';

const MAINTENANCE_ENV = () => {
  const v = String(process.env.MAINTENANCE_MODE || '').toLowerCase();
  return v === 'true' || v === '1';
};

/**
 * Effective maintenance: env wins if set; otherwise store flag.
 */
export async function getMaintenance() {
  if (MAINTENANCE_ENV()) {
    return { enabled: true, source: 'env', message: process.env.MAINTENANCE_MESSAGE || null };
  }
  return withBillingLock((db) => {
    const m = db.maintenance || { enabled: false, message: null, updatedAt: null, updatedBy: null };
    return {
      enabled: Boolean(m.enabled),
      source: 'store',
      message: m.message || null,
      updatedAt: m.updatedAt || null,
      updatedBy: m.updatedBy || null,
    };
  });
}

export async function setMaintenance({ enabled, message = null, actorId }) {
  if (MAINTENANCE_ENV()) {
    const err = new Error('Режим обслуживания зафиксирован через MAINTENANCE_MODE в окружении.');
    err.code = 'MAINTENANCE_ENV_LOCKED';
    throw err;
  }
  return withBillingLock((db) => {
    const now = new Date().toISOString();
    db.maintenance = {
      enabled: Boolean(enabled),
      message: message != null ? String(message).slice(0, 500) : (db.maintenance?.message || null),
      updatedAt: now,
      updatedBy: actorId || null,
    };
    pushAudit(db, {
      action: 'maintenance.set',
      actorId: actorId || null,
      entityType: 'system',
      entityId: null,
      detail: { enabled: db.maintenance.enabled, message: db.maintenance.message },
    });
    return {
      enabled: db.maintenance.enabled,
      source: 'store',
      message: db.maintenance.message,
      updatedAt: db.maintenance.updatedAt,
      updatedBy: db.maintenance.updatedBy,
    };
  });
}

/** Sync check used on hot path (jobs/holds). Reads env first; store via snapshot cache is ok for MVP. */
let _maintCache = { at: 0, enabled: false };

export async function isMaintenanceBlocking() {
  if (MAINTENANCE_ENV()) return true;
  const now = Date.now();
  if (now - _maintCache.at < 2000) return _maintCache.enabled;
  const m = await getMaintenance();
  _maintCache = { at: now, enabled: m.enabled };
  return m.enabled;
}

export function invalidateMaintenanceCache() {
  _maintCache = { at: 0, enabled: false };
}

/**
 * Auth users + billing wallet snapshot for admin UI.
 */
export async function listAdminUsers({ limit = 100 } = {}) {
  const authUsers = await withAuthLock((db) => db.users.map((u) => publicUser(u)));
  const billing = await getDbSnapshot();
  const byId = new Map(authUsers.map((u) => [u.id, { ...u, source: 'auth' }]));

  for (const bu of billing.users || []) {
    if (!byId.has(bu.id)) {
      byId.set(bu.id, {
        id: bu.id,
        email: bu.email || null,
        name: bu.name || null,
        role: bu.role || 'user',
        createdAt: bu.createdAt || null,
        source: 'billing-only',
      });
    } else {
      // Prefer auth role; keep email/name from auth
      const existing = byId.get(bu.id);
      if (!existing.role && bu.role) existing.role = bu.role;
    }
  }

  const items = [...byId.values()].map((u) => {
    const wallet = (billing.wallets || []).find((w) => w.userId === u.id);
    const balanceKopecks = wallet?.balanceKopecks ?? 0;
    const heldKopecks = (billing.holds || [])
      .filter((h) => h.userId === u.id && h.status === 'active')
      .reduce((s, h) => s + h.amountKopecks, 0);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt,
      source: u.source,
      wallet: {
        balanceKopecks,
        heldKopecks,
        availableKopecks: balanceKopecks - heldKopecks,
        balanceTokens: balanceKopecks / 100,
        heldTokens: heldKopecks / 100,
        availableTokens: (balanceKopecks - heldKopecks) / 100,
      },
    };
  });

  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return items.slice(0, limit);
}

/**
 * Financial / admin audit events (credit, promo.*, maintenance).
 */
export async function listAdminAudit({
  limit = 100,
  actions = null,
} = {}) {
  const financial = new Set([
    'wallet.credit',
    'promo.create',
    'promo.status',
    'promo.redeem',
    'maintenance.set',
    'hold.create',
    'hold.capture',
    'hold.release',
  ]);
  return withBillingLock((db) => {
    let rows = (db.audit || []).slice().reverse();
    if (actions && actions.length) {
      const want = new Set(actions);
      rows = rows.filter((r) => want.has(r.action));
    } else {
      rows = rows.filter((r) => financial.has(r.action) || String(r.action).startsWith('promo.') || String(r.action).startsWith('wallet.'));
    }
    return rows.slice(0, limit).map((r) => ({
      id: r.id,
      action: r.action,
      actorId: r.actorId,
      entityType: r.entityType,
      entityId: r.entityId,
      detail: r.detail,
      createdAt: r.createdAt,
    }));
  });
}

export async function adminOverviewStats() {
  const billing = await getDbSnapshot();
  const maintenance = await getMaintenance();
  const users = billing.users?.length || 0;
  const wallets = billing.wallets || [];
  const totalBalance = wallets.reduce((s, w) => s + (w.balanceKopecks || 0), 0);
  const activeHolds = (billing.holds || []).filter((h) => h.status === 'active');
  const heldSum = activeHolds.reduce((s, h) => s + h.amountKopecks, 0);
  const promosActive = (billing.promoCodes || []).filter((p) => p.status === 'active').length;
  const auditCount = billing.audit?.length || 0;
  return {
    billingEnabled: billingEnabled(),
    maintenance,
    users,
    wallets: wallets.length,
    totalBalanceKopecks: totalBalance,
    totalBalanceTokens: totalBalance / 100,
    activeHolds: activeHolds.length,
    heldKopecks: heldSum,
    promos: billing.promoCodes?.length || 0,
    promosActive,
    auditEvents: auditCount,
    payments: billing.payments?.length || 0,
  };
}
