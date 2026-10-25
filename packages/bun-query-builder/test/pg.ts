/**
 * The Postgres a gated test should connect to, and whether it is reachable.
 *
 * Several tests can only be written against a real pooled driver — the
 * transaction data leak (#1065), the migration lock (#1067), the ORM
 * integration pass (#1038) — so they gate on a live server and skip without
 * one. That gate was quietly wrong in CI.
 *
 * Each of those files built its own URL as
 * `postgres://${process.env.USER}@localhost:5432/postgres`, which describes a
 * developer machine: a peer-authenticated server owned by the current user,
 * no password. CI is not that. It starts Postgres 17 as a service with
 * `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres`, `POSTGRES_DB=test_db`
 * and exports `DATABASE_URL`. On a runner, `process.env.USER` is `runner`, so
 * every probe failed with
 *
 *     FATAL: password authentication failed for user "runner"
 *
 * the gate read that as "no Postgres here", and the tests SKIPPED. CI stayed
 * green while the guards for the two most severe bugs in the release never
 * ran at all — the worst shape for a test to be in, because the green tick
 * says the opposite.
 *
 * So: prefer what the environment tells us, fall back to the local shape.
 */

import { SQL } from 'bun'
import process from 'node:process'
import { gateUnavailable, requiredInCi } from './gate'

export const PG_URL: string
  = process.env.DATABASE_URL
    ?? process.env.POSTGRES_URL
    ?? `postgres://${process.env.USER ?? 'postgres'}@localhost:5432/postgres`

/**
 * Whether that server actually answers.
 *
 * A function rather than an awaited constant so this module needs no top-level
 * await: the rule against it exists to keep one out of the shipped bundle, and
 * suppressing it in a helper to save three callers one line each is a poor
 * trade. Callers await it at the top of their own `.test.ts`, where the rule
 * does not apply. The URL above is the part that was wrong and the part worth
 * sharing; this is three lines of probe.
 *
 * It no longer answers `false` unconditionally. Fixing the URL fixed the cause
 * of the incident above but not its mechanism: `catch { return false }` reads
 * every possible failure — a rotated password, a service that never came up,
 * an exhausted connection limit — as "this machine has no Postgres", and the
 * 14 files gated on it disappear. Measured on the suite as it stands, a
 * Postgres that does not answer takes 30 passing live-Postgres assertions down
 * to 11 and still exits 0. So where the environment is one that supplies
 * Postgres, an unreachable server raises; see `gate.ts`.
 */
export async function probePostgres(): Promise<boolean> {
  // Only where a failure is fatal, and only then: locally the connection is
  // refused immediately and retrying three times per file for a developer who
  // has no Postgres is pure latency. In CI the workflow already waits for
  // `pg_isready`, so this is for a blip after that point rather than for boot.
  const attempts = requiredInCi() ? 3 : 1
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const probe = new SQL(PG_URL)
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
    'live Postgres',
    `${PG_URL} did not answer after ${attempts} attempt${attempts === 1 ? '' : 's'} (${(lastError as Error)?.message ?? lastError})`,
    'Start Postgres, or point DATABASE_URL at one.',
  )
}
