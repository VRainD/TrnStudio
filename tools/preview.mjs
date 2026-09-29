// Local development studio: auth sessions + ClickHouse transcripts + billing.
import http from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAudio, MediaError } from './media.mjs';
import { createJobFromUpload, getJob, readJobArtifact, transcriptionCapabilities,
  listJobsForUser, getJobForUser, listJobsAdmin,
} from './jobs.mjs';
import { quoteCost, formatRub } from './billing/cost.mjs';
import { getWalletView, listTransactions, creditWallet, createQuote } from './billing/wallet.mjs';
import { validatePromo, redeemPromo, createPromo, listPromos, setPromoStatus } from './billing/promos.mjs';
import {
  createTopupPayment, paymentStatusPublic, reconcilePaymentWebhook,
} from './billing/payments.mjs';
import { billingEnabled, ensureBillingUser } from './billing/store.mjs';
import {
  listAdminUsers, listAdminAudit, adminOverviewStats,
  getMaintenance, setMaintenance, invalidateMaintenanceCache,
} from './billing/admin.mjs';
import {
  registerUser, loginUser, logoutByCookieHeader, currentUserFromRequest,
  bootstrapAuth, authCapabilities,
} from './auth/service.mjs';
import {
  sessionCookieHeader, clearSessionCookieHeader, SESSION_COOKIE,
} from './auth/sessions.mjs';
import {
  clickhouseConfigured, pingClickHouse, getSharedClient,
} from './clickhouse/client.mjs';
import { ensureTranscriptSchema } from './clickhouse/transcripts.mjs';

const page = new URL('../prototype/index.html', import.meta.url);
const root = process.env.MEDIA_ROOT || fileURLToPath(new URL('../.local-media/', import.meta.url));
const port = Number(process.env.PORT || 4173);
const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
const allowedHost = new URL(origin).host;
let busy = false;
let ready = false;

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, limit = 64_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function localClientOk(req) {
  return req.headers.origin === origin && req.headers['x-gorizont-client'] === 'local-preview';
}

function matchJob(url) {
  const m = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(txt|srt|vtt|json))?$/.exec(url);
  if (!m) return null;
  return { id: m[1], artifact: m[2] || null };
}

async function requireUser(req, res) {
  const auth = await currentUserFromRequest(req);
  if (!auth) {
    json(res, 401, { error: 'Требуется вход.', code: 'UNAUTHORIZED' });
    return null;
  }
  return auth;
}

async function requireAdmin(req, res) {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  if (auth.user.role !== 'admin') {
    json(res, 403, { error: 'Недостаточно прав.', code: 'FORBIDDEN' });
    return null;
  }
  return auth;
}

async function syncBilling(user) {
  await ensureBillingUser({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = (req.url || '').split('?')[0];
    const qs = new URL(req.url || '/', origin).searchParams;

    if (urlPath === '/healthz' && req.method === 'GET') {
      json(res, 200, {
        status: 'ok',
        ready,
        clickhouse: clickhouseConfigured(),
      });
      return;
    }
    if (req.headers.host !== allowedHost) { json(res, 403, { error: 'Недопустимый адрес сервера.' }); return; }
    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(await readFile(page));
      } catch { res.end('Preview unavailable'); }
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/capabilities') {
      const ch = clickhouseConfigured() ? await pingClickHouse() : { ok: false };
      json(res, 200, {
        ...transcriptionCapabilities(),
        auth: authCapabilities(),
        billing: {
          enabled: billingEnabled(),
          payments: paymentStatusPublic(),
        },
        clickhouse: { configured: clickhouseConfigured(), ping: ch },
      });
      return;
    }

    // --- Auth (SPEC §8) ---
    if (req.method === 'POST' && urlPath === '/api/auth/register') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const body = await readJsonBody(req);
      try {
        const user = await registerUser({
          email: body.email,
          password: body.password,
          name: body.name,
        });
        await syncBilling(user);
        const logged = await loginUser({
          email: body.email,
          password: body.password,
          userAgent: req.headers['user-agent'],
          ip: req.socket.remoteAddress,
        });
        json(res, 201, { user: logged.user }, {
          'Set-Cookie': sessionCookieHeader(logged.token, { maxAgeSec: logged.maxAgeSec }),
        });
      } catch (e) {
        const status = e.code === 'EMAIL_TAKEN' ? 409 : 422;
        json(res, status, { error: e.message || 'Не удалось зарегистрироваться.', code: e.code });
      }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/auth/login') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const body = await readJsonBody(req);
      try {
        const logged = await loginUser({
          email: body.email,
          password: body.password,
          userAgent: req.headers['user-agent'],
          ip: req.socket.remoteAddress,
        });
        await syncBilling(logged.user);
        json(res, 200, { user: logged.user }, {
          'Set-Cookie': sessionCookieHeader(logged.token, { maxAgeSec: logged.maxAgeSec }),
        });
      } catch (e) {
        json(res, 401, { error: e.message || 'Неверный email или пароль.', code: e.code || 'AUTH_FAILED' });
      }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/auth/logout') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      await logoutByCookieHeader(req.headers.cookie);
      json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookieHeader() });
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/me') {
      const auth = await currentUserFromRequest(req);
      if (!auth) { json(res, 401, { error: 'Требуется вход.', code: 'UNAUTHORIZED' }); return; }
      json(res, 200, { user: auth.user, session: auth.session });
      return;
    }

    // --- Quote (metering; works with BILLING_ENABLED=false) ---
    if (req.method === 'GET' && urlPath === '/api/quote') {
      const durationSeconds = Number(qs.get('durationSeconds'));
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 14400) {
        json(res, 400, { error: 'Укажите durationSeconds от 0 до 14400.' });
        return;
      }
      const quote = quoteCost({ durationSeconds });
      json(res, 200, {
        ...quote,
        costRub: formatRub(quote.costKopecks),
        durationSeconds,
      });
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/quotes') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const auth = await requireUser(req, res);
      if (!auth) return;
      await syncBilling(auth.user);
      const body = await readJsonBody(req);
      const q = await createQuote({
        userId: auth.user.id,
        durationSeconds: Number(body.durationSeconds),
        uploadId: body.uploadId || null,
        fileHash: body.fileHash || null,
      });
      json(res, 201, q);
      return;
    }

    // --- Wallet (authenticated) ---
    if (req.method === 'GET' && urlPath === '/api/wallet') {
      const auth = await requireUser(req, res);
      if (!auth) return;
      await syncBilling(auth.user);
      json(res, 200, await getWalletView(auth.user.id));
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/wallet/transactions') {
      const auth = await requireUser(req, res);
      if (!auth) return;
      await syncBilling(auth.user);
      json(res, 200, { items: await listTransactions(auth.user.id) });
      return;
    }

    // --- Payments ---
    if (req.method === 'GET' && urlPath === '/api/payments/status') {
      json(res, 200, paymentStatusPublic());
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/payments') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const auth = await requireUser(req, res);
      if (!auth) return;
      await syncBilling(auth.user);
      const body = await readJsonBody(req);
      try {
        const result = await createTopupPayment({
          userId: auth.user.id,
          amountRub: Number(body.amountRub),
          idempotenceKey: body.idempotenceKey || req.headers['idempotence-key'] || undefined,
        });
        json(res, 201, result);
      } catch (e) {
        json(res, 422, { error: e.message || 'Не удалось создать платёж.' });
      }
      return;
    }
    if (req.method === 'POST' && (urlPath === '/api/webhooks/yookassa' || urlPath === '/api/webhooks/yoomoney')) {
      const body = await readJsonBody(req);
      const provider = urlPath.endsWith('yoomoney') ? 'yoomoney' : 'yookassa';
      const providerPaymentId = body.object?.id || body.providerPaymentId || body.id;
      const status = body.object?.status || body.status;
      const result = await reconcilePaymentWebhook({ provider, providerPaymentId, status });
      json(res, 200, result);
      return;
    }

    // --- Promos ---
    if (req.method === 'POST' && urlPath === '/api/promos/validate') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const auth = await requireUser(req, res);
      if (!auth) return;
      const body = await readJsonBody(req);
      try {
        json(res, 200, await validatePromo({
          userId: auth.user.id,
          code: body.code,
          topupKopecks: body.topupKopecks != null ? Number(body.topupKopecks) : (
            body.amountRub != null ? Number(body.amountRub) * 100 : null
          ),
        }));
      } catch (e) {
        json(res, 422, { error: e.message || 'Промокод недоступен.', code: e.code || 'PROMO_UNAVAILABLE' });
      }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/promos/redeem') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const auth = await requireUser(req, res);
      if (!auth) return;
      await syncBilling(auth.user);
      const body = await readJsonBody(req);
      try {
        json(res, 200, await redeemPromo({
          userId: auth.user.id,
          code: body.code,
          topupKopecks: body.topupKopecks != null ? Number(body.topupKopecks) : (
            body.amountRub != null ? Number(body.amountRub) * 100 : null
          ),
          businessKey: body.businessKey || undefined,
        }));
      } catch (e) {
        json(res, 422, { error: e.message || 'Промокод недоступен.', code: e.code || 'PROMO_UNAVAILABLE' });
      }
      return;
    }

    // --- Admin ---
    if (req.method === 'GET' && urlPath === '/api/admin/health') {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const ch = clickhouseConfigured()
        ? await pingClickHouse()
        : { ok: false, error: 'ClickHouse не настроен' };
      const stats = await adminOverviewStats();
      json(res, 200, {
        status: ready ? 'ok' : 'starting',
        ready,
        studio: { origin, host: allowedHost },
        clickhouse: { configured: clickhouseConfigured(), ping: ch },
        billing: {
          enabled: billingEnabled(),
          payments: paymentStatusPublic(),
        },
        maintenance: stats.maintenance,
        stats: {
          users: stats.users,
          wallets: stats.wallets,
          totalBalanceTokens: stats.totalBalanceTokens,
          activeHolds: stats.activeHolds,
          heldKopecks: stats.heldKopecks,
          promos: stats.promos,
          promosActive: stats.promosActive,
          auditEvents: stats.auditEvents,
          payments: stats.payments,
        },
        auth: authCapabilities(),
        transcription: transcriptionCapabilities(),
        // TOTP 2FA for admin — deferred (stub)
        adminSecurity: { totpRequired: false, note: 'TOTP 2FA для admin — позже' },
      });
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/admin/jobs') {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const items = await listJobsAdmin({
        limit: Math.min(200, Number(qs.get('limit')) || 50),
      });
      // Privacy: never include transcript text in admin list payload.
      json(res, 200, {
        items: items.map((j) => ({
          id: j.id,
          userId: j.userId,
          title: j.title,
          status: j.status,
          progress: j.progress,
          error: j.error,
          durationSeconds: j.durationSeconds,
          backend: j.backend,
          costKopecks: j.costKopecks ?? j.cost?.cost_kopecks ?? null,
          costTokens: j.costTokens ?? ((j.costKopecks ?? j.cost?.cost_kopecks ?? 0) / 100),
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          textChars: j.textChars ?? 0,
          source: j.source || null,
        })),
      });
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/admin/users') {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const items = await listAdminUsers({
        limit: Math.min(200, Number(qs.get('limit')) || 100),
      });
      json(res, 200, { items });
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/admin/audit') {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const actions = qs.get('actions') ? qs.get('actions').split(',').map((s) => s.trim()).filter(Boolean) : null;
      const items = await listAdminAudit({
        limit: Math.min(200, Number(qs.get('limit')) || 100),
        actions,
      });
      json(res, 200, { items });
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/admin/maintenance') {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      json(res, 200, await getMaintenance());
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/admin/maintenance') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const body = await readJsonBody(req);
      try {
        const result = await setMaintenance({
          enabled: Boolean(body.enabled),
          message: body.message ?? null,
          actorId: auth.user.id,
        });
        invalidateMaintenanceCache();
        json(res, 200, result);
      } catch (e) {
        json(res, e.code === 'MAINTENANCE_ENV_LOCKED' ? 409 : 422, { error: e.message, code: e.code });
      }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/admin/credit') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const body = await readJsonBody(req);
      try {
        if (!body.reason || !String(body.reason).trim()) {
          json(res, 422, { error: 'Укажите причину начисления (reason).', code: 'REASON_REQUIRED' });
          return;
        }
        const targetUserId = body.userId || auth.user.id;
        await ensureBillingUser({ id: targetUserId });
        const amountKopecks = body.amountKopecks != null
          ? Number(body.amountKopecks)
          : Math.round(Number(body.amountRub) * 100);
        if (!Number.isFinite(amountKopecks) || amountKopecks <= 0) {
          json(res, 422, { error: 'Укажите положительную сумму (amountRub или amountKopecks).' });
          return;
        }
        json(res, 200, await creditWallet({
          userId: targetUserId,
          amountKopecks: Math.round(amountKopecks),
          reason: body.reason,
          businessKey: body.businessKey || undefined,
          actorId: auth.user.id,
        }));
      } catch (e) {
        json(res, 422, { error: e.message || 'Не удалось начислить.' });
      }
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/admin/promos') {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      try { json(res, 200, { items: await listPromos({ actorId: auth.user.id }) }); }
      catch (e) { json(res, 403, { error: e.message }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/admin/promos') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const body = await readJsonBody(req);
      try { json(res, 201, await createPromo({ ...body, actorId: auth.user.id })); }
      catch (e) { json(res, 422, { error: e.message }); }
      return;
    }
    if (req.method === 'POST' && urlPath.startsWith('/api/admin/promos/') && urlPath.endsWith('/status')) {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const id = urlPath.slice('/api/admin/promos/'.length, -'/status'.length);
      const body = await readJsonBody(req);
      try { json(res, 200, await setPromoStatus({ promoId: id, status: body.status, actorId: auth.user.id })); }
      catch (e) { json(res, 422, { error: e.message }); }
      return;
    }

    // --- Jobs / cabinet (owner-scoped) ---
    if (req.method === 'GET' && urlPath === '/api/jobs') {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const items = await listJobsForUser(auth.user.id, {
        limit: Math.min(100, Number(qs.get('limit')) || 50),
      });
      json(res, 200, { items });
      return;
    }

    const jobMatch = matchJob(urlPath);
    if (req.method === 'GET' && jobMatch && !jobMatch.artifact) {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const job = await getJobForUser(auth.user.id, jobMatch.id);
      if (!job) { json(res, 404, { error: 'Задача не найдена.' }); return; }
      json(res, 200, job);
      return;
    }
    if (req.method === 'GET' && jobMatch && jobMatch.artifact) {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const artifact = await readJobArtifact(jobMatch.id, jobMatch.artifact, { userId: auth.user.id });
      if (!artifact) { json(res, 404, { error: 'Задача не найдена.' }); return; }
      if (artifact.pending) { json(res, 409, { error: 'Результат ещё не готов.', job: artifact.job }); return; }
      res.writeHead(200, { 'Content-Type': artifact.contentType, 'Cache-Control': 'no-store' });
      res.end(artifact.body);
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/jobs') {
      if (!localClientOk(req)) {
        json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' });
        return;
      }
      const auth = await requireUser(req, res);
      if (!auth) return;
      await syncBilling(auth.user);
      if (busy) { json(res, 409, { error: 'Сейчас обрабатывается другой файл. Попробуйте чуть позже.' }); return; }
      if (Number(req.headers['content-length']) > 1024 ** 3) { json(res, 413, { error: 'Максимальный размер — 1 ГБ.' }); return; }
      busy = true;
      try {
        const title = decodeURIComponent(String(req.headers['x-gorizont-title'] || 'Запись'));
        const job = await createJobFromUpload(req, root, { title, userId: auth.user.id });
        json(res, 202, job);
      } catch (error) {
        if (!res.headersSent && !res.destroyed) {
          const status = error instanceof MediaError
            ? (error.code === 'INSUFFICIENT_FUNDS' ? 402 : 422)
            : 500;
          json(res, status, {
            error: error instanceof MediaError ? error.message : 'Не удалось запустить распознавание.',
            code: error.code || undefined,
          });
        }
      } finally {
        busy = false;
      }
      return;
    }

    // Legacy extract endpoint kept for tooling; studio UI no longer offers WAV download.
    if (req.method !== 'POST' || urlPath !== '/api/extract') { json(res, 404, { error: 'Не найдено.' }); return; }
    if (!localClientOk(req)) {
      json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' });
      return;
    }
    const authExtract = await requireUser(req, res);
    if (!authExtract) return;
    if (busy) { json(res, 409, { error: 'Сейчас обрабатывается другой файл. Попробуйте чуть позже.' }); return; }
    if (Number(req.headers['content-length']) > 1024 ** 3) { json(res, 413, { error: 'Максимальный размер — 1 ГБ.' }); return; }
    busy = true;
    let dir;
    try {
      await mkdir(root, { recursive: true });
      dir = await mkdtemp(join(root, 'job-'));
      const input = join(dir, 'source.media'), output = join(dir, 'audio.wav');
      let size = 0;
      const limit = new Transform({
        transform(chunk, enc, cb) {
          size += chunk.length;
          cb(size > 1024 ** 3 ? new MediaError('Максимальный размер — 1 ГБ.') : null, chunk);
        },
      });
      await pipeline(req, limit, createWriteStream(input, { flags: 'wx' }));
      if (!size) throw new MediaError('Файл пуст.');
      const result = await extractAudio(input, output);
      const quote = quoteCost({ durationSeconds: result.seconds });
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': result.bytes,
        'Content-Disposition': 'attachment; filename="gorizont-audio.wav"',
        'X-Audio-Duration': String(result.seconds),
        'X-Cost-Kopecks': String(quote.costKopecks),
        'Cache-Control': 'no-store',
      });
      await pipeline(createReadStream(output), res);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        json(res, error instanceof MediaError ? 422 : 500, {
          error: error instanceof MediaError ? error.message : 'Не удалось обработать файл. Проверьте FFmpeg и свободное место.',
        });
      }
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => console.error('Temporary media cleanup failed'));
      busy = false;
    }
  } catch (error) {
    if (!res.headersSent) {
      json(res, error.status || 500, { error: error.message || 'Внутренняя ошибка.' });
    }
  }
});

server.requestTimeout = 10 * 60 * 1000;

async function boot() {
  await bootstrapAuth();
  if (clickhouseConfigured()) {
    try {
      await ensureTranscriptSchema();
      const ping = await pingClickHouse();
      if (!ping.ok) console.warn('ClickHouse ping failed:', ping.error);
      else console.log('ClickHouse schema ready');
    } catch (err) {
      console.warn('ClickHouse migrate failed (studio still starts):', err.message);
    }
  }
  ready = true;
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`Local studio: ${origin} (auth + ClickHouse transcripts)`);
  });
}

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { SESSION_COOKIE, getSharedClient };
