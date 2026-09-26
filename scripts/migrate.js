
const path = require("node:path");
const { openDatabase } = require("../src/db");

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
const db = openDatabase(databasePath);
const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version);
db.close();
console.log(`数据库迁移完成：${databasePath}\n已应用版本：${versions.join(", ")}`);
