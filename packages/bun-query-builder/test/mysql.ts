/**
 * The MySQL a gated test should connect to, and whether it is reachable.
 *
 * The same contract as `pg.ts`, for the same reason: prefer what the
 * environment says (CI exports the service's URL), fall back to the shape of a
 * developer machine, and where the environment is one that supplies MySQL,
 * raise instead of skipping when it does not answer (see `gate.ts`).
 */

import { SQL } from 'bun'
import process from 'node:process'
import { gateUnavailable, requiredInCi } from './gate'

export const MYSQL_URL: string
  = process.env.MYSQL_URL
    ?? process.env.QUERY_HOOK_MYSQL_URL
    ?? 'mysql://root@127.0.0.1:3306/test_db'

export async function probeMysql(): Promise<boolean> {
  const attempts = requiredInCi() ? 3 : 1
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const probe = new SQL(MYSQL_URL)
      await probe.unsafe('SELECT 1')
      await probe.end()
      return true
    }
    catch (error) {
      lastError = error
      if (attempt < attempts)
        await Bun.sleep(attempt * 250)
    }
  }

  return gateUnavailable(
    'live MySQL',
    `${MYSQL_URL} did not answer after ${attempts} attempt${attempts === 1 ? '' : 's'} (${(lastError as Error)?.message ?? lastError})`,
    'Start MySQL, or point MYSQL_URL at one.',
  )
}
