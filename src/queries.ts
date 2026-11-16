export const creditSql = `
  WITH changed AS (
    INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + EXCLUDED.balance
    RETURNING user_id, balance
  ), appended AS (
    INSERT INTO ledger (user_id, type, amount)
    SELECT user_id, 'credit', $2::integer FROM changed
  )
  SELECT balance FROM changed
`;

export const debitSql = `
  WITH changed AS (
    UPDATE wallets
    SET balance = balance - $2
    WHERE user_id = $1 AND balance >= $2
    RETURNING user_id, balance
  ), appended AS (
    INSERT INTO ledger (user_id, type, amount)
    SELECT user_id, 'debit', $2::integer FROM changed
  )
  SELECT balance, true AS wallet_exists FROM changed
  UNION ALL
  SELECT NULL, EXISTS (SELECT 1 FROM wallets WHERE user_id = $1)
  WHERE NOT EXISTS (SELECT 1 FROM changed)
`;

export const balanceSql = `SELECT balance FROM wallets WHERE user_id = $1`;
