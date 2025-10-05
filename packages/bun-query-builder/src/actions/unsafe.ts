import type { UnsafeOptions } from '../types'
import { createQueryBuilder } from '../index'

export async function unsafe(sql: string, opts: UnsafeOptions = {}) {
  const qb = createQueryBuilder()
  const params = opts.params ? JSON.parse(opts.params) : undefined

  const res = await qb.unsafe(sql, params)

  console.log(JSON.stringify(res))

  return res
}
