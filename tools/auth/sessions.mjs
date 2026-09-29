/**
 * Opaque session tokens (SPEC §4): crypto-random token, hash in DB, HttpOnly cookie.
 */
import { createHash, randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { withAuthLock, publicUser, findUserById } from './store.mjs';

export const SESSION_COOKIE = 'gorizont_session';

const IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_IDLE_MS = 12 * 60 * 60 * 1000;

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function idleMsForRole(role) {
  return role === 'admin' ? ADMIN_IDLE_MS : IDLE_MS;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionCookieHeader(token, { maxAgeSec, secure } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec ?? Math.floor(IDLE_MS / 1000)}`,
  ];
  if (secure || process.env.COOKIE_SECURE === 'true') parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookieHeader({ secure } = {}) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure || process.env.COOKIE_SECURE === 'true') parts.push('Secure');
  return parts.join('; ');
}

export async function createSession({ userId, role, userAgent, ip }) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const now = Date.now();
  const idle = idleMsForRole(role);
  const session = {
    id: randomUUID(),
    userId,
    tokenHash,
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    expiresAt: new Date(now + idle).toISOString(),
    absoluteExpiresAt: new Date(now + ABSOLUTE_MS).toISOString(),
    userAgent: userAgent || null,
    ip: ip || null,
  };
  await withAuthLock((db) => {
    db.sessions.push(session);
  });
  return {
    token,
    sessionId: session.id,
    maxAgeSec: Math.floor(idle / 1000),
  };
}

export async function revokeSessionByToken(token) {
  if (!token) return false;
  const tokenHash = hashToken(token);
  return withAuthLock((db) => {
    const before = db.sessions.length;
    db.sessions = db.sessions.filter((s) => s.tokenHash !== tokenHash);
    return db.sessions.length < before;
  });
}

export async function revokeAllUserSessions(userId, { exceptSessionId } = {}) {
  return withAuthLock((db) => {
    db.sessions = db.sessions.filter((s) => {
      if (s.userId !== userId) return true;
      if (exceptSessionId && s.id === exceptSessionId) return true;
      return false;
    });
  });
}

/**
 * Resolve session from cookie token. Touches lastSeen / idle expiry.
 * @returns {Promise<{user: object, session: object}|null>}
 */
export async function resolveSession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const now = Date.now();

  const resolved = await withAuthLock((db) => {
    const session = db.sessions.find((s) => s.tokenHash === tokenHash);
    if (!session) return null;
    if (new Date(session.absoluteExpiresAt).getTime() <= now
      || new Date(session.expiresAt).getTime() <= now) {
      db.sessions = db.sessions.filter((s) => s.id !== session.id);
      return null;
    }
    const user = db.users.find((u) => u.id === session.userId);
    if (!user) {
      db.sessions = db.sessions.filter((s) => s.id !== session.id);
      return null;
    }
    const idle = idleMsForRole(user.role);
    session.lastSeenAt = new Date(now).toISOString();
    session.expiresAt = new Date(now + idle).toISOString();
    return { user: { ...user }, session: { ...session } };
  });

  if (!resolved) return null;
  return {
    user: publicUser(resolved.user),
    session: {
      id: resolved.session.id,
      createdAt: resolved.session.createdAt,
      lastSeenAt: resolved.session.lastSeenAt,
      expiresAt: resolved.session.expiresAt,
    },
  };
}

export async function listSessionsForUser(userId) {
  return withAuthLock((db) => db.sessions
    .filter((s) => s.userId === userId)
    .map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      userAgent: s.userAgent,
      ip: s.ip,
    })));
}

export { findUserById, hashToken };
