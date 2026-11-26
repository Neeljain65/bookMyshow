import pg from 'pg';

const adminUrl = (process.env.DATABASE_URL ?? 'postgres://postgres:neel@localhost:5432/bms').replace(
  /\/[^/]+$/,
  '/postgres',
);

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const r = await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'bms'`);
if (r.rowCount === 0) {
  await admin.query('CREATE DATABASE bms');
  console.log('created database bms');
} else {
  console.log('database bms already exists');
}
await admin.end();
