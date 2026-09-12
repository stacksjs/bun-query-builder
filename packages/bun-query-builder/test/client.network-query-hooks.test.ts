import { describe, expect, it } from 'bun:test'

// Explicit opt-in: never probe or modify an application's default database.
for (const dialect of ['mysql', 'postgres'] as const) {
  const url = process.env[`QUERY_HOOK_${dialect.toUpperCase()}_URL`]
  describe.skipIf(!url)(`${dialect} query hook metadata (#1142)`, () => {
    it('reports parameterized SQL through the native driver', () => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, `${import.meta.dir}/fixtures/network-query-hooks.ts`, dialect],
        env: { ...process.env, QUERY_HOOK_URL: url },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30000,
      })
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toContain('query hooks OK')
    }, 35000)
  })
}
