import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PG_URL, probePostgres } from './pg'

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
    const child = Bun.spawnSync([process.execPath, script], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    expect(child.exitCode, `${child.stdout}\n${child.stderr}`).toBe(0)
    expect(child.stdout.toString()).toContain('PostgreSQL target isolation verified')
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}, 35_000)
