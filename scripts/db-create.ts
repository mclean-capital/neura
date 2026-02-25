import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

// Parse the target database name from the connection string
const url = new URL(databaseUrl);
const dbName = url.pathname.slice(1); // remove leading "/"

if (!dbName) {
  console.error("DATABASE_URL must include a database name");
  process.exit(1);
}

// Connect to the default "postgres" database to run CREATE DATABASE
url.pathname = "/postgres";
const client = new pg.Client({ connectionString: url.toString() });

try {
  await client.connect();
  await client.query(`CREATE DATABASE "${dbName}"`);
  console.log(`Database "${dbName}" created`);
} catch (err: unknown) {
  if (err instanceof Error && "code" in err && err.code === "42P04") {
    console.log(`Database "${dbName}" already exists`);
  } else {
    console.error("Failed to create database:", err);
    process.exit(1);
  }
} finally {
  await client.end();
}
