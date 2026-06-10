/**
 * Regression: getConfig() must apply a config file (and env vars, via bunfig)
 * to the LIVE process-wide `config` singleton that the query builder reads.
 *
 * Previously getConfig() loaded into a private `_config` variable that nothing
 * else read, so a `query-builder.config.ts` silently never took effect. The
 * fix routes the loaded config through setConfig(). Run in a fresh process so
 * the global config and cwd-based file discovery are isolated from other tests.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '../src/index.ts')

describe('getConfig() applies a config file to the runtime singleton', () => {
  it('merges query-builder.config.ts into the shared config (incl. nested + env)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qb-cfgfile-'))
    writeFileSync(
      join(dir, 'query-builder.config.ts'),
      `export default { dialect: 'mysql', pagination: { defaultPerPage: 7 } }\n`,
    )
    const probe = join(dir, 'probe.ts')
    writeFileSync(probe, `
import { config, getConfig } from ${JSON.stringify(SRC)}
const before = config.dialect
await getConfig()
const out = {
  before,
  dialect: config.dialect,
  perPage: config.pagination.defaultPerPage,
  // unspecified keys keep their defaults (merge, not replace)
  cursorColumn: config.pagination.cursorColumn,
  // env var via bunfig (QUERY_BUILDER_ prefix from config name) reaches the singleton
  verboseFromEnv: config.verbose,
}
process.stdout.write(JSON.stringify(out))
`)
    const proc = Bun.spawnSync({
      cmd: ['bun', probe],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, QUERY_BUILDER_VERBOSE: 'false' },
    })
    const stdout = new TextDecoder().decode(proc.stdout).trim()
    const stderr = new TextDecoder().decode(proc.stderr).trim()
    rmSync(dir, { recursive: true, force: true })

    expect(proc.exitCode, `probe failed.\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.before).toBe('postgres') // default before load
    expect(out.dialect).toBe('mysql') // from config file
    expect(out.perPage).toBe(7) // nested value from file
    expect(out.cursorColumn).toBe('id') // nested default preserved (deep merge)
    expect(out.verboseFromEnv).toBe(false) // env var applied via bunfig
  })
})
