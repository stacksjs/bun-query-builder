import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A guard on what the published types actually say.
 *
 * `any` in a `.d.ts` is not a local shortcut - it is a hole punched through
 * every consumer's typechecker. An app that writes `db.selectFrom('users')`
 * gets no help from the compiler if the builder it received was typed `any`
 * three files upstream, and that is exactly how the ORM ended up reporting
 * models as `any` in installed Stacks apps.
 *
 * So the count is pinned. The survivors are deliberate and each carries its
 * reason in the source:
 *
 *  - driver escape hatches in `db.ts` (`execute(): Promise<any>`, the
 *    `[key: string]: any` index signatures) - narrowing them would force a
 *    cast at every `await sql.unsafe(...)` call site, which is the same hole
 *    moved somewhere less visible
 *  - `(...args: any[]) => any` in `DeepPartial` - the standard "is this a
 *    function" idiom; `unknown[]` does not match under contravariance
 *  - accessor/mutator parameters in `schema.ts` - a model's own
 *    `(value: string) => ...` would be REJECTED against `unknown`
 *  - the faker proxy's dynamic members
 *
 * Adding one means either a real justification in a comment next to it, or a
 * better type. Raising this number without the former is the regression.
 */

const DIST = join(import.meta.dir, '..', 'dist')
const BASELINE = 18

function anyCount(source: string): number {
  return (source.match(/:\s*any\b|<any>|any\[\]/g) ?? []).length
}

describe('the published type surface', () => {
  it('does not leak more `any` than the documented survivors', () => {
    if (!existsSync(DIST)) {
      // Types are a build output; nothing to check before `bun run build`.
      return
    }

    const declarations = readdirSync(DIST).filter(file => file.endsWith('.d.ts'))
    expect(declarations.length).toBeGreaterThan(0)

    const total = declarations.reduce(
      (sum, file) => sum + anyCount(readFileSync(join(DIST, file), 'utf8')),
      0,
    )

    expect(total).toBeLessThanOrEqual(BASELINE)
  })

  it('keeps the query builder itself free of them', () => {
    if (!existsSync(join(DIST, 'client.d.ts')))
      return

    // client.d.ts is the type an app touches on every single query. It went
    // from 29 to 0 by naming what a schema IS (`AnyDatabaseSchema`) instead
    // of writing `DatabaseSchema<any>` in 21 generic constraints.
    expect(anyCount(readFileSync(join(DIST, 'client.d.ts'), 'utf8'))).toBe(0)
    expect(anyCount(readFileSync(join(DIST, 'orm.d.ts'), 'utf8'))).toBe(0)
  })
})
