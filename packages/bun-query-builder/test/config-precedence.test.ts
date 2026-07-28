import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

    const script = `
      import { config, setConfig, getConfig } from ${JSON.stringify(SRC_INDEX)}
      ${setup}
      await getConfig()
      console.log(JSON.stringify({
        snapshotDir: config.snapshotDir,
        dialect: config.dialect,
        verbose: config.verbose,
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

    // The probe may share stdout with library chatter; the JSON is the last line.
    const lastLine = stdout.split('\n').filter(Boolean).at(-1) ?? ''
    return JSON.parse(lastLine) as ProbeResult
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
})
