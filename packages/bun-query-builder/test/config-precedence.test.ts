import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Config precedence: `defaults < config file < setConfig()`.
 *
 * This is regression cover for a bug that came back repeatedly: `getConfig()`
 * loaded the config file with `defaultConfig` as bunfig's defaults, so it got
 * back a FULLY-POPULATED object and pushed every key of it into the singleton.
 * Calling `getConfig()` therefore reset settings the config file never
 * mentioned back to library defaults — most visibly `snapshotDir`, which
 * reverted to `.qb` and wrote generated state into the project root of any host
 * framework that had configured it via `setConfig()`.
 *
 * `getConfig()` memoizes the file load per process, so each case runs in its
 * own subprocess against its own cwd. That is also the only way to exercise the
 * config-FILE half at all.
 */

const SRC_INDEX = resolve(__dirname, '../src/index.ts')

interface ProbeResult {
  snapshotDir?: string
  dialect?: string
  verbose?: boolean
  dbHost?: string
  dbPort?: number
  dbUrl?: string
}

/**
 * Run `setup` (optional `setConfig` calls) then `getConfig()` in a fresh
 * process rooted at a temp dir holding `configFile`, and report the resulting
 * config values.
 */
function probe(configFile: string, setup: string): ProbeResult {
  const dir = mkdtempSync(join(tmpdir(), 'qb-precedence-'))

  try {
    writeFileSync(join(dir, 'query-builder.config.ts'), configFile)
    const resultPath = join(dir, 'result.json')

    const script = `
      import { config, setConfig, getConfig } from ${JSON.stringify(SRC_INDEX)}
      ${setup}
      await getConfig()
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
        snapshotDir: config.snapshotDir,
        dialect: config.dialect,
        verbose: config.verbose,
        dbHost: config.database?.host,
        dbPort: config.database?.port,
        dbUrl: config.database?.url,
      }))
    `

    const scriptPath = join(dir, 'probe.ts')
    writeFileSync(scriptPath, script)

    const proc = Bun.spawnSync({
      cmd: ['bun', scriptPath],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })

    const stdout = new TextDecoder().decode(proc.stdout).trim()
    const stderr = new TextDecoder().decode(proc.stderr).trim()

    if (proc.exitCode !== 0)
      throw new Error(`probe exited ${proc.exitCode}: ${stderr || stdout}`)

    return JSON.parse(readFileSync(resultPath, 'utf8')) as ProbeResult
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('config precedence', () => {
  it('applies the config file when nothing was set programmatically', () => {
    const result = probe(
      `export default { dialect: 'sqlite', snapshotDir: 'from-file', verbose: false }`,
      '',
    )

    expect(result.snapshotDir).toBe('from-file')
    expect(result.dialect).toBe('sqlite')
    expect(result.verbose).toBe(false)
  })

  it('keeps setConfig() values that the config file does not mention', () => {
    // The original bug: the file says nothing about snapshotDir, yet getConfig()
    // still reset it to the '.qb' default, discarding the embedder's choice.
    const result = probe(
      `export default { dialect: 'sqlite' }`,
      `setConfig({ snapshotDir: 'from-embedder', verbose: false })`,
    )

    expect(result.snapshotDir).toBe('from-embedder')
    expect(result.verbose).toBe(false)
  })

  it('lets setConfig() outrank the config file on the same key', () => {
    const result = probe(
      `export default { snapshotDir: 'from-file' }`,
      `setConfig({ snapshotDir: 'from-embedder' })`,
    )

    expect(result.snapshotDir).toBe('from-embedder')
  })

  it('leaves defaults in place for keys neither source sets', () => {
    const result = probe(
      `export default { dialect: 'sqlite' }`,
      '',
    )

    expect(result.snapshotDir).toBe('.qb')
  })

  /**
   * The veto is per SECTION, not per leaf — naming one field of `database`
   * discards the file's whole `database` section.
   *
   * That looks coarse, and a per-leaf veto was tried. It is wrong, because the
   * fields of a section are not always independent settings: `database.url` and
   * the discrete `host`/`port`/`username`/`password` are two mutually exclusive
   * SPELLINGS of one setting, and `createConnectionString()` returns `url`
   * verbatim without reading any of the others. Under a per-leaf veto, an
   * embedder passing discrete credentials never names `url`, so a stale `url`
   * in the config file survives the merge and silently wins — the app connects
   * to a different database than the one its own code asked for.
   *
   * So an embedder who speaks for a section owns that whole section.
   */
  it('discards the whole section from the file when setConfig named any of it', () => {
    const result = probe(
      `export default { database: { port: 6543 } }`,
      `setConfig({ database: { host: 'from-embedder' } })`,
    )

    expect(result.dbHost).toBe('from-embedder')
    expect(result.dbPort).toBe(5432)
  })

  it('keeps a config-file section that setConfig never mentioned', () => {
    const result = probe(
      `export default { database: { host: 'from-file', port: 6543 } }`,
      `setConfig({ snapshotDir: 'from-embedder' })`,
    )

    expect(result.dbHost).toBe('from-file')
    expect(result.dbPort).toBe(6543)
    expect(result.snapshotDir).toBe('from-embedder')
  })

  /**
   * The wrong-database scenario itself, pinned directly: a config file left
   * over with a `url`, and application code configuring discrete credentials.
   */
  it('does not let a stale url in the config file override configured credentials', () => {
    const result = probe(
      `export default { database: { url: 'postgres://user:pw@stale-host:5432/stale_db' } }`,
      `setConfig({ database: { host: 'real-host', port: 6543, database: 'real_db' } })`,
    )

    expect(result.dbUrl).toBeUndefined()
    expect(result.dbHost).toBe('real-host')
    expect(result.dbPort).toBe(6543)
  })
})
