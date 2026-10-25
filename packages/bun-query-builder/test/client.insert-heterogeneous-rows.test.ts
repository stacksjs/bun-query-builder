/**
 * A multi-row INSERT must name every column any row carries —
 * stacksjs/bun-query-builder#1189.
 *
 * The column list came from `Object.keys(rows[0])`, and each row was then read
 * through it as `row[keys[c]]`. A key that appeared only in a later row had
 * nowhere to go, so its value was dropped from the statement — from every row
 * that carried it — with no error and the full row count reported.
 *
 * Four builders had it independently: `insertInto().values([...])`, the
 * `createMany()` and `insertMany()` helpers, and `buildInsertClause()`, which
 * backs upsert / insertOrIgnore / insertGetId / updateOrInsert.
 *
 * The reporter lost five cross-references out of forty seeded rows and found it
 * only by running `count(reference_number)` afterwards. That is the shape worth
 * pinning: nothing throws, the count is right, the table is not empty, so a
 * test asserting "the insert succeeded" cannot see it. Every case below either
 * reads the value back or asserts the emitted SQL names the column.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { config } from '../src/config'
import { PG_URL, probePostgres } from './pg'

const pgAvailable = await probePostgres()
const SRC = resolve(import.meta.dir, '../src/index.ts')

function qb() {
  const models = {
    entries: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        kind: { type: 'text' },
        subject_text: { type: 'text' },
        previous_text: { type: 'text' },
      },
    },
  } as any
  return createQueryBuilder<any>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

/** The issue's own rows: `previous_text` is set on the second one only. */
const ROWS = [
  { kind: 'labeled', subject_text: 'first-row-only' },
  { kind: 'renamed', subject_text: 'second', previous_text: 'SHOULD PERSIST' },
]

describe('a multi-row INSERT names every column any row carries (#1189)', () => {
  let dialect: string
  beforeEach(() => { dialect = config.dialect })
  afterEach(() => { config.dialect = dialect as any })

  it('includes a column that only a later row sets', () => {
    config.dialect = 'sqlite' as any
    const sql = String((qb() as any).insertInto('entries').values(ROWS).toSQL())

    // Before the fix this read `("kind","subject_text")` and the third value
    // was absent from the statement entirely.
    expect(sql).toContain('"previous_text"')
    expect(sql).toContain('INSERT INTO "entries"("kind","subject_text","previous_text")')
  })

  it('orders the union by first appearance, so existing columns keep their place', () => {
    config.dialect = 'sqlite' as any
    const sql = String((qb() as any).insertInto('entries').values([
      { kind: 'a' },
      { subject_text: 'b' },
      { previous_text: 'c' },
    ]).toSQL())

    expect(sql).toContain('("kind","subject_text","previous_text")')
  })

  it('fills the gap with DEFAULT, so a column default still applies', () => {
    config.dialect = 'postgres' as any
    const sql = String((qb() as any).insertInto('entries').values(ROWS).toSQL())

    // Row 1 lacks previous_text. DEFAULT rather than a bound NULL: NULL would
    // override a non-null default and a NOT NULL column with a default would
    // reject the row. DEFAULT consumes no placeholder, hence $1..$5 for 6 cells.
    expect(sql).toContain('($1,$2,DEFAULT),($3,$4,$5)')
  })

  it('binds NULL on SQLite, which has no DEFAULT inside a VALUES list', () => {
    config.dialect = 'sqlite' as any
    const sql = String((qb() as any).insertInto('entries').values(ROWS).toSQL())

    // `near "DEFAULT": syntax error` — verified against bun:sqlite. So the
    // column default is lost here; the value the caller DID supply is not.
    expect(sql).toContain('(?,?,NULL),(?,?,?)')
  })

  it('leaves a uniform batch exactly as it was', () => {
    config.dialect = 'postgres' as any
    const sql = String((qb() as any).insertInto('entries').values([
      { kind: 'a', subject_text: 'x' },
      { kind: 'b', subject_text: 'y' },
    ]).toSQL())

    // The common case: no presence check, no DEFAULT, placeholders dense.
    expect(sql).toContain('($1,$2),($3,$4)')
    expect(sql).not.toContain('DEFAULT')
  })

  it('still emits nothing for an empty batch (#1097)', () => {
    config.dialect = 'sqlite' as any
    expect(String((qb() as any).insertInto('entries').values([]).toSQL())).not.toContain('INSERT')
  })
})

/**
 * The part that matters: the value has to be IN the table afterwards.
 *
 * In a subprocess because `config` is process-wide and other files pin the
 * dialect to sqlite, and because reading the row back is the only assertion
 * that could have failed while the bug was live — `toSQL()` does not expose
 * parameters, and every negative case ("this row has no previous_text") passed
 * throughout.
 */
function runProbe(body: string, env: Record<string, string> = {}): { code: number | null, output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qb-1189-'))
  try {
    const script = join(dir, 'probe.ts')
    writeFileSync(script, body)
    const child = Bun.spawnSync([process.execPath, script], {
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: child.exitCode, output: `${child.stdout.toString()}${child.stderr.toString()}` }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the value reaches the table (#1189)', () => {
  it('persists through every multi-row entry point on SQLite', () => {
    const { code, output } = runProbe(`
import { Database } from 'bun:sqlite'
import { setConfig, createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from ${JSON.stringify(SRC)}
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const file = join(mkdtempSync(join(tmpdir(), 'qb-1189-db-')), 'r.db')
new Database(file).run('CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, subject_text TEXT, previous_text TEXT)')
setConfig({ dialect: 'sqlite', database: { database: file } })

const models = { entries: { columns: { id: { type: 'integer', isPrimaryKey: true }, kind: { type: 'text' }, subject_text: { type: 'text' }, previous_text: { type: 'text' } } } }
const db = createQueryBuilder({ schema: buildDatabaseSchema(models), meta: buildSchemaMeta(models), autoMigration: { enabled: false } })
const ROWS = ${JSON.stringify(ROWS)}
const failures = []

async function check(label, run) {
  new Database(file).run('DELETE FROM entries')
  await run()
  const rows = new Database(file).query('SELECT kind, previous_text FROM entries ORDER BY id').all()
  if (rows.length !== 2)
    failures.push(label + ': expected 2 rows, got ' + rows.length)
  // The count was always right. This is the assertion the bug survived.
  if (rows[1]?.previous_text !== 'SHOULD PERSIST')
    failures.push(label + ': previous_text = ' + JSON.stringify(rows[1]?.previous_text))
  if (rows[0]?.previous_text !== null)
    failures.push(label + ': row 0 should be null, got ' + JSON.stringify(rows[0]?.previous_text))
}

await check('values()', () => db.insertInto('entries').values(ROWS).execute())
await check('createMany()', () => db.createMany('entries', ROWS))
await check('insertMany()', () => db.insertMany('entries', ROWS))

if (failures.length) {
  console.error(failures.join('\\n'))
  process.exit(1)
}
console.log('OK')
`)

    expect(output).toContain('OK')
    expect(code).toBe(0)
  }, 30_000)

  it.skipIf(!pgAvailable)('takes the column default, not NULL, for the gap on Postgres', () => {
    // Only observable against a real server: `note` is NOT NULL with a default
    // and is set on the second row only, so it IS in the union and row 1 has to
    // fill it. DEFAULT stores the default; a bound NULL would fail the NOT NULL
    // constraint outright.
    const { code, output } = runProbe(`
import { SQL } from 'bun'
import { setConfig, createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from ${JSON.stringify(SRC)}

const URL = ${JSON.stringify(PG_URL)}
const raw = new SQL(URL)
const T = 't1189_' + Date.now()
await raw.unsafe('CREATE TABLE ' + T + ' (id serial primary key, kind text, note text NOT NULL DEFAULT \\'from-column-default\\')')

setConfig({ dialect: 'postgres', database: { url: URL } })
const models = { [T]: { columns: { id: { type: 'integer', isPrimaryKey: true }, kind: { type: 'text' }, note: { type: 'text' } } } }
const db = createQueryBuilder({ schema: buildDatabaseSchema(models), meta: buildSchemaMeta(models), autoMigration: { enabled: false } })
const failures = []

try {
  await db.insertInto(T).values([{ kind: 'without-note' }, { kind: 'with-note', note: 'explicit' }]).execute()
  const rows = await raw.unsafe('SELECT kind, note FROM ' + T + ' ORDER BY id')
  if (rows[0]?.note !== 'from-column-default')
    failures.push('row 0 note = ' + JSON.stringify(rows[0]?.note) + ' (expected the column default)')
  if (rows[1]?.note !== 'explicit')
    failures.push('row 1 note = ' + JSON.stringify(rows[1]?.note))
}
catch (error) {
  failures.push('insert threw: ' + error.message)
}
finally {
  await raw.unsafe('DROP TABLE IF EXISTS ' + T)
  await raw.end()
}

if (failures.length) {
  console.error(failures.join('\\n'))
  process.exit(1)
}
console.log('OK')
`)

    expect(output).toContain('OK')
    expect(code).toBe(0)
  }, 30_000)
})
