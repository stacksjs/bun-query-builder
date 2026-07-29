/**
 * What `migrate:fresh` is allowed to delete.
 *
 * It cleared every `.sql` file in the migrations directory. The generator's
 * own output is about to be rewritten from the models, so that much is fair
 * game — but a hand-written migration is schema nothing else knows how to
 * produce, and deleting it left the project with a corpus that could no longer
 * rebuild its own database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { deleteMigrationFiles } from '../src/actions/migrate'
import { GENERATED_MARKER } from '../src/migrations'

let workspace: string
let migrationsDir: string
let modelsDir: string
let originalCwd: string

const AUTHORED = '0000000131-add-user-to-farms.sql'
const AUTHORED_SQL = '-- A hand-written migration, with a comment header.\nALTER TABLE "farms" ADD COLUMN "user_id" INTEGER;\n'
const GENERATED = '0000000132-alter-farms-columns.sql'

beforeAll(() => {
  originalCwd = process.cwd()
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'qb-fresh-')))
  migrationsDir = join(workspace, 'database', 'migrations')
  modelsDir = join(workspace, 'models')
  mkdirSync(migrationsDir, { recursive: true })
  mkdirSync(modelsDir, { recursive: true })
  writeFileSync(join(workspace, 'package.json'), '{"name":"fresh-fixture"}')
  process.chdir(workspace)
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(workspace, { recursive: true, force: true })
})

beforeEach(() => {
  writeFileSync(join(migrationsDir, AUTHORED), AUTHORED_SQL)
  writeFileSync(join(migrationsDir, GENERATED), `${GENERATED_MARKER}\nALTER TABLE "farms" ADD COLUMN "region" TEXT;\n`)
})

describe('deleteMigrationFiles', () => {
  it('removes the generator\'s own output', async () => {
    await deleteMigrationFiles(modelsDir, workspace, { dialect: 'sqlite' })
    expect(existsSync(join(migrationsDir, GENERATED))).toBe(false)
  })

  it('keeps a hand-written migration, untouched', async () => {
    await deleteMigrationFiles(modelsDir, workspace, { dialect: 'sqlite' })

    expect(existsSync(join(migrationsDir, AUTHORED))).toBe(true)
    expect(readFileSync(join(migrationsDir, AUTHORED), 'utf8')).toBe(AUTHORED_SQL)
  })

  it('keeps a legacy generated file rather than guessing from its name', async () => {
    // Written before the marker existed: unreadable provenance, so it counts
    // as authored. Regenerating simply skips writing a duplicate of it.
    const legacy = '0000000100-alter-farms-table.sql'
    writeFileSync(join(migrationsDir, legacy), 'ALTER TABLE "farms" ADD COLUMN "legacy" TEXT;\n')

    await deleteMigrationFiles(modelsDir, workspace, { dialect: 'sqlite' })

    expect(existsSync(join(migrationsDir, legacy))).toBe(true)
    rmSync(join(migrationsDir, legacy), { force: true })
  })
})
