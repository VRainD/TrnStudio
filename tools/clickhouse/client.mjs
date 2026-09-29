/**
 * ClickHouse client for Горизонт transcript storage.
 */
import { createClient } from '@clickhouse/client';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:8123';

export function clickhouseConfigured() {
  const v = String(process.env.CLICKHOUSE_ENABLED || 'true').toLowerCase();
  if (v === 'false' || v === '0') return false;
  return true;
}

export function clickhouseUrl() {
  return process.env.CLICKHOUSE_URL || DEFAULT_URL;
}

export function createClickHouseClient(options = {}) {
  return createClient({
    url: options.url || clickhouseUrl(),
    username: options.username || process.env.CLICKHOUSE_USER || 'default',
    password: options.password || process.env.CLICKHOUSE_PASSWORD || '',
    database: options.database || process.env.CLICKHOUSE_DATABASE || 'gorizont',
    clickhouse_settings: {
      date_time_input_format: 'best_effort',
    },
    request_timeout: options.requestTimeout || 30_000,
  });
}

let shared = null;

export function getSharedClient() {
  if (!clickhouseConfigured()) return null;
  if (!shared) shared = createClickHouseClient();
  return shared;
}

export async function closeSharedClient() {
  if (shared) {
    await shared.close().catch(() => {});
    shared = null;
  }
}

/**
 * Apply schema.sql (idempotent CREATE IF NOT EXISTS).
 */
export async function migrateClickHouse(client = getSharedClient()) {
  if (!client) throw new Error('ClickHouse is not configured');
  const schemaPath = fileURLToPath(new URL('../../clickhouse/schema.sql', import.meta.url));
  const sql = await readFile(schemaPath, 'utf8');
  // Split on semicolons; skip empty / comments-only chunks.
  const statements = sql
    .split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter(Boolean);
  for (const statement of statements) {
    // CREATE DATABASE must run without default database context sometimes
    await client.command({ query: statement });
  }
  return { ok: true, statements: statements.length };
}

export async function pingClickHouse(client = getSharedClient()) {
  if (!client) return { ok: false, error: 'not configured' };
  try {
    const result = await client.ping();
    return { ok: Boolean(result?.success ?? result) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
