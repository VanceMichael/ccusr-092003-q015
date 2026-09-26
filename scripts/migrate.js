
const path = require("node:path");
const { resolveDatabase } = require("../src/db");

const databasePath =
  process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
const database = resolveDatabase(databasePath);
database.close();
console.log(`数据库迁移完成：${databasePath}`);
