const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Agent, setGlobalDispatcher } = require('undici');
const { Pool } = require('pg');

const token = randomUUID();
const runId = randomUUID();
const db = new Pool();
const agent = new Agent({ connections: 100 });
setGlobalDispatcher(agent);
const servers = [];
let base;
let secondBase;

async function startApi() {
  const api = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, PORT: '0', API_TOKEN: token },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  servers.push(api);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('API startup timed out')), 10000);
    api.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('API exited with code ' + code));
    });
    let output = '';
    api.stdout.on('data', (chunk) => {
      output += chunk;
      const listening = output.match(/Wallet API listening on port (\d+)/);
      if (listening) {
        clearTimeout(timer);
        resolve('http://127.0.0.1:' + listening[1]);
      }
    });
  });
}

before(async () => {
  [base, secondBase] = await Promise.all([startApi(), startApi()]);
});

after(async () => {
  await Promise.all(servers.map(async (api) => {
    if (api.exitCode !== null || api.signalCode !== null) return;
    const stopped = once(api, 'exit');
    api.kill();
    await stopped;
  }));
  await Promise.all([db.end(), agent.close()]);
});

async function call(path, { body, raw, authorization = 'Bearer ' + token, url = base } = {}) {
  const hasBody = body !== undefined || raw !== undefined;
  const headers = {};
  if (authorization !== null) headers.authorization = authorization;
  if (hasBody) headers['content-type'] = 'application/json';
  const response = await fetch(url + path, {
    method: hasBody ? 'POST' : 'GET',
    headers,
    body: raw ?? (hasBody ? JSON.stringify(body) : undefined),
  });
  return { status: response.status, body: await response.json() };
}

function post(path, user_id, amount, url) {
  return call(path, { body: { user_id, amount }, url });
}

function checkError(response, status, error) {
  assert.equal(response.status, status);
  assert.equal(response.body.error, error);
  assert.equal(typeof response.body.message, 'string');
  assert.deepEqual(Object.keys(response.body).sort(), ['error', 'message']);
}

test('auth runs before parsing and applies to every endpoint', async () => {
  for (const authorization of [null, 'Basic ' + token, 'Bearer wrong']) {
    for (const path of ['/credit', '/debit']) {
      checkError(await call(path, { raw: '{', authorization }), 401, 'unauthorized');
    }
    checkError(await call('/balance/unknown', { authorization }), 401, 'unauthorized');
  }
});

test('strict validation rejects malformed JSON, floats, and invalid fields', async () => {
  for (const raw of ['{', 'null', '[]', '{}', '{"user_id":"u","amount":1.0}',
    '{"user_id":"u","amount":1e0}', '{"user_id":"u","amount":"1"}']) {
    checkError(await call('/credit', { raw }), 400, 'invalid_request');
  }
  for (const [id, amount] of [['bad!', 1], ['u\n', 1], ['a'.repeat(65), 1],
    ['u', 0], ['u', -1], ['u', 1000000001], ['u', 0.5]]) {
    checkError(await post('/credit', id, amount), 400, 'invalid_request');
  }
  checkError(await call('/balance/%0A'), 400, 'invalid_request');
  checkError(await call('/balance/%zz'), 400, 'invalid_request');

  const user_id = 'extra-' + runId;
  const response = await call('/credit', {
    body: { user_id, amount: 1, unknown: { amount: 0.5 } },
  });
  assert.deepEqual(response, { status: 200, body: { user_id, balance: 1 } });
});

test('unknown wallets and rejected debits leave no ledger rows', async () => {
  const user = 'missing-' + runId;
  checkError(await call('/balance/' + user), 404, 'user_not_found');
  checkError(await post('/debit', user, 1), 404, 'user_not_found');
  assert.equal((await db.query('SELECT 1 FROM ledger WHERE user_id = $1', [user])).rowCount, 0);
});

test('concurrent debits reject exactly one and persist a single debit', async () => {
  const user_id = 'debit-' + runId;
  assert.deepEqual(await post('/credit', user_id, 100), {
    status: 200, body: { user_id, balance: 100 },
  });
  const results = await Promise.all([
    post('/debit', user_id, 60),
    post('/debit', user_id, 60, secondBase),
  ]);
  results.sort((a, b) => a.status - b.status);
  assert.deepEqual(results[0], { status: 200, body: { user_id, balance: 40 } });
  checkError(results[1], 409, 'insufficient_funds');
  assert.deepEqual(await call('/balance/' + user_id), {
    status: 200, body: { user_id, balance: 40 },
  });
  const ledger = await db.query('SELECT type, amount FROM ledger WHERE user_id = $1 ORDER BY id', [user_id]);
  assert.deepEqual(ledger.rows, [{ type: 'credit', amount: 100 }, { type: 'debit', amount: 60 }]);
});

test('1,000 concurrent credits return each intermediate balance exactly once', async () => {
  const user_id = 'credit-' + runId;
  const responses = await Promise.all(Array.from({ length: 1000 }, (_, index) =>
    post('/credit', user_id, 100, index % 2 ? base : secondBase),
  ));
  for (const response of responses) assert.equal(response.status, 200);
  assert.deepEqual(responses.map((r) => r.body.balance).sort((a, b) => a - b),
    Array.from({ length: 1000 }, (_, i) => (i + 1) * 100));
  assert.deepEqual(await call('/balance/' + user_id), {
    status: 200, body: { user_id, balance: 100000 },
  });
  const { rows: [row] } = await db.query(
    'SELECT count(*)::int AS count, sum(amount)::int AS balance FROM ledger WHERE user_id = $1',
    [user_id],
  );
  assert.deepEqual(row, { count: 1000, balance: 100000 });
});

test('blocked writes to one wallet do not exhaust connections for other users', async () => {
  const hot = 'hot-' + runId;
  const cold = 'cold-' + runId;
  assert.equal((await post('/credit', hot, 1)).status, 200);
  const lock = await db.connect();
  let writes = [];
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT 1 FROM wallets WHERE user_id = $1 FOR UPDATE', [hot]);
    writes = Array.from({ length: 50 }, () => post('/credit', hot, 1));
    await delay(100);
    const result = await Promise.race([
      post('/credit', cold, 1),
      delay(2000, null, { ref: false }),
    ]);
    assert.equal(result?.status, 200);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    assert.ok((await Promise.all(writes)).every((result) => result.status === 200));
  }
});

test('failure to append the ledger row rolls back the balance change', async () => {
  const user = 'rollback-' + runId;
  assert.equal((await post('/credit', user, 10)).status, 200);
  // A transaction-local trigger cannot affect the API connection. Use a
  // committed, narrowly scoped check constraint and remove it afterwards.
  await db.query("ALTER TABLE ledger ADD CONSTRAINT test_reject_amount CHECK (user_id <> '" +
    user + "' OR amount <> 7) NOT VALID");
  try {
    checkError(await post('/credit', user, 7), 500, 'internal_error');
    assert.equal((await call('/balance/' + user)).body.balance, 10);
  } finally {
    await db.query('ALTER TABLE ledger DROP CONSTRAINT test_reject_amount');
  }
});
