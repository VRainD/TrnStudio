/**
 * Admin API tests: non-admin → 403; admin credit/promo/health/audit happy paths.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { registerUser, loginUser } from './auth/service.mjs';
import { withAuthLock, ensureDemoSeed, DEMO_EMAIL, DEMO_PASSWORD } from './auth/store.mjs';
import { SESSION_COOKIE } from './auth/sessions.mjs';
import { listAdminAudit } from './billing/admin.mjs';
import { ensureBillingUser } from './billing/store.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const authRoot = await mkdtemp(join(tmpdir(), 'gorizont-admin-auth-'));
const billingRoot = await mkdtemp(join(tmpdir(), 'gorizont-admin-bill-'));
const port = 4317 + Math.floor(Math.random() * 200);
const origin = `http://127.0.0.1:${port}`;

const prev = {
  AUTH_ROOT: process.env.AUTH_ROOT,
  BILLING_ROOT: process.env.BILLING_ROOT,
  AUTH_DEMO_SEED: process.env.AUTH_DEMO_SEED,
  PORT: process.env.PORT,
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
  CLICKHOUSE_ENABLED: process.env.CLICKHOUSE_ENABLED,
  BILLING_ENABLED: process.env.BILLING_ENABLED,
};

process.env.AUTH_ROOT = authRoot;
process.env.BILLING_ROOT = billingRoot;
process.env.AUTH_DEMO_SEED = 'true';
process.env.PORT = String(port);
process.env.PUBLIC_ORIGIN = origin;
process.env.CLICKHOUSE_ENABLED = process.env.CLICKHOUSE_ENABLED || 'false';
process.env.BILLING_ENABLED = 'true';

let child = null;

async function restoreEnv() {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function cookieHeader(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

async function api(method, path, { token, body, client = true } = {}) {
  const headers = {};
  if (client) {
    headers.origin = origin;
    headers['x-gorizont-client'] = 'local-preview';
  }
  if (token) headers.cookie = cookieHeader(token);
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${origin}/healthz`);
      if (r.ok) return;
    } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error('preview server did not become ready');
}

try {
  // Seed demo admin + a normal user in the same AUTH_ROOT the server will use
  await ensureDemoSeed();
  const user = await registerUser({
    email: 'user.adminqa@example.com',
    password: 'SecurePassw0rd!',
    name: 'Обычный',
  });
  assert.equal(user.role, 'user');
  await ensureBillingUser({ id: user.id, email: user.email, name: user.name, role: 'user' });

  const userLogin = await loginUser({
    email: 'user.adminqa@example.com',
    password: 'SecurePassw0rd!',
  });
  const adminLogin = await loginUser({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
  });
  assert.equal(adminLogin.user.role, 'admin');
  await ensureBillingUser({
    id: adminLogin.user.id,
    email: adminLogin.user.email,
    name: adminLogin.user.name,
    role: 'admin',
  });

  child = spawn(process.execPath, [join(root, 'tools/preview.mjs')], {
    cwd: root,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += String(c); });
  await waitReady();

  // --- Non-admin → 403 on all admin routes ---
  const forbiddenPaths = [
    ['GET', '/api/admin/health'],
    ['GET', '/api/admin/jobs'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/audit'],
    ['GET', '/api/admin/promos'],
    ['GET', '/api/admin/maintenance'],
  ];
  for (const [method, path] of forbiddenPaths) {
    const r = await api(method, path, { token: userLogin.token });
    assert.equal(r.status, 403, `${method} ${path} should 403 for user`);
    assert.equal(r.data.code, 'FORBIDDEN');
  }
  const creditForbidden = await api('POST', '/api/admin/credit', {
    token: userLogin.token,
    body: { amountRub: 10, reason: 'hack' },
  });
  assert.equal(creditForbidden.status, 403);

  // Unauthenticated → 401
  const noAuth = await api('GET', '/api/admin/health', { token: null });
  assert.equal(noAuth.status, 401);

  // --- Admin happy paths ---
  const health = await api('GET', '/api/admin/health', { token: adminLogin.token });
  assert.equal(health.status, 200, `health: ${JSON.stringify(health.data)}`);
  assert.equal(health.data.ready, true);
  assert.ok(health.data.stats);
  assert.ok(health.data.adminSecurity);

  const users = await api('GET', '/api/admin/users', { token: adminLogin.token });
  assert.equal(users.status, 200);
  assert.ok(Array.isArray(users.data.items));
  assert.ok(users.data.items.some((u) => u.email === 'user.adminqa@example.com'));

  const credit = await api('POST', '/api/admin/credit', {
    token: adminLogin.token,
    body: {
      userId: user.id,
      amountRub: 50,
      reason: 'admin qa credit',
      businessKey: `qa:admin:credit:${user.id}:50`,
    },
  });
  assert.equal(credit.status, 200, JSON.stringify(credit.data));
  assert.equal(credit.data.idempotent, false);
  assert.equal(credit.data.entry.amountKopecks, 5000);
  assert.equal(credit.data.entry.reason, 'admin qa credit');

  const creditNoReason = await api('POST', '/api/admin/credit', {
    token: adminLogin.token,
    body: { userId: user.id, amountRub: 10 },
  });
  assert.equal(creditNoReason.status, 422);
  assert.equal(creditNoReason.data.code, 'REASON_REQUIRED');

  const promo = await api('POST', '/api/admin/promos', {
    token: adminLogin.token,
    body: {
      code: 'ADMINQA50',
      effectType: 'bonus_credit',
      bonusKopecks: 5000,
      status: 'active',
    },
  });
  assert.equal(promo.status, 201, JSON.stringify(promo.data));
  assert.equal(promo.data.code, 'ADMINQA50');

  const promoList = await api('GET', '/api/admin/promos', { token: adminLogin.token });
  assert.equal(promoList.status, 200);
  assert.ok(promoList.data.items.some((p) => p.code === 'ADMINQA50'));

  const promoPause = await api('POST', `/api/admin/promos/${promo.data.id}/status`, {
    token: adminLogin.token,
    body: { status: 'paused' },
  });
  assert.equal(promoPause.status, 200);
  assert.equal(promoPause.data.status, 'paused');

  const jobs = await api('GET', '/api/admin/jobs', { token: adminLogin.token });
  assert.equal(jobs.status, 200);
  assert.ok(Array.isArray(jobs.data.items));
  // Privacy: list items must not expose transcript text
  for (const item of jobs.data.items) {
    assert.equal(item.text, undefined);
    assert.equal(item.segments, undefined);
    assert.equal(item.srt, undefined);
  }

  const audit = await api('GET', '/api/admin/audit', { token: adminLogin.token });
  assert.equal(audit.status, 200);
  assert.ok(audit.data.items.some((a) => a.action === 'wallet.credit'));
  assert.ok(audit.data.items.some((a) => a.action === 'promo.create'));
  assert.ok(audit.data.items.some((a) => a.action === 'promo.status'));

  const maintOn = await api('POST', '/api/admin/maintenance', {
    token: adminLogin.token,
    body: { enabled: true, message: 'qa window' },
  });
  assert.equal(maintOn.status, 200);
  assert.equal(maintOn.data.enabled, true);
  const maintGet = await api('GET', '/api/admin/maintenance', { token: adminLogin.token });
  assert.equal(maintGet.data.enabled, true);
  await api('POST', '/api/admin/maintenance', {
    token: adminLogin.token,
    body: { enabled: false },
  });

  // Module-level audit helper still sees events
  const localAudit = await listAdminAudit({ limit: 20 });
  assert.ok(localAudit.some((a) => a.action === 'wallet.credit'));

  // Confirm demo admin still admin in auth store
  const adminRow = await withAuthLock((db) => db.users.find((u) => u.email === DEMO_EMAIL));
  assert.equal(adminRow.role, 'admin');

  console.log('PASS admin API authz (403) + credit/promo/health/audit/maintenance');
} catch (err) {
  console.error(err);
  if (child) console.error('server stderr:', child.stderr ? '' : '');
  process.exitCode = 1;
} finally {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    await sleep(300);
    try { child.kill('SIGKILL'); } catch { /* */ }
  }
  await restoreEnv();
  await rm(authRoot, { recursive: true, force: true });
  await rm(billingRoot, { recursive: true, force: true });
}
