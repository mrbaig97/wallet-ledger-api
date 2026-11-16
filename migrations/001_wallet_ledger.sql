CREATE TABLE wallets (
  user_id varchar(64) COLLATE "C" PRIMARY KEY CHECK (user_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  balance bigint NOT NULL CHECK (balance >= 0)
) WITH (fillfactor = 80);

CREATE TABLE ledger (
  id bigint GENERATED ALWAYS AS IDENTITY (CACHE 64) PRIMARY KEY,
  user_id varchar(64) COLLATE "C" NOT NULL REFERENCES wallets (user_id),
  type text NOT NULL CHECK (type IN ('credit', 'debit')),
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 1000000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ledger_user_id_idx ON ledger (user_id);

CREATE FUNCTION reject_ledger_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only';
END;
$$;

CREATE TRIGGER ledger_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger
FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_change();
