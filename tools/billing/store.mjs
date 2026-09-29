/**
 * File-backed billing ledger for local Горизонт preview.
 *
 * Choice (documented): JSON files under BILLING_ROOT (default .local-billing/),
 * not PostgreSQL yet — PG is not in the current Node preview stack.
 * Schema mirrors SPEC logical tables; migrate to PG later without changing API shapes.
 *
 * Concurrency: process-local mutex (single preview process). Not multi-node safe.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../../.local-billing/', import.meta.url));

const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';
const DEMO_EMAIL = 'demo@example.com';

/** @type {Promise<void>|null} */
let chain = null;

function billingRoot() {
  return process.env.BILLING_ROOT || DEFAULT_ROOT;
}

function emptyDb() {
  const now = new Date().toISOString();
  return {
    version: 1,
    users: [{
      id: DEMO_USER_ID,
      email: DEMO_EMAIL,
      name: 'Владимир',
      role: 'admin',
      createdAt: now,
    }],
    wallets: [{
      userId: DEMO_USER_ID,
      balanceKopecks: 0,
      updatedAt: now,
    }],
    ledger: [],
    holds: [],
    quotes: [],
    audit: [],
    promoCodes: [],
    promoRedemptions: [],
    payments: [],
  };
}

async function readDb() {
  const root = billingRoot();
  await mkdir(root, { recursive: true });
  const path = join(root, 'ledger.json');
  try {
    const raw = await readFile(path, 'utf8');
    const db = JSON.parse(raw);
    if (!db.users?.length) return emptyDb();
    return db;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const db = emptyDb();
      await atomicWrite(path, db);
      return db;
    }
    throw err;
  }
}

async function atomicWrite(path, db) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await rename(tmp, path);
}

/**
 * Serialize mutations through a promise chain (single Node process).
 * @template T
 * @param {(db: object) => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export function withBillingLock(fn) {
  const run = async () => {
    const db = await readDb();
    const result = await fn(db);
    await atomicWrite(join(billingRoot(), 'ledger.json'), db);
    return result;
  };
  const next = (chain || Promise.resolve()).then(run, run);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

export function billingEnabled() {
  return String(process.env.BILLING_ENABLED || '').toLowerCase() === 'true'
    || process.env.BILLING_ENABLED === '1';
}

export function demoUserId() {
  return DEMO_USER_ID;
}

export function demoEmail() {
  return DEMO_EMAIL;
}

/**
 * Ensure billing user + wallet rows exist for a real auth user_id.
 * Demo seed user remains for AUTH_DEMO_SEED / legacy tests.
 */
export async function ensureBillingUser({ id, email, name, role = 'user' }) {
  if (!id) throw new Error('user id required');
  const now = new Date().toISOString();
  return withBillingLock((db) => {
    let user = db.users.find((u) => u.id === id);
    if (!user) {
      user = {
        id,
        email: email || `${id}@local`,
        name: name || 'Пользователь',
        role: role === 'admin' ? 'admin' : 'user',
        createdAt: now,
      };
      db.users.push(user);
    } else {
      if (email) user.email = email;
      if (name) user.name = name;
      if (role) user.role = role === 'admin' ? 'admin' : 'user';
    }
    if (!db.wallets.some((w) => w.userId === id)) {
      db.wallets.push({ userId: id, balanceKopecks: 0, updatedAt: now });
    }
    return { user, wallet: db.wallets.find((w) => w.userId === id) };
  });
}

export async function getDbSnapshot() {
  return withBillingLock(async (db) => structuredClone(db));
}

export function pushAudit(db, { action, actorId = DEMO_USER_ID, entityType, entityId, detail }) {
  db.audit.push({
    id: randomUUID(),
    action,
    actorId,
    entityType,
    entityId: entityId || null,
    detail: detail || null,
    createdAt: new Date().toISOString(),
  });
}

export { DEMO_USER_ID, DEMO_EMAIL };
