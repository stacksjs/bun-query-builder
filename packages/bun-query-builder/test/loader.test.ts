/**
 * Reading a models directory.
 *
 * Three things the loader got wrong, each of which surfaced somewhere else as
 * a stranger problem: subdirectories were skipped (so embedders flattened the
 * tree into a staging directory first), `index.ts` and helper files became
 * models named after themselves, and directory order was whatever the
 * filesystem returned — which decides the order tables are created in a full
 * generate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { loadModels } from '../src/loader'

let root: string
let modelsDir: string
let originalCwd: string

function model(name: string, table: string): string {
  return `export default { name: '${name}', table: '${table}', primaryKey: 'id', attributes: { title: { validation: { rule: {} } } } }\n`
}

beforeAll(() => {
  originalCwd = process.cwd()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'qb-loader-')))
  modelsDir = join(root, 'models')
  mkdirSync(join(modelsDir, 'commerce'), { recursive: true })

  writeFileSync(join(modelsDir, 'Zebra.ts'), model('Zebra', 'zebras'))
  writeFileSync(join(modelsDir, 'Apple.ts'), model('Apple', 'apples'))
  // A barrel and a partial, the two files that always end up in a models dir.
  writeFileSync(join(modelsDir, 'index.ts'), `export * from './Apple'\n`)
  writeFileSync(join(modelsDir, '_shared.ts'), `export const shared = { nope: true }\n`)
  // A helper that exports something which is not a model at all.
  writeFileSync(join(modelsDir, 'helpers.ts'), `export default { totallyNotAModel: true }\n`)
  // A model in a subdirectory.
  writeFileSync(join(modelsDir, 'commerce', 'Order.ts'), model('Order', 'orders'))
  // Not a source file.
  writeFileSync(join(modelsDir, 'README.md'), '# models\n')
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
})

describe('loadModels', () => {
  it('finds models in subdirectories', async () => {
    const models = await loadModels({ modelsDir })
    expect(Object.keys(models)).toContain('Order')
  })

  it('does not register index barrels, partials or non-models', async () => {
    const models = await loadModels({ modelsDir })
    const names = Object.keys(models)

    expect(names).not.toContain('index')
    expect(names).not.toContain('_shared')
    expect(names).not.toContain('shared')
    expect(names).not.toContain('helpers')
  })

  it('returns the real models and nothing else', async () => {
    const models = await loadModels({ modelsDir })
    expect(Object.keys(models).sort()).toEqual(['Apple', 'Order', 'Zebra'])
  })

  it('reads the directory in a stable order', async () => {
    // Filesystem order decides table-creation order in a full generate, so an
    // unsorted read made the generated corpus depend on the machine.
    const first = Object.keys(await loadModels({ modelsDir }))
    const second = Object.keys(await loadModels({ modelsDir }))

    expect(first).toEqual(second)
    // Alphabetical within a level, subdirectory contents in place.
    expect(first.indexOf('Apple')).toBeLessThan(first.indexOf('Zebra'))
  })

  it('accepts an absolute path as absolute', async () => {
    // The old check was `startsWith('/')`, which reads `C:\models` as relative.
    process.chdir(originalCwd)
    const models = await loadModels({ modelsDir })
    expect(Object.keys(models)).toContain('Apple')
  })

  it('resolves a relative path against cwd', async () => {
    process.chdir(root)
    const models = await loadModels({ modelsDir: 'models' })
    expect(Object.keys(models)).toContain('Apple')
    process.chdir(originalCwd)
  })
})
