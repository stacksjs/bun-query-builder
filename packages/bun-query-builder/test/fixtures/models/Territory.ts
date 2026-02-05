import type { Model } from '../mocks/stacks'
import { schema } from '../mocks/stacks'

export default {
  name: 'Territory',
  table: 'territories',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'name', 'areaSize', 'status'],
      searchable: ['name'],
      sortable: ['createdAt', 'areaSize', 'conquestCount'],
      filterable: ['status'],
    },
    useSeeder: {
      count: 30,
    },
    useApi: {
      uri: 'territories',
      routes: ['index', 'show', 'update', 'destroy'],
    },
  },

  belongsTo: ['User', 'Activity'],
  hasMany: ['TerritoryHistory'],

  attributes: {
    parentTerritoryId: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: () => null,
    },

    name: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().max(200),
      },
      factory: (faker) => `${faker.location.street()} Territory`,
    },

    polygonData: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string().required(),
        message: {
          required: 'Polygon data is required',
        },
      },
      factory: (faker) => {
        const centerLat = faker.location.latitude()
        const centerLng = faker.location.longitude()
        const offset = 0.005
        const coords = [
          [centerLng - offset, centerLat - offset],
          [centerLng + offset, centerLat - offset],
          [centerLng + offset, centerLat + offset],
          [centerLng - offset, centerLat + offset],
          [centerLng - offset, centerLat - offset],
        ]
        return JSON.stringify({
          type: 'Polygon',
          coordinates: [coords],
        })
      },
    },

    boundingBox: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => {
        const lat = faker.location.latitude()
        const lng = faker.location.longitude()
        const offset = 0.005
        return `${lat - offset},${lng - offset},${lat + offset},${lng + offset}`
      },
    },

    centerLat: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.number().required(),
        message: {
          required: 'Center latitude is required',
        },
      },
      factory: (faker) => faker.location.latitude(),
    },

    centerLng: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.number().required(),
        message: {
          required: 'Center longitude is required',
        },
      },
      factory: (faker) => faker.location.longitude(),
    },

    areaSize: {
      order: 7,
      fillable: true,
      validation: {
        rule: schema.number().required().min(0),
        message: {
          required: 'Area size is required',
        },
      },
      factory: (faker) => faker.number.float({ min: 1000, max: 500000, fractionDigits: 2 }),
    },

    perimeter: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.float({ min: 100, max: 5000, fractionDigits: 2 }),
    },

    status: {
      order: 9,
      fillable: true,
      validation: {
        rule: schema.string().required(),
        message: {
          required: 'Status is required',
        },
      },
      factory: (faker) => faker.helpers.arrayElement(['active', 'contested']),
    },

    conquestCount: {
      order: 10,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 50 }),
    },

    claimedAt: {
      order: 11,
      fillable: true,
      validation: {
        rule: schema.string().required(),
        message: {
          required: 'Claimed timestamp is required',
        },
      },
      factory: (faker) => faker.date.recent({ days: 30 }).toISOString(),
    },
  },

  dashboard: {
    highlight: true,
  },
} satisfies Model
