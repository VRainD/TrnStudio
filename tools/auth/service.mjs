/**
 * Auth service: register / login / logout / me (SPEC §4, §8).
 */
import { randomUUID } from 'node:crypto';
import {
  withAuthLock, normalizeEmail, publicUser, demoSeedEnabled, ensureDemoSeed,
  DEMO_EMAIL, DEMO_PASSWORD,
} from './store.mjs';
import { hashPassword, verifyPassword, validatePasswordPolicy } from './passwords.mjs';
import {
  createSession, revokeSessionByToken, resolveSession,
  parseCookies, SESSION_COOKIE,
} from './sessions.mjs';

const ROLES = new Set(['user', 'admin']);

function validateEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || normalized.length > 254) {
    return { ok: false, error: 'Укажите корректный email.' };
  }
  // Practical check — keep plus/dots (SPEC §8).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { ok: false, error: 'Укажите корректный email.' };
  }
  return { ok: true, email: normalized };
}

export async function registerUser({ email, password, name, role = 'user' }) {
  const emailCheck = validateEmail(email);
  if (!emailCheck.ok) {
    const err = new Error(emailCheck.error);
    err.code = 'EMAIL_INVALID';
    throw err;
  }
  const pwCheck = validatePasswordPolicy(password);
  if (!pwCheck.ok) {
    const err = new Error(pwCheck.error);
    err.code = 'PASSWORD_POLICY';
    throw err;
  }
  const displayName = String(name || '').trim() || emailCheck.email.split('@')[0];
  if (displayName.length > 80) {
    const err = new Error('Имя слишком длинное.');
    err.code = 'NAME_INVALID';
    throw err;
  }
  if (!ROLES.has(role)) {
    const err = new Error('Недопустимая роль.');
    err.code = 'ROLE_INVALID';
    throw err;
  }

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  const user = await withAuthLock((db) => {
    if (db.users.some((u) => u.emailNormalized === emailCheck.email)) {
      const err = new Error('Аккаунт с таким email уже существует.');
      err.code = 'EMAIL_TAKEN';
      throw err;
    }
    const row = {
      id: randomUUID(),
      email: emailCheck.email,
      emailNormalized: emailCheck.email,
      name: displayName,
      passwordHash,
      role,
      createdAt: now,
      updatedAt: now,
    };
    db.users.push(row);
    return { ...row };
  });

  return publicUser(user);
}

export async function loginUser({ email, password, userAgent, ip }) {
  const emailCheck = validateEmail(email);
  if (!emailCheck.ok) {
    const err = new Error('Неверный email или пароль.');
    err.code = 'AUTH_FAILED';
    throw err;
  }

  const user = await withAuthLock((db) => {
    const row = db.users.find((u) => u.emailNormalized === emailCheck.email);
    return row ? { ...row } : null;
  });

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    const err = new Error('Неверный email или пароль.');
    err.code = 'AUTH_FAILED';
    throw err;
  }

  const session = await createSession({
    userId: user.id,
    role: user.role,
    userAgent,
    ip,
  });

  return {
    user: publicUser(user),
    token: session.token,
    sessionId: session.sessionId,
    maxAgeSec: session.maxAgeSec,
  };
}

export async function logoutByCookieHeader(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[SESSION_COOKIE];
  if (!token) return false;
  return revokeSessionByToken(token);
}

export async function currentUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  return resolveSession(token);
}

export async function bootstrapAuth() {
  if (demoSeedEnabled()) {
    await ensureDemoSeed();
  }
}

export function authCapabilities() {
  return {
    register: true,
    login: true,
    logout: true,
    sessions: true,
    roles: ['user', 'admin'],
    demoSeed: demoSeedEnabled(),
    passwordMinLength: 12,
  };
}

export { DEMO_EMAIL, DEMO_PASSWORD, SESSION_COOKIE };
