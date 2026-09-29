/**
 * Auth tests: register / login / session cookie / isolation.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerUser, loginUser, currentUserFromRequest, logoutByCookieHeader } from './auth/service.mjs';
import { ensureDemoSeed, DEMO_EMAIL, DEMO_PASSWORD, DEMO_USER_ID } from './auth/store.mjs';
import { SESSION_COOKIE, parseCookies, hashToken } from './auth/sessions.mjs';
import { withAuthLock } from './auth/store.mjs';
import { verifyPassword } from './auth/passwords.mjs';
import { ensureBillingUser } from './billing/store.mjs';
import { getWalletView, creditWallet } from './billing/wallet.mjs';

const prevAuth = process.env.AUTH_ROOT;
const prevBilling = process.env.BILLING_ROOT;
const prevDemo = process.env.AUTH_DEMO_SEED;
const authRoot = await mkdtemp(join(tmpdir(), 'gorizont-auth-'));
const billingRoot = await mkdtemp(join(tmpdir(), 'gorizont-billing-auth-'));
process.env.AUTH_ROOT = authRoot;
process.env.BILLING_ROOT = billingRoot;
process.env.AUTH_DEMO_SEED = 'false';

try {
  // Password policy
  let rejected = false;
  try {
    await registerUser({ email: 'short@example.com', password: 'short', name: 'S' });
  } catch (e) {
    rejected = e.code === 'PASSWORD_POLICY';
  }
  assert.equal(rejected, true, 'short password rejected');

  const user = await registerUser({
    email: 'Alice+Test@Example.COM',
    password: 'SecurePassw0rd!',
    name: 'Алиса',
  });
  assert.equal(user.email, 'alice+test@example.com', 'email normalized, plus kept');
  assert.equal(user.role, 'user');
  assert.ok(user.id);

  // Duplicate email
  let taken = false;
  try {
    await registerUser({ email: 'alice+test@example.com', password: 'SecurePassw0rd!', name: 'Dup' });
  } catch (e) {
    taken = e.code === 'EMAIL_TAKEN';
  }
  assert.equal(taken, true);

  // Password stored as hash, not plaintext
  const stored = await withAuthLock((db) => db.users.find((u) => u.id === user.id));
  assert.notEqual(stored.passwordHash, 'SecurePassw0rd!');
  assert.equal(await verifyPassword('SecurePassw0rd!', stored.passwordHash), true);
  assert.equal(await verifyPassword('wrong-password!!', stored.passwordHash), false);

  // Login + opaque session
  const logged = await loginUser({
    email: 'alice+test@example.com',
    password: 'SecurePassw0rd!',
    userAgent: 'qa',
    ip: '127.0.0.1',
  });
  assert.equal(logged.user.id, user.id);
  assert.ok(logged.token);
  assert.ok(logged.token.length >= 32);

  // Token hash in DB, not raw token
  const sess = await withAuthLock((db) => db.sessions.find((s) => s.userId === user.id));
  assert.equal(sess.tokenHash, hashToken(logged.token));
  assert.notEqual(sess.tokenHash, logged.token);

  const fakeReq = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(logged.token)}` } };
  const me = await currentUserFromRequest(fakeReq);
  assert.equal(me.user.id, user.id);
  assert.equal(me.user.role, 'user');

  // Bad password
  let failed = false;
  try {
    await loginUser({ email: 'alice+test@example.com', password: 'wrong-password!!' });
  } catch (e) {
    failed = e.code === 'AUTH_FAILED';
  }
  assert.equal(failed, true);

  // Logout
  await logoutByCookieHeader(fakeReq.headers.cookie);
  const after = await currentUserFromRequest(fakeReq);
  assert.equal(after, null);

  // Wallet attaches to real user_id
  await ensureBillingUser({ id: user.id, email: user.email, name: user.name, role: user.role });
  await creditWallet({
    userId: user.id,
    amountKopecks: 500,
    reason: 'auth qa',
    businessKey: `qa:auth:${user.id}`,
  });
  const wallet = await getWalletView(user.id);
  assert.equal(wallet.userId, user.id);
  assert.equal(wallet.availableKopecks, 500);

  // Demo seed behind flag
  process.env.AUTH_DEMO_SEED = 'true';
  const seeded = await ensureDemoSeed();
  assert.equal(seeded.user.id, DEMO_USER_ID);
  const demoLogin = await loginUser({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  assert.equal(demoLogin.user.role, 'admin');
  const cookies = parseCookies(`${SESSION_COOKIE}=x`);
  assert.equal(cookies[SESSION_COOKIE], 'x');

  console.log('PASS auth register/login/session/logout + wallet user_id + demo seed flag');
} finally {
  if (prevAuth === undefined) delete process.env.AUTH_ROOT;
  else process.env.AUTH_ROOT = prevAuth;
  if (prevBilling === undefined) delete process.env.BILLING_ROOT;
  else process.env.BILLING_ROOT = prevBilling;
  if (prevDemo === undefined) delete process.env.AUTH_DEMO_SEED;
  else process.env.AUTH_DEMO_SEED = prevDemo;
  await rm(authRoot, { recursive: true, force: true });
  await rm(billingRoot, { recursive: true, force: true });
}
