import type { SupportedDialect } from '@/types'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { config } from '@/config'
import { buildMigrationPlan, loadModels } from '../index'
import { createQueryBuilder } from '../client'
import { existsSync } from 'node:fs'

/**
 * Find workspace root by looking for package.json
 */
function findWorkspaceRoot(startPath: string): string {
  let currentPath = startPath

  while (currentPath !== dirname(currentPath)) {
    if (existsSync(join(currentPath, 'package.json'))) {
      return currentPath
    }
    currentPath = dirname(currentPath)
  }

  return process.cwd()
}

export interface ValidationIssue {
  type: 'missing_table' | 'extra_table' | 'missing_column' | 'extra_column' | 'type_mismatch'
  severity: 'error' | 'warning'
  table?: string
  column?: string
  expected?: string
  actual?: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  issues: ValidationIssue[]
}

/**
 * Validate that models match the database schema
 */
export async function validateSchema(dir?: string): Promise<ValidationResult> {
  if (!dir) {
    dir = join(findWorkspaceRoot(process.cwd()), 'app/Models')
  }

  const dialect = config.dialect as SupportedDialect || 'postgres'

  console.log('-- Validating Schema')
  console.log(`-- Models directory: ${dir}`)
  console.log(`-- Dialect: ${dialect}`)
  console.log()

  const issues: ValidationIssue[] = []

  try {
    // Load models and build migration plan
    const models = await loadModels({ modelsDir: dir })
    const plan = buildMigrationPlan(models, { dialect })

    // Get actual database tables
    const qb = createQueryBuilder()
    let actualTables: string[] = []

    if (dialect === 'sqlite') {
      const result = await qb.unsafe(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name != 'migrations'
      `)
      actualTables = result.map((r: any) => r.name)
    }
    else if (dialect === 'postgres') {
      const result = await qb.unsafe(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name != 'migrations'
      `)
      actualTables = result.map((r: any) => r.table_name)
    }
    else if (dialect === 'mysql') {
      const result = await qb.unsafe(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
        AND table_type = 'BASE TABLE'
        AND table_name != 'migrations'
      `)
      actualTables = result.map((r: any) => r.table_name)
    }

    const expectedTables = plan.tables.map(t => t.table)

    // Check for missing tables
    for (const expectedTable of expectedTables) {
      if (!actualTables.includes(expectedTable)) {
        issues.push({
          type: 'missing_table',
          severity: 'error',
          table: expectedTable,
          message: `Table '${expectedTable}' defined in models but not found in database`,
        })
      }
    }

    // Check for extra tables
    for (const actualTable of actualTables) {
      if (!expectedTables.includes(actualTable)) {
        issues.push({
          type: 'extra_table',
          severity: 'warning',
          table: actualTable,
          message: `Table '${actualTable}' exists in database but not defined in models`,
        })
      }
    }

    // Check columns for each table that exists in both
    for (const modelTable of plan.tables) {
      if (!actualTables.includes(modelTable.table)) {
        continue
      }

      // Get actual columns from database
      let actualColumns: Array<{ name: string, type: string }> = []

      if (dialect === 'sqlite') {
        const result = await qb.unsafe(`PRAGMA table_info(${modelTable.table})`)
        actualColumns = result.map((r: any) => ({
          name: r.name,
          type: r.type.toLowerCase(),
        }))
      }
      else if (dialect === 'postgres') {
        const result = await qb.unsafe(`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_name = $1
        `, [modelTable.table])
        actualColumns = result.map((r: any) => ({
          name: r.column_name,
          type: r.data_type.toLowerCase(),
        }))
      }
      else if (dialect === 'mysql') {
        const result = await qb.unsafe(`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_name = ?
          AND table_schema = DATABASE()
        `, [modelTable.table])
        actualColumns = result.map((r: any) => ({
          name: r.column_name,
          type: r.data_type.toLowerCase(),
        }))
      }

      const actualColumnNames = actualColumns.map(c => c.name)
      const expectedColumnNames = modelTable.columns.map(c => c.name)

      // Check for missing columns
      for (const expectedCol of modelTable.columns) {
        if (!actualColumnNames.includes(expectedCol.name)) {
          issues.push({
            type: 'missing_column',
            severity: 'error',
            table: modelTable.table,
            column: expectedCol.name,
            expected: expectedCol.type,
            message: `Column '${modelTable.table}.${expectedCol.name}' defined in model but not found in database`,
          })
        }
      }

      // Check for extra columns
      for (const actualCol of actualColumns) {
        if (!expectedColumnNames.includes(actualCol.name)) {
          issues.push({
            type: 'extra_column',
            severity: 'warning',
            table: modelTable.table,
            column: actualCol.name,
            actual: actualCol.type,
            message: `Column '${modelTable.table}.${actualCol.name}' exists in database but not defined in model`,
          })
        }
      }

      // Check for type mismatches (simplified check)
      for (const expectedCol of modelTable.columns) {
        const actualCol = actualColumns.find(c => c.name === expectedCol.name)
        if (actualCol) {
          // Normalize types for comparison
          const normalizeType = (type: string) => {
            return type.toLowerCase()
              .replace(/\(.*\)/, '') // Remove length specifiers
              .replace('integer', 'int')
              .replace('varchar', 'text')
              .replace('character varying', 'text')
              .trim()
          }

          const expectedType = normalizeType(expectedCol.type)
          const actualType = normalizeType(actualCol.type)

          if (expectedType !== actualType) {
            issues.push({
              type: 'type_mismatch',
              severity: 'warning',
              table: modelTable.table,
              column: expectedCol.name,
              expected: expectedCol.type,
              actual: actualCol.type,
              message: `Column '${modelTable.table}.${expectedCol.name}' type mismatch: expected '${expectedCol.type}', found '${actualCol.type}'`,
            })
          }
        }
      }
    }

    // Display results
    const valid = issues.filter(i => i.severity === 'error').length === 0

    if (valid && issues.length === 0) {
      console.log('✓ Schema is valid - no issues found')
      console.log()
    }
    else {
      console.log(`-- Found ${issues.length} issue(s)`)
      console.log()

      const errors = issues.filter(i => i.severity === 'error')
      const warnings = issues.filter(i => i.severity === 'warning')

      if (errors.length > 0) {
        console.log(`✗ Errors (${errors.length}):`)
        for (const issue of errors) {
          console.log(`  - ${issue.message}`)
        }
        console.log()
      }

      if (warnings.length > 0) {
        console.log(`⚠  Warnings (${warnings.length}):`)
        for (const issue of warnings) {
          console.log(`  - ${issue.message}`)
        }
        console.log()
      }

      if (!valid) {
        console.log('-- Recommendation: Run migrations to sync the database schema')
        console.log('--   qb migrate ./app/Models --apply')
      }
    }

    return {
      valid,
      issues,
    }
  }
  catch (err) {
    console.error('-- Schema validation failed:', err)
    throw err
  }
}

/**
 * Check schema (alias for validateSchema)
 */
export async function checkSchema(dir?: string): Promise<ValidationResult> {
  return validateSchema(dir)
}
