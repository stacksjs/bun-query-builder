/**
 * `db.sql` and `db.raw` fragments carrying values.
 *
 * The docs used both as fragments, and neither kept its values:
 *
 *  - `db.raw('stock - ?', [quantity])` returned the SQLite driver's identifier
 *    marker with the array dropped, so `set({ stock: ... })` changed no rows. On
 *    Postgres it threw `Query not called as a tagged template literal`.
 *  - `where(db.sql\`name = ${v}\`)` on Postgres read the query object as an empty
 *    column map, added no condition, and returned EVERY row. On SQLite it threw.
 *  - `whereRaw(db.sql\`name = ${v}\`)` on SQLite rendered `name = ?` with the value
 *    dropped and returned [] without an error; `orderByRaw(db.sql\`${col}\`)`
 *    silently ordered by a constant.
 *  - `set({ n: db.sql\`n + ${1}\` })` on SQLite bound nothing to the `?`.
 *  - `where({ sql, parameters })` was read as a column named `sql`.
 *
 * Each now binds its values or throws. Runs each dialect in a subprocess
 * because the connection config is global; Postgres is skipped without a server.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { PG_URL, probePostgres } from './pg'

const pgAvailable = await probePostgres()

function runProbe(dialect: 'sqlite' | 'postgres'): { code: number | null, out: string, err: string } {
  const srcEntry = resolve(import.meta.dir, '../src/index.ts')
  const dir = mkdtempSync(join(tmpdir(), 'qb-boundfrag-'))
  const scriptPath = join(dir, 'probe.ts')

  writeFileSync(scriptPath, `
import { SQL } from 'bun'
import { setConfig, resetConnection, createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from ${JSON.stringify(srcEntry)}

const DIALECT = ${JSON.stringify(dialect)}
const PG = ${JSON.stringify(PG_URL)}
const failures = []
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) failures.push(label + ': got ' + g + ', want ' + w)
}
const throws = async (label, fn, pattern) => {
  try { await fn(); failures.push(label + ': did not throw') }
  catch (e) { if (!pattern.test(String(e && e.message))) failures.push(label + ': threw ' + (e && e.message)) }
}

if (DIALECT === 'postgres') {
  const r = new SQL(PG)
  await r.unsafe('DROP TABLE IF EXISTS _qb_boundfrag')
  await r.unsafe('CREATE TABLE _qb_boundfrag (id int primary key, name text, n int)')
  await r.end()
  setConfig({ dialect: 'postgres', database: { url: PG } })
}
else {
  setConfig({ dialect: 'sqlite', database: { database: ${JSON.stringify(join(dir, 'probe.db'))} } })
}
resetConnection()

const models = { _qb_boundfrag: { columns: { id: { type: 'integer', isPrimaryKey: true }, name: { type: 'text' }, n: { type: 'integer' } } } }
const db = createQueryBuilder({ schema: buildDatabaseSchema(models), meta: buildSchemaMeta(models), autoMigration: { enabled: false } })
if (DIALECT === 'sqlite')
  await db.unsafe('CREATE TABLE _qb_boundfrag (id integer primary key, name text, n integer)')

const reset = async () => {
  await db.unsafe('DELETE FROM _qb_boundfrag')
  await db.unsafe("INSERT INTO _qb_boundfrag (id, name, n) VALUES (1, 'a', 10), (2, 'b', 20)")
}
const ns = async () => (await db.unsafe('SELECT n FROM _qb_boundfrag ORDER BY id')).map(r => Number(r.n))
const ids = rows => rows.map(r => Number(r.id)).sort((a, b) => a - b)

// db.raw(sql, bindings) in set() and where()
await reset()
await db.updateTable('_qb_boundfrag').set({ n: db.raw('n - ?', [3]) }).where('id', '=', 1).execute()
check('set db.raw with binding', await ns(), [7, 20])
await db.updateTable('_qb_boundfrag').set({ n: db.raw('n + 1') }).where('id', '=', 2).execute()
check('set db.raw without binding', await ns(), [7, 21])
check('where db.raw', ids(await db.selectFrom('_qb_boundfrag').where(db.raw('name = ?', ['b'])).get()), [2])
check('orWhere db.raw', ids(await db.selectFrom('_qb_boundfrag').where('id', '=', 1).orWhere(db.raw('n > ?', [20])).get()), [1, 2])
check('where db.raw beside where', ids(await db.selectFrom('_qb_boundfrag').where('id', '>', 0).where(db.raw('name = ?', ['a'])).get()), [1])
check('delete where db.raw', await (async () => {
  await db.deleteFrom('_qb_boundfrag').where(db.raw('n > ?', [20])).execute()
  return ids(await db.selectFrom('_qb_boundfrag').get())
})(), [1])

// { sql, parameters } in the select builder's where()
await reset()
check('where { sql, parameters }', ids(await db.selectFrom('_qb_boundfrag').where({ sql: 'name = ?', parameters: ['a'] }).get()), [1])

// db.raw is not a query
await throws('await db.raw', () => db.raw('SELECT 1 WHERE 1 = ?', [1]), /not a query/)
await throws('db.raw bindings not an array', async () => db.raw('a = ?', 1), /one array/)

// *Raw methods refuse fragments that carry values
await throws('whereRaw db.raw', async () => db.selectFrom('_qb_boundfrag').whereRaw(db.raw('name = ?', ['a'])), /no bindings/)

if (DIALECT === 'sqlite') {
  // The SQLite driver's db.sql fragments carry readable text and values.
  await reset()
  await db.updateTable('_qb_boundfrag').set({ n: db.sql\`n + \${5}\` }).where('id', '=', 1).execute()
  check('set db.sql', await ns(), [15, 20])
  check('where db.sql', ids(await db.selectFrom('_qb_boundfrag').where(db.sql\`name = \${'b'}\`).get()), [2])
  await throws('whereRaw db.sql with value', async () => db.selectFrom('_qb_boundfrag').whereRaw(db.sql\`name = \${'a'}\`), /no bindings/)
  await throws('orderByRaw db.sql with value', async () => db.selectFrom('_qb_boundfrag').orderByRaw(db.sql\`\${'n'} desc\`), /no bindings/)
  check('selectRaw db.sql without value', (await db.selectFrom('_qb_boundfrag').selectRaw(db.sql\`count(*) as c\`).get()).length > 0, true)
}
else {
  // Bun's Postgres query objects expose no SQL text.
  await reset()
  await throws('where db.sql', async () => db.selectFrom('_qb_boundfrag').where(db.sql\`name = \${'a'}\`), /cannot be used as a fragment/)
  await throws('orWhere db.sql', async () => db.selectFrom('_qb_boundfrag').where('id', '=', 1).orWhere(db.sql\`name = \${'b'}\`), /cannot be used as a fragment/)
  await throws('set db.sql', async () => db.updateTable('_qb_boundfrag').set({ n: db.sql\`n + \${1}\` }), /cannot be used as a fragment/)
  await throws('update where db.sql', async () => db.updateTable('_qb_boundfrag').set({ n: 1 }).where(db.sql\`id = \${1}\`), /cannot be used as a fragment/)
  await throws('delete where db.sql', async () => db.deleteFrom('_qb_boundfrag').where(db.sql\`id = \${1}\`), /cannot be used as a fragment/)
  check('no rows changed', await ns(), [10, 20])
  const r = new SQL(PG)
  await r.unsafe('DROP TABLE IF EXISTS _qb_boundfrag')
  await r.end()
}

if (failures.length) {
  console.error('FAILURES:\\n' + failures.join('\\n'))
  process.exit(1)
}
console.log('OK')
process.exit(0)
`)

  const proc = Bun.spawnSync({ cmd: ['bun', scriptPath], stdout: 'pipe', stderr: 'pipe', cwd: process.cwd(), env: { ...process.env } })
  const dec = new TextDecoder()
  const result = { code: proc.exitCode, out: dec.decode(proc.stdout).trim(), err: dec.decode(proc.stderr).trim() }
  rmSync(dir, { recursive: true, force: true })
  return result
}

describe('db.sql and db.raw fragments carrying values', () => {
  it('bind or refuse on SQLite', () => {
    const { code, out, err } = runProbe('sqlite')
    expect(code, `sqlite probe failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toContain('OK')
  }, 30_000)

  it.skipIf(!pgAvailable)('bind or refuse on Postgres', () => {
    const { code, out, err } = runProbe('postgres')
    expect(code, `postgres probe failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toContain('OK')
  }, 30_000)
})
