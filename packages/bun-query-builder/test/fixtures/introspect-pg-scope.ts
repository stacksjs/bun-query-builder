import assert from 'node:assert/strict'
import { SQL } from 'bun'
import { setConfig } from '../../src'
import { buildPlanFromDatabase, introspectDatabase } from '../../src/actions/introspect-db'
import { closeConnection } from '../../src/db'

const url = process.env.QB_PG_INTROSPECTION_URL!
assert.match(new URL(url).pathname, /^\/qb_introspection_[a-z0-9_]+$/)
const raw = new SQL(url)
try {
  await raw.unsafe(`CREATE TABLE public.key_scope (
    actual_key integer, incidental_id integer, label text DEFAULT 'kept',
    CONSTRAINT same_key_name PRIMARY KEY (actual_key) INCLUDE (incidental_id)
  )`)
  await raw.unsafe('CREATE SCHEMA another_schema')
  await raw.unsafe(`CREATE TABLE another_schema.key_scope (
    actual_key integer, incidental_id integer,
    CONSTRAINT same_key_name PRIMARY KEY (incidental_id)
  )`)
  await raw.unsafe(`CREATE TABLE public.composite_scope (
    dropped_column integer, key_a integer, key_b text, included_column text,
    CONSTRAINT composite_key PRIMARY KEY (key_a, key_b) INCLUDE (included_column)
  )`)
  await raw.unsafe('ALTER TABLE public.composite_scope DROP COLUMN dropped_column')
  setConfig({ dialect: 'postgres', database: { url } })
  const names = ['key_scope', 'composite_scope']
  const models = await introspectDatabase({ tables: names })
  const plan = await buildPlanFromDatabase('postgres', { tables: names })
  for (const [table, keys] of [['key_scope', ['actual_key']], ['composite_scope', ['key_a', 'key_b']]] as const) {
    const model = models.find(item => item.table === table)!
    const planned = plan.tables.find(item => item.table === table)!
    assert.deepEqual(model.columns.filter(item => item.isPrimaryKey).map(item => item.name), [...keys])
    assert.deepEqual(planned.columns.filter(item => item.isPrimaryKey).map(item => item.name), [...keys])
    assert.equal(model.primaryKey, keys[0])
  }
  const ordinary = plan.tables.find(item => item.table === 'key_scope')!.columns.find(item => item.name === 'incidental_id')!
  assert.equal(ordinary.isNullable, true)
  assert.equal(ordinary.isPrimaryKey, false)
  process.stdout.write('Postgres key ownership passed\n')
}
finally {
  await closeConnection()
  await raw.end()
}
