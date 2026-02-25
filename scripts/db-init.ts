import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const schemaPath = path.join(root, "src", "db", "schema.sql");
const seedPath = path.join(root, "src", "db", "seed.sql");

const schema = fs.readFileSync(schemaPath, "utf-8");
const seed = fs.readFileSync(seedPath, "utf-8");

const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();

  console.log("Applying schema...");
  await client.query(schema);
  console.log("Schema applied");

  console.log("Applying seed data...");
  await client.query(seed);
  console.log("Seed data applied");

  console.log("Database initialized successfully");
} catch (err) {
  console.error("Failed to initialize database:", err);
  process.exit(1);
} finally {
  await client.end();
}
