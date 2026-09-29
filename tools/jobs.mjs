// Disk-backed transcription jobs + ClickHouse persistence for Горизонт.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { extractAudio, MediaError } from './media.mjs';
import { costSnapshotFromSeconds } from './billing/cost.mjs';
import {
  reserveForJob, captureHoldForJob, releaseHoldForJob,
} from './billing/wallet.mjs';
import { billingEnabled } from './billing/store.mjs';
import {
  upsertTranscript, listTranscriptsForUser, getTranscriptForUser,
} from './clickhouse/transcripts.mjs';
import { clickhouseConfigured } from './clickhouse/client.mjs';

const workerRoot = fileURLToPath(new URL('../worker/', import.meta.url));
const longformScript = join(workerRoot, 'longform_transcribe.py');
const jobs = new Map();

function pythonBin() {
  return process.env.PYTHON || process.env.TRANSCRIBE_PYTHON || 'python3';
}

function backendEnv() {
  return process.env.TRANSCRIBE_BACKEND || 'auto';
}

export function transcriptionCapabilities() {
  const backend = backendEnv();
  return {
    extraction: true,
    transcription: true,
    backend,
    longform: true,
    maxChunkSeconds: 20,
    formats: ['txt', 'srt', 'vtt'],
    clickhouse: clickhouseConfigured(),
    note: backend === 'mock'
      ? 'Mock ASR (нет GPU/GigaAM в этой среде). Chunking как в VRainD/gigaamui.'
      : 'Long-form ASR (движок VRainD/gigaamui) через worker/longform_transcribe.py',
  };
}

async function persistLocal(job) {
  await writeFile(join(job.dir, 'meta.json'), JSON.stringify({
    id: job.id,
    userId: job.userId,
    status: job.status,
    progress: job.progress,
    error: job.error,
    title: job.title,
    durationSeconds: job.durationSeconds,
    backend: job.backend,
    cost: job.cost,
    holdId: job.holdId,
    billingEnabled: job.billingEnabled,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }, null, 2), 'utf8');
}

async function persistClickHouse(job, extra = {}) {
  if (!clickhouseConfigured()) return;
  const costKopecks = job.cost?.cost_kopecks ?? 0;
  const segments = job.result?.segments || extra.segments || [];
  await upsertTranscript({
    jobId: job.id,
    userId: job.userId,
    title: job.title,
    status: job.status,
    text: extra.text ?? job.result?.text ?? '',
    segments,
    srt: extra.srt ?? job.result?.srt ?? '',
    vtt: extra.vtt ?? job.result?.vtt ?? '',
    durationSeconds: job.durationSeconds,
    backend: job.backend,
    costKopecks,
    error: job.error || '',
    createdAt: job.createdAt,
    completedAt: (job.status === 'done' || job.status === 'failed') ? job.updatedAt : null,
  });
}

function publicJob(job) {
  return {
    id: job.id,
    userId: job.userId,
    status: job.status,
    progress: job.progress,
    error: job.error,
    title: job.title,
    durationSeconds: job.durationSeconds,
    backend: job.backend,
    cost: job.cost,
    costKopecks: job.cost?.cost_kopecks ?? null,
    holdId: job.holdId,
    billingEnabled: job.billingEnabled,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

async function runLongform(job) {
  const wav = join(job.dir, 'audio.wav');
  const resultPath = join(job.dir, 'result.json');
  const progressPath = join(job.dir, 'progress.json');
  job.status = 'running';
  job.progress = 0.05;
  job.updatedAt = new Date().toISOString();
  await persistLocal(job);
  await persistClickHouse(job).catch((err) => console.error('CH persist (running):', err.message));

  const args = [
    longformScript,
    '--audio', wav,
    '--backend', backendEnv(),
    '--json-out', resultPath,
    '--progress-out', progressPath,
  ];

  await new Promise((resolve) => {
    const child = spawn(pythonBin(), args, {
      cwd: workerRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const poll = setInterval(async () => {
      try {
        if (!existsSync(progressPath)) return;
        const progress = JSON.parse(await readFile(progressPath, 'utf8'));
        if (typeof progress.progress === 'number') job.progress = progress.progress;
        if (progress.backend) job.backend = progress.backend;
        job.updatedAt = new Date().toISOString();
        await persistLocal(job);
      } catch { /* ignore partial JSON */ }
    }, 400);

    child.on('close', async (code) => {
      clearInterval(poll);
      try {
        if (code !== 0 || !existsSync(resultPath)) {
          job.status = 'failed';
          job.error = stderr.trim() || `Транскрибация завершилась с кодом ${code}`;
          job.progress = 1;
          await releaseHoldForJob({ userId: job.userId, jobId: job.id }).catch(() => {});
          await persistClickHouse(job).catch((err) => console.error('CH persist (failed):', err.message));
        } else {
          const result = JSON.parse(await readFile(resultPath, 'utf8'));
          if (result.status === 'failed') {
            job.status = 'failed';
            job.error = result.error || 'Ошибка распознавания';
            await releaseHoldForJob({ userId: job.userId, jobId: job.id }).catch(() => {});
            await persistClickHouse(job).catch((err) => console.error('CH persist (failed):', err.message));
          } else {
            job.status = 'done';
            job.progress = 1;
            job.backend = result.backend || job.backend;
            job.result = result;
            await writeFile(join(job.dir, 'result.txt'), `${result.text}\n`, 'utf8');
            await writeFile(join(job.dir, 'result.srt'), result.srt || '', 'utf8');
            await writeFile(join(job.dir, 'result.vtt'), result.vtt || '', 'utf8');
            await captureHoldForJob({ userId: job.userId, jobId: job.id }).catch(() => {});
            await persistClickHouse(job, {
              text: result.text,
              segments: result.segments,
              srt: result.srt,
              vtt: result.vtt,
            }).catch((err) => console.error('CH persist (done):', err.message));
          }
        }
      } catch (error) {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Не удалось прочитать результат';
        await releaseHoldForJob({ userId: job.userId, jobId: job.id }).catch(() => {});
        await persistClickHouse(job).catch((err) => console.error('CH persist (error):', err.message));
      }
      job.updatedAt = new Date().toISOString();
      await persistLocal(job);
      resolve();
    });
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} mediaRoot
 * @param {{ title?: string, userId: string }} opts
 */
export async function createJobFromUpload(req, mediaRoot, { title, userId } = {}) {
  if (!userId) throw new MediaError('Требуется авторизация.');
  await mkdir(mediaRoot, { recursive: true });
  const dir = await mkdtemp(join(mediaRoot, 'asr-'));
  const id = randomUUID();
  const input = join(dir, 'source.media');
  const output = join(dir, 'audio.wav');
  let size = 0;
  const limit = new Transform({
    transform(chunk, enc, cb) {
      size += chunk.length;
      cb(size > 1024 ** 3 ? new MediaError('Максимальный размер — 1 ГБ.') : null, chunk);
    },
  });
  await pipeline(req, limit, createWriteStream(input, { flags: 'wx' }));
  if (!size) throw new MediaError('Файл пуст.');
  const extracted = await extractAudio(input, output);
  const cost = costSnapshotFromSeconds(extracted.seconds);
  let holdId = null;
  try {
    const reserved = await reserveForJob({
      userId,
      jobId: id,
      durationSeconds: extracted.seconds,
      idempotencyKey: `hold:job:${id}`,
    });
    holdId = reserved.hold?.id || null;
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (error && error.code === 'INSUFFICIENT_FUNDS') {
      const err = new MediaError(
        `Недостаточно токенов на балансе. Нужно ${(error.costKopecks / 100).toFixed(2).replace('.', ',')} ток., доступно ${(error.availableKopecks / 100).toFixed(2).replace('.', ',')} ток. (1 токен = 1 ₽).`,
      );
      err.code = 'INSUFFICIENT_FUNDS';
      throw err;
    }
    throw error;
  }
  const job = {
    id,
    dir,
    userId,
    status: 'queued',
    progress: 0,
    error: null,
    title: title || 'Запись',
    durationSeconds: extracted.seconds,
    backend: backendEnv(),
    cost,
    holdId,
    billingEnabled: billingEnabled(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
  };
  jobs.set(id, job);
  await persistLocal(job);
  await persistClickHouse(job).catch((err) => console.error('CH persist (queued):', err.message));
  setImmediate(() => {
    runLongform(job).catch(async (error) => {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Сбой worker';
      job.updatedAt = new Date().toISOString();
      await releaseHoldForJob({ userId: job.userId, jobId: job.id }).catch(() => {});
      await persistLocal(job);
      await persistClickHouse(job).catch((err) => console.error('CH persist (crash):', err.message));
    });
  });
  return publicJob(job);
}

/**
 * In-memory job — only for owner.
 */
export function getJob(id, { userId } = {}) {
  const job = jobs.get(id);
  if (!job) return null;
  if (userId && job.userId !== userId) return null;
  return publicJob(job);
}

export async function readJobArtifact(id, kind, { userId } = {}) {
  const job = jobs.get(id);
  if (job) {
    if (userId && job.userId !== userId) return null;
    if (job.status !== 'done') return { pending: true, job: publicJob(job) };
    const files = {
      json: { file: 'result.json', type: 'application/json; charset=utf-8' },
      txt: { file: 'result.txt', type: 'text/plain; charset=utf-8' },
      srt: { file: 'result.srt', type: 'application/x-subrip; charset=utf-8' },
      vtt: { file: 'result.vtt', type: 'text/vtt; charset=utf-8' },
    };
    const meta = files[kind];
    if (!meta) return null;
    const body = await readFile(join(job.dir, meta.file), 'utf8');
    return { contentType: meta.type, body, job: publicJob(job) };
  }

  // Fall back to ClickHouse history (survives process restart).
  if (!userId) return null;
  const row = await getTranscriptForUser(userId, id);
  if (!row || row.status !== 'done') {
    if (row) return { pending: true, job: {
      id: row.id,
      userId: row.userId,
      status: row.status,
      progress: row.status === 'done' ? 1 : 0,
      error: row.error,
      title: row.title,
      durationSeconds: row.durationSeconds,
      backend: row.backend,
      costKopecks: row.costKopecks,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } };
    return null;
  }
  const bodies = {
    json: JSON.stringify({
      text: row.text,
      segments: row.segments,
      srt: row.srt,
      vtt: row.vtt,
      status: 'done',
      backend: row.backend,
    }, null, 2),
    txt: `${row.text}\n`,
    srt: row.srt || '',
    vtt: row.vtt || '',
  };
  const types = {
    json: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    srt: 'application/x-subrip; charset=utf-8',
    vtt: 'text/vtt; charset=utf-8',
  };
  if (!(kind in bodies)) return null;
  return {
    contentType: types[kind],
    body: bodies[kind],
    job: {
      id: row.id,
      userId: row.userId,
      status: row.status,
      progress: 1,
      error: row.error,
      title: row.title,
      durationSeconds: row.durationSeconds,
      backend: row.backend,
      costKopecks: row.costKopecks,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  };
}

/**
 * Cabinet list: active in-memory jobs + ClickHouse history for this user only.
 */
export async function listJobsForUser(userId, { limit = 50 } = {}) {
  const active = [...jobs.values()]
    .filter((j) => j.userId === userId)
    .map(publicJob);

  let history = [];
  if (clickhouseConfigured()) {
    history = await listTranscriptsForUser(userId, { limit });
  }

  const byId = new Map();
  for (const row of history) {
    byId.set(row.id, {
      id: row.id,
      userId: row.userId,
      status: row.status,
      progress: row.status === 'done' ? 1 : (row.status === 'failed' ? 1 : 0),
      error: row.error,
      title: row.title,
      durationSeconds: row.durationSeconds,
      backend: row.backend,
      costKopecks: row.costKopecks,
      costTokens: row.costTokens,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      textPreview: row.text ? String(row.text).slice(0, 160) : '',
    });
  }
  // In-memory wins for fresher progress.
  for (const job of active) {
    byId.set(job.id, { ...job, textPreview: '' });
  }

  return [...byId.values()]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

export async function getJobForUser(userId, jobId) {
  const mem = getJob(jobId, { userId });
  if (mem) return mem;
  if (!clickhouseConfigured()) return null;
  const row = await getTranscriptForUser(userId, jobId);
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    progress: row.status === 'done' ? 1 : (row.status === 'failed' ? 1 : 0),
    error: row.error,
    title: row.title,
    durationSeconds: row.durationSeconds,
    backend: row.backend,
    costKopecks: row.costKopecks,
    costTokens: row.costTokens,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    text: row.text,
    segments: row.segments,
  };
}

export async function cleanupJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  await rm(job.dir, { recursive: true, force: true }).catch(() => {});
}
