#!/usr/bin/env node
/** Apply ClickHouse schema (CREATE DATABASE / TABLE IF NOT EXISTS). */
import { createClickHouseClient, migrateClickHouse, closeSharedClient } from './client.mjs';

const client = createClickHouseClient({ database: 'default' });
try {
  const result = await migrateClickHouse(client);
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  await client.close();
  await closeSharedClient();
}
