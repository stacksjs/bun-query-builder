import { resolve } from 'node:path'
import { SQL } from 'bun'
import { describe, expect, it } from 'bun:test'
import { PG_URL, probePostgres } from './pg'

const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(PG_URL).hostname)
const available = local && await probePostgres()

describe.skipIf(!available)('Postgres introspection uses the owning relation', () => {
  it('distinguishes equal constraint names across schemas and excludes included columns', async () => {
    const database = `qb_introspection_${process.pid}_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
    const admin = new SQL(PG_URL)
    const url = new URL(PG_URL)
    url.pathname = `/${database}`
    try {
      await admin.unsafe(`CREATE DATABASE "${database}"`)
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--no-env-file', resolve(import.meta.dir, 'fixtures/introspect-pg-scope.ts')],
        env: { ...process.env, QB_PG_INTROSPECTION_URL: url.href },
        stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      })
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toContain('Postgres key ownership passed')
    }
    finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      await admin.end()
    }
  }, 40_000)
})
