import { createQueryBuilder } from '../index'

export interface WaitReadyOptions {
  attempts?: number
  delay?: number
}

export async function waitReady(opts: WaitReadyOptions = {}) {
  const attempts = Number(opts.attempts || 10)
  const delayMs = Number(opts.delay || 100)

  const qb = createQueryBuilder()

  try {
    await qb.waitForReady({ attempts, delayMs })
    console.log('READY')
    return true
  }
  catch {
    console.error('NOT READY')
    throw new Error('Database not ready')
  }
}
