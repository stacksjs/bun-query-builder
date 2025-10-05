import { createQueryBuilder } from '../index'

export async function ping() {
  const qb = createQueryBuilder()
  const ok = await qb.ping()

  console.log(ok ? 'OK' : 'NOT READY')

  return ok
}
