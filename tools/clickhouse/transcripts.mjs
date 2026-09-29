/**
 * Transcript repository — ClickHouse is the primary store for jobs/results.
 * Ownership is enforced by user_id on every read.
 */
import { getSharedClient, migrateClickHouse, clickhouseConfigured } from './client.mjs';

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  // ClickHouse DateTime64 often returns 'YYYY-MM-DD HH:MM:SS.mmm'
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) return `${s.replace(' ', 'T')}Z`;
  return s;
}

function rowToPublic(row) {
  return {
    id: row.job_id,
    jobId: row.job_id,
    userId: row.user_id,
    title: row.title,
    status: row.status,
    text: row.text || '',
    segments: (() => {
      try { return JSON.parse(row.segments_json || '[]'); } catch { return []; }
    })(),
    srt: row.srt || '',
    vtt: row.vtt || '',
    durationSeconds: Number(row.duration_seconds) || 0,
    backend: row.backend || '',
    costKopecks: Number(row.cost_kopecks) || 0,
    costTokens: Number(row.cost_tokens) || (Number(row.cost_kopecks) || 0) / 100,
    error: row.error || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: toIso(row.completed_at),
  };
}

function costTokensFromKopecks(kopecks) {
  return (Number(kopecks) || 0) / 100;
}

/**
 * Upsert transcript row (ReplacingMergeTree on updated_at).
 */
export async function upsertTranscript(input) {
  if (!clickhouseConfigured()) {
    const err = new Error('ClickHouse отключён — транскрипты не сохраняются.');
    err.code = 'CLICKHOUSE_DISABLED';
    throw err;
  }
  const client = getSharedClient();
  const now = new Date();
  const costKopecks = Number(input.costKopecks) || 0;
  const row = {
    job_id: input.jobId,
    user_id: input.userId,
    title: String(input.title || 'Запись'),
    status: String(input.status || 'queued'),
    text: String(input.text || ''),
    segments_json: typeof input.segmentsJson === 'string'
      ? input.segmentsJson
      : JSON.stringify(input.segments || []),
    srt: String(input.srt || ''),
    vtt: String(input.vtt || ''),
    duration_seconds: Number(input.durationSeconds) || 0,
    backend: String(input.backend || ''),
    cost_kopecks: costKopecks,
    cost_tokens: costTokensFromKopecks(costKopecks),
    error: String(input.error || ''),
    created_at: input.createdAt ? new Date(input.createdAt).toISOString().replace('T', ' ').replace('Z', '') : now.toISOString().replace('T', ' ').replace('Z', ''),
    updated_at: now.toISOString().replace('T', ' ').replace('Z', ''),
    completed_at: input.completedAt
      ? new Date(input.completedAt).toISOString().replace('T', ' ').replace('Z', '')
      : (input.status === 'done' || input.status === 'failed'
        ? now.toISOString().replace('T', ' ').replace('Z', '')
        : null),
  };

  await client.insert({
    table: 'transcripts',
    values: [row],
    format: 'JSONEachRow',
  });
  return rowToPublic({
    ...row,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  });
}

export async function listTranscriptsForUser(userId, { limit = 50, offset = 0 } = {}) {
  if (!clickhouseConfigured()) return [];
  const client = getSharedClient();
  const result = await client.query({
    query: `
      SELECT *
      FROM transcripts FINAL
      WHERE user_id = {userId:UUID}
      ORDER BY created_at DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    query_params: { userId, limit, offset },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  return rows.map(rowToPublic);
}

export async function getTranscriptForUser(userId, jobId) {
  if (!clickhouseConfigured()) return null;
  const client = getSharedClient();
  const result = await client.query({
    query: `
      SELECT *
      FROM transcripts FINAL
      WHERE user_id = {userId:UUID} AND job_id = {jobId:UUID}
      LIMIT 1
    `,
    query_params: { userId, jobId },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  if (!rows.length) return null;
  return rowToPublic(rows[0]);
}

/** Cross-user read must return null — used in isolation tests. */
export async function getTranscriptByJobId(jobId) {
  if (!clickhouseConfigured()) return null;
  const client = getSharedClient();
  const result = await client.query({
    query: `
      SELECT *
      FROM transcripts FINAL
      WHERE job_id = {jobId:UUID}
      LIMIT 1
    `,
    query_params: { jobId },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  if (!rows.length) return null;
  return rowToPublic(rows[0]);
}

export async function ensureTranscriptSchema() {
  if (!clickhouseConfigured()) return { skipped: true };
  return migrateClickHouse();
}
