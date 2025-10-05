import { createQueryBuilder } from '../index'

export async function explain(sql: string) {
  const qb = createQueryBuilder()
  const q = qb.raw([sql] as unknown as TemplateStringsArray)
  const rows = await ((q as any).simple()?.execute?.() ?? Promise.resolve([]))

  console.log(JSON.stringify(rows, null, 2))

  return rows
}
