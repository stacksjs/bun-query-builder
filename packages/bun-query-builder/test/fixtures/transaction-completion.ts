import assert from 'node:assert/strict'
import { SQL } from 'bun'
import { createQueryBuilder, setConfig } from '../../src'
import { getOrCreateBunSql } from '../../src/db'

const mode = process.argv[2]
const dialect = (mode === 'sqlite-wrapper' ? 'sqlite' : mode) as 'sqlite' | 'mysql' | 'postgres'
const url = dialect === 'sqlite' ? 'sqlite://:memory:' : process.env.TRANSACTION_TEST_URL!
assert.ok(url, 'An explicit disposable database URL is required')
setConfig({ dialect, database: { database: ':memory:' }, hooks: {} })
const connection = mode === 'sqlite-wrapper' ? getOrCreateBunSql(true) : new SQL(url, { max: 1 })
const db = createQueryBuilder({ sql: connection })
const table = `qb_completion_${crypto.randomUUID().replaceAll('-', '')}`
try {
  await connection.unsafe(`CREATE TEMPORARY TABLE ${table} (id INT PRIMARY KEY)`)
  for (const asyncCallback of [false, true]) {
    await db.deleteFrom(table).execute()
    let bodies = 0
    let callbacks = 0
    let retries = 0
    let rollbacks = 0
    const failure = new Error('database is locked: after commit fixture')
    await assert.rejects(db.transaction(async (tx) => {
      bodies++
      await tx.insertInto(table).values({ id: bodies }).execute()
      return 'committed'
    }, {
      retries: 1,
      backoff: { baseMs: 1, maxMs: 1 },
      afterCommit: asyncCallback
        ? async () => { callbacks++; await Promise.resolve(); throw failure }
        : () => { callbacks++; throw failure },
      onRetry: () => { retries++ },
      onRollback: () => { rollbacks++ },
      afterRollback: () => { rollbacks++ },
    }), error => error === failure)
    assert.equal((await db.selectFrom(table).get()).length, 1, 'A committed write must never be replayed')
    assert.deepEqual({ bodies, callbacks, retries, rollbacks }, { bodies: 1, callbacks: 1, retries: 0, rollbacks: 0 })
  }

  // A genuinely rolled-back attempt must still retry and commit once.
  await db.deleteFrom(table).execute()
  let attempts = 0
  let committed = 0
  let retried = 0
  const result = await db.transaction(async (tx) => {
    attempts++
    await tx.insertInto(table).values({ id: attempts }).execute()
    if (attempts === 1)
      throw new Error('database is locked: rolled-back attempt')
    return 'success'
  }, {
    retries: 1,
    backoff: { baseMs: 1, maxMs: 1 },
    onRetry: () => { retried++ },
    // Returning a value remains valid for a void callback; async completion
    // is still awaited even though its result is ignored.
    afterCommit: async () => { await Promise.resolve(); return ++committed },
  })
  assert.equal(result, 'success')
  assert.deepEqual({ attempts, committed, retried }, { attempts: 2, committed: 1, retried: 1 })
  assert.deepEqual(Array.from(await db.selectFrom(table).get(), row => row.id), [2])
  console.log(`${mode} transaction completion OK`)
}
finally {
  await connection.close()
}
