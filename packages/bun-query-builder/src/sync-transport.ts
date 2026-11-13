/**
 * Which synchronous driver a connection gets.
 *
 * There are two, with one face (`SyncDatabase`): the pool on the calling
 * thread (native-sync-driver.ts), for a Bun whose MySQL and Postgres drivers
 * can wait for a statement where it is issued, and the pool on a worker
 * thread (sync-driver.ts), for every other Bun. The first is preferred where
 * it exists: no second thread, and no copy of the rows between two.
 */

import type { SyncDatabase } from './sync-driver'
import { config } from './config'
import { NativeSyncDriver } from './native-sync-driver'
import { SyncDriver } from './sync-driver'

/**
 * Open a driver for `url`. `models.transport: 'worker'` keeps the worker even
 * where the runtime could do without it.
 */
export function openSyncDriver(url: string, options: Record<string, unknown> = {}): SyncDatabase {
  if (config.models?.transport !== 'worker') {
    const native = NativeSyncDriver.open(url, options)
    if (native)
      return native
  }
  return new SyncDriver(url, options)
}

let current: { key: string, driver: SyncDatabase } | null = null

/**
 * The driver for a connection, opened on first use and kept until the
 * connection it describes changes. `key` is the caller's identity for it.
 */
export function syncDriverFor(key: string, target: () => { url: string, options: Record<string, unknown> }): SyncDatabase {
  if (current?.key === key)
    return current.driver
  closeSyncDriver()
  const { url, options } = target()
  current = { key, driver: openSyncDriver(url, options) }
  return current.driver
}

/** Close the model layer's synchronous connection, if one is open. */
export function closeSyncDriver(): void {
  const open = current
  current = null
  open?.driver.close()
}
