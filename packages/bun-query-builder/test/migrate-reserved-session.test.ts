import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SQL } from 'bun'
import { expect, it } from 'bun:test'
import { PG_URL, probePostgres } from './pg'

const source = resolve(import.meta.dir, '../src/index.ts')
const connectionSource = resolve(import.meta.dir, '../src/db.ts')
const pgAvailable = await probePostgres()

async function probe(directory: string, script: string) {
  const file = join(directory, 'probe.ts')
  writeFileSync(file, script)
  const child = Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', file], {
    cwd: directory, env: process.env, stdout: 'pipe', stderr: 'pipe',
  })
  let timedOut = false
  // Allow the real PostgreSQL integration path to cross an SSH tunnel; its
  // queries take about nine seconds there. Keep a hard child deadline so a
  // pool deadlock fails without leaving the subprocess running.
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 20_000)
  try {
    const [code, out, err] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    return { code, out, err, timedOut }
  } finally {
    clearTimeout(deadline)
  }
}

it('does not execute ledger or migration SQL when reservation fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qb-migration-reservation-'))
  try {
    writeFileSync(join(directory, 'package.json'), '{"name":"synthetic-migration-probe"}')
    const migrations = join(directory, 'migrations')
    mkdirSync(migrations)
    writeFileSync(join(migrations, '0001-synthetic.sql'), 'CREATE TABLE synthetic_items (id INTEGER);')
    const result = await probe(directory, `
      import { setConfig, getConfig, executeMigrationWithReport } from ${JSON.stringify(source)}
      import { setSqlInstance } from ${JSON.stringify(connectionSource)}
      setConfig({ dialect: 'postgres', database: { url: 'postgres://synthetic.invalid/synthetic' }, verbose: false })
      await getConfig()
      const queries = []
      const connection = Object.assign(() => {}, {
        unsafe: async (query) => { queries.push(query); return [] },
        reserve: async () => { throw new Error('synthetic reservation refused') },
        close: async () => {},
      })
      setSqlInstance(connection)
      let failure = ''
      try { await executeMigrationWithReport(${JSON.stringify(migrations)}, { auditDrift: false }) }
      catch (error) { failure = error.message }
      console.log(JSON.stringify({ failure, queries: queries.length }))
    `)
    if (result.timedOut) throw new Error(`Probe timed out: ${result.out} ${result.err}`)
    if (result.code !== 0) throw new Error(`Reservation probe failed (${result.code}): ${result.err}`)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out.trim().split('\n').at(-1)!)).toEqual({ failure: 'synthetic reservation refused', queries: 0 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

it.skipIf(!pgAvailable)('uses one reserved session for fresh, repeat and failed transactional migrations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qb-migration-one-session-'))
  const key = randomUUID().replaceAll('-', '')
  const table = `mig_reserved_${key}`
  const good = `0001-${key}.sql`
  const bad = `0002-${key}.sql`
  const cleanup = new SQL(PG_URL)
  try {
    writeFileSync(join(directory, 'package.json'), '{"name":"synthetic-migration-probe"}')
    const goodDir = join(directory, 'good')
    const badDir = join(directory, 'bad')
    mkdirSync(goodDir); mkdirSync(badDir)
    writeFileSync(join(goodDir, good), `CREATE TABLE ${table} (id INTEGER PRIMARY KEY); INSERT INTO ${table} VALUES (1);`)
    writeFileSync(join(badDir, bad), `INSERT INTO ${table} VALUES (2); INSERT INTO ${table} VALUES (1);`)
    const result = await probe(directory, `
      import { setConfig, createQueryBuilder, executeMigrationWithReport } from ${JSON.stringify(source)}
      import { closeConnection } from ${JSON.stringify(connectionSource)}
      setConfig({ dialect: 'postgres', database: { url: ${JSON.stringify(PG_URL)}, pool: { max: 1 } }, verbose: false })
      const first = await executeMigrationWithReport(${JSON.stringify(goodDir)}, { auditDrift: false })
      const repeat = await executeMigrationWithReport(${JSON.stringify(goodDir)}, { auditDrift: false })
      let failed = false
      try { await executeMigrationWithReport(${JSON.stringify(badDir)}, { auditDrift: false }) } catch { failed = true }
      const afterFailure = await executeMigrationWithReport(${JSON.stringify(goodDir)}, { auditDrift: false })
      const qb = createQueryBuilder()
      const rows = await qb.unsafe('SELECT id FROM ${table} ORDER BY id')
      const ledger = await qb.unsafe('SELECT migration FROM migrations WHERE migration IN ($1, $2) ORDER BY migration', [${JSON.stringify(good)}, ${JSON.stringify(bad)}])
      await closeConnection()
      console.log(JSON.stringify({ first: first.executed.length, repeat: repeat.executed.length, failed, afterFailure: afterFailure.executed.length, rows, ledger }))
    `)
    if (result.timedOut) throw new Error(`Probe timed out: ${result.out} ${result.err}`)
    if (result.code !== 0) throw new Error(`Migration probe failed (${result.code}): ${result.err}`)
    expect(JSON.parse(result.out.trim().split('\n').at(-1)!)).toEqual({
      first: 1, repeat: 0, failed: true, afterFailure: 0,
      rows: [{ id: 1 }], ledger: [{ migration: good }],
    })
  } finally {
    await cleanup.unsafe(`DROP TABLE IF EXISTS ${table}`)
    await cleanup.unsafe('DELETE FROM migrations WHERE migration IN ($1, $2)', [good, bad]).catch(error => {
      if (error.errno !== '42P01') throw error
    })
    await cleanup.end()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
