// The declarations for the calls stacksjs/bun adds to Bun's SQL drivers.
//
// `bun-types` describes official Bun, so these are a module augmentation this
// package ships at `bun-query-builder/bun-sync`. Three things can go wrong
// without anything else failing: the file can stop being valid against the
// `bun-types` it augments, it can leak into projects that never asked for it,
// and the build can leave it out of the package.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dir, '..')
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const declarations = join(packageRoot, 'src/bun-sync.d.ts')

const uses = `import { SQL } from 'bun'
const sql = new SQL('postgres://localhost/app')

const rows = sql\`select 1 as one\`.executeSync()
export const first: unknown = rows[0]
export const count: number | null = rows.count
export const typed: { id: number }[] = sql<{ id: number }[]>\`select id from users\`.executeSync(5000)

const query = sql.unsafe('select pg_sleep(1)')
export const settled: boolean | null = query.wait(50)
export const same: typeof query = query.cancelSync(2000)

const reserved = sql.reserveSync(1000)
export const held: Bun.ReservedSQL | undefined = reserved
reserved?.unsafe('BEGIN').executeSync()
reserved?.release()
`

let project: string

async function check(name: string, source: string): Promise<{ exitCode: number, output: string }> {
  const file = join(project, `${name}.ts`)
  await writeFile(file, source)
  const run = Bun.spawnSync([process.execPath, compiler, '--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'esnext', '--module', 'esnext', '--moduleResolution', 'bundler', '--types', 'bun', file], { cwd: project, stdout: 'pipe', stderr: 'pipe' })
  return { exitCode: run.exitCode, output: run.stdout.toString() + run.stderr.toString() }
}

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), 'bqb-bun-sync-types-'))
  // The compiler finds `bun` types and this package the way a consumer's does.
  await mkdir(join(project, 'node_modules/@types'), { recursive: true })
  await symlink(dirname(require.resolve('@types/bun/package.json')), join(project, 'node_modules/@types/bun'))
  await symlink(dirname(require.resolve('bun-types/package.json')), join(project, 'node_modules/bun-types'))
  await symlink(packageRoot, join(project, 'node_modules/bun-query-builder'))
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

describe('bun-query-builder/bun-sync', () => {
  it('types the calls for a project that references it', async () => {
    const result = await check('referenced', `/// <reference path=${JSON.stringify(declarations)} />\n${uses}`)
    expect(result.output).toBe('')
    expect(result.exitCode).toBe(0)
  }, 120_000)

  it('gives what the calls really return, not any', async () => {
    const result = await check('wrong', `/// <reference path=${JSON.stringify(declarations)} />
import { SQL } from 'bun'
const sql = new SQL('postgres://localhost/app')
export const a: string = sql.unsafe('select 1').wait()
export const b: Bun.ReservedSQL = sql.reserveSync()
export const c: number = sql<{ id: number }[]>\`select id from users\`.executeSync()
`)
    expect(result.exitCode).not.toBe(0)
    for (const line of [4, 5, 6])
      expect(result.output).toContain(`wrong.ts(${line},`)
  }, 120_000)

  it('is opt-in: official Bun\'s types are untouched without the reference', async () => {
    const result = await check('unreferenced', uses)
    expect(result.exitCode).not.toBe(0)
    for (const call of ['executeSync', 'wait', 'cancelSync', 'reserveSync'])
      expect(result.output).toContain(`Property '${call}' does not exist`)
  }, 120_000)

  it('is in the package under the name the docs give', async () => {
    const manifest = await Bun.file(join(packageRoot, 'package.json')).json()
    const entry = manifest.exports['./bun-sync']
    expect(entry).toEqual({ types: './dist/bun-sync.d.ts', import: './dist/src/bun-sync.js' })
    // dist is what `bun run build` left; the root `test` script builds first.
    expect(await Bun.file(join(packageRoot, entry.types)).text()).toBe(await Bun.file(declarations).text())
    expect(await Bun.file(join(packageRoot, entry.import)).exists()).toBe(true)
    const result = await check('by-name', `/// <reference types="bun-query-builder/bun-sync" />\n${uses}`)
    expect(result.output).toBe('')
  }, 120_000)
})
