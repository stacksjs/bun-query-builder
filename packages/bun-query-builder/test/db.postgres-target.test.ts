import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PG_URL, probePostgres } from './pg'

/**
 * How long the isolation child gets.
 *
 * Its work - create two databases, exercise four connection configurations
 * against them, write a marker table, drop both - is under 2s on an idle
 * machine and up to ~9s on a busy one. 90s is generous on purpose: the old 30s
 * was ~3x the loaded cost and ran out twice, and the only thing a tight bound
 * buys is a faster failure on a hang this has never had.
 */
const CHILD_TIMEOUT_MS = 90_000

const available = await probePostgres()

test.skipIf(!available)('explicit PostgreSQL targets remain isolated with PGDATABASE exported', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qb-postgres-target-'))
  const script = join(directory, 'check.ts')
  writeFileSync(script, `
import assert from 'node:assert/strict'
import { SQL } from 'bun'
import { setConfig } from ${JSON.stringify(resolve(import.meta.dir, '../src/config.ts'))}
import { getBunSql } from ${JSON.stringify(resolve(import.meta.dir, '../src/db.ts'))}
const adminUrl = new URL(${JSON.stringify(PG_URL)})
const admin = new SQL(adminUrl.href, { database: decodeURIComponent(adminUrl.pathname.slice(1)) })
const names = ['qb_target_a_' + crypto.randomUUID().replaceAll('-', ''), 'qb_target_b_' + crypto.randomUUID().replaceAll('-', '') + '_a b']
const created = []
try {
  for (const name of names) {
    await admin.unsafe('CREATE DATABASE "' + name + '"')
    created.push(name)
  }
  const ambient = new URL(adminUrl); ambient.pathname = '/' + names[0]
  process.env.PGDATABASE = names[0]
  process.env.POSTGRES_URL = ambient.href
  delete process.env.DB_CONNECTION
  delete process.env.DB_DATABASE
  for (const useUrl of [true, false]) {
  for (const pool of [undefined, { max: 2, acquireTimeoutMs: 2000 }]) {
    const target = new URL(adminUrl); target.pathname = '/' + names[1]
    const connection = useUrl ? { url: target.href } : { url: undefined, database: names[1], host: target.hostname, port: Number(target.port || 5432), username: decodeURIComponent(target.username), password: decodeURIComponent(target.password) }
    setConfig({ dialect: 'postgres', database: { ...connection, pool } })
    const sql = getBunSql()
    try {
      const rows = await sql.unsafe('SELECT current_database() AS name')
      assert.equal(rows[0].name, names[1], 'an explicit URL must select its own database')
      await sql.unsafe('CREATE TABLE IF NOT EXISTS target_marker (id INTEGER PRIMARY KEY)')
      await sql.unsafe('INSERT INTO target_marker VALUES (1) ON CONFLICT DO NOTHING')
    } finally { await sql.close() }
  }
  }
  setConfig({ dialect: 'postgres', database: { url: ambient.href } })
  const first = getBunSql()
  try {
    const rows = await first.unsafe("SELECT to_regclass('public.target_marker') AS table_name")
    assert.equal(rows[0].table_name, null, 'writes must not leak into the ambient database')
  } finally { await first.close() }
  console.log('PostgreSQL target isolation verified')
} finally {
  for (const name of created.reverse()) await admin.unsafe('DROP DATABASE "' + name + '" WITH (FORCE)')
  await admin.close()
}
`)
  try {
    /*
     * Two budgets, and the inner one is what bites.
     *
     * The child creates two databases, exercises four connection
     * configurations against them, writes a marker table, then drops both.
     * The old `timeout: 30_000` was about 3x its loaded cost, and it ran out
     * twice on a busy machine, surfacing as
     * `expect(child.exitCode).toBe(0)` failing at just over 30s. The 35s test
     * budget was never reached, so raising only that would have changed
     * nothing: spawnSync kills the child first and the assertion fails on the
     * corpse.
     *
     * The test budget stays comfortably above CHILD_TIMEOUT_MS so the child's
     * own timeout is always the one that reports, with its stdout and stderr
     * attached, rather than bun:test killing the case first and saying nothing.
     */
    const child = Bun.spawnSync([process.execPath, script], { stdout: 'pipe', stderr: 'pipe', timeout: CHILD_TIMEOUT_MS })

    // Say so when the child was killed rather than finished. Without this a
    // timeout reads as `expected null to be 0`, which looks like the isolation
    // logic broke when nothing ran long enough to have an opinion.
    if (child.signalCode) {
      throw new Error(
        `the isolation child was killed by ${child.signalCode} after ${CHILD_TIMEOUT_MS}ms, so it `
        + `did not finish. That is a timeout, not an isolation failure - the work is under 2s `
        + `idle and ~9s loaded, so suspect machine load or an unreachable Postgres before `
        + `suspecting the code.\n`
        + `stdout: ${child.stdout}\nstderr: ${child.stderr}`,
      )
    }

    expect(child.exitCode, `${child.stdout}\n${child.stderr}`).toBe(0)
    expect(child.stdout.toString()).toContain('PostgreSQL target isolation verified')
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}, 120_000)
