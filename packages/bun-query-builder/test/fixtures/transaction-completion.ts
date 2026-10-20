import assert from 'node:assert/strict'
import { SQL } from 'bun'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQueryBuilder, setConfig } from '../../src'
import { getOrCreateBunSql } from '../../src/db'

const mode = process.argv[2]
const dialect = (mode === 'sqlite-wrapper' ? 'sqlite' : mode) as 'sqlite' | 'mysql' | 'postgres'
const directory = dialect === 'sqlite' ? mkdtempSync(join(tmpdir(), 'qb-transaction-admission-')) : undefined
const databaseFile = directory ? join(directory, 'transaction.sqlite') : undefined
const url = databaseFile ? `sqlite://${databaseFile}` : process.env.TRANSACTION_TEST_URL!
assert.ok(url, 'An explicit disposable database URL is required')
setConfig({ dialect, database: { database: databaseFile ?? ':memory:' }, hooks: {} })
const connection = mode === 'sqlite-wrapper' ? getOrCreateBunSql(true) : new SQL(url, { max: 1 })
const db = createQueryBuilder({ sql: connection })
const table = `qb_completion_${crypto.randomUUID().replaceAll('-', '')}`
try {
  await connection.unsafe(`CREATE ${dialect === 'sqlite' ? '' : 'TEMPORARY '}TABLE ${table} (id INT PRIMARY KEY)`)
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
  if (databaseFile) {
    const contender = new Database(databaseFile)
    contender.run('PRAGMA busy_timeout = 0')
    try {
      await db.deleteFrom(table).execute()
      // The default and explicit deferred modes do not reserve the writer.
      for (const sqliteMode of [undefined, 'deferred'] as const) {
        await db.transaction(async () => {
          contender.run(`INSERT INTO ${table} (id) VALUES (1)`)
        }, { sqliteMode })
        await db.deleteFrom(table).execute()
      }
      // Writer modes reserve admission before any read. Nested calls retain
      // that admission through a savepoint rather than issuing another BEGIN.
      for (const sqliteMode of ['immediate', 'exclusive'] as const) {
        await db.transaction(async (tx) => {
          assert.throws(() => contender.run(`INSERT INTO ${table} (id) VALUES (2)`), /locked|busy/i)
          await tx.transaction(async (nested) => {
            await nested.insertInto(table).values({ id: 3 }).execute()
          }, { sqliteMode })
        }, { sqliteMode })
        assert.deepEqual(Array.from(await db.selectFrom(table).get(), row => row.id), [3])
        await db.deleteFrom(table).execute()
      }
      let invoked = false
      await assert.rejects(db.transaction(async () => { invoked = true }, { sqliteMode: 'immediate; DROP TABLE users' as never }), /sqliteMode/)
      assert.equal(invoked, false)
    }
    finally { contender.close() }
  }
  if (dialect !== 'sqlite') {
    let invoked = false
    await assert.rejects(db.transaction(async () => { invoked = true }, { sqliteMode: 'immediate' }), /requires the SQLite dialect/)
    assert.equal(invoked, false)
  }
  console.log(`${mode} transaction completion OK`)
}
finally {
  try { await connection.close() }
  finally { if (directory) rmSync(directory, { recursive: true, force: true }) }
}
