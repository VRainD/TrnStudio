/**
 * Thin file-backed app DB for users + sessions (SPEC §4 / §8).
 * Transcripts live in ClickHouse — not here.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './passwords.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../../.local-auth/', import.meta.url));

/** Demo account — only seeded when AUTH_DEMO_SEED=true. */
export const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_EMAIL = 'demo@example.com';
export const DEMO_PASSWORD = 'DemoPassw0rd!';

/** @type {Promise<void>|null} */
let chain = null;

function authRoot() {
  return process.env.AUTH_ROOT || DEFAULT_ROOT;
}

function emptyDb() {
  return {
    version: 1,
    users: [],
    sessions: [],
  };
}

async function atomicWrite(path, db) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await rename(tmp, path);
}

async function readDb() {
  const root = authRoot();
  await mkdir(root, { recursive: true });
  const path = join(root, 'auth.json');
  try {
    const raw = await readFile(path, 'utf8');
    const db = JSON.parse(raw);
    if (!Array.isArray(db.users)) db.users = [];
    if (!Array.isArray(db.sessions)) db.sessions = [];
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

/**
 * @template T
 * @param {(db: object) => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export function withAuthLock(fn) {
  const run = async () => {
    const db = await readDb();
    const result = await fn(db);
    await atomicWrite(join(authRoot(), 'auth.json'), db);
    return result;
  };
  const next = (chain || Promise.resolve()).then(run, run);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function demoSeedEnabled() {
  const v = String(process.env.AUTH_DEMO_SEED || '').toLowerCase();
  return v === 'true' || v === '1';
}

/**
 * Create demo user/admin when AUTH_DEMO_SEED is on. Idempotent.
 */
export async function ensureDemoSeed() {
  if (!demoSeedEnabled()) return null;
  return withAuthLock(async (db) => {
    let user = db.users.find((u) => u.id === DEMO_USER_ID || normalizeEmail(u.email) === DEMO_EMAIL);
    if (user) return { seeded: false, user: publicUser(user) };
    const now = new Date().toISOString();
    user = {
      id: DEMO_USER_ID,
      email: DEMO_EMAIL,
      emailNormalized: DEMO_EMAIL,
      name: 'Владимир',
      passwordHash: await hashPassword(DEMO_PASSWORD),
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    };
    db.users.push(user);
    return { seeded: true, user: publicUser(user) };
  });
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
  };
}

export async function findUserByEmail(email) {
  const normalized = normalizeEmail(email);
  return withAuthLock((db) => {
    const user = db.users.find((u) => u.emailNormalized === normalized);
    return user ? { ...user } : null;
  });
}

export async function findUserById(id) {
  return withAuthLock((db) => {
    const user = db.users.find((u) => u.id === id);
    return user ? { ...user } : null;
  });
}

export { authRoot };
