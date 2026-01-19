/**
 * Tests for DynamoDB Entity-Centric API
 *
 * Tests the fluent API: dynamo.entity('User').pk().sk.beginsWith().get()
 */

import { describe, expect, it, mock } from 'bun:test'
import { createDynamo, dynamo, EntityQueryBuilder } from '../src/dynamodb'

describe('DynamoDB Entity API', () => {
  describe('dynamo.connection()', () => {
    it('should configure connection with basic options', () => {
      const client = createDynamo()
      client.connection({
        region: 'us-east-1',
        table: 'MyApp',
      })

      expect(client.getDriver()).toBeDefined()
    })

    it('should configure connection with all options', () => {
      const client = createDynamo()
      client.connection({
        region: 'us-west-2',
        table: 'TestTable',
        endpoint: 'http://localhost:8000',
        pkAttribute: 'PK',
        skAttribute: 'SK',
        entityTypeAttribute: 'entityType',
        keyDelimiter: '|',
      })

      expect(client.getDriver()).toBeDefined()
    })
  })

  describe('dynamo.entity()', () => {
    it('should create an entity query builder', () => {
      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })

      const builder = client.entity('User')
      expect(builder).toBeInstanceOf(EntityQueryBuilder)
    })

    it('should throw if not configured', () => {
      const client = createDynamo()
      expect(() => client.entity('User')).toThrow('DynamoDB not configured')
    })
  })

  describe('EntityQueryBuilder', () => {
    const setupClient = () => {
      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })
      return client
    }

    describe('pk()', () => {
      it('should set partition key', () => {
        const client = setupClient()
        const builder = client.entity('User').pk('USER#123')
        const request = builder.toRequest()

        expect(request.KeyConditionExpression).toContain('=')
        expect(request.ExpressionAttributeValues).toBeDefined()
      })
    })

    describe('sk.beginsWith()', () => {
      it('should set sort key begins_with condition', () => {
        const client = setupClient()
        const builder = client.entity('User')
          .pk('USER#123')
          .sk.beginsWith('PROFILE#')

        const request = builder.toRequest()
        expect(request.KeyConditionExpression).toContain('begins_with')
      })
    })

    describe('sk.between()', () => {
      it('should set sort key between condition', () => {
        const client = setupClient()
        const builder = client.entity('Post')
          .pk('USER#123')
          .sk.between('POST#2024-01', 'POST#2024-12')

        const request = builder.toRequest()
        expect(request.KeyConditionExpression).toContain('BETWEEN')
      })
    })

    describe('sk.equals()', () => {
      it('should set sort key equals condition', () => {
        const client = setupClient()
        const builder = client.entity('User')
          .pk('USER#123')
          .sk.equals('METADATA')

        const request = builder.toRequest()
        expect(request.KeyConditionExpression).toMatch(/= :sk\d/)
      })
    })

    describe('sk.lt() / sk.lte() / sk.gt() / sk.gte()', () => {
      it('should set less than condition', () => {
        const client = setupClient()
        const builder = client.entity('User').pk('USER#123').sk.lt('Z')
        const request = builder.toRequest()
        expect(request.KeyConditionExpression).toContain('<')
      })

      it('should set less than or equal condition', () => {
        const client = setupClient()
        const builder = client.entity('User').pk('USER#123').sk.lte('Z')
        const request = builder.toRequest()
        expect(request.KeyConditionExpression).toContain('<=')
      })

      it('should set greater than condition', () => {
        const client = setupClient()
        const builder = client.entity('User').pk('USER#123').sk.gt('A')
        const request = builder.toRequest()
        expect(request.KeyConditionExpression).toContain('>')
      })

      it('should set greater than or equal condition', () => {
        const client = setupClient()
        const builder = client.entity('User').pk('USER#123').sk.gte('A')
        const request = builder.toRequest()
        expect(request.KeyConditionExpression).toContain('>=')
      })
    })

    describe('index()', () => {
      it('should set index name', () => {
        const client = setupClient()
        const builder = client.entity('User')
          .pk('USER#123')
          .index('GSI1')

        const request = builder.toRequest()
        expect(request.IndexName).toBe('GSI1')
      })
    })

    describe('project()', () => {
      it('should set projection attributes', () => {
        const client = setupClient()
        const builder = client.entity('User')
          .pk('USER#123')
          .project('name', 'email')

        const request = builder.toRequest()
        expect(request.ProjectionExpression).toBeDefined()
      })
    })

    describe('filter() / where()', () => {
      it('should add filter conditions', () => {
        const client = setupClient()
        const builder = client.entity('User')
          .pk('USER#123')
          .where('status', 'active')

        const request = builder.toRequest()
        expect(request.FilterExpression).toBeDefined()
      })

      it('should support whereIn()', () => {
        const client = setupClient()
        const builder = client.entity('User')
          .pk('USER#123')
          .whereIn('role', ['admin', 'moderator'])

        const request = builder.toRequest()
        expect(request.FilterExpression).toContain('IN')
      })
    })

    describe('limit()', () => {
      it('should set limit', () => {
        const client = setupClient()
        const builder = client.entity('User')
          .pk('USER#123')
          .limit(10)

        const request = builder.toRequest()
        expect(request.Limit).toBe(10)
      })
    })

    describe('asc() / desc()', () => {
      it('should set ascending order', () => {
        const client = setupClient()
        const builder = client.entity('User').pk('USER#123').asc()
        const request = builder.toRequest()
        expect(request.ScanIndexForward).toBe(true)
      })

      it('should set descending order', () => {
        const client = setupClient()
        const builder = client.entity('User').pk('USER#123').desc()
        const request = builder.toRequest()
        expect(request.ScanIndexForward).toBe(false)
      })
    })

    describe('consistent()', () => {
      it('should enable consistent read', () => {
        const client = setupClient()
        const builder = client.entity('User').pk('USER#123').consistent()
        const request = builder.toRequest()
        expect(request.ConsistentRead).toBe(true)
      })
    })

    describe('toRequest()', () => {
      it('should build a valid DynamoDB Query request', () => {
        const client = setupClient()
        const builder = client.entity('User')
          .pk('USER#123')
          .sk.beginsWith('PROFILE#')
          .index('GSI1')
          .project('name', 'email')
          .limit(10)
          .desc()

        const request = builder.toRequest()

        expect(request.TableName).toBe('MyApp')
        expect(request.IndexName).toBe('GSI1')
        expect(request.KeyConditionExpression).toBeDefined()
        expect(request.ProjectionExpression).toBeDefined()
        expect(request.Limit).toBe(10)
        expect(request.ScanIndexForward).toBe(false)
      })
    })
  })

  describe('batchWrite()', () => {
    it('should throw if client not set', async () => {
      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })

      await expect(client.batchWrite([
        { put: { entity: 'User', item: { id: '123' } } },
      ])).rejects.toThrow('DynamoDB client not configured')
    })

    it('should build batch write request for put operations', async () => {
      const mockClient = {
        batchWriteItem: mock(async () => ({})),
      }

      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })
      client.setClient(mockClient)

      await client.batchWrite([
        { put: { entity: 'User', item: { id: '123', name: 'John' } } },
      ])

      expect(mockClient.batchWriteItem).toHaveBeenCalled()
    })

    it('should build batch write request for delete operations', async () => {
      const mockClient = {
        batchWriteItem: mock(async () => ({})),
      }

      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })
      client.setClient(mockClient)

      await client.batchWrite([
        { delete: { entity: 'User', pk: 'USER#456', sk: 'USER#456' } },
      ])

      expect(mockClient.batchWriteItem).toHaveBeenCalled()
    })
  })

  describe('transactWrite()', () => {
    it('should throw if client not set', async () => {
      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })

      await expect(client.transactWrite([
        { put: { entity: 'User', item: { id: '123' } } },
      ])).rejects.toThrow('DynamoDB client not configured')
    })

    it('should build transact write request for put operations', async () => {
      const mockClient = {
        transactWriteItems: mock(async () => ({})),
      }

      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })
      client.setClient(mockClient)

      await client.transactWrite([
        { put: { entity: 'User', item: { id: '123', name: 'John' } } },
      ])

      expect(mockClient.transactWriteItems).toHaveBeenCalled()
    })

    it('should build transact write request for update with add', async () => {
      const mockClient = {
        transactWriteItems: mock(async () => ({})),
      }

      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })
      client.setClient(mockClient)

      await client.transactWrite([
        { update: { entity: 'Counter', pk: 'COUNTER#users', add: { count: 1 } } },
      ])

      expect(mockClient.transactWriteItems).toHaveBeenCalled()
    })

    it('should build transact write request for delete operations', async () => {
      const mockClient = {
        transactWriteItems: mock(async () => ({})),
      }

      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })
      client.setClient(mockClient)

      await client.transactWrite([
        { delete: { entity: 'User', pk: 'USER#456', sk: 'USER#456' } },
      ])

      expect(mockClient.transactWriteItems).toHaveBeenCalled()
    })
  })

  describe('registerEntity()', () => {
    it('should register entity mappings', () => {
      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })

      client.registerEntity({
        entityType: 'User',
        pkPattern: 'USER#{id}',
        skPattern: 'USER#{id}',
      })

      // Should not throw
      expect(true).toBe(true)
    })
  })

  describe('Query execution', () => {
    it('should execute query with mock client', async () => {
      const mockItems = [
        { pk: { S: 'USER#123' }, sk: { S: 'PROFILE#1' }, name: { S: 'John' } },
        { pk: { S: 'USER#123' }, sk: { S: 'PROFILE#2' }, name: { S: 'Jane' } },
      ]

      const mockClient = {
        query: mock(async () => ({
          Items: mockItems,
          Count: 2,
        })),
      }

      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })
      client.setClient(mockClient)

      const results = await client.entity('User')
        .pk('USER#123')
        .sk.beginsWith('PROFILE#')
        .get()

      expect(mockClient.query).toHaveBeenCalled()
      expect(results).toHaveLength(2)
    })

    it('should get first result', async () => {
      const mockItems = [
        { pk: { S: 'USER#123' }, sk: { S: 'PROFILE#1' }, name: { S: 'John' } },
      ]

      const mockClient = {
        query: mock(async () => ({
          Items: mockItems,
          Count: 1,
        })),
      }

      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })
      client.setClient(mockClient)

      const result = await client.entity('User')
        .pk('USER#123')
        .first()

      expect(result).toBeDefined()
      expect(result.name).toBe('John')
    })

    it('should count results', async () => {
      const mockClient = {
        query: mock(async () => ({
          Count: 42,
        })),
      }

      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })
      client.setClient(mockClient)

      const count = await client.entity('User')
        .pk('USER#123')
        .count()

      expect(count).toBe(42)
    })

    it('should use scan when no pk is set', async () => {
      const mockClient = {
        scan: mock(async () => ({
          Items: [],
          Count: 0,
        })),
      }

      const client = createDynamo()
      client.connection({ region: 'us-east-1', table: 'MyApp' })
      client.setClient(mockClient)

      await client.entity('User')
        .where('status', 'active')
        .get()

      expect(mockClient.scan).toHaveBeenCalled()
    })
  })
})

describe('Usage Examples from TODO', () => {
  it('should support the documented API style', () => {
    const client = createDynamo()
    client.connection({
      region: 'us-east-1',
      table: 'MyApp',
    })

    // Entity-centric queries (NO JOINs - different paradigm)
    const builder = client.entity('User')
      .pk('USER#123')
      .sk.beginsWith('PROFILE#')
      .index('GSI1')
      .project('name', 'email')

    const request = builder.toRequest()

    expect(request.TableName).toBe('MyApp')
    expect(request.IndexName).toBe('GSI1')
    expect(request.KeyConditionExpression).toContain('begins_with')
    expect(request.ProjectionExpression).toBeDefined()
  })

  it('should support query by access pattern', () => {
    const client = createDynamo()
    client.connection({
      region: 'us-east-1',
      table: 'MyApp',
    })

    // Query by access pattern
    const builder = client.entity('Post')
      .pk('USER#123')
      .sk.between('POST#2024-01', 'POST#2024-12')

    const request = builder.toRequest()

    expect(request.KeyConditionExpression).toContain('BETWEEN')
  })
})
