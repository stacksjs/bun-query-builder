import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import type { SupportedDialect } from '../types'
import { config, getPlaceholder, isMysqlLike } from '../config'
import { createQueryBuilder } from '../index'
import { getSqlDirectory } from '@/workspace'

/**
 * Split a SQL script into individual statements.
 *
 * Quoting is tracked for all three quote characters, and comments are removed
 * as they are scanned rather than by dropping whole lines up front. The line
 * filter missed a comment that trailed a statement — `ALTER TABLE …; -- note`
 * left `-- note` behind as its own "statement", which the rollback then
 * reported as un-reversible DDL — and only single quotes were tracked, so a
 * `;` inside a double-quoted identifier or a backtick-quoted MySQL default
 * split one statement into two broken halves.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = []
  let buf = ''
  /** The quote character we are inside of, or null. */
  let quote: string | null = null

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]

    if (quote) {
      buf += ch
      if (ch === quote) {
        // `''` / `""` / ``` `` ``` is an escaped quote, not the end of one.
        if (sql[i + 1] === quote) {
          buf += sql[i + 1]
          i++
        }
        else {
          quote = null
        }
      }
      continue
    }

    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch
      buf += ch
      continue
    }

    // `-- …` to end of line, and `/* … */`, wherever they start.
    if (ch === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i)
      i = newline === -1 ? sql.length : newline
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      i = close === -1 ? sql.length : close + 1
      continue
    }

    if (ch === ';') {
      if (buf.trim())
        out.push(buf.trim())
      buf = ''
      continue
    }

    buf += ch
  }

  if (buf.trim())
    out.push(buf.trim())
  return out
}

/**
 * Derive reverse ("down") DDL from a forward migration's SQL, so a rollback can
 * actually undo schema changes (stacksjs/bun-query-builder#1048). Inverts the
 * statements our generator emits — CREATE TABLE, ALTER TABLE ADD COLUMN, CREATE
 * [UNIQUE] INDEX — in reverse order. Statements it can't safely invert (data
 * changes, complex alters) are skipped; the caller reports them.
 */
export function deriveDownStatements(forwardSql: string, dialect: SupportedDialect = config.dialect): { down: string[], skipped: string[] } {
  const q = (id: string): string => isMysqlLike(dialect) ? `\`${id}\`` : `"${id}"`
  const down: string[] = []
  const skipped: string[] = []
  for (const stmt of splitSqlStatements(forwardSql)) {
    let m: RegExpExecArray | null
    // eslint-disable-next-line no-cond-assign
    if ((m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?(\w+)["`']?/i.exec(stmt))) {
      down.push(`DROP TABLE IF EXISTS ${q(m[1])}`)
    }
    // `ADD CONSTRAINT <name>` is not a column, and inverting it as one produced
    // `DROP COLUMN "CONSTRAINT"` — reported as a successful reversal.
    // eslint-disable-next-line no-cond-assign
    else if ((m = /^ALTER\s+TABLE\s+["`']?(\w+)["`']?\s+ADD\s+CONSTRAINT\s+["`']?(\w+)["`']?([\s\S]*)$/i.exec(stmt))) {
      // SQLite has no `ALTER TABLE ... DROP CONSTRAINT` in any form.
      if (dialect === 'sqlite') {
        skipped.push(stmt)
      }
      else if (isMysqlLike(dialect) && /\bFOREIGN\s+KEY\b/i.test(m[3] ?? '')) {
        // MySQL drops a foreign key by its own verb; DROP CONSTRAINT only
        // reaches CHECK and (8.0.19+) the rest.
        down.push(`ALTER TABLE ${q(m[1])} DROP FOREIGN KEY ${q(m[2])}`)
      }
      else {
        down.push(`ALTER TABLE ${q(m[1])} DROP CONSTRAINT ${q(m[2])}`)
      }
    }
    // eslint-disable-next-line no-cond-assign
    else if ((m = /^ALTER\s+TABLE\s+["`']?(\w+)["`']?\s+ADD\s+(?:COLUMN\s+["`']?(\w+)["`']?|["`'](\w+)["`']|(\w+))/i.exec(stmt))) {
      // The unquoted, no-COLUMN form is where a keyword can masquerade as a
      // column name: `ADD PRIMARY KEY (...)`, `ADD UNIQUE ...`, `ADD INDEX ...`.
      // Those add no column, so there is nothing to invert and pretending
      // otherwise emitted `DROP COLUMN "PRIMARY"`.
      const column = m[2] ?? m[3] ?? m[4]
      if (m[4] && /^(?:PRIMARY|UNIQUE|INDEX|KEY|FOREIGN|CHECK|FULLTEXT|SPATIAL)$/i.test(m[4]))
        skipped.push(stmt)
      else
        down.push(`ALTER TABLE ${q(m[1])} DROP COLUMN ${q(column)}`)
    }
    // eslint-disable-next-line no-cond-assign
    else if ((m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?(\w+)["`']?(?:\s+ON\s+["`']?(\w+)["`']?)?/i.exec(stmt))) {
      down.push(isMysqlLike(dialect) && m[2]
        ? `DROP INDEX ${q(m[1])} ON ${q(m[2])}`
        : `DROP INDEX IF EXISTS ${q(m[1])}`)
    }
    else {
      skipped.push(stmt)
    }
  }
  return { down: down.reverse(), skipped }
}

export interface RollbackOptions {
  steps?: number
  /**
   * Execute reverse ("down") DDL derived from each migration's forward SQL
   * before removing its record (#1048). Default true. Set false for the legacy
   * record-only behaviour.
   */
  reverseSchema?: boolean
  /**
   * Also delete the migration FILE, not just its record. Off by default.
   *
   * Rolling back used to delete it unconditionally. That is committed history
   * — the file is what every other machine replays — so one developer undoing
   * a change locally silently removed it for everybody, and getting it back
   * meant finding it in git. Undoing a migration and discarding it are two
   * different intentions; this is the second one.
   */
  deleteFiles?: boolean
}

/**
 * Rollback migrations
 *
 * Note: This removes migration entries from the migrations table.
 * Since migrations are auto-generated from models, you should:
 * 1. Revert your model changes
 * 2. Run rollback to remove migration records
 * 3. Generate fresh migrations
 */
export async function migrateRollback(options: RollbackOptions = {}): Promise<void> {
  const steps = options.steps || 1
  const reverseSchema = options.reverseSchema !== false

  console.log('-- Rolling back migrations')
  console.log(`-- Steps: ${steps}`)
  console.log()

  try {
    const qb = createQueryBuilder()

    // Get executed migrations from database (ordered by execution time desc)
    let executedMigrations: Array<{ migration: string, executed_at?: string }> = []
    try {
      const query = `
        SELECT migration, executed_at
        FROM migrations
        ORDER BY executed_at DESC, migration DESC
      `
      executedMigrations = await qb.unsafe(query)
    }
    catch (err) {
      console.log('-- Migrations table not found. Nothing to rollback.', err)
      return
    }

    if (executedMigrations.length === 0) {
      console.log('-- No migrations to rollback')
      return
    }

    const migrationsToRollback = executedMigrations.slice(0, steps)

    console.log(`-- Found ${executedMigrations.length} executed migrations`)
    console.log(`-- Rolling back ${migrationsToRollback.length} migration(s):`)
    console.log()

    for (const migration of migrationsToRollback) {
      console.log(`  - ${migration.migration}`)
    }
    console.log()

    const sqlDir = getSqlDirectory(undefined, config.migrationDir)
    let reversedAny = false
    for (const migration of migrationsToRollback) {
      try {
        const filePath = join(sqlDir, migration.migration)

        // Reverse the schema by deriving + running "down" DDL from the forward
        // migration file BEFORE removing the record, so a failure leaves the
        // record intact (#1048).
        if (reverseSchema && existsSync(filePath)) {
          const forwardSql = readFileSync(filePath, 'utf8')
          const { down, skipped } = deriveDownStatements(forwardSql)
          for (const stmt of down) {
            await qb.unsafe(stmt)
            console.log(`-- ↩  ${stmt}`)
            reversedAny = true
          }
          if (skipped.length > 0)
            console.log(`-- ⚠️  ${skipped.length} statement(s) in ${migration.migration} could not be auto-reversed (data/complex DDL) — reverse manually.`)
        }

        // `$1` is Postgres-only syntax; MySQL and SQLite take `?`.
        const deleteSql = `DELETE FROM migrations WHERE migration = ${getPlaceholder(1)}`
        await qb.unsafe(deleteSql, [migration.migration])
        console.log(`-- ✓ Removed migration record: ${migration.migration}`)

        if (options.deleteFiles && existsSync(filePath)) {
          unlinkSync(filePath)
          console.log(`-- 🗑️  Deleted migration file: ${migration.migration}`)
        }
      }
      catch (err) {
        console.error(`-- ✗ Failed to rollback migration ${migration.migration}:`, err)
        throw err
      }
    }

    console.log()
    if (reverseSchema) {
      console.log(reversedAny
        ? '-- ✓ Reverse DDL executed for the rolled-back migration(s).'
        : '-- ⚠️  No reversible DDL found; only migration records were removed.')
    }
    else {
      console.log('-- ⚠️  reverseSchema disabled: only migration records were removed.')
    }
  }
  catch (err) {
    console.error('-- Rollback failed:', err)
    throw err
  }
}
