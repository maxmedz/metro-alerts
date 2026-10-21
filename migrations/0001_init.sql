CREATE TABLE IF NOT EXISTS line_state (
  line TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  status_at TEXT NOT NULL
);
