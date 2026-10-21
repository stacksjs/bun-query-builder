/**
 * Whether a precondition a test needs is allowed to be missing.
 *
 * A gated test — one that needs a live server, or a built `dist/` — has to do
 * something when its precondition is absent. Skipping is right on a developer
 * machine: nobody should have to run Postgres to change a string helper. In CI
 * the same absence means the opposite, because the workflow PROVIDES the
 * precondition: it starts Postgres 17 as a service, waits for `pg_isready`,
 * exports `DATABASE_URL`, and builds before testing. So in CI a missing
 * precondition is a broken job, and skipping turns it into a green tick over
 * tests that never ran.
 *
 * This repository has been bitten by that twice, and both are written up where
 * they happened:
 *
 *  - every live-Postgres gate built its URL from `process.env.USER`, which on a
 *    runner is `runner`, so every probe failed auth and all 14 files skipped —
 *    "CI stayed green while the guards for the two most severe bugs in the
 *    release never ran at all" (see the docblock in `pg.ts`)
 *  - the CI `test` job did not build, so the published-types guard returned
 *    early on every run and checked nothing, which is how an `any` reached
 *    `client.d.ts` (see `public-surface-types.test.ts`)
 *
 * Both were fixed by repairing the cause. Neither closed the mechanism, so the
 * next cause — a rotated service password, a service that fails to start, a
 * build step someone reorders — lands in the same silence. That is what this
 * closes: `required()` is true in CI, so the gate raises instead of skipping.
 *
 * `QB_REQUIRE_LIVE` overrides it in both directions: `0` for a CI-like
 * environment that genuinely has no services (a fork running the suite without
 * them), `1` to get CI's strictness locally.
 */

import process from 'node:process'

export function requiredInCi(): boolean {
  const override = process.env.QB_REQUIRE_LIVE
  if (override !== undefined)
    return override !== '0' && override !== 'false' && override !== ''
  return Boolean(process.env.CI)
}

/**
 * Report an absent precondition: raise where it must be present, warn and
 * return `false` where skipping is legitimate.
 *
 * Returning the boolean rather than calling `describe.skipIf` here keeps the
 * decision at the call site, where bun:test needs it at module scope.
 */
export function gateUnavailable(what: string, reason: string, remedy: string): false {
  if (requiredInCi()) {
    throw new Error(
      `[gate] ${what} is required here but unavailable: ${reason}. `
      + `CI provides it, so this is a broken job rather than an absent optional dependency — `
      + `skipping would report a green run over tests that never executed. ${remedy} `
      + `Set QB_REQUIRE_LIVE=0 if this environment genuinely has none.`,
    )
  }

  console.warn(`[gate] skipping ${what} tests: ${reason}. ${remedy}`)
  return false
}
