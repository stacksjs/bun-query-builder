/**
 * DynamoDB Driver Tests
 *
 * Tests for the DynamoDB driver, query builder, single table design,
 * and dynamodb-tooling adapter integration.
 */

import { describe, expect, it } from 'bun:test'
import {
  createDynamoDBDriver,
  type DynamoDBConfig,
  type DynamoDBCondition,
} from '../src/drivers/dynamodb'
import {
  createDynamoDBClient,
  createDynamoDBItemBuilder,
  createDynamoDBQueryBuilder,
  DynamoDBItemBuilder,
  DynamoDBQueryBuilder,
} from '../src/dynamodb-client'
import {
  createRepository,
  createSingleTableManager,
  SingleTablePatterns,
} from '../src/dynamodb-single-table'
import {
  createDynamoDBToolingAdapter,
  generateAccessPatterns,
  stacksModelToEntity,
} from '../src/dynamodb-tooling-adapter'

const testConfig: DynamoDBConfig = {
  region: 'us-east-1',
  tableName: 'TestTable',
}

// ============================================================================
// DynamoDB Driver Tests
// ============================================================================

describe('DynamoDB Driver', () => {
  describe('value marshalling', () => {
    it('marshalls string values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.marshall({ name: 'John' })
      expect(result.name).toEqual({ S: 'John' })
    })

    it('marshalls number values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.marshall({ age: 25 })
      expect(result.age).toEqual({ N: '25' })
    })

    it('marshalls boolean values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.marshall({ active: true })
      expect(result.active).toEqual({ BOOL: true })
    })

    it('marshalls null values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.marshall({ deletedAt: null })
      expect(result.deletedAt).toEqual({ NULL: true })
    })

    it('marshalls array values as list', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.marshall({ tags: ['a', 'b', 'c'] })
      expect(result.tags).toEqual({ SS: ['a', 'b', 'c'] })
    })

    it('marshalls number array as number set', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.marshall({ scores: [1, 2, 3] })
      expect(result.scores).toEqual({ NS: ['1', '2', '3'] })
    })

    it('marshalls nested objects as map', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.marshall({ address: { city: 'NYC', zip: '10001' } })
      expect(result.address).toEqual({
        M: {
          city: { S: 'NYC' },
          zip: { S: '10001' },
        },
      })
    })

    it('marshalls mixed array as list', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.marshall({ mixed: ['a', 1, true] })
      expect(result.mixed).toEqual({
        L: [{ S: 'a' }, { N: '1' }, { BOOL: true }],
      })
    })
  })

  describe('value unmarshalling', () => {
    it('unmarshalls string values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.unmarshall({ name: { S: 'John' } })
      expect(result.name).toBe('John')
    })

    it('unmarshalls number values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.unmarshall({ age: { N: '25' } })
      expect(result.age).toBe(25)
    })

    it('unmarshalls boolean values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.unmarshall({ active: { BOOL: true } })
      expect(result.active).toBe(true)
    })

    it('unmarshalls null values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.unmarshall({ deletedAt: { NULL: true } })
      expect(result.deletedAt).toBeNull()
    })

    it('unmarshalls string set values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.unmarshall({ tags: { SS: ['a', 'b', 'c'] } })
      expect(result.tags).toEqual(['a', 'b', 'c'])
    })

    it('unmarshalls number set values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.unmarshall({ scores: { NS: ['1', '2', '3'] } })
      expect(result.scores).toEqual([1, 2, 3])
    })

    it('unmarshalls map values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.unmarshall({
        address: {
          M: {
            city: { S: 'NYC' },
            zip: { S: '10001' },
          },
        },
      })
      expect(result.address).toEqual({ city: 'NYC', zip: '10001' })
    })

    it('unmarshalls list values', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.unmarshall({
        items: { L: [{ S: 'a' }, { N: '1' }, { BOOL: true }] },
      })
      expect(result.items).toEqual(['a', 1, true])
    })
  })

  describe('expression building', () => {
    it('builds key condition expression with equals', () => {
      const driver = createDynamoDBDriver(testConfig)
      const conditions: DynamoDBCondition[] = [
        { attribute: 'pk', operator: '=', value: 'USER#123' },
      ]
      const result = driver.buildKeyConditionExpression(conditions)
      expect(result.expression).toBe('#attr0 = :val0')
      expect(result.expressionAttributeNames['#attr0']).toBe('pk')
      expect(result.expressionAttributeValues[':val0']).toEqual({ S: 'USER#123' })
    })

    it('builds key condition expression with begins_with', () => {
      const driver = createDynamoDBDriver(testConfig)
      const conditions: DynamoDBCondition[] = [
        { attribute: 'pk', operator: '=', value: 'USER#123' },
        { attribute: 'sk', operator: 'begins_with', value: 'ORDER#' },
      ]
      const result = driver.buildKeyConditionExpression(conditions)
      expect(result.expression).toBe('#attr0 = :val0 AND begins_with(#attr1, :val1)')
    })

    it('builds key condition expression with between', () => {
      const driver = createDynamoDBDriver(testConfig)
      const conditions: DynamoDBCondition[] = [
        { attribute: 'pk', operator: '=', value: 'USER#123' },
        { attribute: 'sk', operator: 'BETWEEN', values: ['2024-01-01', '2024-12-31'] },
      ]
      const result = driver.buildKeyConditionExpression(conditions)
      expect(result.expression).toBe('#attr0 = :val0 AND #attr1 BETWEEN :val1a AND :val1b')
    })

    it('builds filter expression with contains', () => {
      const driver = createDynamoDBDriver(testConfig)
      const conditions: DynamoDBCondition[] = [
        { attribute: 'email', operator: 'contains', value: '@gmail.com' },
      ]
      const result = driver.buildFilterExpression(conditions)
      expect(result.expression).toBe('contains(#attr0, :val0)')
    })

    it('builds filter expression with attribute_exists', () => {
      const driver = createDynamoDBDriver(testConfig)
      const conditions: DynamoDBCondition[] = [
        { attribute: 'deletedAt', operator: 'attribute_not_exists' },
      ]
      const result = driver.buildFilterExpression(conditions)
      expect(result.expression).toBe('attribute_not_exists(#attr0)')
    })

    it('builds filter expression with IN operator', () => {
      const driver = createDynamoDBDriver(testConfig)
      const conditions: DynamoDBCondition[] = [
        { attribute: 'status', operator: 'IN', values: ['active', 'pending', 'approved'] },
      ]
      const result = driver.buildFilterExpression(conditions)
      expect(result.expression).toBe('#attr0 IN (:val0_0, :val0_1, :val0_2)')
    })

    it('builds update expression with SET', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.buildUpdateExpression({
        set: { name: 'Jane', age: 30 },
      })
      expect(result.expression).toContain('SET')
      expect(result.expressionAttributeNames['#attr0']).toBe('name')
      expect(result.expressionAttributeNames['#attr1']).toBe('age')
    })

    it('builds update expression with REMOVE', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.buildUpdateExpression({
        remove: ['tempField', 'oldField'],
      })
      expect(result.expression).toContain('REMOVE')
    })

    it('builds update expression with ADD', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.buildUpdateExpression({
        add: { viewCount: 1 },
      })
      expect(result.expression).toContain('ADD')
    })

    it('builds projection expression', () => {
      const driver = createDynamoDBDriver(testConfig)
      const result = driver.buildProjectionExpression(['id', 'name', 'email'])
      expect(result.expression).toBe('#proj0, #proj1, #proj2')
      expect(result.expressionAttributeNames['#proj0']).toBe('id')
      expect(result.expressionAttributeNames['#proj1']).toBe('name')
      expect(result.expressionAttributeNames['#proj2']).toBe('email')
    })
  })

  describe('entity mapping', () => {
    it('registers and retrieves entity mappings', () => {
      const driver = createDynamoDBDriver(testConfig)
      driver.registerEntity({
        entityType: 'User',
        pkPattern: 'USER#${id}',
        skPattern: 'METADATA',
      })
      const mapping = driver.getEntityMapping('User')
      expect(mapping).toBeDefined()
      expect(mapping?.pkPattern).toBe('USER#${id}')
    })

    it('builds primary key from entity mapping', () => {
      const driver = createDynamoDBDriver(testConfig)
      driver.registerEntity({
        entityType: 'User',
        pkPattern: 'USER#${id}',
        skPattern: 'USER#${id}',
      })
      const key = driver.buildPrimaryKey('User', { id: '123' })
      expect(key.pk).toBe('USER#123')
      expect(key.sk).toBe('USER#123')
    })

    it('throws error for missing entity mapping', () => {
      const driver = createDynamoDBDriver(testConfig)
      expect(() => driver.buildPrimaryKey('Unknown', { id: '123' })).toThrow()
    })
  })
})

// ============================================================================
// DynamoDB Query Builder Tests
// ============================================================================

describe('DynamoDB Query Builder', () => {
  const options = { config: testConfig }

  describe('query construction', () => {
    it('builds query with partition key', () => {
      const builder = createDynamoDBQueryBuilder(options)
      const request = builder
        .table('TestTable')
        .wherePartitionKey('pk', 'USER#123')
        .toQueryRequest()

      expect(request.TableName).toBe('TestTable')
      expect(request.KeyConditionExpression).toContain('#key0 = :keyval0')
    })

    it('builds query with sort key begins_with', () => {
      const builder = createDynamoDBQueryBuilder(options)
      const request = builder
        .table('TestTable')
        .wherePartitionKey('pk', 'USER#123')
        .whereSortKeyBeginsWith('sk', 'ORDER#')
        .toQueryRequest()

      expect(request.KeyConditionExpression).toContain('begins_with')
    })

    it('builds query with sort key between', () => {
      const builder = createDynamoDBQueryBuilder(options)
      const request = builder
        .table('TestTable')
        .wherePartitionKey('pk', 'USER#123')
        .whereSortKeyBetween('sk', '2024-01-01', '2024-12-31')
        .toQueryRequest()

      expect(request.KeyConditionExpression).toContain('BETWEEN')
    })

    it('builds query with filter conditions', () => {
      const builder = createDynamoDBQueryBuilder(options)
      const request = builder
        .table('TestTable')
        .wherePartitionKey('pk', 'USER#123')
        .whereEquals('status', 'active')
        .whereGreaterThan('age', 18)
        .toQueryRequest()

      expect(request.FilterExpression).toBeDefined()
      expect(request.FilterExpression).toContain('#flt')
    })

    it('builds query with index', () => {
      const builder = createDynamoDBQueryBuilder(options)
      const request = builder
        .table('TestTable')
        .index('GSI1')
        .wherePartitionKey('gsi1pk', 'EMAIL#test@example.com')
        .toQueryRequest()

      expect(request.IndexName).toBe('GSI1')
    })

    it('builds query with projection', () => {
      const builder = createDynamoDBQueryBuilder(options)
      const request = builder
        .table('TestTable')
        .wherePartitionKey('pk', 'USER#123')
        .select('id', 'name', 'email')
        .toQueryRequest()

      expect(request.ProjectionExpression).toBeDefined()
      expect(request.ProjectionExpression).toContain('#proj')
    })

    it('builds query with limit and descending order', () => {
      const builder = createDynamoDBQueryBuilder(options)
      const request = builder
        .table('TestTable')
        .wherePartitionKey('pk', 'USER#123')
        .limit(10)
        .descending()
        .toQueryRequest()

      expect(request.Limit).toBe(10)
      expect(request.ScanIndexForward).toBe(false)
    })

    it('builds query with consistent read', () => {
      const builder = createDynamoDBQueryBuilder(options)
      const request = builder
        .table('TestTable')
        .wherePartitionKey('pk', 'USER#123')
        .consistentRead()
        .toQueryRequest()

      expect(request.ConsistentRead).toBe(true)
    })
  })

  describe('scan construction', () => {
    it('builds scan with filter', () => {
      const builder = createDynamoDBQueryBuilder(options)
      const request = builder
        .table('TestTable')
        .whereEquals('_et', 'User')
        .toScanRequest()

      expect(request.TableName).toBe('TestTable')
      expect(request.FilterExpression).toBeDefined()
    })

    it('builds scan with index', () => {
      const builder = createDynamoDBQueryBuilder(options)
      const request = builder
        .table('TestTable')
        .index('GSI1')
        .whereEquals('status', 'active')
        .toScanRequest()

      expect(request.IndexName).toBe('GSI1')
    })
  })

  describe('reset functionality', () => {
    it('resets builder state', () => {
      const builder = createDynamoDBQueryBuilder(options)
      builder
        .table('TestTable')
        .index('GSI1')
        .wherePartitionKey('pk', 'USER#123')
        .limit(10)
        .reset()

      const request = builder.table('TestTable').toQueryRequest()
      expect(request.IndexName).toBeUndefined()
      expect(request.Limit).toBeUndefined()
    })
  })
})

// ============================================================================
// DynamoDB Item Builder Tests
// ============================================================================

describe('DynamoDB Item Builder', () => {
  const options = { config: testConfig }

  describe('put item construction', () => {
    it('builds put request with item data', () => {
      const builder = createDynamoDBItemBuilder(options)
      const request = builder
        .table('TestTable')
        .item({ pk: 'USER#123', sk: 'METADATA', name: 'John' })
        .toPutRequest()

      expect(request.TableName).toBe('TestTable')
      expect(request.Item.pk).toEqual({ S: 'USER#123' })
      expect(request.Item.name).toEqual({ S: 'John' })
    })

    it('builds put request with condition expression', () => {
      const builder = createDynamoDBItemBuilder(options)
      const request = builder
        .table('TestTable')
        .item({ pk: 'USER#123', sk: 'METADATA' })
        .ifNotExists('pk')
        .toPutRequest()

      expect(request.ConditionExpression).toBe('attribute_not_exists(pk)')
    })

    it('builds put request with return values', () => {
      const builder = createDynamoDBItemBuilder(options)
      const request = builder
        .table('TestTable')
        .item({ pk: 'USER#123', sk: 'METADATA' })
        .returnOld()
        .toPutRequest()

      expect(request.ReturnValues).toBe('ALL_OLD')
    })
  })

  describe('update item construction', () => {
    it('builds update request with SET', () => {
      const builder = createDynamoDBItemBuilder(options)
      const request = builder
        .table('TestTable')
        .key({ pk: 'USER#123', sk: 'METADATA' })
        .set('name', 'Jane')
        .set('age', 30)
        .toUpdateRequest()

      expect(request.TableName).toBe('TestTable')
      expect(request.UpdateExpression).toContain('SET')
    })

    it('builds update request with setMany', () => {
      const builder = createDynamoDBItemBuilder(options)
      const request = builder
        .table('TestTable')
        .key({ pk: 'USER#123', sk: 'METADATA' })
        .setMany({ name: 'Jane', age: 30, active: true })
        .toUpdateRequest()

      expect(request.UpdateExpression).toContain('SET')
    })

    it('builds update request with REMOVE', () => {
      const builder = createDynamoDBItemBuilder(options)
      const request = builder
        .table('TestTable')
        .key({ pk: 'USER#123', sk: 'METADATA' })
        .remove('tempField')
        .toUpdateRequest()

      expect(request.UpdateExpression).toContain('REMOVE')
    })

    it('builds update request with ADD', () => {
      const builder = createDynamoDBItemBuilder(options)
      const request = builder
        .table('TestTable')
        .key({ pk: 'USER#123', sk: 'METADATA' })
        .add('viewCount', 1)
        .toUpdateRequest()

      expect(request.UpdateExpression).toContain('ADD')
    })

    it('builds update request with condition', () => {
      const builder = createDynamoDBItemBuilder(options)
      const request = builder
        .table('TestTable')
        .key({ pk: 'USER#123', sk: 'METADATA' })
        .set('name', 'Jane')
        .ifExists('pk')
        .returnNew()
        .toUpdateRequest()

      expect(request.ConditionExpression).toBe('attribute_exists(pk)')
      expect(request.ReturnValues).toBe('ALL_NEW')
    })
  })

  describe('delete item construction', () => {
    it('builds delete request', () => {
      const builder = createDynamoDBItemBuilder(options)
      const request = builder
        .table('TestTable')
        .key({ pk: 'USER#123', sk: 'METADATA' })
        .toDeleteRequest()

      expect(request.TableName).toBe('TestTable')
      expect(request.Key.pk).toEqual({ S: 'USER#123' })
    })

    it('builds delete request with condition', () => {
      const builder = createDynamoDBItemBuilder(options)
      const request = builder
        .table('TestTable')
        .key({ pk: 'USER#123', sk: 'METADATA' })
        .condition('attribute_exists(pk)')
        .toDeleteRequest()

      expect(request.ConditionExpression).toBe('attribute_exists(pk)')
    })
  })

  describe('get item construction', () => {
    it('builds get request', () => {
      const builder = createDynamoDBItemBuilder(options)
      const request = builder
        .table('TestTable')
        .key({ pk: 'USER#123', sk: 'METADATA' })
        .toGetRequest()

      expect(request.TableName).toBe('TestTable')
      expect(request.Key.pk).toEqual({ S: 'USER#123' })
    })
  })
})

// ============================================================================
// Single Table Design Tests
// ============================================================================

describe('Single Table Design', () => {
  describe('SingleTableManager', () => {
    it('creates manager with config', () => {
      const manager = createSingleTableManager({
        tableName: 'TestTable',
        entities: [],
      })
      expect(manager).toBeDefined()
    })

    it('registers and retrieves entities', () => {
      const manager = createSingleTableManager({
        tableName: 'TestTable',
        entities: [
          {
            name: 'User',
            pkPattern: 'USER#${id}',
            skPattern: 'METADATA',
            keyFields: ['id'],
          },
        ],
      })

      const entity = manager.getEntity('User')
      expect(entity).toBeDefined()
      expect(entity?.pkPattern).toBe('USER#${id}')
    })

    it('builds keys for entity', () => {
      const manager = createSingleTableManager({
        tableName: 'TestTable',
        entities: [
          {
            name: 'User',
            pkPattern: 'USER#${id}',
            skPattern: 'USER#${id}',
            keyFields: ['id'],
          },
        ],
      })

      const key = manager.buildKey('User', { id: '123' })
      expect(key.pk).toBe('USER#123')
      expect(key.sk).toBe('USER#123')
    })

    it('builds GSI keys for entity', () => {
      const manager = createSingleTableManager({
        tableName: 'TestTable',
        indexes: [
          { name: 'GSI1', pkAttribute: 'gsi1pk', skAttribute: 'gsi1sk' },
        ],
        entities: [
          {
            name: 'User',
            pkPattern: 'USER#${id}',
            skPattern: 'USER#${id}',
            keyFields: ['id'],
            indexes: [
              { name: 'GSI1', pkPattern: 'EMAIL#${email}', skPattern: 'USER#${id}' },
            ],
          },
        ],
      })

      const key = manager.buildGSIKey('User', 'GSI1', { email: 'test@example.com', id: '123' })
      expect(key.pk).toBe('EMAIL#test@example.com')
      expect(key.sk).toBe('USER#123')
    })

    it('creates full item with keys and type', () => {
      const manager = createSingleTableManager({
        tableName: 'TestTable',
        entities: [
          {
            name: 'User',
            pkPattern: 'USER#${id}',
            skPattern: 'USER#${id}',
            keyFields: ['id'],
          },
        ],
      })

      const item = manager.createItem('User', { id: '123', name: 'John', email: 'john@example.com' })
      expect(item.pk).toBe('USER#123')
      expect(item.sk).toBe('USER#123')
      expect(item._type).toBe('User')
      expect(item.name).toBe('John')
    })

    it('parses entity type from item', () => {
      const manager = createSingleTableManager({
        tableName: 'TestTable',
        entities: [
          {
            name: 'User',
            pkPattern: 'USER#${id}',
            skPattern: 'USER#${id}',
            keyFields: ['id'],
          },
        ],
      })

      const type = manager.parseEntityType({ pk: 'USER#123', sk: 'USER#123', name: 'John' })
      expect(type).toBe('User')
    })

    it('parses item and returns typed data', () => {
      const manager = createSingleTableManager({
        tableName: 'TestTable',
        entities: [
          {
            name: 'User',
            pkPattern: 'USER#${id}',
            skPattern: 'USER#${id}',
            keyFields: ['id'],
          },
        ],
      })

      const result = manager.parseItem({ pk: 'USER#123', sk: 'USER#123', _type: 'User', name: 'John' })
      expect(result?.type).toBe('User')
      expect(result?.data.name).toBe('John')
    })

    it('generates table definition', () => {
      const manager = createSingleTableManager({
        tableName: 'TestTable',
        indexes: [
          { name: 'GSI1', pkAttribute: 'gsi1pk', skAttribute: 'gsi1sk' },
        ],
        entities: [],
      })

      const definition = manager.generateTableDefinition()
      expect(definition.tableName).toBe('TestTable')
      expect(definition.keySchema.partitionKey).toBe('pk')
      expect(definition.keySchema.sortKey).toBe('sk')
      expect(definition.globalSecondaryIndexes).toHaveLength(1)
    })
  })

  describe('SingleTablePatterns', () => {
    it('creates simple entity pattern', () => {
      const pattern = SingleTablePatterns.simpleEntity('User', 'id')
      expect(pattern.name).toBe('User')
      expect(pattern.pkPattern).toBe('USER#${id}')
      expect(pattern.skPattern).toBe('METADATA')
      expect(pattern.keyFields).toEqual(['id'])
    })

    it('creates one-to-many pattern', () => {
      const { parent, child } = SingleTablePatterns.oneToMany('User', 'Order', 'id', 'id')

      expect(parent.name).toBe('User')
      expect(parent.pkPattern).toBe('USER#${id}')
      expect(parent.skPattern).toBe('METADATA')

      expect(child.name).toBe('Order')
      expect(child.pkPattern).toBe('USER#${id}')
      expect(child.skPattern).toBe('ORDER#${id}')
      expect(child.keyFields).toEqual(['id', 'id'])
    })

    it('creates many-to-many pattern', () => {
      const { entity, relation } = SingleTablePatterns.manyToMany('User', 'Role', 'id', 'relatedId')

      expect(entity.name).toBe('User')
      expect(entity.pkPattern).toBe('USER#${id}')

      expect(relation.name).toBe('Role')
      expect(relation.pkPattern).toBe('USER#${id}')
      expect(relation.skPattern).toBe('ROLE#${relatedId}')
      expect(relation.indexes).toBeDefined()
    })

    it('creates hierarchical pattern', () => {
      const pattern = SingleTablePatterns.hierarchical('File', 'rootId', 'path')
      expect(pattern.name).toBe('File')
      expect(pattern.pkPattern).toBe('ROOT#${rootId}')
      expect(pattern.skPattern).toBe('PATH#${path}')
    })
  })
})

// ============================================================================
// DynamoDB Tooling Adapter Tests
// ============================================================================

describe('DynamoDB Tooling Adapter', () => {
  describe('adapter creation', () => {
    it('creates adapter with config', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })
      expect(adapter).toBeDefined()
    })

    it('uses default attribute names', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      const definition = adapter.generateTableDefinition()
      expect(definition.keySchema.partitionKey).toBe('pk')
      expect(definition.keySchema.sortKey).toBe('sk')
    })
  })

  describe('model registration', () => {
    it('registers a simple model', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      const parsed = adapter.registerModel({
        name: 'User',
        primaryKey: 'id',
        attributes: {
          name: { fillable: true },
          email: { fillable: true, unique: true },
        },
        traits: {
          useTimestamps: true,
        },
      })

      expect(parsed.name).toBe('User')
      expect(parsed.entityType).toBe('USER')
      expect(parsed.hasTimestamps).toBe(true)
    })

    it('registers multiple models', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      const models = adapter.registerModels([
        { name: 'User', primaryKey: 'id' },
        { name: 'Post', primaryKey: 'id', belongsTo: ['User'] },
      ])

      expect(models).toHaveLength(2)
      expect(adapter.getAllModels()).toHaveLength(2)
    })

    it('retrieves registered model by name', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      adapter.registerModel({ name: 'User', primaryKey: 'id' })
      const model = adapter.getModel('User')

      expect(model).toBeDefined()
      expect(model?.name).toBe('User')
    })
  })

  describe('key building', () => {
    it('builds keys for model', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      adapter.registerModel({ name: 'User', primaryKey: 'id' })
      const key = adapter.buildKey('User', { id: '123' })

      expect(key.pk).toBe('USER#123')
      expect(key.sk).toBe('USER#123')
    })

    it('creates full item with timestamps', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      adapter.registerModel({
        name: 'User',
        primaryKey: 'id',
        traits: { useTimestamps: true },
      })

      const item = adapter.createItem('User', { id: '123', name: 'John' })

      expect(item.pk).toBe('USER#123')
      expect(item._et).toBe('User') // _et is the default entity type attribute
      expect(item.createdAt).toBeDefined()
      expect(item.updatedAt).toBeDefined()
    })
  })

  describe('relationships', () => {
    it('parses belongsTo relationships', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      const parsed = adapter.registerModel({
        name: 'Post',
        primaryKey: 'id',
        belongsTo: ['User'],
      })

      expect(parsed.relationships).toHaveLength(1)
      expect(parsed.relationships[0].type).toBe('belongsTo')
      expect(parsed.relationships[0].relatedModel).toBe('User')
      expect(parsed.keyPatterns.gsi1pk).toContain('USER')
    })

    it('parses hasMany relationships', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      const parsed = adapter.registerModel({
        name: 'User',
        primaryKey: 'id',
        hasMany: ['Post'],
      })

      expect(parsed.relationships).toHaveLength(1)
      expect(parsed.relationships[0].type).toBe('hasMany')
      expect(parsed.relationships[0].relatedModel).toBe('Post')
    })

    it('parses belongsToMany relationships', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      const parsed = adapter.registerModel({
        name: 'User',
        primaryKey: 'id',
        belongsToMany: ['Role'],
      })

      expect(parsed.relationships).toHaveLength(1)
      expect(parsed.relationships[0].type).toBe('belongsToMany')
      expect(parsed.relationships[0].pivotEntity).toBe('RoleUser')
    })
  })

  describe('query builder access', () => {
    it('creates query builder for model', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      adapter.registerModel({ name: 'User', primaryKey: 'id' })
      const builder = adapter.query('User')

      expect(builder).toBeInstanceOf(DynamoDBQueryBuilder)
    })

    it('creates item builder for model', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      adapter.registerModel({ name: 'User', primaryKey: 'id' })
      const builder = adapter.item('User')

      expect(builder).toBeInstanceOf(DynamoDBItemBuilder)
    })

    it('throws error for unregistered model', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      expect(() => adapter.query('Unknown')).toThrow('Model not found: Unknown')
    })
  })
})

// ============================================================================
// Helper Function Tests
// ============================================================================

describe('Helper Functions', () => {
  describe('stacksModelToEntity', () => {
    it('converts simple model to entity', () => {
      const entity = stacksModelToEntity({ name: 'User', primaryKey: 'id' })
      expect(entity.name).toBe('User')
      expect(entity.pkPattern).toBe('USER#${id}')
      expect(entity.skPattern).toBe('USER#${id}')
    })

    it('uses default primary key', () => {
      const entity = stacksModelToEntity({ name: 'User' })
      expect(entity.pkPattern).toBe('USER#${id}')
    })

    it('uses custom delimiter', () => {
      const entity = stacksModelToEntity({ name: 'User', primaryKey: 'id' }, '|')
      expect(entity.pkPattern).toBe('USER|${id}')
    })
  })

  describe('generateAccessPatterns', () => {
    it('generates access patterns for model', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      const parsed = adapter.registerModel({
        name: 'User',
        primaryKey: 'id',
        hasMany: ['Post'],
      })

      const patterns = generateAccessPatterns(parsed)

      expect(patterns.length).toBeGreaterThan(0)
      expect(patterns.some(p => p.name === 'Get User by ID')).toBe(true)
      expect(patterns.some(p => p.name === 'List all Users')).toBe(true)
    })

    it('generates patterns for relationships', () => {
      const adapter = createDynamoDBToolingAdapter({
        region: 'us-east-1',
        tableName: 'TestTable',
      })

      const parsed = adapter.registerModel({
        name: 'Post',
        primaryKey: 'id',
        belongsTo: ['User'],
      })

      const patterns = generateAccessPatterns(parsed)

      expect(patterns.some(p => p.name === 'Get Posts by User')).toBe(true)
    })
  })
})

// ============================================================================
// Integration Tests
// ============================================================================

describe('DynamoDB Integration', () => {
  it('end-to-end: register model, create item, build query', () => {
    const adapter = createDynamoDBToolingAdapter({
      region: 'us-east-1',
      tableName: 'TestTable',
    })

    // Register model
    adapter.registerModel({
      name: 'User',
      primaryKey: 'id',
      attributes: {
        name: { fillable: true },
        email: { fillable: true, unique: true },
      },
      traits: { useTimestamps: true },
    })

    // Create item
    const item = adapter.createItem('User', { id: '123', name: 'John', email: 'john@example.com' })
    expect(item.pk).toBe('USER#123')
    expect(item._et).toBe('User') // _et is the default entity type attribute
    expect(item.createdAt).toBeDefined()

    // Build query
    const queryBuilder = adapter.query('User')
    const request = queryBuilder
      .wherePartitionKey('pk', item.pk)
      .toQueryRequest()

    expect(request.TableName).toBe('TestTable')
    expect(request.KeyConditionExpression).toContain('#key0 = :keyval0')
  })

  it('end-to-end: parent-child relationship query', () => {
    const adapter = createDynamoDBToolingAdapter({
      region: 'us-east-1',
      tableName: 'TestTable',
    })

    // Register models
    adapter.registerModels([
      { name: 'User', primaryKey: 'id', hasMany: ['Post'] },
      { name: 'Post', primaryKey: 'id', belongsTo: ['User'] },
    ])

    // Create parent item
    const user = adapter.createItem('User', { id: 'user-1', name: 'John' })
    expect(user.pk).toBe('USER#user-1')

    // Build query for posts by user (using GSI)
    const postModel = adapter.getModel('Post')
    expect(postModel?.keyPatterns.gsi1pk).toContain('USER')
  })

  it('DynamoDB client factory creates working client', () => {
    const client = createDynamoDBClient({
      config: testConfig,
    })

    expect(client.query).toBeDefined()
    expect(client.item).toBeDefined()
    expect(client.driver).toBeDefined()
    expect(client.registerEntity).toBeDefined()
    expect(client.buildKey).toBeDefined()

    // Register entity and build key
    client.registerEntity({
      entityType: 'User',
      pkPattern: 'USER#${id}',
      skPattern: 'USER#${id}',
    })

    const key = client.buildKey('User', { id: '123' })
    expect(key.pk).toBe('USER#123')
    expect(key.sk).toBe('USER#123')
  })
})
