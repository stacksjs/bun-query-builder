import type { IndexPlan, TablePlan } from '../migrations'
import { MySQLDriver } from './mysql'

/**
 * SingleStore DDL driver.
 *
 * SingleStore (formerly MemSQL) speaks the MySQL wire protocol, so runtime DML
 * (placeholders, backtick quoting, `ON DUPLICATE KEY UPDATE`, `LAST_INSERT_ID`)
 * is identical — see `isMysqlLike` in `config.ts`. Only the DDL diverges, which
 * is what this driver customizes:
 *
 *  - **Distributed tables.** Rows are hash-partitioned across leaf nodes by a
 *    `SHARD KEY`. When a model declares `shardKey`, we emit it; otherwise
 *    SingleStore shards on the primary key (or a random key for columnstore),
 *    so a plain MySQL-shaped `CREATE TABLE` still works.
 *  - **Storage engine.** `tableKind: 'columnstore'` (default for analytics
 *    workloads) emits `SORT KEY (...)`; `'rowstore'` emits `ROWSTORE`;
 *    `'reference'` emits a `REFERENCE` table (fully replicated, no shard key —
 *    ideal for small dimension tables that get JOINed everywhere).
 *  - **No foreign keys.** SingleStore does not support `FOREIGN KEY`
 *    constraints, so `addForeignKey` is a no-op (referential integrity is an
 *    application concern). This mirrors how the MySQL driver already treats
 *    enums (`createEnumType` → '').
 */
export class SingleStoreDriver extends MySQLDriver {
  override createTable(table: TablePlan): string {
    const columns = table.columns.map(c => this.renderColumn(c)).join(',\n  ')

    const clauses: string[] = []

    // SHARD KEY — explicit columns win; otherwise SingleStore uses the PK.
    // A `reference` table is fully replicated and must NOT carry a shard key.
    if (table.tableKind !== 'reference') {
      const shardCols = table.shardKey?.length
        ? table.shardKey
        : table.columns.filter(c => c.isPrimaryKey).map(c => c.name)
      if (shardCols && shardCols.length > 0) {
        clauses.push(`SHARD KEY (${shardCols.map(c => this.quoteIdentifier(c)).join(', ')})`)
      }
    }

    // SORT KEY — columnstore ordering. Default the table to columnstore (the
    // SingleStore analytics sweet spot) unless the model asks for rowstore.
    if (table.tableKind !== 'rowstore' && table.tableKind !== 'reference') {
      const sortCols = table.sortKey?.length ? table.sortKey : undefined
      // `SORT KEY ()` (empty) is valid and tells SingleStore to build a
      // columnstore with no explicit sort order — cheaper than forcing one.
      clauses.push(`SORT KEY (${(sortCols ?? []).map(c => this.quoteIdentifier(c)).join(', ')})`)
    }

    const body = [columns, ...clauses].join(',\n  ')
    const suffix = this.tableKindSuffix(table.tableKind)
    return `CREATE${suffix} TABLE IF NOT EXISTS ${this.quoteIdentifier(table.table)} (\n  ${body}\n);`
  }

  private tableKindSuffix(kind: TablePlan['tableKind']): string {
    switch (kind) {
      case 'rowstore': return ' ROWSTORE'
      case 'reference': return ' REFERENCE'
      // columnstore is the default; no keyword needed (a SORT KEY makes it
      // columnstore implicitly).
      default: return ''
    }
  }

  override addForeignKey(): string {
    // SingleStore does not support FOREIGN KEY constraints. Emitting one is a
    // hard parse error, so we skip it entirely — the migration runner tolerates
    // empty statements (same contract as MySQL's no-op enum type helpers).
    return ''
  }

  override createIndex(tableName: string, index: IndexPlan): string {
    if (index.where) {
      throw new Error(
        `[migrations] Partial indexes (CompositeIndex.where) are not supported on SingleStore. Index '${index.name}' on table '${tableName}' uses WHERE clause: ${index.where}`,
      )
    }
    // SingleStore supports standard secondary indexes; UNIQUE indexes are only
    // enforced when they contain the shard key, but we still emit the requested
    // shape and let the engine validate — the same responsibility boundary the
    // MySQL driver keeps. Reuse the MySQL implementation.
    return super.createIndex(tableName, index)
  }
}
