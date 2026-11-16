/**
 * A transaction's callback runs in the async context `transaction()` was
 * called from.
 *
 * A pooled driver starts the callback once it has a connection, and that can
 * be from the context of whichever caller released one. The callback then saw
 * that caller's request, not its own, and lost the scope that puts model
 * writes in the transaction (model-transaction.ts). Stacks worked around it by
 * binding every callback itself (stacksjs/stacks#3269).
 *
 * The connection here does what such a pool does: it runs the callback from a
 * context of its own.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it } from 'bun:test'
import { createQueryBuilder } from '../src'

const context = new AsyncLocalStorage<string>()
const fromThePool = context.run('pool', () => AsyncLocalStorage.snapshot())

function pooledConnection() {
  const waiting: Array<() => void> = []
  const later = (callback: (handle: unknown) => unknown, handle: unknown) => new Promise((resolve, reject) => {
    waiting.push(() => {
      try {
        resolve(callback(handle))
      }
      catch (error) {
        reject(error)
      }
    })
  })
  const handle: Record<string, unknown> = {
    unsafe: () => [],
    savepoint: (...args: unknown[]) => later(args.find(arg => typeof arg === 'function') as (handle: unknown) => unknown, handle),
  }
  const connection = {
    unsafe: () => [],
    begin: (...args: unknown[]) => later(args.find(arg => typeof arg === 'function') as (handle: unknown) => unknown, handle),
  }
  /** Start what is waiting, from the pool's context. */
  const release = async (): Promise<void> => {
    for (let turn = 0; turn < 50; turn++) {
      await Bun.sleep(1)
      while (waiting.length)
        fromThePool(() => waiting.shift()!())
    }
  }
  return { connection, release }
}

describe('a transaction callback', () => {
  it('runs in the context its caller called transaction() from', async () => {
    const { connection, release } = pooledConnection()
    const db = createQueryBuilder({ sql: connection as never })
    const seen = context.run('request', () => db.transaction(async () => context.getStore()))
    await release()
    expect(await seen).toBe('request')
  })

  it('and a savepoint in the context it was called from', async () => {
    const { connection, release } = pooledConnection()
    const db = createQueryBuilder({ sql: connection as never })
    const seen = context.run('request', () => db.transaction(async tx => ({
      outer: context.getStore(),
      inner: await context.run('inner', () => tx.savepoint(async () => context.getStore())),
    })))
    await release()
    expect(await seen).toEqual({ outer: 'request', inner: 'inner' })
  })
})
