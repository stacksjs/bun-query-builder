import type { ColumnPlan, TablePlan } from '../migrations'
import { MySQLDriver } from './mysql'

/**
 * Vitess DDL driver.
 *
 * Vitess shards MySQL behind vtgate, which speaks the MySQL wire protocol, so
 * runtime DML (placeholders, backtick quoting, `ON DUPLICATE KEY UPDATE`,
 * `LAST_INSERT_ID`) is identical — see `isMysqlLike` in `config.ts`. Only DDL
 * diverges, and every divergence below follows from one fact: a keyspace is
 * split across shards that share nothing.
 *
 *  - **No foreign keys.** Enforcing one would need a cross-shard read on every
 *    write, so vtgate rejects them in a sharded keyspace. Both forms are
 *    suppressed: the `ALTER TABLE … ADD CONSTRAINT` statement (`addForeignKey`)
 *    and the inline `REFERENCES` clause the MySQL driver emits inside a column
 *    definition. Missing the inline form would be the subtler bug — the table
 *    plan carries the reference on the column, so a `CREATE TABLE` would fail
 *    on its own without any FK statement being generated.
 *  - **No AUTO_INCREMENT.** Each shard would independently hand out the same
 *    values and collide. This is not a parse error, which makes it worse than
 *    one: the DDL succeeds and the collisions appear later, under load, as
 *    duplicate-key failures on inserts that were previously fine. Primary keys
 *    must come from the application or from a sequence table in an unsharded
 *    keyspace, declared in the VSchema.
 *
 * **Sharding is not expressed in DDL.** Unlike SingleStore, where the shard key
 * is a `CREATE TABLE` clause, Vitess keeps the topology in a separate VSchema
 * document that maps each table's sharding column to a vindex. So `createTable`
 * here is plain MySQL minus the two constructs above, and nothing in this
 * driver needs to know how a table is sharded.
 */
export class VitessDriver extends MySQLDriver {
  /**
   * Vitess rejects AUTO_INCREMENT in a sharded keyspace, so no column ever
   * gets the clause. Overriding here (rather than in `renderColumn`) also
   * covers `addColumn`, which asks the same helper.
   */
  protected override getAutoIncrementClause(_column: ColumnPlan): string {
    return ''
  }

  /**
   * Re-render the column without the inline `REFERENCES` clause.
   *
   * The base implementation appends it whenever `column.references` is set,
   * which is a foreign key by another name and fails the same way. Everything
   * else about the column — type, nullability, default, primary key — is
   * inherited by delegating and stripping, rather than duplicating the base
   * logic and drifting from it.
   */
  protected override renderColumn(column: ColumnPlan): string {
    if (!column.references)
      return super.renderColumn(column)

    // Render as if the reference were not declared. The column itself still
    // exists and is still indexed by the migration plan; only the constraint
    // is dropped, which is exactly the SingleStore contract for `addForeignKey`.
    const { references: _references, ...withoutReference } = column
    return super.renderColumn(withoutReference as ColumnPlan)
  }

  override createTable(table: TablePlan): string {
    // Deliberately the MySQL shape: the shard key lives in the VSchema, not in
    // the CREATE TABLE. The column-level suppressions above are what make this
    // safe on a sharded keyspace.
    return super.createTable(table)
  }

  override addForeignKey(): string {
    // A sharded keyspace cannot enforce referential integrity across shards,
    // so this is a no-op and integrity becomes an application concern. The
    // migration runner tolerates empty statements — same contract as the
    // SingleStore driver and MySQL's no-op enum helpers.
    return ''
  }

  /**
   * The migrations ledger, without a surrogate auto-increment key.
   *
   * `migration` is already unique and is the only column the ledger queries
   * read (`getExecutedMigrationsQuery` / `recordMigrationQuery` never touch
   * `id`), so promoting it to the primary key removes the need for a sequence
   * without losing anything. A VARCHAR key also lets this table live in a
   * sharded keyspace if the operator has not set an unsharded one aside.
   */
  override createMigrationsTable(): string {
    return `CREATE TABLE IF NOT EXISTS migrations (
      migration VARCHAR(255) NOT NULL PRIMARY KEY,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  }
}
