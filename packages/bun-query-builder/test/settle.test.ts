import { describe, expect, it } from 'bun:test'
import { isThenable, settle, wait, waitAll } from '../src/settle'

const later = <T>(value: T): Promise<T> => new Promise(resolve => setTimeout(() => resolve(value), 1))

describe('settle: synchronous when everything it touches is', () => {
  it('returns the value itself when nothing yielded was a promise', () => {
    const result = settle(function* () {
      const a = yield* wait(1)
      const b = yield* wait(a + 1)
      return a + b
    })
    expect(result).toBe(3)
  })

  it('returns a promise of the value from the first promise on', async () => {
    const order: string[] = []
    const result = settle(function* () {
      order.push('before')
      const a = yield* wait(later(1))
      order.push('after')
      const b = yield* wait(2)
      return a + b
    })
    // It ran up to the promise and stopped there, as an async function would.
    expect(order).toEqual(['before'])
    expect(isThenable(result)).toBe(true)
    expect(await result).toBe(3)
    expect(order).toEqual(['before', 'after'])
  })

  it('throws where it is called when the body throws synchronously', () => {
    expect(() => settle(function* () {
      yield* wait(1)
      throw new Error('not found')
    })).toThrow('not found')
  })

  it('rejects when the body throws after a promise', async () => {
    const result = settle(function* () {
      yield* wait(later(1))
      throw new Error('too late')
    }) as unknown as Promise<never>
    await expect(result).rejects.toThrow('too late')
  })

  it('throws a rejection into the body, where a try/catch sees it', async () => {
    const result = settle(function* () {
      try {
        yield* wait(Promise.reject(new Error('refused')))
        return 'not reached'
      }
      catch (error) {
        return `caught ${(error as Error).message}`
      }
    })
    expect(await result).toBe('caught refused')
  })

  it('runs finally blocks on both paths', async () => {
    const ran: string[] = []
    settle(function* () {
      try {
        return yield* wait(1)
      }
      finally {
        ran.push('sync')
      }
    })
    await settle(function* () {
      try {
        return yield* wait(later(1))
      }
      finally {
        ran.push('async')
      }
    })
    expect(ran).toEqual(['sync', 'async'])
  })

  it('hands back a promise the body returns, which the caller awaits as usual', async () => {
    const result = settle(function* () {
      yield* wait(1)
      return later('inner')
    })
    expect(await result).toBe('inner')
  })

  it('nests: a settled body can be waited on by another', async () => {
    const inner = (value: unknown): number => settle(function* () {
      return (yield* wait(value)) as number
    })
    expect(settle(function* () {
      return (yield* wait(inner(2))) * 2
    })).toBe(4)
    expect(await settle(function* () {
      return (yield* wait(inner(later(2)))) * 2
    })).toBe(4)
  })
})

describe('waitAll', () => {
  it('is the list itself when none of it is a promise', () => {
    const values = [1, 2, 3]
    expect(waitAll(values)).toBe(values)
  })

  it('waits for all of it when any is a promise', async () => {
    const result = waitAll([1, later(2), 3])
    expect(isThenable(result)).toBe(true)
    expect(await result).toEqual([1, 2, 3])
  })
})

describe('isThenable', () => {
  it('knows a promise and a thenable from a value', () => {
    expect(isThenable(Promise.resolve(1))).toBe(true)
    expect(isThenable({ then() {} })).toBe(true)
    expect(isThenable({ then: 1 })).toBe(false)
    expect(isThenable(null)).toBe(false)
    expect(isThenable(undefined)).toBe(false)
    expect(isThenable('then')).toBe(false)
  })
})
