import assert from 'node:assert/strict'
import { SQL } from 'bun'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQueryBuilder, setConfig } from '../../src'
import { createConnectionString, getOrCreateBunSql } from '../../src/db'

const mode = process.argv[2]
const dialect = (mode === 'sqlite-wrapper' ? 'sqlite' : mode) as 'sqlite' | 'mysql' | 'postgres'
const directory = dialect === 'sqlite' ? mkdtempSync(join(tmpdir(), 'qb-transaction-admission-')) : undefined
const databaseFile = directory ? join(directory, 'transaction.sqlite') : undefined
const url = databaseFile ? `sqlite://${databaseFile}` : process.env.TRANSACTION_TEST_URL!
assert.ok(url, 'An explicit disposable database URL is required')
setConfig({ dialect, database: { database: databaseFile ?? ':memory:' }, hooks: {} })
if (dialect !== 'sqlite') {
  const parsed = new URL(url)
  const settings = { database: decodeURIComponent(parsed.pathname.slice(1)), username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), host: parsed.hostname, port: Number(parsed.port) || (dialect === 'postgres' ? 5432 : 3306), ssl: parsed.searchParams.get('ssl') === 'true' }
  const environment = { DB_CONNECTION: dialect, DB_DATABASE: settings.database, DB_USERNAME: settings.username, DB_PASSWORD: settings.password, DB_HOST: settings.host, DB_PORT: String(settings.port), DB_SSL: String(settings.ssl) }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  try {
    for (const fromEnv of [false, true]) {
      for (const [key, value] of Object.entries(environment)) {
        if (fromEnv) process.env[key] = value
        else delete process.env[key]
      }
      const probe = new SQL(createConnectionString(dialect, settings))
      try { assert.equal(Number((await probe.unsafe('SELECT 1 AS connected'))[0]?.connected), 1) }
      finally { await probe.close() }
    }
  }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
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
  if (dialect === 'postgres') {
    // Native Bun errors expose errno=SQLSTATE alongside a generic code. The
    // message intentionally contains none of the legacy English matchers.
    for (const state of ['40001', '40P01', '23505']) {
      await db.deleteFrom(table).execute()
      let attempts = 0
      await db.transaction(async (tx) => {
        attempts++
        await tx.insertInto(table).values({ id: attempts }).execute()
        if (attempts === 1)
          await tx.unsafe(`DO $$ BEGIN RAISE SQLSTATE '${state}' USING MESSAGE = 'native retry fixture'; END $$`)
      }, { retries: 1, sqlStates: ['23505'], backoff: { baseMs: 1, maxMs: 1 } })
      assert.equal(attempts, 2, `Native SQLSTATE ${state} must retry`)
      assert.deepEqual(Array.from(await db.selectFrom(table).get(), row => row.id), [2])
    }
    await db.deleteFrom(table).execute()
    let attempts = 0
    await assert.rejects(db.transaction(async (tx) => {
      attempts++
      await tx.insertInto(table).values({ id: attempts }).execute()
      await tx.unsafe("DO $$ BEGIN RAISE SQLSTATE '23514' USING MESSAGE = 'native refusal fixture'; END $$")
    }, { retries: 2, sqlStates: ['23505'] }))
    assert.equal(attempts, 1, 'unlisted constraint failures must not retry')
    assert.equal((await db.selectFrom(table).get()).length, 0)
  }
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
