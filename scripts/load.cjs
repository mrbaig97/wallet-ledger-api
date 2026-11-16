const { performance } = require('node:perf_hooks');
const { run } = require('./database.cjs');

const token = process.env.API_TOKEN;
const base = process.env.API_URL ?? 'http://localhost:8080';
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 100);
const requests = Number(process.env.LOAD_REQUESTS ?? 30_000);
const endpoints = ['credit', 'debit', 'balance'];

function percentile(sorted, fraction) {
  return sorted.length ? Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2)) : null;
}

async function measure(mode, count) {
  const latencies = { credit: [], debit: [], balance: [] };
  const otherWallets = { credit: [], debit: [], balance: [] };
  const failures = {};
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const sequence = next++;
      const endpoint = endpoints[sequence % endpoints.length];
      const hot = mode === 'hot' && sequence % 10 < 9;
      const userId = hot ? 'seed-1' : 'seed-' + (1 + ((sequence * 7919) % 100_000));
      const read = endpoint === 'balance';
      const headers = { authorization: 'Bearer ' + token };
      if (!read) headers['content-type'] = 'application/json';
      const start = performance.now();
      try {
        const response = await fetch(base + '/' + endpoint + (read ? '/' + userId : ''), {
          method: read ? 'GET' : 'POST',
          headers,
          body: read ? undefined : JSON.stringify({ user_id: userId, amount: 1 }),
          signal: AbortSignal.timeout(30_000),
        });
        const result = await response.json();
        if (response.status !== 200 || result.user_id !== userId ||
            !Number.isInteger(result.balance) || result.balance < 0) {
          const code = endpoint + ':' + response.status;
          failures[code] = (failures[code] ?? 0) + 1;
          continue;
        }
        const elapsed = performance.now() - start;
        latencies[endpoint].push(elapsed);
        if (mode === 'hot' && userId !== 'seed-1') otherWallets[endpoint].push(elapsed);
      } catch (error) {
        const code = endpoint + ':' + error.name;
        failures[code] = (failures[code] ?? 0) + 1;
      }
    }
  }));
  const seconds = (performance.now() - started) / 1000;
  const summarize = (samples) => Object.fromEntries(endpoints.map((endpoint) => {
    const sorted = samples[endpoint].sort((a, b) => a - b);
    return [endpoint, { count: sorted.length, p50_ms: percentile(sorted, 0.5), p99_ms: percentile(sorted, 0.99) }];
  }));
  return { mode, concurrency, requests: count, seconds: Number(seconds.toFixed(2)),
    requests_per_second: Math.round(count / seconds),
    stats: summarize(latencies),
    ...(mode === 'hot' ? { other_wallets: summarize(otherWallets) } : {}),
    failures };
}

run(async () => {
  if (!token) throw new Error('Set API_TOKEN before starting the load test.');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
      !Number.isSafeInteger(requests) || requests < 3) {
    throw new Error('Set positive integer LOAD_CONCURRENCY and LOAD_REQUESTS (at least 3).');
  }
  for (const mode of ['mixed', 'hot']) {
    const warmup = await measure(mode, Math.min(1000, requests));
    if (Object.keys(warmup.failures).length) {
      console.error(JSON.stringify(warmup));
      throw new Error('Warmup failed. Start the API and load the seed first.');
    }
    const result = await measure(mode, requests);
    console.log(JSON.stringify(result));
    if (Object.keys(result.failures).length) process.exitCode = 1;
  }
});
