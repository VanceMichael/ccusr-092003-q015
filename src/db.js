"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const migrationsDir = path.join(process.cwd(), "migrations");

// 按文件名顺序执行尚未记录的迁移。
function runMigrations(db, dir = migrationsDir) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const version = path.basename(file, ".sql");
    if (applied.has(version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    applied.add(version);
  }
}

function openDatabase(databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3")) {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  runMigrations(db);
  return db;
}

module.exports = { openDatabase, runMigrations };
