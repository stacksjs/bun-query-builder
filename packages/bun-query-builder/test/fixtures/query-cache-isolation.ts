import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { SQL } from 'bun'
import { clearQueryCache, createQueryBuilder, setConfig } from '../../src'
import { getOrCreateBunSql } from '../../src/db'

const mode = process.argv[2]
const dialect = (mode === 'sqlite-wrapper' ? 'sqlite' : mode) as 'sqlite' | 'mysql' | 'postgres'
const url = dialect === 'sqlite' ? 'sqlite://:memory:' : process.env.QUERY_CACHE_URL!
assert.ok(url, 'An explicit disposable database URL is required')
setConfig({ dialect, database: { database: ':memory:' }, softDeletes: { enabled: false }, hooks: {} })
const first = mode === 'sqlite-wrapper' ? getOrCreateBunSql(true) : new SQL(url, { max: 1 })
const second = mode === 'sqlite-wrapper' ? getOrCreateBunSql(true) : new SQL(url, { max: 1 })
const db = createQueryBuilder({ sql: first })
const other = createQueryBuilder({ sql: second })
const table = `qb_cache_${crypto.randomUUID().replaceAll('-', '')}`
const failures: string[] = []
async function check(name: string, fn: () => Promise<void>) {
  clearQueryCache()
  try {
    await fn()
    console.log(`PASS ${name}`)
  }
  catch (error) {
    failures.push(`${name}: ${error}`)
  }
}

try {
  // Session-local tables keep even the network probes fully disposable.
  for (const connection of [first, second]) {
    await connection.unsafe(`CREATE TEMPORARY TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(100))`)
    await connection.unsafe(`INSERT INTO ${table} VALUES (1, '${connection === first ? 'first' : 'second'}')`)
  }
  await check('identical queries on the same connection still hit', async () => {
    let reads = 0
    const cached = createQueryBuilder({ sql: first, hooks: { onQueryStart: () => { reads++ } } })
    const sameConnection = createQueryBuilder({ sql: first, hooks: { onQueryStart: () => { reads++ } } })
    assert.equal((await cached.selectFrom(table).where('id', '=', 1).cache().get())[0].name, 'first')
    assert.equal((await sameConnection.selectFrom(table).where('id', '=', 1).cache().get())[0].name, 'first')
    assert.equal(reads, 1, 'The second query must actually hit the cache')
    assert.equal((await cached.selectFrom(table).where('id', '=', 2).cache().get()).length, 0)
    assert.equal(reads, 2, 'Different bindings must execute independently')
    clearQueryCache()
    await cached.selectFrom(table).where('id', '=', 1).cache().get()
    assert.equal(reads, 3, 'Explicit invalidation must still work')
  })
  await check('different SQL with equal bindings', async () => {
    assert.equal((await db.selectFrom(table).select('name').where('id', '=', 1).cache().get())[0].name, 'first')
    assert.equal((await db.selectFrom(table).select('id').where('id', '=', 1).cache().get())[0].id, 1)
  })
  await check('same SQL on independent connections', async () => {
    assert.equal((await db.selectFrom(table).where('id', '=', 1).cache().get())[0].name, 'first')
    assert.equal((await other.selectFrom(table).where('id', '=', 1).cache().get())[0].name, 'second')
  })
  await check('transaction reads its own writes after cached read', async () => {
    await db.selectFrom(table).cache().get()
    await assert.rejects(db.transaction(async (tx) => {
      await tx.updateTable(table).set({ name: 'uncommitted' }).where('id', '=', 1).execute()
      assert.equal((await tx.selectFrom(table).cache().get())[0].name, 'uncommitted')
      throw new Error('rollback fixture')
    }), /rollback fixture/)
  })
  await check('rolled-back rows never populate outside cache', async () => {
    await assert.rejects(db.transaction(async (tx) => {
      await tx.updateTable(table).set({ name: 'rolled-back' }).where('id', '=', 1).execute()
      assert.equal((await tx.selectFrom(table).cache().get())[0].name, 'rolled-back')
      throw new Error('rollback fixture')
    }), /rollback fixture/)
    assert.equal((await db.selectFrom(table).cache().get())[0].name, 'first')
  })
  await check('bigint bindings can be cached', async () => {
    assert.equal((await db.selectFrom(table).where('id', '=', 1n).cache().get())[0].name, 'first')
  })
  await check('binary views cache only their visible bytes', async () => {
    await first.unsafe(`CREATE TEMPORARY TABLE ${table}_binary (id INT PRIMARY KEY, payload ${dialect === 'postgres' ? 'BYTEA' : 'BLOB'})`)
    await first.unsafe(`INSERT INTO ${table}_binary VALUES (1, ${dialect === 'postgres' ? '$1' : '?'})`, [Buffer.from([1, 2])])
    let reads = 0
    const cached = createQueryBuilder({ sql: first, hooks: { onQueryStart: () => { reads++ } } })
    const backing = Buffer.alloc(1024 * 1024, 9)
    const view = backing.subarray(13, 15)
    view.set([1, 2])
    assert.equal((await cached.selectFrom(`${table}_binary`).where({ payload: view }).cache().get())[0].id, 1)
    assert.equal((await cached.selectFrom(`${table}_binary`).where({ payload: Buffer.from([1, 2]) }).cache().get())[0].id, 1)
    assert.equal(reads, 1, 'Equal binary bindings must hit regardless of backing storage')
    assert.equal((await cached.selectFrom(`${table}_binary`).where({ payload: Buffer.from([2, 1]) }).cache().get()).length, 0)
    assert.equal(reads, 2, 'Different visible bytes must not collide')
  })
  await check('nested transactions never reuse cached reads', async () => {
    await assert.rejects(db.transaction(async (tx) => {
      assert.equal((await tx.selectFrom(table).cache().get())[0].name, 'first')
      await tx.transaction(async (nested) => {
        await nested.updateTable(table).set({ name: 'nested' }).where('id', '=', 1).execute()
        assert.equal((await nested.selectFrom(table).cache().get())[0].name, 'nested')
      })
      assert.equal((await tx.selectFrom(table).cache().get())[0].name, 'nested')
      throw new Error('rollback fixture')
    }), /rollback fixture/)
    assert.equal((await db.selectFrom(table).cache().get())[0].name, 'first')
  })
}
finally {
  clearQueryCache()
  await first.close()
  await second.close()
}
assert.deepEqual(failures, [], failures.join('\n'))
console.log(`${mode} cache isolation OK`)
