
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

// 数据文件位置由 DATABASE_PATH 决定；迁移按文件名顺序应用且只执行一次
function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function migrate(database, migrationsDir = path.join(process.cwd(), "migrations")) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version)
  );
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    database.exec("BEGIN");
    try {
      database.exec(sql);
      // 001 在文件内自行登记，OR IGNORE 可兼容新旧两种写法
      database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(version);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

function resolveDatabase(
  databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3"),
  migrationsDir
) {
  const database = openDatabase(databasePath);
  migrate(database, migrationsDir);
  return database;
}

module.exports = { openDatabase, migrate, resolveDatabase };
