const { run, withDatabase } = require('./database.cjs');
const { creditSql, debitSql, balanceSql } = require('../dist/queries.js');

run(() => withDatabase(async (client) => {
  const userId = process.env.EXPLAIN_USER ?? 'seed-1';
  for (const [label, sql, args] of [
    ['credit', creditSql, [userId, 100]],
    ['debit', debitSql, [userId, 40]],
    ['get_balance', balanceSql, [userId]],
  ]) {
    const result = await client.query('EXPLAIN (COSTS OFF) ' + sql, args);
    console.log('[' + label + ']');
    for (const row of result.rows) console.log(row['QUERY PLAN']);
  }
}));
