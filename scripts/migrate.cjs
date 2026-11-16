const fs = require('node:fs/promises');
const path = require('node:path');
const { run, transaction, withDatabase } = require('./database.cjs');

const directory = path.join(__dirname, '..', 'migrations');

run(() => withDatabase((client) => transaction(client, async () => {
  await client.query('SELECT pg_advisory_xact_lock(416092572)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY)');
  const applied = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map(
    (row) => row.filename,
  ));
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  for (const filename of files) {
    if (applied.has(filename)) continue;
    await client.query(await fs.readFile(path.join(directory, filename), 'utf8'));
    await client.query('INSERT INTO schema_migrations VALUES ($1)', [filename]);
    console.log('Applied ' + filename);
  }
})));
