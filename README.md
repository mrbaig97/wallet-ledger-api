# Wallet Ledger API

A NestJS HTTP API backed by PostgreSQL. Amounts and balances are integers in minor units.

## Start the API

Start the services with Docker and the Compose plugin.

```sh
docker compose up --build -d
```

Compose starts PostgreSQL, applies the schema migration, and exposes the API at `http://localhost:8080`. PostgreSQL data persists in a named volume. The development token defaults to `recruitment-test-token` and can be set through the `API_TOKEN` environment variable before starting Compose.

### API examples

**Credit a wallet**

```sh
curl -X POST http://localhost:8080/credit \
  -H 'Authorization: Bearer recruitment-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"u123","amount":10000}'
```

**Debit a wallet**

```sh
curl -X POST http://localhost:8080/debit \
  -H 'Authorization: Bearer recruitment-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"u123","amount":4000}'
```

**Get wallet balance**

```sh
curl http://localhost:8080/balance/u123 \
  -H 'Authorization: Bearer recruitment-test-token'
```

Each successful request returns HTTP 200 with the wallet's balance. In this example, the credit returns 10000, then the debit and lookup return:

```json
{
  "user_id": "u123",
  "balance": 6000
}
```

Credit creates a wallet on its first successful operation. IDs accept 1–64 ASCII letters, digits, underscores, and hyphens. Amounts accept JSON integers from 1 through 1,000,000,000. Extra fields are ignored.

### HTTP errors

| Status | Error code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed JSON or invalid input |
| 401 | `unauthorized` | Missing or invalid bearer token |
| 404 | `user_not_found` | Debit or balance lookup for an unknown wallet |
| 409 | `insufficient_funds` | Debit exceeds the wallet balance |

Errors return:

```json
{
  "error": "<code>",
  "message": "<text>"
}
```

Authentication runs before parsing or database queries and compares SHA-256 digests with a constant-time comparison. The service reads the token from the environment.

## Seed, inspect, and reconcile

Start a fresh Compose project or use a fresh database. The seed requires an empty wallet table. Run it before the example credit above.

```sh
docker compose exec api node scripts/seed.cjs
docker compose exec api node scripts/explain.cjs
docker compose exec api node scripts/reconcile.cjs
```

The default seed creates 10 million entries across 100,000 wallets, including four wallets with 125,000 entries each. It alternates credits of 100 and debits of 40, starting with a credit. A trailing credit accounts for odd-length histories.

SQL generates the rows in batches inside one transaction and analyzes the tables after commit. The reconciliation command compares all wallets with the ledger in one SQL snapshot and exits nonzero if it finds a discrepancy.

For a 1M comparison, use a separate fresh database or Compose project and pass `-e SEED_ROWS=1000000` to the seed command. If using two Compose projects, free port 8080 before starting the second one.

## Develop and test

Use Node.js 24 or later, pnpm 11.25.0, and a dedicated PostgreSQL test database. Set the PostgreSQL connection through the standard `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE` variables.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm test
```

The tests launch two NestJS processes, use real HTTP requests and PostgreSQL, and write wallet fixtures to the selected database.

The suite checks:

- Authentication and request validation.
- Unknown users and rejected debits.
- Concurrent debit races.
- 1,000 concurrent credits and their intermediate balances.
- Hot-wallet isolation.
- Rollback when an injected constraint rejects a ledger append.

To start the app locally after building and migrating, set `API_TOKEN` and run:

```sh
pnpm start
```

The port defaults to 8080.

## Data and concurrency

### Ledger

The ledger records one append per accepted mutation. It uses a bigint identity key, a foreign key to the wallet, checks on operation type and amount, and a server timestamp. A trigger rejects updates, deletes, and truncation. The user index supports per-wallet audits.

ID sequence caching can leave gaps and interleave ID ranges from different sessions. An ID serves as an identifier.

### Balances

The wallet primary key is the access path for current balances. PostgreSQL stores balances as bigint and the API emits exact JSON integers, including those above JavaScript's safe integer range. Consumers that need exact values at that scale need a JSON parser that preserves large integers.

Summing ledger history on each read would give hot wallets much more work per request. The stored projection keeps that aggregation off the request path.

### Atomic writes

Credit uses an upsert that adds to the existing balance under the wallet row lock. Debit uses an update whose predicate requires sufficient funds.

Under PostgreSQL's default Read Committed isolation, a contending update waits for the row and rechecks its predicate once the competing write commits. The ledger insert consumes only rows returned by the mutation, so a declined debit appends nothing.

Both writes succeed or roll back as a single SQL statement. A successful response is sent after PostgreSQL completes the statement. Later reads query the primary and see that commit or a newer one.

See [PostgreSQL transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html).

### Contention

Each process queues writes by wallet before they acquire a pool connection. This keeps a hot wallet from taking the entire local pool while PostgreSQL serializes its writes. Reads bypass that queue.

PostgreSQL handles correctness across API instances. Deadlock and serialization failures are retried with short jittered backoff. Exhausted retries return 503. Retrying an ambiguous connection failure could double-apply a write, so the service retries only SQLSTATEs that confirm PostgreSQL aborted the statement.

An explicit transaction around a lock, balance update, and ledger insert would provide the same invariant with extra database round trips. Serializable isolation would add retry pressure on hot wallets, where the invariant already fits a single locked balance row.

The wallet balance stays out of the indexes so updates that fit on the same heap page can reuse index entries. A covering balance index would add maintenance to every write.

## Load test results

Run the load test after starting the API and seeding the database.

```sh
pnpm load
```

The client defaults to `http://localhost:8080` and accepts these environment variables:

- `API_TOKEN`: bearer token for the running API.
- `API_URL`: API base URL.
- `LOAD_CONCURRENCY`: number of concurrent clients (default: 100).
- `LOAD_REQUESTS`: measured requests per scenario (default: 30,000).

The load test runs two scenarios:

1. **Mixed workload:** distributes credit, debit, and balance requests across seeded wallets.
2. **Hot-wallet workload:** directs 90% of requests to one wallet while the remaining requests target other wallets.

Each scenario performs up to 1,000 warm-up requests before its measured run. The client reports p50 and p99 latency, throughput, and unexpected responses. It exits nonzero if failures occur.

### Latest benchmark

The following results were measured locally using:

- 100 concurrent clients.
- 30,000 measured requests per scenario.
- 10 million seeded ledger entries before benchmarking.
- Node.js 24 and PostgreSQL 18.
- Windows development environment with the API, load client, and database running on the same host.

Each latency cell shows p50 / p99 in milliseconds.

#### Mixed workload

| Endpoint | p50 (ms) | p99 (ms) |
|---|---:|---:|
| Credit | 25.01 | 44.98 |
| Debit | 24.95 | 44.89 |
| Balance | 22.69 | 39.08 |

**Throughput:** 3,896 requests/second.

**Failed requests:** 0.

#### Hot-wallet workload

| Endpoint | p50 (ms) | p99 (ms) |
|---|---:|---:|
| Credit | 179.98 | 265.28 |
| Debit | 180.97 | 266.85 |
| Balance | 0.81 | 3.63 |

**Throughput:** 854 requests/second.

**Failed requests:** 0.

#### Other-wallet latency during hot-wallet workload

These measurements represent requests targeting wallets other than the heavily contended wallet.

| Endpoint | p50 (ms) | p99 (ms) |
|---|---:|---:|
| Credit | 2.42 | 8.29 |
| Debit | 3.07 | 6.67 |
| Balance | 0.81 | 3.04 |

### Benchmark observations

The hot-wallet workload increases credit and debit latency because concurrent writes targeting the same wallet contend for its balance row.

Requests targeting unrelated wallets remain responsive during this contention. This demonstrates that wallet-level write queuing prevents a single hot wallet from consuming the entire local connection pool.

Balance reads remain fast during the hot-wallet workload because they bypass the per-wallet write queue.

These are local benchmark results, not production capacity guarantees. Results include client scheduling and HTTP overhead and may vary with hardware, database configuration, and network conditions.

### Post-benchmark reconciliation

After the latest full benchmark, the reconciliation script reported:

| Metric | Result |
|---|---:|
| Ledger entries | 10,046,670 |
| Wallets | 100,001 |
| Balance mismatches | 0 |

The results confirm that wallet balances remained consistent with the ledger after the concurrent workload.

## PostgreSQL query plans

`pnpm db:explain` produced these plans against the 10M database. Each query finds the relevant wallet through the primary key. The mutation append consumes the changed row directly.

```text
[credit]
CTE Scan on changed
  CTE changed
    -> Insert on wallets
         Conflict Resolution: UPDATE
         Conflict Arbiter Indexes: wallets_pkey
         -> Result
  CTE appended
    -> Insert on ledger
         -> CTE Scan on changed changed_1

[debit]
Append
  CTE changed
    -> Update on wallets
         -> Index Scan using wallets_pkey on wallets
              Index Cond: ((user_id)::text = 'seed-1'::text)
              Filter: (balance >= '40'::bigint)
  CTE appended
    -> Insert on ledger
         -> CTE Scan on changed changed_1
  -> CTE Scan on changed
  -> Result
       One-Time Filter: (NOT (InitPlan 4).col1)
       InitPlan 3
         -> Index Only Scan using wallets_pkey on wallets wallets_1
              Index Cond: (user_id = 'seed-1'::text)
       InitPlan 4
         -> CTE Scan on changed changed_2

[get_balance]
Index Scan using wallets_pkey on wallets
  Index Cond: ((user_id)::text = 'seed-1'::text)
```

## Limits and follow-up

One wallet's writes serialize on its balance row. For distributed traffic, connection capacity, WAL throughput, storage latency, and the growing ledger indexes are the next constraints to measure at higher load.

A deployment with multiple API instances should budget total pool connections and watch row lock waits, queue depth, and autovacuum on the frequently updated wallets table. Keep authoritative reads on the primary to preserve read-your-writes.

With more time, potential improvements include:

- Request idempotency for ambiguous client timeouts.
- Production database roles that restrict table access to the intended write path.
- Bounded request admission with queue metrics.
- Endurance tests that measure WAL and vacuum behavior under sustained traffic.
