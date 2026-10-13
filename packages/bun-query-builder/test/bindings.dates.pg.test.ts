/**
 * A JavaScript `Date` bound as a parameter, against a live Postgres.
 *
 * Bun's driver does not serialize a `Date` the same way in every mode. With
 * prepared statements on (its default) a `Date` bound to a `timestamp` or
 * `timestamptz` parameter is sent as a typed timestamp and works; bound to a
 * `date` parameter, or inside an array, it is sent as `String(date)`. With
 * `pool: { preparedStatements: false }` (Bun's `prepare: false`) EVERY `Date`
 * is sent as `String(date)`:
 *
 *     Tue Oct 13 2026 20:45:42 GMT+0000 (Coordinated Universal Time)
 *
 * which Postgres refuses - `invalid input syntax for type timestamp`, or, on a
 * machine outside UTC, `time zone "gmt-0700" not recognized`. Turning prepared
 * statements off (0.3.9) therefore broke every write of a `Date` an application
 * had read back from the database, e.g. `applied_at: row.applied_at || now`.
 *
 * The builder now hands the driver `date.toISOString()` for every `Date`, on
 * every path, in both modes. This runs each path twice, prepared and not.
 *
 * Runs in a subprocess: `config.dialect` is global and other test files pin it
 * to sqlite, which would mask the network-driver path entirely.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { PG_URL, probePostgres } from './pg'

const pgAvailable = await probePostgres()

function probe(prepare: boolean, timeZone: string): { code: number | null, out: string, err: string } {
  const srcEntry = resolve(import.meta.dir, '../src/index.ts')
  const dir = mkdtempSync(join(tmpdir(), 'qb-dates-'))
  const scriptPath = join(dir, 'probe.ts')
  const table = `_qb_dates_${prepare ? 'p' : 'u'}_${process.pid}`

  writeFileSync(scriptPath, `
import { SQL } from 'bun'
import { setConfig, resetConnection, createQueryBuilder, buildDatabaseSchema, buildSchemaMeta, defineModel, clearModelRegistry } from ${JSON.stringify(srcEntry)}

const URL = ${JSON.stringify(PG_URL)}
const T = ${JSON.stringify(table)}
const failures = []
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) failures.push(label + ': got ' + g + ', want ' + w)
}
const attempt = async (label, fn) => {
  try { return await fn() }
  catch (e) { failures.push(label + ' threw: ' + (e && e.message)); return undefined }
}

const raw = new SQL(URL)
await raw.unsafe('DROP TABLE IF EXISTS ' + T)
await raw.unsafe('CREATE TABLE ' + T + ' (id serial primary key, label text, at timestamptz, plain timestamp, day date, created_at timestamptz, updated_at timestamptz)')

setConfig({ dialect: 'postgres', database: { url: URL, pool: { preparedStatements: ${prepare} } } })
resetConnection()

const models = { [T]: { columns: {
  id: { type: 'integer', isPrimaryKey: true }, label: { type: 'string' }, at: { type: 'datetime' },
  plain: { type: 'datetime' }, day: { type: 'date' },
} } }
const db = createQueryBuilder({ schema: buildDatabaseSchema(models), meta: buildSchemaMeta(models), autoMigration: { enabled: false } })

const at = new Date('2026-10-13T20:45:42.123Z')
const day = new Date('2026-10-12T00:00:00.000Z')
const later = new Date('2026-10-14T08:00:00.000Z')

// What Postgres stored, as text the session time zone cannot shift.
const stored = async (label) => {
  const rows = await raw.unsafe("SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS at, to_char(plain, 'YYYY-MM-DD HH24:MI:SS.MS') AS plain, day::text AS day FROM " + T + ' WHERE label = $1', [label])
  return rows[0] ? [rows[0].at, rows[0].plain, rows[0].day] : null
}
const want = ['2026-10-13 20:45:42.123', '2026-10-13 20:45:42.123', '2026-10-12']
const ids = rows => (rows ?? []).map(r => r.label).sort()

// Builder: insert.
await attempt('insert', () => db.insertInto(T).values({ label: 'insert', at, plain: at, day }).execute())
check('insert stores the instant', await stored('insert'), want)

// Builder: insert ... returning, and a multi-row insert.
await attempt('insert returning', () => db.insertInto(T).values({ label: 'returning', at, plain: at, day }).returning('id').execute())
check('insert returning stores the instant', await stored('returning'), want)
await attempt('insert many', () => db.insertInto(T).values([{ label: 'many-1', at, plain: at, day }, { label: 'many-2', at, plain: at, day }]).execute())
check('multi-row insert stores the instant', await stored('many-2'), want)

// Builder: update, with the Date read back from Postgres (the HQ shape:
// \`applied_at: current.applied_at || now\`).
await raw.unsafe('INSERT INTO ' + T + " (label) VALUES ('update')")
const readBack = (await raw.unsafe('SELECT at, plain, day FROM ' + T + " WHERE label = 'insert'"))[0]
await attempt('update', () => db.updateTable(T).set({ at: readBack.at, plain: readBack.plain, day: readBack.day }).where('label', '=', 'update').execute())
check('update stores the instant read back', await stored('update'), want)

// Builder: where / whereIn / whereBetween / first / count.
check('where =', ids(await attempt('where', () => db.selectFrom(T).where('at', '=', at).where('label', '=', 'insert').get())), ['insert'])
check('where on a date column', ids(await attempt('where date', () => db.selectFrom(T).where('day', '=', day).where('label', '=', 'insert').get())), ['insert'])
check('where on a timestamp column', ids(await attempt('where plain', () => db.selectFrom(T).where('plain', '=', at).where('label', '=', 'insert').get())), ['insert'])
check('whereIn', ids(await attempt('whereIn', () => db.selectFrom(T).whereIn('at', [at, later]).whereIn('label', ['insert', 'update']).get())), ['insert', 'update'])
check('whereBetween', ids(await attempt('whereBetween', () => db.selectFrom(T).whereBetween('at', day, later).where('label', '=', 'insert').get())), ['insert'])
check('first', (await attempt('first', () => db.selectFrom(T).where('at', '<', later).where('label', '=', 'insert').first()))?.label, 'insert')
check('count', Number(await attempt('count', () => db.selectFrom(T).where('at', '<', later).count())), 5)

// Builder: paginate, plain and through a transaction handle.
const page = await attempt('paginate', () => db.selectFrom(T).where('at', '<', later).orderBy('id', 'asc').paginate(2, 1))
check('paginate total', page?.meta?.total, 5)
const txPage = await attempt('paginate tx', () => db.transaction(tx => tx.selectFrom(T).where('at', '<', later).orderBy('id', 'asc').paginate(2, 1, { tx })))
check('paginate through tx total', txPage?.meta?.total, 5)
const rawTxPage = await attempt('paginate raw tx', () => raw.begin(tx => db.selectFrom(T).where('at', '<', later).orderBy('id', 'asc').paginate(2, 1, { tx })))
check('paginate through a raw Bun tx total', rawTxPage?.meta?.total, 5)

// Raw SQL through the builder: db.unsafe, with scalars and an array (IN list via ANY).
await attempt('unsafe insert', () => db.unsafe('INSERT INTO ' + T + ' (label, at, plain, day) VALUES ($1, $2, $3, $4)', ['unsafe', at, at, day]))
check('db.unsafe stores the instant', await stored('unsafe'), want)
// Dates inside an IN list or array. Bun binds a plain JS array parameter as
// "a,b" (malformed for any element type), so the driver's own helpers are the
// way in: sql.array() for = ANY($1), and sql([...]) for an IN list.
const anyRows = await attempt('sql.array', () => db.unsafe('SELECT label FROM ' + T + " WHERE at = ANY($1) AND label IN ('insert', 'unsafe')", [db.sql.array([at, later], 'timestamptz')]))
check('Dates inside sql.array()', ids(anyRows), ['insert', 'unsafe'])
const inRows = await attempt('sql([...]) IN list', () => db.raw\`SELECT label FROM \${db.sql(T)} WHERE at IN \${db.sql([at, later])} AND label IN ('insert', 'unsafe')\`)
check('Dates inside an IN list helper', ids(inRows), ['insert', 'unsafe'])
const rowHelper = await attempt('sql(row) helper', () => db.raw\`INSERT INTO \${db.sql(T)} \${db.sql({ label: 'helper', at, plain: at, day })}\`)
check('Dates inside the row helper', await stored('helper'), want)

// Tagged templates through the builder.
const tagged = await attempt('raw tagged', () => db.raw\`SELECT \${at}::timestamptz = '2026-10-13T20:45:42.123Z'::timestamptz AS same, \${day}::date::text AS day\`)
check('db.raw tagged template', [tagged?.[0]?.same, tagged?.[0]?.day], [true, '2026-10-12'])

// Transactions: the builder handed to the callback, its unsafe(), and a nested savepoint.
await attempt('transaction', () => db.transaction(async (tx) => {
  await tx.insertInto(T).values({ label: 'tx', at, plain: at, day }).execute()
  await tx.unsafe('INSERT INTO ' + T + ' (label, at, plain, day) VALUES ($1, $2, $3, $4)', ['tx-unsafe', at, at, day])
  await tx.transaction(inner => inner.updateTable(T).set({ day }).where('label', '=', 'tx').execute())
}))
check('transaction insert', await stored('tx'), want)
check('transaction unsafe', await stored('tx-unsafe'), want)

// The connection itself (db.sql) and a Bun transaction opened on it.
await attempt('db.sql.begin', () => db.sql.begin(tx => tx.unsafe('INSERT INTO ' + T + ' (label, at, plain, day) VALUES ($1, $2, $3, $4)', ['sql-begin', at, at, day])))
check('db.sql.begin tx.unsafe', await stored('sql-begin'), want)

// An invalid Date is refused before it reaches the driver, by name.
const refusal = async (fn) => { try { await fn(); return 'accepted' } catch (e) { return String(e && e.message) } }
for (const [label, fn] of [
  ['db.unsafe', () => db.unsafe('SELECT $1::timestamptz AS t', [new Date('nope')])],
  ['insert', () => db.insertInto(T).values({ label: 'invalid', at: new Date('nope') }).execute()],
  ['where', () => db.selectFrom(T).where('at', '=', new Date('nope')).get()],
]) {
  const message = await refusal(fn)
  if (!/invalid Date/.test(message)) failures.push('invalid Date via ' + label + ': got ' + message)
}

// ORM: create (insert), where/get (all), first (get), update via save.
clearModelRegistry()
const Event = defineModel({ name: 'DateEvent', table: T, primaryKey: 'id',
  attributes: { label: { type: 'string', fillable: true }, at: { type: 'datetime', fillable: true }, plain: { type: 'datetime', fillable: true }, day: { type: 'date', fillable: true } } })
await attempt('orm create', () => Event.create({ label: 'orm', at, plain: at, day }))
check('ORM create stores the instant', await stored('orm'), want)
check('ORM where().get()', ids((await attempt('orm get', () => Event.where('at', at).where('label', 'orm').get()))?.map(m => ({ label: m.get('label') }))), ['orm'])
check('ORM where().first()', (await attempt('orm first', () => Event.where('day', day).where('label', 'orm').first()))?.get('label'), 'orm')
const ormPage = await attempt('orm paginate', () => Event.where('at', '<', later).paginate(1, 2))
check('ORM paginate total', ormPage?.total ?? ormPage?.meta?.total, 11)

await raw.unsafe('DROP TABLE IF EXISTS ' + T)
await raw.end()

if (failures.length) {
  console.error('FAILURES:\\n' + failures.join('\\n'))
  process.exit(1)
}
console.log('OK')
process.exit(0)
`)

  const proc = Bun.spawnSync({ cmd: ['bun', scriptPath], stdout: 'pipe', stderr: 'pipe', cwd: process.cwd(), env: { ...process.env, TZ: timeZone } })
  const dec = new TextDecoder()
  rmSync(dir, { recursive: true, force: true })
  return { code: proc.exitCode, out: dec.decode(proc.stdout).trim(), err: dec.decode(proc.stderr).trim() }
}

describe.skipIf(!pgAvailable)('Date parameters against live Postgres', () => {
  for (const prepare of [false, true]) {
    for (const timeZone of ['UTC', 'America/Los_Angeles', 'Europe/Berlin']) {
      it(`binds Dates on every path with preparedStatements: ${prepare}, TZ=${timeZone}`, () => {
        const { code, out, err } = probe(prepare, timeZone)
        expect(code, `date pg probe failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
        expect(out).toContain('OK')
      }, 60_000)
    }
  }
})
