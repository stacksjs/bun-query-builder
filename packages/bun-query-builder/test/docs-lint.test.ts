/**
 * Mechanical checks on the documentation.
 *
 * Three classes of doc breakage reached `main` and survived months, because
 * nothing verified the docs against the code:
 *
 *  - ~40 documented calls to builder methods that do not exist (`db.update`,
 *    `db.insert`, `db.delete`, `db.execute`, `db.beginTransaction`, …). Every
 *    one threw on its first line, on every dialect, and `docs/api/reference.md`
 *    listed one of them in its method table.
 *  - Six pages truncated mid-code-block by a lint-fix commit, each starting on
 *    an orphaned expression with no H1 and an unbalanced fence.
 *  - 132 identifiers whose `_` had been rewritten to `*` — `created*at`,
 *    `user*id` — and the multiplication in `7 * 24 * 60 * 60 * 1000` rewritten
 *    the other way. One line read `60 _ 60 * 1000`, half converted.
 *
 * None of these need a database or a network, so they are cheap to assert.
 * The builder-method check is the load-bearing one: it compares every
 * documented call against the live export list rather than a hand-kept copy,
 * so it cannot drift as the API grows.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, createQueryBuilder } from '../src/index'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const DOCS_DIR = join(REPO_ROOT, 'docs')

function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    // `public/` holds images and other binaries.
    if (entry.isDirectory()) {
      if (entry.name !== 'public')
        out.push(...markdownFiles(full))
      continue
    }
    if (extname(entry.name) === '.md')
      out.push(full)
  }
  return out.sort()
}

const DOC_FILES = markdownFiles(DOCS_DIR)
const READMES = [join(REPO_ROOT, 'README.md'), join(REPO_ROOT, 'packages/bun-query-builder/README.md')]
  .filter(p => statSync(p, { throwIfNoEntry: false }))
const ALL_FILES = [...DOC_FILES, ...READMES]

const rel = (p: string) => relative(REPO_ROOT, p)

describe('docs lint', () => {
  it('finds documentation to check', () => {
    // Guards the guard: a bad glob would make every assertion below vacuous.
    expect(DOC_FILES.length).toBeGreaterThan(20)
  })

  it('closes every code fence', () => {
    // An odd count means a page is truncated mid-block — the exact signature of
    // the six pages that lost their heads.
    const offenders: string[] = []
    for (const file of ALL_FILES) {
      const fences = readFileSync(file, 'utf8').split('\n').filter(l => l.startsWith('```')).length
      if (fences % 2 !== 0)
        offenders.push(`${rel(file)} (${fences} fences)`)
    }
    expect(offenders).toEqual([])
  })

  it('starts every prose page with a heading', () => {
    // The truncated pages opened on an orphaned `.get()` instead. This is what
    // caught `docs/aggregations.md`, a seventh casualty of the same commit that
    // the first repair pass missed.
    const offenders: string[] = []
    for (const file of DOC_FILES) {
      const raw = readFileSync(file, 'utf8')
      const lines = raw.split('\n')
      let i = 0
      let frontmatter = ''
      if (lines[0]?.trim() === '---') {
        i = 1
        while (i < lines.length && lines[i].trim() !== '---') {
          frontmatter += `${lines[i]}\n`
          i++
        }
        i++
      }
      // `layout: home` / `layout: page` pages (index, team) render from
      // frontmatter and legitimately have no heading in the body.
      if (/^layout:/m.test(frontmatter))
        continue

      while (i < lines.length && lines[i].trim() === '') i++
      // A leading HTML block — the centred logo on intro.md — is fine, so long
      // as a heading follows it.
      if (lines[i]?.startsWith('<')) {
        while (i < lines.length && !lines[i].startsWith('#') && lines[i].trim() !== '') i++
        while (i < lines.length && lines[i].trim() === '') i++
      }
      if (!lines[i]?.startsWith('#'))
        offenders.push(`${rel(file)} starts with: ${JSON.stringify(lines[i]?.slice(0, 60) ?? '')}`)
    }
    expect(offenders).toEqual([])
  })

  it('has no identifiers whose underscore was rewritten as an asterisk', () => {
    // `created*at`, `user*id`. Deliberately narrow so `SELECT *`, `COUNT(*)`
    // and `**bold**` are untouched: the asterisk must sit between two
    // alphanumerics with no spaces.
    const offenders: string[] = []
    for (const file of ALL_FILES) {
      readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
        const hit = line.match(/[A-Za-z0-9]\*[A-Za-z0-9]/)
        if (hit)
          offenders.push(`${rel(file)}:${n + 1} ${hit[0]}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('has no multiplication rewritten as an underscore', () => {
    // `7 _ 24 _ 60 _ 60 _ 1000` was `7 * 24 * 60 * 60 * 1000`.
    const offenders: string[] = []
    for (const file of ALL_FILES) {
      readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
        const hit = line.match(/[A-Za-z0-9_)\]] _ [A-Za-z0-9(]/)
        if (hit)
          offenders.push(`${rel(file)}:${n + 1} ${hit[0]}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('only documents builder methods that exist', () => {
    // Compared against the live builder rather than a hand-kept list, so the
    // check keeps working as the API grows.
    const schema = buildDatabaseSchema({
      User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
    } as any)
    const builder = createQueryBuilder<typeof schema>({ schema }) as Record<string, unknown>
    const methods = new Set(Object.keys(builder))
    // The same receiver names hold chain objects in the docs' examples
    // (`const q = db.selectFrom('users'); q.where(...)`), so a chain's methods
    // are equally legitimate. Collect them from a real chain rather than
    // listing them, for the same reason as the builder itself.
    for (const chain of [
      (builder as any).selectFrom('users'),
      (builder as any).insertInto('users'),
      (builder as any).updateTable('users'),
      (builder as any).deleteFrom('users'),
    ]) {
      let obj = chain
      while (obj && obj !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(obj)) methods.add(k)
        obj = Object.getPrototypeOf(obj)
      }
    }
    expect(methods.size).toBeGreaterThan(40)

    // Receivers that are a query builder in the docs' own examples.
    const CALL = /\b(?:db|trx|tx|sp|innerTrx|qb)\.([a-zA-Z]+)\(/g
    const offenders: string[] = []
    for (const file of ALL_FILES) {
      readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
        for (const m of line.matchAll(CALL)) {
          if (!methods.has(m[1]))
            offenders.push(`${rel(file)}:${n + 1} .${m[1]}()`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('only documents environment variables the library reads', () => {
    // `DB_USER`, `DB_TIMEOUT`, `DB_RETRY_ATTEMPTS` and friends were documented
    // for a long time and read nowhere, so following the docs did nothing and
    // reported no error.
    const srcDir = resolve(import.meta.dir, '../src')
    const sources: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory())
          walk(full)
        else if (extname(entry.name) === '.ts')
          sources.push(readFileSync(full, 'utf8'))
      }
    }
    walk(srcDir)
    const source = sources.join('\n')

    // `createConnectionString` does `const e = process.env` and then reads
    // `e.DB_HOST`, so a scan for `process.env.DB_*` alone reports variables as
    // unread when they are not. Match the property access on any receiver, and
    // strip comments first so a prose mention does not count as a read.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(l => l.replace(/\/\/.*$/, ''))
      .join('\n')

    const read = new Set<string>()
    for (const m of code.matchAll(/\.(DB_[A-Z0-9_]+)\b/g)) read.add(m[1])
    for (const m of code.matchAll(/\[['"](DB_[A-Z0-9_]+)['"]\]/g)) read.add(m[1])
    expect(read.size).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of ALL_FILES) {
      readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
        for (const m of line.matchAll(/\b(DB_[A-Z0-9_]{2,})\b/g)) {
          if (!read.has(m[1]))
            offenders.push(`${rel(file)}:${n + 1} ${m[1]}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
