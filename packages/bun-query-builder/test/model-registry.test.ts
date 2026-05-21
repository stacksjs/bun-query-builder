import { beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, defineModel, getModel, getModelRegistry, registerModel } from '../src'

describe('model registry', () => {
  beforeEach(() => {
    clearModelRegistry()
  })

  it('registers defineModel models in the shared registry', () => {
    const User = defineModel({
      name: 'User',
      table: 'users',
      primaryKey: 'id',
      attributes: {
        id: { type: 'number' },
        name: { type: 'string' },
      },
    })

    expect(getModel('User')).toBe(User)
    expect(getModelRegistry().User).toBe(User)
  })

  it('registers externally created model facades', () => {
    const model = {
      getDefinition: () => ({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { type: 'number' },
          title: { type: 'string' },
        },
      }),
      getName: () => 'Post',
      getTable: () => 'posts',
    }

    expect(registerModel('Post', model)).toBe(model)
    expect(getModel('Post')).toBe(model)
  })
})
