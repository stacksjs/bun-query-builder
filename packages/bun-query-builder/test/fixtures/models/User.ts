import type { ModelDefinition as Model } from '../../../src/orm'
import { schema } from '@stacksjs/ts-validation'

export default {
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'name', 'email', 'role'],
      searchable: ['name', 'email'],
      sortable: ['createdAt', 'name'],
      filterable: ['role', 'active'],
    },
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'users',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  hasMany: ['Activity', 'Territory', 'Review', 'Kudos'],
  hasOne: ['UserStats', 'TerritoryStats'],

  attributes: {
    name: {
      type: 'string',
      order: 1,
      fillable: true,
      validation: {
        rule: schema.string().required().min(2).max(100),
        message: {
          required: 'Name is required',
          min: 'Name must have at least 2 characters',
        },
      },
      factory: (faker) => faker.person.fullName(),
    },

    email: {
      type: 'string',
      order: 2,
      unique: true,
      fillable: true,
      validation: {
        rule: schema.string().required().email(),
        message: {
          required: 'Email is required',
          email: 'Must be a valid email address',
        },
      },
      factory: (faker) => faker.internet.email().toLowerCase(),
    },

    password: {
      type: 'string',
      order: 3,
      fillable: true,
      hidden: true,
      validation: {
        rule: schema.string().required().min(6),
        message: {
          required: 'Password is required',
          min: 'Password must be at least 6 characters',
        },
      },
      factory: () => 'hashed_password_123',
    },

    avatar: {
      type: 'string',
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string().url(),
      },
      factory: (faker) => faker.image.avatar(),
    },

    bio: {
      type: 'string',
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string().max(500),
      },
      factory: (faker) => faker.lorem.sentence(),
    },

    location: {
      type: 'string',
      order: 6,
      fillable: true,
      validation: {
        rule: schema.string().max(200),
      },
      factory: (faker) => `${faker.location.city()}, ${faker.location.state({ abbreviated: true })}`,
    },

    active: {
      type: 'boolean',
      order: 7,
      fillable: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => true,
    },

    role: {
      // Literal union type - enables narrow type inference
      type: ['user', 'admin', 'moderator'] as const,
      order: 8,
      fillable: true,
      validation: {
        rule: schema.string().required(),
      },
      factory: (faker) => faker.helpers.arrayElement(['user', 'admin', 'moderator']),
    },
  },

  dashboard: {
    highlight: true,
  },
} satisfies Model
