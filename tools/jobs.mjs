// Disk-backed transcription jobs for local Горизонт preview.
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
import { billingEnabled, demoUserId } from './billing/store.mjs';

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
    note: backend === 'mock'
      ? 'Mock ASR (нет GPU/GigaAM в этой среде). Chunking как в VRainD/gigaamui.'
      : 'Long-form ASR (движок VRainD/gigaamui) через worker/longform_transcribe.py',
  };
}

async function persist(job) {
  await writeFile(join(job.dir, 'meta.json'), JSON.stringify({
    id: job.id,
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

function publicJob(job) {
  return {
    id: job.id,
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
  await persist(job);

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
        await persist(job);
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
        } else {
          const result = JSON.parse(await readFile(resultPath, 'utf8'));
          if (result.status === 'failed') {
            job.status = 'failed';
            job.error = result.error || 'Ошибка распознавания';
            await releaseHoldForJob({ userId: job.userId, jobId: job.id }).catch(() => {});
          } else {
            job.status = 'done';
            job.progress = 1;
            job.backend = result.backend || job.backend;
            job.result = result;
            await writeFile(join(job.dir, 'result.txt'), `${result.text}\n`, 'utf8');
            await writeFile(join(job.dir, 'result.srt'), result.srt || '', 'utf8');
            await writeFile(join(job.dir, 'result.vtt'), result.vtt || '', 'utf8');
            await captureHoldForJob({ userId: job.userId, jobId: job.id }).catch(() => {});
          }
        }
      } catch (error) {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Не удалось прочитать результат';
        await releaseHoldForJob({ userId: job.userId, jobId: job.id }).catch(() => {});
      }
      job.updatedAt = new Date().toISOString();
      await persist(job);
      resolve();
    });
  });
}

export async function createJobFromUpload(req, mediaRoot, { title } = {}) {
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
  const userId = demoUserId();
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
  await persist(job);
  setImmediate(() => {
    runLongform(job).catch(async (error) => {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Сбой worker';
      job.updatedAt = new Date().toISOString();
      await releaseHoldForJob({ userId: job.userId, jobId: job.id }).catch(() => {});
      await persist(job);
    });
  });
  return publicJob(job);
}

export function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

export async function readJobArtifact(id, kind) {
  const job = jobs.get(id);
  if (!job) return null;
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

export async function cleanupJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  await rm(job.dir, { recursive: true, force: true }).catch(() => {});
}
