const { performance } = require('node:perf_hooks');
const { run, transaction, withDatabase } = require('./database.cjs');

const userCount = 100_000;
const hotUsers = 4;
const hotRows = 125_000;
const minRows = hotUsers * hotRows + userCount - hotUsers;

run(async () => {
  const rows = Number(process.env.SEED_ROWS ?? 10_000_000);
  if (!Number.isSafeInteger(rows) || rows < minRows || rows > 2_147_483_647) {
    throw new Error('SEED_ROWS must be an integer between ' + minRows + ' and 2147483647.');
  }

  const start = performance.now();
  await withDatabase(async (client) => {
    await transaction(client, async () => {
      await client.query('LOCK TABLE wallets IN SHARE ROW EXCLUSIVE MODE');
      if ((await client.query('SELECT 1 FROM wallets LIMIT 1')).rowCount) {
        throw new Error('Seed requires an empty database. Use a fresh database or Compose project.');
      }

      const remaining = rows - hotUsers * hotRows;
      const coldUsers = userCount - hotUsers;
      await client.query(`
        CREATE TEMP TABLE seed_counts (wallet_number integer, entry_count integer) ON COMMIT DROP
      `);
      await client.query(`
        INSERT INTO seed_counts
        SELECT n, CASE WHEN n <= $1 THEN $2
                       ELSE $3 + (n <= $1 + $4)::integer END
        FROM generate_series(1, $5) AS n
      `, [hotUsers, hotRows, Math.floor(remaining / coldUsers), remaining % coldUsers, userCount]);

      await client.query(`
        INSERT INTO wallets (user_id, balance)
        SELECT 'seed-' || wallet_number, (entry_count / 2)::bigint * 60 + (entry_count % 2) * 100
        FROM seed_counts ORDER BY wallet_number
      `);

      // Small statements bound the foreign-key trigger queue while one outer
      // transaction keeps the balance table and ledger atomic.
      const batchUsers = 1000;
      for (let first = 1; first <= userCount; first += batchUsers) {
        await client.query(`
          INSERT INTO ledger (user_id, type, amount)
          SELECT 'seed-' || wallet_number,
                 CASE WHEN n % 2 = 1 THEN 'credit' ELSE 'debit' END,
                 CASE WHEN n % 2 = 1 THEN 100 ELSE 40 END
          FROM seed_counts
          CROSS JOIN LATERAL generate_series(1, entry_count) AS n
          WHERE wallet_number >= $1 AND wallet_number < $2
          ORDER BY wallet_number, n
        `, [first, first + batchUsers]);
      }
    });
    await client.query('ANALYZE wallets; ANALYZE ledger');
  });
  console.log('Seeded ' + rows + ' rows across ' + userCount + ' users in ' +
    ((performance.now() - start) / 1000).toFixed(2) + ' s.');
});
