import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

const packageRoot = resolve(import.meta.dir, '..')
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const outputLimit = 256 * 1024
type OwnedChild = Bun.Subprocess<'ignore', 'pipe', 'pipe'>
const children = new Set<OwnedChild>()
let ownedRoot: string | undefined
let consumer: string

function stop(child: OwnedChild): void {
  try {
    if (process.platform === 'win32')
      child.kill('SIGKILL')
    else
      process.kill(-child.pid, 'SIGKILL')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      throw error
  }
}

async function run(command: string[], cwd: string, timeoutMs: number, temporaryDirectory?: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test',
      ...(temporaryDirectory ? { TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory } : {}),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: process.platform !== 'win32',
  })
  children.add(child)
  let timedOut = false
  let overflow = false
  const timer = setTimeout(() => {
    timedOut = true
    stop(child)
  }, timeoutMs)
  async function capture(stream: ReadableStream<Uint8Array>): Promise<string> {
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of stream) {
      const remaining = outputLimit - bytes
      if (remaining > 0)
        chunks.push(chunk.subarray(0, remaining))
      bytes += chunk.byteLength
      if (bytes > outputLimit) {
        overflow = true
        stop(child)
      }
    }
    return Buffer.concat(chunks).toString()
  }
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      capture(child.stdout),
      capture(child.stderr),
    ])
    return { exitCode, stdout, stderr, timedOut, overflow }
  }
  finally {
    clearTimeout(timer)
    stop(child)
    await child.exited
    children.delete(child)
  }
}

async function cleanup(): Promise<void> {
  for (const child of children)
    stop(child)
  await Promise.all([...children].map(child => child.exited))
  if (ownedRoot)
    await rm(ownedRoot, { recursive: true, force: true })
}

const cases = [
  {
    name: 'root model inference',
    source: `import { defineModel } from 'bun-query-builder'
import type { ModelRow } from 'bun-query-builder'
const model = defineModel({
  name: 'PublicUser', table: 'public_users',
  attributes: { name: { type: 'string', fillable: true }, age: { type: 'number', fillable: true } },
} as const)
declare const row: ModelRow<typeof model>
export const name: string = row.name
export const age: number = row.age
`,
    invalid: 'export const rejected: number = row.name',
  },
  {
    name: 'runtime dialect',
    source: `import { createQueryBuilder } from 'bun-query-builder/runtime'
import type { SupportedDialect } from 'bun-query-builder/runtime'
export const factory = createQueryBuilder
export const dialect: SupportedDialect = 'sqlite'
`,
    invalid: "export const rejected: SupportedDialect = 'not-a-supported-dialect'",
  },
  {
    name: 'browser query inference',
    source: `import { browserQuery } from 'bun-query-builder/browser'
const query = browserQuery<{ id: number, name: string, age: number }>('public_users')
declare const row: NonNullable<Awaited<ReturnType<typeof query.find>>>
export const name: string = row.name
export const age: number = row.age
`,
    invalid: 'export const rejected: number = row.name',
  },
  {
    name: 'browser model factory inference',
    source: `import { createBrowserModel } from 'bun-query-builder/browser'
import type { BrowserModelStatic } from 'bun-query-builder/browser'
const definition = {
  name: 'PublicUser', table: 'public_users', traits: { useTimestamps: true, useUuid: true },
  attributes: {
    name: { type: 'string', fillable: true }, age: { type: 'number', fillable: true },
    role: { type: ['admin', 'user'], fillable: true },
    nickname: { type: 'string', nullable: true }, password: { type: 'string', hidden: true },
  },
} as const
const User = createBrowserModel(definition)
export const model: BrowserModelStatic<typeof definition> = User
const query = User.where('age', '>', 18).select('name', 'age')
declare const selected: NonNullable<Awaited<ReturnType<typeof query.first>>>
declare const found: NonNullable<Awaited<ReturnType<typeof User.find>>>
export const name: string = selected.get('name')
export const age: number = selected.get('age')
export const role: 'admin' | 'user' = found.get('role')
export const nickname: string | null = found.get('nickname')
export const uuid: string = found.get('uuid')
export const created: string = found.get('created_at')
export const named = User.whereName('Ada')
export const byAge = User.whereAge(42)
export const definitionName: 'PublicUser' = User.getDefinition().name
// @ts-expect-error name is a string column
User.whereName(42)
// @ts-expect-error age is a number column
User.where('age', 'too old')
// @ts-expect-error selection excludes role
selected.get('role')
// @ts-expect-error hidden password is excluded from JSON
found.toJSON().password
// @ts-expect-error nullable fields cannot be used as a non-null string
export const notNullable: string = found.get('nickname')
`,
    invalid: "export const rejected: number = selected.get('name')",
  },
  {
    name: 'dynamodb generic results',
    source: `import { createDynamo } from 'bun-query-builder/dynamodb'
import type { DynamoConnectionConfig, DynamoDBQueryResult } from 'bun-query-builder/dynamodb'
export const factory = createDynamo
export const config: DynamoConnectionConfig = { region: 'us-east-1', table: 'public_consumer' }
declare const result: DynamoDBQueryResult<{ id: number, name: string }>
export const name: string = result.items[0].name
export const id: number = result.items[0].id
`,
    invalid: 'export const rejected: number = result.items[0].name',
  },
]

function diagnostic(result: Awaited<ReturnType<typeof run>>): string {
  return JSON.stringify(result, null, 2)
}

beforeAll(async () => {
  ownedRoot = await mkdtemp(join(tmpdir(), 'qb-public-package-types-'))
  try {
    const packs = join(ownedRoot, 'packs')
    consumer = join(ownedRoot, 'consumer')
    await mkdir(packs)
    await mkdir(consumer)
    // Pack the actual publishable workspace, never the repository's private root.
    const packed = await run([process.execPath, 'pm', 'pack', '--destination', packs, '--quiet'], packageRoot, 10_000)
    expect(packed, diagnostic(packed)).toMatchObject({ exitCode: 0, timedOut: false, overflow: false })
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    const archive = join(packs, `${manifest.name}-${manifest.version}.tgz`)
    const bunTypes = JSON.parse(await readFile(require.resolve('@types/bun/package.json'), 'utf8'))
    await writeFile(join(consumer, 'package.json'), JSON.stringify({
      name: 'query-builder-public-consumer', private: true, type: 'module',
      dependencies: { 'bun-query-builder': archive },
      devDependencies: { '@types/bun': bunTypes.version },
    }))
    const installed = await run([process.execPath, 'install'], consumer, 60_000)
    expect(installed, diagnostic(installed)).toMatchObject({ exitCode: 0, timedOut: false, overflow: false })
    const frozen = await run([process.execPath, 'install', '--frozen-lockfile'], consumer, 15_000)
    expect(frozen, diagnostic(frozen)).toMatchObject({ exitCode: 0, timedOut: false, overflow: false })
    const published = JSON.parse(await readFile(join(consumer, 'node_modules/bun-query-builder/package.json'), 'utf8'))
    expect(published.exports).toEqual(manifest.exports)
    expect(await realpath(join(consumer, 'node_modules/bun-query-builder'))).toBe(join(await realpath(consumer), 'node_modules/bun-query-builder'))
    for (const [index, entry] of cases.entries()) {
      for (const variant of ['positive', 'negative']) {
        const stem = `${index}-${variant}`
        await writeFile(join(consumer, `${stem}.ts`), entry.source + (variant === 'negative' ? `${entry.invalid}\n` : ''))
        await writeFile(join(consumer, `${stem}.json`), JSON.stringify({
          compilerOptions: {
            strict: true, skipLibCheck: false, skipDefaultLibCheck: false, noEmit: true,
            target: 'ESNext', module: 'Preserve', moduleResolution: 'Bundler',
            lib: ['ESNext', 'DOM'], types: ['bun'], paths: {},
          },
          files: [`${stem}.ts`],
        }))
      }
    }
  }
  catch (error) {
    await cleanup()
    throw error
  }
}, 90_000)

afterAll(cleanup)

describe('the normally packed public declaration surface', () => {
  for (const [index, entry] of cases.entries()) {
    it(`accepts ${entry.name} through a bare package import`, async () => {
      const result = await run([process.execPath, compiler, '--noEmit', '-p', `${index}-positive.json`, '--pretty', 'false'], consumer, 3_000)
      expect(result, diagnostic(result)).toEqual({ exitCode: 0, stdout: '', stderr: '', timedOut: false, overflow: false })
    })

    it(`rejects an incorrect ${entry.name} assignment with TS2322`, async () => {
      const result = await run([process.execPath, compiler, '--noEmit', '-p', `${index}-negative.json`, '--pretty', 'false'], consumer, 3_000)
      expect(result, diagnostic(result)).toMatchObject({ stderr: '', timedOut: false, overflow: false })
      expect(result.exitCode, diagnostic(result)).toBeGreaterThan(0)
      const lines = result.stdout.trim().split('\n')
      expect(lines, diagnostic(result)).toHaveLength(1)
      const line = entry.source.split('\n').length
      expect(lines[0]).toMatch(new RegExp(`^${index}-negative\\.ts\\(${line},\\d+\\): error TS2322: `))
    })
  }

  it('removes obsolete output through the normal build before packing current entries', async () => {
    const fixture = join(ownedRoot!, 'build-lifecycle')
    const packs = join(fixture, 'packs')
    const temporary = join(fixture, 'temporary')
    await mkdir(join(fixture, 'src/dynamodb'), { recursive: true })
    await mkdir(join(fixture, 'bin'))
    await mkdir(join(fixture, 'dist'))
    await mkdir(packs)
    await mkdir(temporary)
    await writeFile(join(fixture, 'package.json'), JSON.stringify({
      name: 'query-builder-build-output-fixture', version: '1.0.0', type: 'module', files: ['dist'],
    }))
    for (const entry of ['index.ts', 'runtime.ts', 'browser.ts', 'dynamodb/index.ts'])
      await writeFile(join(fixture, 'src', entry), 'export const current = 42\n')
    await writeFile(join(fixture, 'bin/cli.ts'), "console.log('current fixture')\n")
    const obsolete = join(fixture, 'dist/obsolete-previous-build.js')
    await writeFile(obsolete, "export const obsolete = 'must not ship'\n")
    expect(await Bun.file(obsolete).exists()).toBe(true)

    // Run the owning build, including its real declaration plugin and compile
    // assertions. Authored input avoids copying a runtime or mutating shared dist.
    const built = await run([process.execPath, '--bun', join(packageRoot, 'build.ts')], fixture, 3_000, temporary)
    expect(built, diagnostic(built)).toMatchObject({ exitCode: 0, timedOut: false, overflow: false })
    const packed = await run([process.execPath, 'pm', 'pack', '--destination', packs, '--quiet'], fixture, 1_000)
    expect(packed, diagnostic(packed)).toMatchObject({ exitCode: 0, timedOut: false, overflow: false })
    const archive = new Bun.Archive(await Bun.file(join(packs, 'query-builder-build-output-fixture-1.0.0.tgz')).arrayBuffer())
    const entries = await archive.files()
    expect(entries.has('package/dist/obsolete-previous-build.js')).toBe(false)
    expect(await Bun.file(obsolete).exists()).toBe(false)
    for (const target of [
      'src/index.js', 'src/runtime.js', 'src/browser.js', 'src/dynamodb/index.js', 'bin/cli.js',
      'index.d.ts', 'runtime.d.ts', 'browser.d.ts', 'dynamodb/index.d.ts',
    ])
      expect(entries.has(`package/dist/${target}`), target).toBe(true)
  })
})
