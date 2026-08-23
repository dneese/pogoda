// Одноразовий скрипт міграції: застосовує severe_weather.sql напряму
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const sql = fs.readFileSync('supabase/migrations/20260823120000_severe_weather.sql', 'utf8');

const stmts = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  for (const s of stmts) {
    try {
      await pool.query(s);
      console.log('OK:', s.replace(/\s+/g, ' ').slice(0, 70));
    } catch (e) {
      console.error('FAIL:', e.message);
      console.error('>>', s.slice(0, 120));
      process.exitCode = 1;
    }
  }
  const { rows } = await pool.query(
    'SELECT string_agg(k::text, ', ') AS vals FROM (SELECT unnest(enum_range(NULL::alert_kind_enum)) AS k) t'
  );
  console.log('ENUM values:', rows[0].vals);
  const t = await pool.query("SELECT to_regclass('user_settings') AS t");
  console.log('user_settings:', t.rows[0].t);
  await pool.end();
})();
