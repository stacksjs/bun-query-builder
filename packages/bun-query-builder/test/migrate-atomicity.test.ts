/**
 * Regression coverage for stacksjs/bun-query-builder#1067.
 *
 * `executeMigration` applied each `.sql` file with no transaction and no lock,
 * recording it afterwards. Two consequences, and they need different dialects
 * to observe, which is worth stating because it is not obvious:
 *
 *  - PARTIAL APPLICATION shows up on SQLite. The sqlite wrapper splits a file
 *    into statements and runs them one at a time, so a file that fails partway
 *    leaves the earlier statements committed. (Postgres does not reproduce it
 *    through this path: Bun sends the file as one multi-statement query, which
 *    the server already runs in an implicit transaction. The wrap still closes
 *    the apply/record gap there, and matters for anyone applying files another
 *    way — but the statement-level hole is a sqlite one.)
 *
 *  - CONCURRENT RUNS need a real pooled driver, so that half is gated on a live
 *    Postgres. SQLite has no advisory-lock primitive and a single-writer file,
 *    so it has no collision to prevent.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { SQL } from 'bun'
import { describe, expect, it } from 'bun:test'
import { PG_URL, probePostgres } from './pg'

const pgAvailable = await probePostgres()

const SRC = resolve(import.meta.dir, '../src/index.ts')


/** A throwaway workspace with a migrations directory. */
function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'qb-mig-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe' }))
  const migrations = join(dir, 'database', 'migrations')
  mkdirSync(migrations, { recursive: true })
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(migrations, name), body)
  return dir
}

function run(dir: string, name: string, script: string): { code: number, out: string, err: string } {
  const path = join(dir, name)
  writeFileSync(path, script)
  const proc = Bun.spawnSync({ cmd: ['bun', path], cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
  return {
    code: proc.exitCode ?? -1,
    out: new TextDecoder().decode(proc.stdout).trim(),
    err: new TextDecoder().decode(proc.stderr).trim(),
  }
}

const lastJson = (out: string): any => JSON.parse(out.split('\n').filter(Boolean).at(-1) ?? '{}')

describe('migration atomicity (#1067)', () => {
  it('rolls the whole file back when one of its statements fails', () => {
    // Statement 1 is valid, statement 2 is not. Unwrapped, `mig_a` survives the
    // failure and the file is left neither applied nor cleanly re-runnable.
    const dir = workspace({
      '0000000001-partial.sql': [
        'CREATE TABLE mig_a (id INTEGER PRIMARY KEY);',
        'CREATE TABLE mig_b (id INTEGER PRIMARY KEY, oops NOT_A_TYPE CHECK());',
      ].join('\n'),
    })

    const result = run(dir, 'probe.ts', `
import { Database } from 'bun:sqlite'
import { setConfig, executeMigration } from ${JSON.stringify(SRC)}

setConfig({ dialect: 'sqlite', database: { database: './t.sqlite' }, verbose: false })
try { await executeMigration(process.cwd()) } catch {}

const db = new Database('./t.sqlite')
// Explicit names, not a LIKE: 'mig_%' also matches the 'migrations' ledger.
const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mig_a','mig_b')").all()
console.log(JSON.stringify({ leftBehind: tables.map(r => r.name) }))
`)

    rmSync(dir, { recursive: true, force: true })
    if (result.code !== 0)
      throw new Error(`probe exited ${result.code}: ${result.err || result.out}`)

    // Was ['mig_a'] — the first statement had already committed.
    expect(lastJson(result.out).leftBehind).toEqual([])
  })
})

describe.skipIf(!pgAvailable)('migration locking (#1067)', () => {
  it('serialises concurrent runs instead of letting both apply', () => {
    // Both processes start against an empty ledger, so without the lock both
    // see the migration as pending, both run it, and the loser dies on
    // 'relation already exists'.
    // `pg_sleep` widens the window on purpose. Without it the two processes may
    // simply not overlap, and the test passes whether or not the lock exists —
    // a concurrency test that only sometimes exercises concurrency is worse
    // than none. One second is far longer than the other process needs to reach
    // the same point, so they are guaranteed to contend.
    const dir = workspace({
      '0000000001-concurrent.sql': [
        'SELECT pg_sleep(1);',
        'CREATE TABLE mig_concurrent (id serial primary key);',
      ].join('\n'),
    })

    writeFileSync(join(dir, 'worker.ts'), `
import { setConfig, executeMigration } from ${JSON.stringify(SRC)}
setConfig({ dialect: 'postgres', database: { url: ${JSON.stringify(PG_URL)} }, verbose: false })
await executeMigration(process.cwd())
`)

    const result = run(dir, 'probe.ts', `
import { SQL } from 'bun'
// Clear only this migration's traces — the ledger is shared with the rest of
// the suite, so dropping it wholesale would delete other files' bookkeeping.
const reset = new SQL(${JSON.stringify(PG_URL)})
await reset.unsafe('DROP TABLE IF EXISTS mig_concurrent')
await reset.unsafe("DELETE FROM migrations WHERE migration = '0000000001-concurrent.sql'").catch(() => {})
await reset.end()

const a = Bun.spawn({ cmd: ['bun', 'worker.ts'], cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
const b = Bun.spawn({ cmd: ['bun', 'worker.ts'], cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
const codes = await Promise.all([a.exited, b.exited])

// Count only THIS migration. The suite shares one Postgres database, so other
// files leave rows in the ledger and a total count is not ours to assert on.
const check = new SQL(${JSON.stringify(PG_URL)})
const [{ count }] = await check.unsafe(
  "SELECT count(*)::int as count FROM migrations WHERE migration = '0000000001-concurrent.sql'",
)
await check.unsafe('DROP TABLE IF EXISTS mig_concurrent')
await check.unsafe("DELETE FROM migrations WHERE migration = '0000000001-concurrent.sql'")
await check.end()
console.log(JSON.stringify({ codes, recorded: count }))
`)

    rmSync(dir, { recursive: true, force: true })
    if (result.code !== 0)
      throw new Error(`probe exited ${result.code}: ${result.err || result.out}`)

    const { codes, recorded } = lastJson(result.out)
    // Both succeed: the loser waits for the lock, then finds nothing pending.
    expect(codes).toEqual([0, 0])
    // And it is recorded once, not twice.
    expect(recorded).toBe(1)
  })
})
