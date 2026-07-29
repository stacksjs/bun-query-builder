/**
 * Finding and ordering seeders.
 *
 * `runSeeder` is documented as taking a class name and matched on the FILE
 * name, so a seeder living in `users.ts` could not be run by the name of the
 * class inside it — it threw "Seeder not found" and named no alternatives.
 * Load order came straight from the filesystem, so two seeders sharing an
 * `order` ran in whichever sequence the machine happened to report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { loadSeeders } from '../src/actions/seed'

let root: string
let seedersDir: string
let originalCwd: string

/** A seeder file whose CLASS name differs from its FILE name. */
function seederFile(className: string, order?: number): string {
  return `export default class ${className} {
  ${order === undefined ? '' : `get order() { return ${order} }`}
  async run() {}
}
`
}

beforeAll(() => {
  originalCwd = process.cwd()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'qb-seeders-')))
  seedersDir = join(root, 'database', 'seeders')
  mkdirSync(seedersDir, { recursive: true })

  writeFileSync(join(seedersDir, 'users.ts'), seederFile('UserSeeder', 10))
  writeFileSync(join(seedersDir, 'posts.ts'), seederFile('PostSeeder', 20))
  // Same order as posts: the tie must break the same way every run.
  writeFileSync(join(seedersDir, 'comments.ts'), seederFile('CommentSeeder', 20))
  writeFileSync(join(seedersDir, 'index.ts'), `export * from './users'\n`)
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
})

describe('loadSeeders', () => {
  it('reports the class name as well as the file name', async () => {
    const seeders = await loadSeeders(seedersDir)
    const users = seeders.find(s => s.name === 'users')

    expect(users).toBeDefined()
    expect(users!.className).toBe('UserSeeder')
  })

  it('skips the index barrel', async () => {
    const seeders = await loadSeeders(seedersDir)
    expect(seeders.map(s => s.name)).not.toContain('index')
  })

  it('orders by `order`, and breaks ties the same way every time', async () => {
    const first = (await loadSeeders(seedersDir)).map(s => s.name)
    const second = (await loadSeeders(seedersDir)).map(s => s.name)

    expect(first).toEqual(second)
    // 10 before the two 20s, and the tie resolved alphabetically by file.
    expect(first).toEqual(['users', 'comments', 'posts'])
  })

  it('returns nothing for a directory that does not exist', async () => {
    expect(await loadSeeders(join(root, 'nope'))).toEqual([])
  })
})
