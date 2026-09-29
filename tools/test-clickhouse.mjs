/**
 * ClickHouse transcript insert / list-by-user / cross-user isolation.
 * Requires ClickHouse at CLICKHOUSE_URL (compose service or local).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createClickHouseClient, migrateClickHouse, pingClickHouse, clickhouseConfigured,
} from './clickhouse/client.mjs';
import {
  upsertTranscript, listTranscriptsForUser, getTranscriptForUser,
} from './clickhouse/transcripts.mjs';

if (!clickhouseConfigured()) {
  console.error('CLICKHOUSE_ENABLED=false — cannot run transcript store tests');
  process.exit(1);
}

const url = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123';
const admin = createClickHouseClient({ url, database: 'default' });

async function waitReady(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    const ping = await pingClickHouse(admin);
    if (ping.ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`ClickHouse not reachable at ${url}`);
}

try {
  await waitReady();
  await migrateClickHouse(admin);

  // Point shared client at same URL with gorizont DB
  process.env.CLICKHOUSE_URL = url;
  const { closeSharedClient } = await import('./clickhouse/client.mjs');
  await closeSharedClient();

  const userA = randomUUID();
  const userB = randomUUID();
  const jobA = randomUUID();
  const jobB = randomUUID();

  await upsertTranscript({
    jobId: jobA,
    userId: userA,
    title: 'Запись Алисы',
    status: 'done',
    text: 'Привет из ClickHouse',
    segments: [{ start: 0, end: 1.5, text: 'Привет из ClickHouse' }],
    srt: '1\n00:00:00,000 --> 00:00:01,500\nПривет из ClickHouse\n',
    vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nПривет из ClickHouse\n',
    durationSeconds: 1.5,
    backend: 'mock',
    costKopecks: 1,
  });

  await upsertTranscript({
    jobId: jobB,
    userId: userB,
    title: 'Запись Бориса',
    status: 'done',
    text: 'Чужой текст',
    segments: [],
    durationSeconds: 10,
    backend: 'mock',
    costKopecks: 7,
  });

  const listA = await listTranscriptsForUser(userA);
  assert.ok(listA.some((r) => r.id === jobA));
  assert.ok(!listA.some((r) => r.id === jobB), 'user A must not see user B jobs');

  const got = await getTranscriptForUser(userA, jobA);
  assert.equal(got.text, 'Привет из ClickHouse');
  assert.equal(got.costKopecks, 1);
  assert.equal(got.costTokens, 0.01);
  assert.ok(Array.isArray(got.segments));
  assert.equal(got.segments[0].text, 'Привет из ClickHouse');

  const stolen = await getTranscriptForUser(userA, jobB);
  assert.equal(stolen, null, 'cross-user get must return null');

  const listB = await listTranscriptsForUser(userB);
  assert.equal(listB.length >= 1, true);
  assert.ok(listB.every((r) => r.userId === userB));

  console.log('PASS ClickHouse insert/list by user + cross-user isolation');
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  await admin.close().catch(() => {});
}
