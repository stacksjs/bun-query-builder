import { describe, expect, it } from 'bun:test'

for (const mode of ['sqlite', 'sqlite-wrapper', 'mysql', 'postgres'] as const) {
  const local = mode.startsWith('sqlite')
  const url = process.env[`TRANSACTION_TEST_${mode.toUpperCase()}_URL`]
  describe.skipIf(!local && !url)(`${mode} transaction completion boundary`, () => {
    it('never retries a committed transaction when its callback fails', () => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, `${import.meta.dir}/fixtures/transaction-completion.ts`, mode],
        env: { ...process.env, TRANSACTION_TEST_URL: url },
        stdout: 'pipe', stderr: 'pipe', timeout: 30000,
      })
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toContain(`${mode} transaction completion OK`)
    }, 35000)
  })
}
