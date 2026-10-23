/**
 * Every statement a builder issues must go through the builder's OWN
 * connection (`_sql`), never the module-global `bunSql`.
 *
 * They are the same object for a plain builder, so this is invisible until a
 * builder is created with a connection of its own — which is exactly what
 * `db.transaction()` does for its callback. Then the global is a DIFFERENT
 * pooled session, and ~29 helper methods were using it:
 *
 *  - A write inside `db.transaction()` autocommitted on that other session and
 *    SURVIVED THE ROLLBACK. The transaction failed, the caller saw the error,
 *    and the row was still in the table. Silent, with no driver error.
 *  - A read inside the transaction could not see the transaction's own
 *    uncommitted rows, so `tx.count()` returned 0 for a row `tx` had just
 *    inserted and read-then-decide logic acted on stale data.
 *
 * SQLite cannot catch either one: `bunSql` and the transaction share a single
 * `bun:sqlite` handle, so the distinction the bug turns on does not exist. It
 * needs a real pooled driver, so this file is gated on a live Postgres and runs
 * in a subprocess (an earlier `configureOrm()` elsewhere in the suite pins the
 * global executor at sqlite and would mask the network path).
 *
 * `unsafe()` was fixed for this once already (client.ts, the comment about raw
 * SQL escaping the transaction); these are the rest of the same family.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { SQL } from 'bun'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'

/*
 * Raised from bun:test's 5000ms default, which this file is not slow enough to
 * need and was failing against anyway.
 *
 * Every case here does real I/O — opens Postgres connections in a subprocess — so its duration tracks machine load
 * rather than the code under test. Normally 262ms. Under load these crossed
 * the line and failed at 5001–5242ms, and the failing SET changed from run to
 * run, which is the signature of a budget rather than a bug: the runs that
 * produced them took 126–199s against a ~35s baseline.
 *
 * 30s absorbs that inflation while staying bounded enough that a genuine hang
 * fails instead of stalling CI. It governs hooks as well as test bodies, which
 * matters because a timed-out `beforeAll` fails the whole file rather than one
 * case — that is how one slow run here took out the next file too.
 *
 * Deliberately per-file rather than `--timeout` on the test script: that would
 * raise the budget for all 2552 tests, including the pure unit ones where
 * 5000ms is a useful signal that something is wrong.
 */
setDefaultTimeout(30_000)
import { PG_URL, probePostgres } from './pg'

const pgAvailable = await probePostgres()



describe.skipIf(!pgAvailable)('builder-local connection routing', () => {
  it('keeps transactional writes inside the transaction, and reads inside it current', () => {
    const srcEntry = resolve(import.meta.dir, '../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'qb-txconn-'))
    const scriptPath = join(dir, 'probe.ts')

    writeFileSync(scriptPath, `
import { SQL } from 'bun'
import { setConfig, createQueryBuilder, buildDatabaseSchema } from ${JSON.stringify(srcEntry)}

const URL = ${JSON.stringify(PG_URL)}
const raw = new SQL(URL)
await raw.unsafe('DROP TABLE IF EXISTS _qb_txconn')
await raw.unsafe('CREATE TABLE _qb_txconn (id serial primary key, name text)')

setConfig({ dialect: 'postgres', database: { url: URL } })
const schema = buildDatabaseSchema({
  Widget: { name: 'Widget', table: '_qb_txconn', primaryKey: 'id', attributes: { id: { validation: { rule: {} } }, name: { validation: { rule: {} } } } },
})
const db = createQueryBuilder({ schema })

// A write in a transaction that throws must not outlive the ROLLBACK.
try {
  await db.transaction(async (tx) => {
    await tx.insertGetId('_qb_txconn', { name: 'rolled-back' })
    throw new Error('deliberate failure')
  })
}
catch {}
const survivors = await raw.unsafe('SELECT name FROM _qb_txconn')

// A read in a transaction must see that transaction's own uncommitted write.
let seenInside = -1
await db.transaction(async (tx) => {
  await tx.insertGetId('_qb_txconn', { name: 'committed' })
  seenInside = Number(await tx.count('_qb_txconn'))
})
const committed = await raw.unsafe('SELECT name FROM _qb_txconn')

await raw.unsafe('DROP TABLE IF EXISTS _qb_txconn')
await raw.end()

console.log(JSON.stringify({
  survivedRollback: survivors.length,
  seenInside,
  committed: committed.length,
}))
`)

    const proc = Bun.spawnSync({ cmd: ['bun', scriptPath], cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    const stdout = new TextDecoder().decode(proc.stdout).trim()
    const stderr = new TextDecoder().decode(proc.stderr).trim()
    rmSync(dir, { recursive: true, force: true })

    if (proc.exitCode !== 0)
      throw new Error(`probe exited ${proc.exitCode}: ${stderr || stdout}`)

    const result = JSON.parse(stdout.split('\n').filter(Boolean).at(-1) ?? '{}')

    // Was 1 — the write autocommitted on the global connection and outlived the rollback.
    expect(result.survivedRollback).toBe(0)
    // Was 0 — the count ran on the global connection and could not see the tx's row.
    expect(result.seenInside).toBe(1)
    expect(result.committed).toBe(1)
  })
})
