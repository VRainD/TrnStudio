// Local development only. Billing uses file-backed ledger; online payments stubbed.
import http from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAudio, MediaError } from './media.mjs';
import { createJobFromUpload, getJob, readJobArtifact, transcriptionCapabilities } from './jobs.mjs';
import { quoteCost, formatRub } from './billing/cost.mjs';
import { getWalletView, listTransactions, creditWallet, createQuote } from './billing/wallet.mjs';
import { validatePromo, redeemPromo, createPromo, listPromos, setPromoStatus } from './billing/promos.mjs';
import {
  createTopupPayment, paymentStatusPublic, reconcilePaymentWebhook,
} from './billing/payments.mjs';
import { billingEnabled, demoUserId } from './billing/store.mjs';

const page = new URL('../prototype/index.html', import.meta.url);
const root = process.env.MEDIA_ROOT || fileURLToPath(new URL('../.local-media/', import.meta.url));
const port = Number(process.env.PORT || 4173);
const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
const allowedHost = new URL(origin).host;
let busy = false;

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
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

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = (req.url || '').split('?')[0];
    const qs = new URL(req.url || '/', origin).searchParams;

    if (urlPath === '/healthz' && req.method === 'GET') { json(res, 200, { status: 'ok' }); return; }
    if (req.headers.host !== allowedHost) { json(res, 403, { error: 'Недопустимый адрес сервера.' }); return; }
    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(await readFile(page));
      } catch { res.end('Preview unavailable'); }
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/capabilities') {
      json(res, 200, {
        ...transcriptionCapabilities(),
        billing: {
          enabled: billingEnabled(),
          payments: paymentStatusPublic(),
        },
      });
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
      const body = await readJsonBody(req);
      const q = await createQuote({
        durationSeconds: Number(body.durationSeconds),
        uploadId: body.uploadId || null,
        fileHash: body.fileHash || null,
      });
      json(res, 201, q);
      return;
    }

    // --- Wallet ---
    if (req.method === 'GET' && urlPath === '/api/wallet') {
      json(res, 200, await getWalletView(demoUserId()));
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/wallet/transactions') {
      json(res, 200, { items: await listTransactions(demoUserId()) });
      return;
    }

    // --- Payments (stub; no real charge without secrets) ---
    if (req.method === 'GET' && urlPath === '/api/payments/status') {
      json(res, 200, paymentStatusPublic());
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/payments') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const body = await readJsonBody(req);
      try {
        const result = await createTopupPayment({
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
      const body = await readJsonBody(req);
      try {
        json(res, 200, await validatePromo({
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
      const body = await readJsonBody(req);
      try {
        json(res, 200, await redeemPromo({
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

    // --- Admin (local demo user is admin) ---
    if (req.method === 'POST' && urlPath === '/api/admin/credit') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const body = await readJsonBody(req);
      try {
        const amountKopecks = body.amountKopecks != null
          ? Number(body.amountKopecks)
          : Math.round(Number(body.amountRub) * 100);
        json(res, 200, await creditWallet({
          amountKopecks,
          reason: body.reason,
          businessKey: body.businessKey || undefined,
        }));
      } catch (e) {
        json(res, 422, { error: e.message || 'Не удалось начислить.' });
      }
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/admin/promos') {
      try { json(res, 200, { items: await listPromos() }); }
      catch (e) { json(res, 403, { error: e.message }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/admin/promos') {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const body = await readJsonBody(req);
      try { json(res, 201, await createPromo(body)); }
      catch (e) { json(res, 422, { error: e.message }); }
      return;
    }
    if (req.method === 'POST' && urlPath.startsWith('/api/admin/promos/') && urlPath.endsWith('/status')) {
      if (!localClientOk(req)) { json(res, 403, { error: 'Разрешены запросы только из локального интерфейса.' }); return; }
      const id = urlPath.slice('/api/admin/promos/'.length, -'/status'.length);
      const body = await readJsonBody(req);
      try { json(res, 200, await setPromoStatus({ promoId: id, status: body.status })); }
      catch (e) { json(res, 422, { error: e.message }); }
      return;
    }

    const jobMatch = matchJob(urlPath);
    if (req.method === 'GET' && jobMatch && !jobMatch.artifact) {
      const job = getJob(jobMatch.id);
      if (!job) { json(res, 404, { error: 'Задача не найдена.' }); return; }
      json(res, 200, job);
      return;
    }
    if (req.method === 'GET' && jobMatch && jobMatch.artifact) {
      const artifact = await readJobArtifact(jobMatch.id, jobMatch.artifact);
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
      if (busy) { json(res, 409, { error: 'Сейчас обрабатывается другой файл. Попробуйте чуть позже.' }); return; }
      if (Number(req.headers['content-length']) > 1024 ** 3) { json(res, 413, { error: 'Максимальный размер — 1 ГБ.' }); return; }
      busy = true;
      try {
        const title = decodeURIComponent(String(req.headers['x-gorizont-title'] || 'Запись'));
        const job = await createJobFromUpload(req, root, { title });
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
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Local studio: ${origin}`));
