import { describe, expect, it } from 'bun:test'
import { defineSeeder, Seeder } from '../src/seeder'

describe('Seeder Base Class', () => {
  it('creates a seeder with default order of 100', () => {
    class TestSeeder extends Seeder {
      async run(_qb: any): Promise<void> {
        // Test implementation
      }
    }

    const seeder = new TestSeeder()
    expect(seeder.order).toBe(100)
  })

  it('creates a seeder with custom order', () => {
    class CustomOrderSeeder extends Seeder {
      async run(_qb: any): Promise<void> {
        // Test implementation
      }

      get order(): number {
        return 50
      }
    }

    const seeder = new CustomOrderSeeder()
    expect(seeder.order).toBe(50)
  })

  it('enforces abstract run method implementation', () => {
    class TestSeeder extends Seeder {
      async run(qb: any): Promise<void> {
        expect(qb).toBeDefined()
      }
    }

    const seeder = new TestSeeder()
    expect(seeder.run).toBeDefined()
    expect(typeof seeder.run).toBe('function')
  })

  it('defineSeeder returns the seeder class', () => {
    const SeederClass = defineSeeder(
      class TestSeeder extends Seeder {
        async run(_qb: any): Promise<void> {
          // Test implementation
        }
      },
    )

    expect(SeederClass).toBeDefined()
    const instance = new SeederClass()
    expect(instance).toBeInstanceOf(Seeder)
  })

  it('seeder can execute run method', async () => {
    let executed = false

    class ExecutableSeeder extends Seeder {
      async run(_qb: any): Promise<void> {
        executed = true
      }
    }

    const seeder = new ExecutableSeeder()
    await seeder.run(null)
    expect(executed).toBe(true)
  })

  it('seeder run method receives query builder', async () => {
    let receivedQb: any = null

    class QbSeeder extends Seeder {
      async run(qb: any): Promise<void> {
        receivedQb = qb
      }
    }

    const mockQb = { table: () => ({}) }
    const seeder = new QbSeeder()
    await seeder.run(mockQb)
    expect(receivedQb).toBe(mockQb)
  })

  it('multiple seeders can have different orders', () => {
    class FirstSeeder extends Seeder {
      async run(_qb: any): Promise<void> {}
      get order(): number {
        return 10
      }
    }

    class SecondSeeder extends Seeder {
      async run(_qb: any): Promise<void> {}
      get order(): number {
        return 20
      }
    }

    class ThirdSeeder extends Seeder {
      async run(_qb: any): Promise<void> {}
      get order(): number {
        return 30
      }
    }

    const first = new FirstSeeder()
    const second = new SecondSeeder()
    const third = new ThirdSeeder()

    expect(first.order).toBe(10)
    expect(second.order).toBe(20)
    expect(third.order).toBe(30)
  })

  it('seeder can handle async operations', async () => {
    let counter = 0

    class AsyncSeeder extends Seeder {
      async run(_qb: any): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, 10))
        counter++
      }
    }

    const seeder = new AsyncSeeder()
    await seeder.run(null)
    expect(counter).toBe(1)
  })

  it('seeder can throw errors', async () => {
    class ErrorSeeder extends Seeder {
      async run(_qb: any): Promise<void> {
        throw new Error('Seeding failed')
      }
    }

    const seeder = new ErrorSeeder()
    expect(async () => {
      await seeder.run(null)
    }).toThrow()
  })
})
