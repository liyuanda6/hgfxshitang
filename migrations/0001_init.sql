-- 班级就餐统计系统 —— D1 初始化 Schema
-- 通过 `wrangler d1 migrations apply <db> --remote`（及 --local）执行。

CREATE TABLE IF NOT EXISTS classes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  grade       INTEGER,
  cls         INTEGER,
  created_at  INTEGER
);

CREATE TABLE IF NOT EXISTS students (
  id          TEXT PRIMARY KEY,
  class_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  id_card     TEXT,
  created_at  INTEGER
);

CREATE TABLE IF NOT EXISTS days (
  class_id    TEXT NOT NULL,
  month       TEXT NOT NULL,
  days        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (class_id, month)
);

CREATE TABLE IF NOT EXISTS records (
  student_id  TEXT NOT NULL,
  month       TEXT NOT NULL,
  standard    TEXT,
  remark      TEXT,
  deduction   REAL DEFAULT 0,
  PRIMARY KEY (student_id, month)
);

CREATE TABLE IF NOT EXISTS meta (
  key         TEXT PRIMARY KEY,
  value       TEXT
);

CREATE INDEX IF NOT EXISTS idx_students_class ON students (class_id);
CREATE INDEX IF NOT EXISTS idx_records_month ON records (month);
CREATE INDEX IF NOT EXISTS idx_days_month ON days (month);
