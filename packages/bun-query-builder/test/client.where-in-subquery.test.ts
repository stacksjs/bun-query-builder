import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { buildDatabaseSchema, config, createQueryBuilder, setConfig } from '../src'
import { resetConnection } from '../src/db'
import { PG_URL, probePostgres } from './pg'

/**
 * `whereIn(column, subquery)` carries the subquery's bindings.
 *
 * The subquery was spliced in as its `toSQL()` text and its parameters were
 * dropped. A subquery with any `where()` then failed on Postgres with "there is
 * no parameter $1" - or, with outer parameters of its own, bound its `$1` to
 * the OUTER query's first value and filtered on the wrong thing. On SQLite the
 * `?` was bound to whatever came next, or NULL.
 *
 * Found seeding a demo tenant: counting a member's health metrics through
 * `whereIn('athlete_id', db.selectFrom('athletes').select('id').where(...))`.
 */

const models = {
  Athlete: { name: 'Athlete', table: 'wis_athletes', primaryKey: 'id', attributes: { id: { validation: { rule: {} } }, team: { validation: { rule: {} } } } },
  Metric: { name: 'Metric', table: 'wis_metrics', primaryKey: 'id', attributes: { id: { validation: { rule: {} } }, athlete_id: { validation: { rule: {} } }, kind: { validation: { rule: {} } } } },
} as any
const schema = buildDatabaseSchema(models)

let saved: { dialect: any, database: any }

beforeEach(async () => {
  saved = { dialect: config.dialect, database: { ...config.database } }
  setConfig({ dialect: 'sqlite', database: { database: ':memory:' } })
  resetConnection()
  const db = createQueryBuilder<typeof schema>({ schema })
  await db.unsafe('CREATE TABLE wis_athletes (id INTEGER PRIMARY KEY, team TEXT)')
  await db.unsafe('CREATE TABLE wis_metrics (id INTEGER PRIMARY KEY, athlete_id INTEGER, kind TEXT)')
  await db.unsafe(`INSERT INTO wis_athletes VALUES (1, 'red'), (2, 'red'), (3, 'blue')`)
  await db.unsafe(`INSERT INTO wis_metrics VALUES (1, 1, 'hrv'), (2, 1, 'sleep'), (3, 2, 'hrv'), (4, 3, 'hrv'), (5, 3, 'sleep')`)
})

afterEach(() => {
  setConfig({ dialect: saved.dialect, database: saved.database } as any)
  resetConnection()
})

describe('whereIn with a subquery (SQLite)', () => {
  const red = (db: any) => db.selectFrom('wis_athletes').select('id').where('team', '=', 'red')

  it('binds the subquery\'s own parameters', async () => {
    const db: any = createQueryBuilder<typeof schema>({ schema })
    const rows = await db.selectFrom('wis_metrics').select('id').whereIn('athlete_id', red(db)).orderBy('id', 'asc').get()
    expect(rows.map((r: any) => Number(r.id))).toEqual([1, 2, 3])
    expect(await db.selectFrom('wis_metrics').whereIn('athlete_id', red(db)).count()).toBe(3)
  })

  it('keeps outer parameters before and after it in order', async () => {
    const db: any = createQueryBuilder<typeof schema>({ schema })
    const count = await db.selectFrom('wis_metrics')
      .where('kind', '=', 'hrv')
      .whereIn('athlete_id', red(db))
      .where('id', '>', 1)
      .count()
    expect(count).toBe(1)
    expect(await db.selectFrom('wis_metrics').whereNotIn('athlete_id', red(db)).count()).toBe(2)
  })
})

const pgAvailable = await probePostgres()

describe.skipIf(!pgAvailable)('whereIn with a subquery (Postgres)', () => {
  it('renumbers the subquery\'s placeholders after the outer ones', () => {
    const srcEntry = resolve(import.meta.dir, '../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'qb-wis-'))
    const scriptPath = join(dir, 'probe.ts')
    writeFileSync(scriptPath, `
import { SQL } from 'bun'
import { setConfig, resetConnection, createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from ${JSON.stringify(srcEntry)}
const URL = ${JSON.stringify(PG_URL)}
const failures = []
const check = (label, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)) }
const raw = new SQL(URL)
await raw.unsafe('DROP TABLE IF EXISTS _qb_wis_metrics; DROP TABLE IF EXISTS _qb_wis_athletes')
await raw.unsafe('CREATE TABLE _qb_wis_athletes (id int primary key, team text)')
await raw.unsafe('CREATE TABLE _qb_wis_metrics (id int primary key, athlete_id int, kind text)')
await raw.unsafe("INSERT INTO _qb_wis_athletes VALUES (1, 'red'), (2, 'red'), (3, 'blue')")
await raw.unsafe("INSERT INTO _qb_wis_metrics VALUES (1, 1, 'hrv'), (2, 1, 'sleep'), (3, 2, 'hrv'), (4, 3, 'hrv'), (5, 3, 'sleep')")
await raw.end()
setConfig({ dialect: 'postgres', database: { url: URL } })
resetConnection()
const models = {
  _qb_wis_athletes: { columns: { id: { type: 'integer', isPrimaryKey: true }, team: { type: 'string' } } },
  _qb_wis_metrics: { columns: { id: { type: 'integer', isPrimaryKey: true }, athlete_id: { type: 'integer' }, kind: { type: 'string' } } },
}
const db = createQueryBuilder({ schema: buildDatabaseSchema(models), meta: buildSchemaMeta(models), autoMigration: { enabled: false } })
const red = () => db.selectFrom('_qb_wis_athletes').select('id').where('team', '=', 'red')
check('count', await db.selectFrom('_qb_wis_metrics').whereIn('athlete_id', red()).count(), 3)
const ids = await db.selectFrom('_qb_wis_metrics').select('id').where('kind', '=', 'hrv').whereIn('athlete_id', red()).where('id', '>', 1).orderBy('id', 'asc').get()
check('outer before and after', ids.map(r => Number(r.id)), [3])
check('not in', await db.selectFrom('_qb_wis_metrics').where('kind', '=', 'sleep').whereNotIn('athlete_id', red()).count(), 1)
const cleanup = new SQL(URL)
await cleanup.unsafe('DROP TABLE IF EXISTS _qb_wis_metrics; DROP TABLE IF EXISTS _qb_wis_athletes')
await cleanup.end()
if (failures.length) { console.error('FAILURES:\\n' + failures.join('\\n')); process.exit(1) }
console.log('OK')
`)
    const proc = Bun.spawnSync({ cmd: ['bun', scriptPath], stdout: 'pipe', stderr: 'pipe', cwd: process.cwd(), env: { ...process.env } })
    const dec = new TextDecoder()
    const out = dec.decode(proc.stdout).trim()
    const err = dec.decode(proc.stderr).trim()
    rmSync(dir, { recursive: true, force: true })
    expect(proc.exitCode, `whereIn subquery pg probe failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toContain('OK')
  }, 60_000)
})
