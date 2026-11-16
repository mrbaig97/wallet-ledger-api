const { Client } = require('pg');

async function withDatabase(work) {
  const client = new Client();
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function transaction(client, work) {
  await client.query('BEGIN');
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function run(main) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { withDatabase, transaction, run };
