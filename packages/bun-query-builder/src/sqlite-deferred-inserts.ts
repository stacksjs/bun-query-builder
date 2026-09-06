import type { Database, SQLQueryBindings } from 'bun:sqlite'

export type DeferredInsert = (table: string, record: Readonly<Record<string, SQLQueryBindings | undefined>>) => Promise<void>

interface Entry {
  table: string
  columns: string[]
  values: SQLQueryBindings[]
  shape: string
  uncached: boolean
  resolve: () => void
  reject: (error: unknown) => void
}

const MAX_ROWS = 32
const MAX_BYTES = 256 * 1024

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Native work stays synchronous so close and transaction barriers can drain it. */
export class SQLiteDeferredInserts {
  private pending: Entry[] = []
  private bytes = 0
  private timer: ReturnType<typeof setImmediate> | undefined
  private closed = false
  private failure: Error | undefined

  constructor(private database: Database) {}

  get hasPending(): boolean {
    return this.pending.length > 0
  }

  append: DeferredInsert = (table, record) => {
    if (this.failure)
      return Promise.reject(this.failure)
    if (this.closed)
      return Promise.reject(new Error('Deferred insert connection is closed'))

    // Snapshot caller-owned values before scheduling. Explicit undefined binds
    // NULL; an absent property retains the column's database default.
    const columns = Object.keys(record)
    const values = columns.map((column) => {
      const value = record[column]
      if (ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
      return value ?? null
    })
    const shape = JSON.stringify([table, columns])
    // Bound retained payload, including UTF-16 strings and a conservative
    // allowance for per-entry metadata. Oversized records never wait in memory.
    const size = 512 + shape.length * 2 + values.reduce<number>((sum, value) => {
      return sum + (typeof value === 'string' ? value.length * 2 : ArrayBuffer.isView(value) ? value.byteLength : 16)
    }, 0)
    if (this.hasPending && (this.pending.length >= MAX_ROWS || this.bytes + size > MAX_BYTES))
      this.flush()

    return new Promise<void>((resolve, reject) => {
      const entry = { table, columns, values, shape, uncached: size > MAX_BYTES, resolve, reject }
      if (this.database.inTransaction || size > MAX_BYTES) {
        this.writeOne(entry)
        return
      }
      this.pending.push(entry)
      this.bytes += size
      this.timer ??= setImmediate(() => this.flush())
    })
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearImmediate(this.timer)
      this.timer = undefined
    }
    const pending = this.pending
    this.pending = []
    this.bytes = 0
    for (let offset = 0; offset < pending.length;) {
      if (this.failure) {
        for (const entry of pending.slice(offset))
          entry.reject(this.failure)
        return
      }
      let end = offset + 1
      while (end < pending.length && pending[end].shape === pending[offset].shape)
        end++
      const batch = pending.slice(offset, end)
      offset = end
      if (batch.length === 1 || !batch[0].columns.length || this.database.inTransaction) {
        for (const entry of batch)
          this.writeOne(entry)
        continue
      }
      try {
        this.database.transaction(() => {
          const first = batch[0]
          const tuple = `(${first.columns.map(() => '?').join(',')})`
          const sql = `INSERT INTO ${quote(first.table)} (${first.columns.map(quote).join(',')}) VALUES ${batch.map(() => tuple).join(',')}`
          this.database.query(sql).run(...batch.flatMap(entry => entry.values))
        })()
        for (const entry of batch)
          entry.resolve()
      }
      catch (error) {
        // RAISE(FAIL) can retain a successful prefix. Retry only after native
        // rollback has ended the transaction, including commit-time failures.
        // If rollback itself failed, replay could duplicate that prefix.
        if (this.database.inTransaction) {
          this.invalidate(error)
          for (const entry of [...batch, ...pending.slice(offset)])
            entry.reject(error)
          return
        }
        for (const entry of batch)
          this.writeOne(entry)
      }
    }
  }

  private writeOne(entry: Entry): void {
    let inTransaction = false
    try {
      this.assertUsable()
      inTransaction = this.database.inTransaction
      const sql = entry.columns.length
        ? `INSERT INTO ${quote(entry.table)} (${entry.columns.map(quote).join(',')}) VALUES (${entry.columns.map(() => '?').join(',')})`
        : `INSERT INTO ${quote(entry.table)} DEFAULT VALUES`
      const write = () => {
        if (!entry.uncached)
          return this.database.query(sql).run(...entry.values)
        // A cached statement retains its latest bindings. Oversized payloads
        // must leave memory after execution, on success as well as failure.
        const statement = this.database.prepare(sql)
        try {
          return statement.run(...entry.values)
        }
        finally {
          statement.finalize()
        }
      }
      // Inside an application transaction, preserve ordinary INSERT semantics.
      // Outside one, isolate trigger side effects when a retry rejects a row.
      if (inTransaction)
        write()
      else
        this.database.transaction(write)()
      entry.resolve()
    }
    catch (error) {
      if (!this.failure && !inTransaction && this.database.inTransaction)
        this.invalidate(error)
      entry.reject(error)
    }
  }

  assertUsable(): void {
    if (this.failure)
      throw this.failure
  }

  private invalidate(cause: unknown): void {
    this.failure = new Error('SQLite connection is unusable after deferred insert rollback failed', { cause })
    // Never let a later COMMIT persist records whose promises we rejected.
    // Closing discards the native transaction; the guard remains if close fails.
    try {
      this.database.close()
    }
    catch {}
  }

  close(): void {
    this.closed = true
    this.flush()
  }
}
