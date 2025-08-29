import { createQueryBuilder } from '../index'

export interface FileOptions {
  params?: string
}

export async function file(path: string, opts: FileOptions = {}) {
  const qb = createQueryBuilder()
  const params = opts.params ? JSON.parse(opts.params) : undefined

  const res = await qb.file(path, params)

  console.log(JSON.stringify(res))

  return res
}
