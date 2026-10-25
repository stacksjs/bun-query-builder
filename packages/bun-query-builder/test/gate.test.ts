/**
 * The live-service gate raises where the service is provided, skips where it
 * is optional.
 *
 * `probePostgres()` used to answer `false` for every possible failure, so the
 * 14 files gated on it vanished into "skip" whenever Postgres was unreachable
 * for any reason — and a run with all of them gone still exits 0. That is how
 * this repository once shipped a release whose two most severe guards never
 * executed: the probe built its URL from `process.env.USER`, auth failed on
 * every runner, and CI was green throughout. Fixing the URL fixed that cause.
 * This pins the mechanism.
 *
 * Both directions are controlled, because only the pair is evidence: a gate
 * that always raises would pass the first case here while making the suite
 * unrunnable for anyone without Postgres, which is the behaviour the skip
 * exists to provide.
 *
 * Each case runs the real gate in a child `bun test`, against a port nothing
 * answers on, and reads the exit status — the thing CI actually keys on.
 */

import { describe, expect, it } from 'bun:test'
import process from 'node:process'
import { resolve } from 'node:path'

// Any file whose only precondition is a live Postgres. Its own assertions are
// irrelevant here; what matters is whether the gate let the run pass.
const GATED = 'packages/bun-query-builder/test/client.json-contains.pg.test.ts'
const REPO = resolve(import.meta.dir, '../../..')
const UNREACHABLE = 'postgresql://postgres:postgres@127.0.0.1:59999/test_db'

function runGated(env: Record<string, string | undefined>): { code: number | null, output: string } {
  const child = Bun.spawnSync([process.execPath, 'test', GATED], {
    cwd: REPO,
    env: {
      ...process.env,
      // Cleared so the parent environment cannot decide the case under test:
      // a developer machine has no CI, a runner has it set, and this file has
      // to produce both regardless of where it runs.
      CI: undefined,
      QB_REQUIRE_LIVE: undefined,
      DATABASE_URL: UNREACHABLE,
      POSTGRES_URL: UNREACHABLE,
      ...env,
    } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  return {
    code: child.exitCode,
    output: `${child.stdout.toString()}${child.stderr.toString()}`,
  }
}

describe('the live-Postgres gate', () => {
  it('fails the run when a provided Postgres is unreachable', () => {
    const { code, output } = runGated({ CI: '1' })

    // The assertion that matters is the status, not the text: a skipped suite
    // exits 0, and 0 is what CI reads as "the guards ran and passed".
    expect(code).not.toBe(0)
    // And it has to say what was missing, or the red run sends someone hunting
    // through 14 files for a failure that is really a dead service.
    expect(output).toContain('live Postgres')
    expect(output).toContain('59999')
  }, 30_000)

  it('skips, and passes, where Postgres is merely optional', () => {
    const { code, output } = runGated({})

    expect(code).toBe(0)
    expect(output).toContain('skipping live Postgres tests')
  }, 30_000)

  it('lets a CI-like environment without services opt out', () => {
    // A fork running the suite with no service containers: CI is set, but
    // nothing provides Postgres, so the gate must stay a skip.
    const { code } = runGated({ CI: '1', QB_REQUIRE_LIVE: '0' })

    expect(code).toBe(0)
  }, 30_000)

  it('lets a developer opt in to CI strictness', () => {
    const { code } = runGated({ QB_REQUIRE_LIVE: '1' })

    expect(code).not.toBe(0)
  }, 30_000)
})
