/**
 * The transaction a model call made right now belongs to.
 *
 * The model layer resolves its own executor (orm.ts): a `bun:sqlite` handle,
 * or the pooled driver. `db.transaction()` runs on the builder's connection.
 * Nothing tied the one to the other, so `User.update()` inside a callback that
 * threw stayed written, and a model read could not see what the handle had
 * written and not yet committed (stacksjs/stacks#3269).
 *
 * `transaction()` and `savepoint()` now run their callback inside a scope that
 * names the connection they hold. Every model call made from that callback,
 * however many `await`s later, finds it here and runs on it (orm.ts decides
 * whether that connection is the model's database at all). A call from
 * anywhere else, such as another request served while the transaction is
 * open, has no scope and runs as before.
 *
 * The scope ends with the callback. A continuation the callback scheduled and
 * did not wait for still carries it, so it is closed rather than trusted: a
 * model call that runs after the transaction is an ordinary write, not one on
 * a connection that has committed.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface ModelTransaction {
  /** The connection the transaction (or savepoint) holds. */
  readonly connection: object
  /** False once the callback has finished. */
  open: boolean
}

const scope = new AsyncLocalStorage<ModelTransaction>()

/**
 * How many scopes are open. A model call outside every transaction is the
 * common case, and this keeps it from asking the async context at all.
 */
let opened = 0

/** The open transaction this call is part of, if there is one. */
export function currentModelTransaction(): ModelTransaction | undefined {
  if (opened === 0)
    return undefined
  const current = scope.getStore()
  return current?.open ? current : undefined
}

/**
 * Open a scope on `connection` for a transaction callback. `run` calls the
 * callback inside it; `close` ends it, and is called once the callback has
 * answered, whether it returned or threw.
 */
export function openModelTransaction(connection: object): { run: <T>(fn: () => T) => T, close: () => void } {
  const transaction: ModelTransaction = { connection, open: true }
  opened++
  return {
    run: fn => scope.run(transaction, fn),
    close: () => {
      if (!transaction.open)
        return
      transaction.open = false
      opened--
    },
  }
}
