// Local development only. No authentication, billing or public deployment.
import http from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAudio, MediaError } from './media.mjs';
import { createJobFromUpload, getJob, readJobArtifact, transcriptionCapabilities } from './jobs.mjs';

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

function matchJob(url) {
  const m = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(txt|srt|vtt|json))?$/.exec(url);
  if (!m) return null;
  return { id: m[1], artifact: m[2] || null };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz' && req.method === 'GET') { json(res, 200, { status: 'ok' }); return; }
  if (req.headers.host !== allowedHost) { json(res, 403, { error: 'Недопустимый адрес сервера.' }); return; }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await readFile(page));
    } catch { res.end('Preview unavailable'); }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/capabilities') {
    json(res, 200, transcriptionCapabilities());
    return;
  }

  const jobMatch = req.url ? matchJob(req.url.split('?')[0]) : null;
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

  if (req.method === 'POST' && req.url === '/api/jobs') {
    if (req.headers.origin !== origin || req.headers['x-gorizont-client'] !== 'local-preview') {
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
        json(res, error instanceof MediaError ? 422 : 500, {
          error: error instanceof MediaError ? error.message : 'Не удалось запустить распознавание.',
        });
      }
    } finally {
      busy = false;
    }
    return;
  }

  // Legacy extract endpoint kept for tooling; studio UI no longer offers WAV download.
  if (req.method !== 'POST' || req.url !== '/api/extract') { json(res, 404, { error: 'Не найдено.' }); return; }
  if (req.headers.origin !== origin || req.headers['x-gorizont-client'] !== 'local-preview') {
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
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': result.bytes,
      'Content-Disposition': 'attachment; filename="gorizont-audio.wav"',
      'X-Audio-Duration': String(result.seconds),
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
});

server.requestTimeout = 10 * 60 * 1000;
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Local studio: ${origin}`));
