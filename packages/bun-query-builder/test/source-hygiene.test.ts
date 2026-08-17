/**
 * Mechanical checks on the source itself.
 *
 * `src/client.ts` carried a literal NUL byte (0x00) for two months, written as
 * the raw control character instead of the `\0` escape, as the delimiter in a
 * cache key:
 *
 *     const cacheKey = `${String(finalQuery)}<0x00>${JSON.stringify(params)}`
 *
 * The runtime string was correct, so nothing failed and nothing caught it. What
 * it broke was every tool that reads the file. A single NUL makes grep classify
 * the whole file as binary, and grep then reports "binary file matches" instead
 * of matching lines — ripgrep, VS Code search and agent search tools inherit
 * the same behaviour. The repo's largest and most-edited file, 8000+ lines,
 * silently returned nothing for ordinary searches:
 *
 *     $ grep -c "async paginate" src/client.ts
 *     0                                   # exit 1, while `grep -a` finds it
 *
 * A search that returns nothing is indistinguishable from a symbol that does
 * not exist, so this actively misleads anyone — human or otherwise — trying to
 * find code in it.
 *
 * The escape and the raw byte produce byte-identical transpiler output, so
 * there is never a reason to commit the raw byte.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC_DIR = resolve(import.meta.dir, '../src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (statSync(full).isFile() && (extname(full) === '.ts' || extname(full) === '.tsx'))
      out.push(full)
  }
  return out
}

describe('source hygiene', () => {
  it('no source file contains a raw control character that makes it read as binary', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(SRC_DIR)) {
      const text = readFileSync(file, 'utf8')
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        // Everything below 0x20 except tab (9), newline (10) and carriage
        // return (13). NUL is the one that triggers the binary heuristic, but
        // no other C0 control belongs in a source file either.
        if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) {
          const line = text.slice(0, i).split('\n').length
          offenders.push(
            `${relative(SRC_DIR, file)}:${line} contains U+${code.toString(16).padStart(4, '0').toUpperCase()} — `
            + `write it as an escape (\\0, \\u0001, …) instead of the raw byte`,
          )
          break
        }
      }
    }

    expect(offenders).toEqual([])
  })

  /**
   * Guards the specific delimiter rather than only the byte: swapping it for a
   * printable character would reintroduce the collision d7c3a16 fixed, where a
   * SQL tail and a parameter head could run together into the same cache key.
   */
  it('the query cache key still separates SQL from params with a NUL', () => {
    const client = readFileSync(join(SRC_DIR, 'client.ts'), 'utf8')
    expect(client).toContain('`${String(finalQuery)}\\0${JSON.stringify(whereParams)}`')
  })
})
