-- Горизонт: transcripts + job history in ClickHouse (primary store).
CREATE DATABASE IF NOT EXISTS gorizont;

CREATE TABLE IF NOT EXISTS gorizont.transcripts
(
  job_id UUID,
  user_id UUID,
  title String,
  status LowCardinality(String),
  text String DEFAULT '',
  segments_json String DEFAULT '[]',
  srt String DEFAULT '',
  vtt String DEFAULT '',
  duration_seconds Float64 DEFAULT 0,
  backend LowCardinality(String) DEFAULT '',
  cost_kopecks UInt64 DEFAULT 0,
  cost_tokens Float64 DEFAULT 0,
  error String DEFAULT '',
  created_at DateTime64(3, 'UTC'),
  updated_at DateTime64(3, 'UTC'),
  completed_at Nullable(DateTime64(3, 'UTC'))
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (user_id, job_id);
