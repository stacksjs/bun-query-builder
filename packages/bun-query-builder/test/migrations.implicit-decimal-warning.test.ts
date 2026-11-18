/**
 * A float-validated attribute that lands on an undeclared decimal is warned
 * about, not silently rounded.
 *
 * An explicit `type: 'number'` wins over the validator and maps to `decimal`,
 * and an undeclared decimal renders as `decimal(10,2)`. So a model that said
 * `schema.float().min(0).max(1)` for a probability stored 0.6234 as 0.62, with
 * nothing in the generated SQL to suggest it. The column type is unchanged
 * (changing the default would rewrite every existing app's columns), but the
 * plan now reports it, and `generateMigration` prints and returns it.
 */
import type { MigrationPlan } from '../src/migrations'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateMigration } from '../src/actions/migrate'
import { buildMigrationPlan, generateSql, hashMigrationPlan, implicitDecimalWarning } from '../src/migrations'

function planFor(attr: Record<string, unknown>, onWarning?: (message: string) => void): MigrationPlan {
  return buildMigrationPlan({
    FairPrice: { name: 'FairPrice', table: 'fair_prices', attributes: { probConsensus: attr } },
  } as any, { dialect: 'mysql', onWarning })
}

function warningsFor(attr: Record<string, unknown>): string[] {
  const warnings: string[] = []
  planFor(attr, w => warnings.push(w))
  return warnings
}

const float = { validation: { rule: { name: 'float' } } }

describe('warning about the decimal(10,2) default', () => {
  it('warns when type: number meets a float validator, naming the column and the fix', () => {
    const warnings = warningsFor({ type: 'number', ...float })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('fair_prices.prob_consensus')
    expect(warnings[0]).toContain('"probConsensus"')
    expect(warnings[0]).toContain('decimal(10,2)')
    expect(warnings[0]).toContain('rounded to 2 decimal places')
    expect(warnings[0]).toContain('`precision` and `scale`')
    expect(warnings[0]).toContain('type: \'double\'')
  })

  it('warns for a double validator and for an explicit bare decimal type', () => {
    expect(warningsFor({ type: 'number', validation: { rule: { name: 'double' } } })[0]).toContain('validated as a double')
    expect(warningsFor({ type: 'decimal', ...float })).toHaveLength(1)
    expect(warningsFor({ type: 'numeric', ...float })).toHaveLength(1)
  })

  it('leaves the column itself exactly as it was', () => {
    const silent = planFor({ type: 'number', ...float })
    const warned = planFor({ type: 'number', ...float }, () => {})
    const column = warned.tables[0].columns.find(c => c.name === 'prob_consensus')!
    expect(column.type).toBe('decimal')
    expect(column.precision).toBeUndefined()
    expect(generateSql(warned).join('\n')).toContain('decimal(10,2)')
    expect(hashMigrationPlan(warned)).toBe(hashMigrationPlan(silent))
  })

  it('is silent once precision or scale is declared', () => {
    expect(warningsFor({ type: 'number', precision: 8, scale: 6, ...float })).toEqual([])
    expect(warningsFor({ type: 'number', scale: 6, ...float })).toEqual([])
    expect(warningsFor({ type: 'decimal(8,6)', ...float })).toEqual([])
  })

  it('is silent for columns that keep what the validator says', () => {
    // No explicit type: the float validator already makes a float column.
    expect(warningsFor(float)).toEqual([])
    expect(warningsFor({ type: 'double', ...float })).toEqual([])
    // A decimal validated as a decimal is the money case the default exists for.
    expect(warningsFor({ type: 'decimal', validation: { rule: { name: 'decimal' } } })).toEqual([])
    expect(warningsFor({ type: 'number' })).toEqual([])
  })

  it('needs no listener: an unset onWarning is silent and does not throw', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => planFor({ type: 'number', ...float })).not.toThrow()
      expect(warn).not.toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
    }
  })

  it('formats the default it describes', () => {
    expect(implicitDecimalWarning('t', 'c', 'a', 'float')).toContain('decimal(10,2)')
  })
})

describe('generateMigration', () => {
  let workspace: string
  let modelsDir: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    workspace = join(tmpdir(), `qb-implicit-decimal-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    modelsDir = join(workspace, 'app', 'Models')
    mkdirSync(modelsDir, { recursive: true })
    writeFileSync(join(workspace, 'package.json'), '{}')
    writeFileSync(join(modelsDir, 'FairPrice.ts'), `export default {
      name: 'FairPrice',
      table: 'fair_prices',
      attributes: {
        probConsensus: { type: 'number', validation: { rule: { name: 'float' } } },
        probSharp: { type: 'number', precision: 8, scale: 6, validation: { rule: { name: 'float' } } },
      },
    }
    `)
    process.chdir(workspace)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(workspace, { recursive: true, force: true })
  })

  it('returns the warnings on a dry run without printing them', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await generateMigration(modelsDir, { dialect: 'mysql', dryRun: true, full: true })
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings![0]).toContain('fair_prices.prob_consensus')
      expect(warn.mock.calls.some(call => String(call[0]).includes('prob_consensus'))).toBe(false)
    }
    finally {
      warn.mockRestore()
    }
  })

  it('prints them on a writing run', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await generateMigration(modelsDir, { dialect: 'mysql', full: true })
      expect(result.warnings).toHaveLength(1)
      const printed = warn.mock.calls.map(call => String(call[0])).filter(line => line.includes('prob_consensus'))
      expect(printed).toHaveLength(1)
      expect(printed[0]).toStartWith('-- qb: fair_prices.prob_consensus')
    }
    finally {
      warn.mockRestore()
    }
  })
})
