import type { SupportedDialect } from '../types'
import { sql as bunSql } from 'bun'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildMigrationPlan, generateDiffSql, generateSql, hashMigrationPlan, loadModels } from '../index'

export interface MigrateOptions {
  dialect?: SupportedDialect
  state?: string
  apply?: boolean
  full?: boolean
}

export interface GenerateMigrationResult {
  sql: string
  sqlStatements: string[]
  hasChanges: boolean
  plan: any
}

export async function generateMigration(dir: string, opts: MigrateOptions = {}): Promise<GenerateMigrationResult> {
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

  const sqlStatements = opts.full ? generateSql(plan) : generateDiffSql(previous, plan)
  const sql = sqlStatements.join('\n')
  const hasChanges = sqlStatements.some(stmt => /\b(?:CREATE|ALTER)\b/i.test(stmt))
  if (opts.apply) {
    try {
      // if (hasChanges) {
      //   await executeMigration(sqlStatements)
      //   console.log('-- Migration applied')
      // }
      // else {
      //   console.log('-- No changes; nothing to apply')
      // }

      // On success, write state snapshot with current plan and hash
      writeFileSync(statePath, JSON.stringify({ plan, hash: hashMigrationPlan(plan), updatedAt: new Date().toISOString() }, null, 2))
    }
    catch (err) {
      console.error('-- Migration failed:', err)
      throw err
    }
  }

  return { sql, sqlStatements, hasChanges, plan }
}

export async function executeMigration(sqlStatements: string[]): Promise<boolean> {
  try {
    for (const sql of sqlStatements) {
      // Use raw SQL execution instead of template literal to avoid parameter binding issues
      await bunSql.unsafe(sql).execute()
    }

    console.log('-- Migration executed successfully')
  }
  catch (err) {
    console.error('-- Migration execution failed:', err)
    throw err
  }

  return true
}
