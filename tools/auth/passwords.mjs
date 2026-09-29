/**
 * Password hashing — bcrypt (SPEC §4 allows Argon2id or bcrypt).
 * bcryptjs: pure JS, works in slim Node images without native build tools.
 */
import bcrypt from 'bcryptjs';

const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const MIN_LENGTH = 12;

export function validatePasswordPolicy(password) {
  if (typeof password !== 'string') {
    return { ok: false, error: 'Укажите пароль.' };
  }
  if (password.length < MIN_LENGTH) {
    return { ok: false, error: `Пароль не короче ${MIN_LENGTH} символов.` };
  }
  if (password.length > 200) {
    return { ok: false, error: 'Пароль слишком длинный.' };
  }
  return { ok: true };
}

export async function hashPassword(password) {
  const check = validatePasswordPolicy(password);
  if (!check.ok) {
    const err = new Error(check.error);
    err.code = 'PASSWORD_POLICY';
    throw err;
  }
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(password, passwordHash) {
  if (typeof password !== 'string' || typeof passwordHash !== 'string') return false;
  return bcrypt.compare(password, passwordHash);
}

export { MIN_LENGTH as PASSWORD_MIN_LENGTH };
