import { describe, expect, it } from 'bun:test'

for (const mode of ['sqlite', 'sqlite-wrapper', 'mysql', 'postgres'] as const) {
  const local = mode.startsWith('sqlite')
  const url = process.env[`QUERY_CACHE_${mode.toUpperCase()}_URL`]
  describe.skipIf(!local && !url)(`${mode} query cache isolation`, () => {
    it('isolates SQL, bindings, connections and transaction reads', () => {
      // A configured but unavailable service fails. Never discover app DBs.
      const result = Bun.spawnSync({
        cmd: [process.execPath, `${import.meta.dir}/fixtures/query-cache-isolation.ts`, mode],
        env: { ...process.env, QUERY_CACHE_URL: url },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30000,
      })
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toContain(`${mode} cache isolation OK`)
    }, 35000)
  })
}
