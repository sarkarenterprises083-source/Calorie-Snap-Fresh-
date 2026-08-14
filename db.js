const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // e.g. postgres://user:pass@host:5432/dbname
});

module.exports = pool;
