/**
 * `?` inside literals and comments on Postgres.
 *
 * The ORM rewrote `?` to `$n` with a bare `sql.replace(/\?/g, …)`. `whereRaw`
 * fragments are caller text, so on live Postgres:
 *
 *  - `whereRaw("label = '?'")` went out as `label = '$1'` and matched nothing;
 *  - a `?` in a comment took a number, pushing the real placeholders past the
 *    bindings: `could not determine data type of parameter $2`.
 *
 * The select/update builders' `{ sql, parameters }` expressions numbered the
 * first N `?` the same way, so a literal `'?'` before a placeholder stole its
 * number and left the placeholder unbound.
 *
 * Runs in a subprocess: an earlier configureOrm() in the same process pins the
 * model layer to sqlite and would mask the network-driver path.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { PG_URL, probePostgres } from './pg'

const pgAvailable = await probePostgres()

describe.skipIf(!pgAvailable)('? inside literals and comments on live Postgres', () => {
  it('binds only the placeholders, in the ORM and the builders', () => {
    const srcEntry = resolve(import.meta.dir, '../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'qb-pgph-'))
    const scriptPath = join(dir, 'probe.ts')

    writeFileSync(scriptPath, `
import { SQL } from 'bun'
import { setConfig, resetConnection, defineModel, clearModelRegistry, createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from ${JSON.stringify(srcEntry)}

const URL = ${JSON.stringify(PG_URL)}
const failures = []
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) failures.push(label + ': got ' + g + ', want ' + w)
}
const attempt = async (label, fn) => {
  try { return await fn() }
  catch (e) { failures.push(label + ': threw ' + (e && e.message)); return undefined }
}

const raw = new SQL(URL)
await raw.unsafe('DROP TABLE IF EXISTS _qb_pgph')
await raw.unsafe('CREATE TABLE _qb_pgph (id int primary key, label text not null, tags jsonb not null)')
await raw.unsafe(\`INSERT INTO _qb_pgph VALUES (1, '?', '["bun"]'), (2, 'b', '["node"]'), (3, 'c', '[]')\`)

setConfig({ dialect: 'postgres', database: { url: URL } })
resetConnection()
clearModelRegistry()
const Row = defineModel({ name: 'Pgph', table: '_qb_pgph', primaryKey: 'id',
  attributes: { label: { type: 'string', fillable: true }, tags: { type: 'json', fillable: true } } })
const ids = rows => (rows ?? []).map(r => Number(r.id ?? r.get('id'))).sort((a, b) => a - b)

// ORM whereRaw. Matched nothing / threw 42P18 before.
check('literal ?', ids(await attempt('literal ?', () => Row.query().whereRaw("label = '?'").get())), [1])
check('comment ?', ids(await attempt('comment ?', () =>
  Row.query().whereRaw('id = ? /* or ? */ OR label = ?', 1, 'b').get())), [1, 2])
check('literal ? then where', ids(await attempt('literal ? then where', () =>
  Row.query().whereRaw("label <> '?'").where('id', 2).get())), [2])
check('jsonb_exists', ids(await attempt('jsonb_exists', () =>
  Row.query().whereRaw('jsonb_exists(tags, ?)', 'bun').get())), [1])

// Builder { sql, parameters } expressions.
const models = { _qb_pgph: { columns: { id: { type: 'integer', isPrimaryKey: true }, label: { type: 'text' }, tags: { type: 'json' } } } }
const db = createQueryBuilder({ schema: buildDatabaseSchema(models), meta: buildSchemaMeta(models), autoMigration: { enabled: false } })
await attempt('update with bound expression', () =>
  db.updateTable('_qb_pgph').set({ label: 'z' }).where({ sql: "label <> '?' AND id = ?", parameters: [3] }).execute())
check('update landed', (await raw.unsafe('SELECT id, label FROM _qb_pgph ORDER BY id')).map(r => r.label), ['?', 'b', 'z'])

await raw.unsafe('DROP TABLE IF EXISTS _qb_pgph')
await raw.end()

if (failures.length) {
  console.error('FAILURES:\\n' + failures.join('\\n'))
  process.exit(1)
}
console.log('OK')
process.exit(0)
`)

    const proc = Bun.spawnSync({ cmd: ['bun', scriptPath], stdout: 'pipe', stderr: 'pipe', cwd: process.cwd(), env: { ...process.env } })
    const dec = new TextDecoder()
    const out = dec.decode(proc.stdout).trim()
    const err = dec.decode(proc.stderr).trim()
    rmSync(dir, { recursive: true, force: true })

    expect(proc.exitCode, `pg placeholder probe failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toContain('OK')
  }, 30_000)
})
