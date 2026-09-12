import assert from 'node:assert/strict'
import { SQL } from 'bun'
import { createQueryBuilder, setConfig } from '../../src'
import type { QueryEvent } from '../../src/types'

const dialect = process.argv[2] as 'mysql' | 'postgres'
const url = process.env.QUERY_HOOK_URL!
const table = `qb_hooks_${crypto.randomUUID().replaceAll('-', '')}`
const admin = new SQL(url)
const events: QueryEvent[] = []
const ends: QueryEvent[] = []
const errors: QueryEvent[] = []
const slow: QueryEvent[] = []
const spans: QueryEvent[] = []
let spansEnded = 0
setConfig({ dialect, database: { url }, hooks: {
  onQueryStart: event => events.push(event),
  onQueryEnd: event => ends.push(event),
  onQueryError: event => errors.push(event),
  slowQueryThresholdMs: 0,
  onSlowQuery: event => slow.push(event),
  startSpan: event => { spans.push(event); return { end: () => { spansEnded++ } } },
} })
const db = createQueryBuilder()
let created = false
try {
  await admin.unsafe(`CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(100), deleted_at TIMESTAMP NULL)`)
  created = true
  await db.insertInto(table).values({ id: 1, name: 'private-bind-value' }).execute()
  const rows = await db.selectFrom(table).where('id', '=', 1).execute()
  assert.equal(rows[0].name, 'private-bind-value')
  await db.updateTable(table).set({ name: 'changed' }).where('id', '=', 1).execute()
  await db.deleteFrom(table).where('id', '=', 1).execute()
  assert.deepEqual(events.map(event => event.kind), ['insert', 'select', 'update', 'delete'])
  for (const event of events) {
    assert.match(event.sql, new RegExp(`^${event.kind}\\b`, 'i'))
    assert.ok(event.sql.includes(table), event.sql)
    assert.ok(!event.sql.includes('private-bind-value'), 'SQL text must not interpolate bindings')
    assert.match(event.sql, dialect === 'postgres' ? /\$1/ : /\?/)
  }
  assert.deepEqual(events.map(event => event.params), [[1, 'private-bind-value'], [1], ['changed', 1], [1]])

  await db.insertInto(table).values({ id: 2, name: 'composed' }).execute()
  const firstIndex = events.length
  assert.equal((await db.selectFrom(table).where('id', '=', 2).first())?.name, 'composed')
  assert.match(events[firstIndex].sql, /^SELECT .* LIMIT 1$/)
  assert.deepEqual(events[firstIndex].params, [2])
  assert.equal(await db.selectFrom(table).where('id', '=', 2).value('name'), 'composed')
  assert.equal(await db.selectFrom(table).where('id', '=', 2).exists(), true)
  const pageIndex = events.length
  assert.equal((await db.selectFrom(table).where('id', '=', 2).paginate(1)).data[0].name, 'composed')
  assert.match(events[pageIndex].sql, /^SELECT COUNT\(\*\) as c FROM \(SELECT/)
  assert.deepEqual(events[pageIndex].params, [2])
  assert.deepEqual(events[pageIndex + 1].params, [2, 1, 0])
  assert.match(events[pageIndex + 1].sql, dialect === 'postgres' ? /LIMIT \$2 OFFSET \$3$/ : /LIMIT \? OFFSET \?$/)
  assert.equal((await db.selectFrom(table).where('id', '=', 2).simplePaginate(1)).data.length, 1)
  assert.equal((await db.selectFrom(table).find(2))?.name, 'composed')
  assert.equal((await db.selectFrom(table).findMany([2])).length, 1)
  assert.ok((await db.selectFrom(table).where('id', '=', 2).explain()).length > 0)

  // Parameterized expression supplied by a tagged-template client, plus a
  // composed subquery, must keep values out of SQL text on both dialects.
  const bind = (parts: TemplateStringsArray, ...parameters: unknown[]) => ({ sql: parts.join('?'), parameters })
  const taggedIndex = events.length
  await db.updateTable(table).set({ name: 'composed' }).where(bind`id = ${2}`).execute()
  assert.deepEqual(events[taggedIndex].params, ['composed', 2])
  assert.ok(!events[taggedIndex].sql.includes('composed'))
  const subIndex = events.length
  const sub = db.selectFrom(table).where('id', '=', 2)
  assert.equal((await db.selectFromSub(sub, 'filtered').where('name', '=', 'composed').get()).length, 1)
  assert.deepEqual(events[subIndex].params, [2, 'composed'])

  const trashedIndex = events.length
  assert.equal((await db.selectFrom(table).where('id', '=', 2).onlyTrashed().execute()).length, 0)
  assert.match(events[trashedIndex].sql, /deleted_at IS NOT NULL/)
  assert.deepEqual(events[trashedIndex].params, [2])

  // Transaction and reserved builders have their own connection. A rollback
  // must still roll back; capturing metadata must not switch to the pool.
  const txIndex = events.length
  await assert.rejects(db.transaction(async (tx) => {
    await tx.updateTable(table).set({ name: 'rolled-back' }).where('id', '=', 2).execute()
    assert.equal((await tx.selectFrom(table).where('id', '=', 2).first())?.name, 'rolled-back')
    throw new Error('rollback fixture')
  }), /rollback fixture/)
  assert.deepEqual(events[txIndex].params, ['rolled-back', 2])
  assert.match(events[txIndex].sql, /^UPDATE /)
  assert.equal((await db.selectFrom(table).where('id', '=', 2).first())?.name, 'composed')
  const reserved = await db.reserve()
  try {
    assert.equal(await reserved.selectFrom(table).where('id', '=', 2).count(), 1)
    assert.equal(await reserved.tryAdvisoryLock(1142), true)
    assert.equal(await reserved.advisoryUnlock(1142), true)
  }
  finally {
    reserved.release()
  }
  assert.equal(await db.ping(), true)
  assert.ok(events.every(event => /^(SELECT|INSERT|UPDATE|DELETE|EXPLAIN)\b/.test(event.sql)), 'all hooks must carry SQL')
  const metadata = (event: QueryEvent) => ({ sql: event.sql, params: event.params, kind: event.kind })
  assert.deepEqual(ends.map(metadata), events.map(metadata))
  assert.deepEqual(slow.map(metadata), events.map(metadata))
  assert.deepEqual(spans.map(metadata), events.map(metadata))
  assert.equal(spansEnded, events.length)
  assert.equal(errors.length, 0)
  const endCount = ends.length
  await assert.rejects(db.selectFrom(`${table}_missing`).where('id', '=', 9).execute())
  assert.equal(errors.length, 1)
  assert.deepEqual(metadata(errors[0]), metadata(events.at(-1)!))
  assert.deepEqual(errors[0].params, [9])
  assert.equal(ends.length, endCount)
  assert.equal(slow.length, endCount)
  assert.equal(spansEnded, events.length)
  console.log('query hooks OK')
}
finally {
  try {
    await db.close()
  }
  finally {
    try {
      if (created)
        await admin.unsafe(`DROP TABLE ${table}`)
    }
    finally {
      await admin.close()
    }
  }
}
