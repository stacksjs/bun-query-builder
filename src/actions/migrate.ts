import type { SupportedDialect } from '../types'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMigrationPlan, createQueryBuilder, generateDiffSql, generateSql, hashMigrationPlan, loadModels } from '../index'

export interface MigrateOptions {
  dialect?: SupportedDialect
  state?: string
  apply?: boolean
  full?: boolean
}

export async function migrate(dir: string, opts: MigrateOptions = {}) {
  const dialect = String(opts.dialect || 'postgres') as SupportedDialect
  const models = await loadModels({ modelsDir: dir })

  const plan = buildMigrationPlan(models, { dialect })

  const defaultStatePath = join(dir, `.qb-migrations.${dialect}.json`)
  const statePath = String(opts.state || defaultStatePath)

  let previous: any | undefined
  if (existsSync(statePath)) {
    try {
      const raw = readFileSync(statePath, 'utf8')
      const parsed = JSON.parse(raw)
      previous = parsed?.plan && parsed.plan.tables ? parsed.plan : (parsed?.tables ? parsed : undefined)
    }
    catch {
      // ignore corrupt state; treat as no previous
    }
  }

  const sql = opts.full ? generateSql(plan) : generateDiffSql(previous, plan)
  const hasChanges = /\b(?:CREATE|ALTER)\b/i.test(sql)

  if (opts.apply) {
    const qb = createQueryBuilder()
    // Use a temp file to execute multiple statements safely via file()
    const dirPath = mkdtempSync(join(tmpdir(), 'qb-migrate-'))
    const filePath = join(dirPath, 'migration.sql')
    try {
      if (hasChanges) {
        writeFileSync(filePath, sql)
        await qb.file(filePath)
        console.log('-- Migration applied')
      }
      else {
        console.log('-- No changes; nothing to apply')
      }
      // On success, write state snapshot with current plan and hash
      writeFileSync(statePath, JSON.stringify({ plan, hash: hashMigrationPlan(plan), updatedAt: new Date().toISOString() }, null, 2))
    }
    catch (err) {
      console.error('-- Migration failed:', err)
      throw err
    }
  }
  else {
    console.log(sql)
  }

  return { sql, hasChanges, plan }
}
