import type { ModelDefinition as Model } from '../../../src/orm'
import { schema } from '@stacksjs/ts-validation'

const roles = ['user', 'admin', 'moderator'] as const

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
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string().url(),
      },
      factory: (faker) => faker.image.avatar(),
    },

    bio: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string().max(500),
      },
      factory: (faker) => faker.lorem.sentence(),
    },

    location: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.string().max(200),
      },
      factory: (faker) => `${faker.location.city()}, ${faker.location.state({ abbreviated: true })}`,
    },

    active: {
      order: 7,
      fillable: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => true,
    },

    role: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.enum(roles).required(),
      },
      factory: (faker): typeof roles[number] => faker.helpers.arrayElement([...roles]),
    },
  },

  dashboard: {
    highlight: true,
  },
} satisfies Model
