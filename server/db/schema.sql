-- CodeReviewSystem 数据库脚本 (PostgreSQL)
-- 用法: psql -h 127.0.0.1 -U postgres -d codereview -f schema.sql

-- 管理员
CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,          -- bcrypt
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 客户端授权 token
CREATE TABLE IF NOT EXISTS client_tokens (
  id         SERIAL PRIMARY KEY,
  token      TEXT UNIQUE NOT NULL,
  machine    TEXT,
  enabled    BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_seen  TIMESTAMPTZ
);

-- 仓库注册表(服务端视角: 定时任务用)
CREATE TABLE IF NOT EXISTS repos (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  git_url     TEXT NOT NULL,
  project     TEXT NOT NULL,
  token       TEXT,
  git_type    TEXT DEFAULT 'gitea',
  local_path  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 审查记录(客户端 + 定时任务统一入口)
CREATE TABLE IF NOT EXISTS reviews (
  id            SERIAL PRIMARY KEY,
  repo_id       INTEGER REFERENCES repos(id),
  repo_name     TEXT NOT NULL,
  source        TEXT NOT NULL,          -- client | scheduler
  target_type   TEXT NOT NULL,          -- mr | commit
  target_id     TEXT NOT NULL,
  target_title  TEXT,
  src_branch    TEXT,
  dst_branch    TEXT,
  status        TEXT DEFAULT 'done',
  model         TEXT,
  duration_ms   INTEGER,
  input_tokens  BIGINT DEFAULT 0,
  output_tokens BIGINT DEFAULT 0,
  request_count INTEGER DEFAULT 0,
  error_msg     TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 问题明细
CREATE TABLE IF NOT EXISTS review_issues (
  id          SERIAL PRIMARY KEY,
  review_id   INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  start_line  INTEGER,
  end_line    INTEGER,
  severity    TEXT NOT NULL,
  category    TEXT,
  content     TEXT NOT NULL,
  suggestion  TEXT,
  fix_status  TEXT DEFAULT 'none',
  fix_run_id  INTEGER,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_issues_review   ON review_issues(review_id);
CREATE INDEX IF NOT EXISTS idx_issues_severity ON review_issues(severity);
CREATE INDEX IF NOT EXISTS idx_issues_path     ON review_issues(path);
CREATE INDEX IF NOT EXISTS idx_issues_created  ON review_issues(created_at);

-- 自动修复运行
CREATE TABLE IF NOT EXISTS fix_runs (
  id           SERIAL PRIMARY KEY,
  review_id    INTEGER NOT NULL REFERENCES reviews(id),
  repo_name    TEXT NOT NULL,
  base_branch  TEXT NOT NULL,
  fix_branch   TEXT NOT NULL,
  issue_count  INTEGER DEFAULT 0,
  commit_count INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'created',
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- 修复 commit 明细
CREATE TABLE IF NOT EXISTS fix_commits (
  id          SERIAL PRIMARY KEY,
  fix_run_id  INTEGER NOT NULL REFERENCES fix_runs(id) ON DELETE CASCADE,
  sha         TEXT,
  message     TEXT,
  issue_id    INTEGER,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 用量明细
CREATE TABLE IF NOT EXISTS usage_logs (
  id             SERIAL PRIMARY KEY,
  review_id      INTEGER REFERENCES reviews(id),
  source         TEXT DEFAULT 'client',
  model          TEXT NOT NULL,
  input_tokens   BIGINT NOT NULL DEFAULT 0,
  output_tokens  BIGINT NOT NULL DEFAULT 0,
  request_count  INTEGER NOT NULL DEFAULT 1,
  cost_estimate  NUMERIC(10,4) DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_time  ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_logs(model);

-- 定时任务
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  repo_id       INTEGER NOT NULL REFERENCES repos(id),
  mode          TEXT NOT NULL,          -- open_mrs | branch | commit
  branch        TEXT,
  cron          TEXT NOT NULL,
  enabled       BOOLEAN DEFAULT true,
  post_to_git   BOOLEAN DEFAULT false,
  model         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 定时任务执行历史
CREATE TABLE IF NOT EXISTS task_runs (
  id              SERIAL PRIMARY KEY,
  task_id         INTEGER NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT DEFAULT 'running',
  reviews_created INTEGER DEFAULT 0,
  error_msg       TEXT
);

-- LLM 配置(单行)
CREATE TABLE IF NOT EXISTS llm_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  provider   TEXT NOT NULL DEFAULT 'opencode',
  base_url   TEXT,
  api_key    TEXT,
  model      TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
  price_in   NUMERIC(10,6) DEFAULT 0,
  price_out  NUMERIC(10,6) DEFAULT 0
);
