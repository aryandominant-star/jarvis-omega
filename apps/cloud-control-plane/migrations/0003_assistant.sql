-- Cloud assistant: a dashboard-native AI that runs in the control plane, so you can talk to JARVIS
-- (and dispatch work to your PCs) even when no device is online. The API key is stored encrypted.
CREATE TABLE IF NOT EXISTS assistant_config (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  model TEXT,
  api_key_enc TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,            -- 'user' | 'assistant'
  content TEXT NOT NULL,
  actions TEXT,                 -- JSON: tasks the assistant dispatched, for the UI
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asst_msg_user ON assistant_messages(user_id, id);
