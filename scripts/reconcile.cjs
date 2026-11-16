const { run, withDatabase } = require('./database.cjs');

run(() => withDatabase(async (client) => {
  const { rows: [result] } = await client.query(`
    SELECT coalesce(sum(totals.entries), 0)::text AS entries,
           count(wallets.user_id)::text AS wallets,
           count(*) FILTER (
             WHERE totals.balance IS DISTINCT FROM wallets.balance
           )::text AS mismatches
    FROM wallets
    FULL JOIN (
      SELECT user_id, count(*) AS entries,
             sum(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS balance
      FROM ledger
      GROUP BY user_id
    ) AS totals USING (user_id)
  `);
  console.log(JSON.stringify(result));
  if (result.mismatches !== '0') process.exitCode = 1;
}));
