/**
 * TrailBuddy Models Index
 *
 * Exports all Stacks model definitions
 */

export { default as User } from './User'
export { default as Trail } from './Trail'
export { default as Activity } from './Activity'
export { default as Territory } from './Territory'
export { default as TerritoryHistory } from './TerritoryHistory'
export { default as Review } from './Review'
export { default as Kudos } from './Kudos'
export { default as UserStats } from './UserStats'
export { default as TerritoryStats } from './TerritoryStats'

/**
 * All models in an array for iteration
 */
export const models = [
  require('./User').default,
  require('./Trail').default,
  require('./Activity').default,
  require('./Territory').default,
  require('./TerritoryHistory').default,
  require('./Review').default,
  require('./Kudos').default,
  require('./UserStats').default,
  require('./TerritoryStats').default,
]

/**
 * Model relationship map derived from model definitions
 */
export const relationships = {
  users: {
    hasMany: ['activities', 'territories', 'reviews', 'kudos'],
    hasOne: ['user_stats', 'territory_stats'],
  },
  trails: {
    hasMany: ['activities', 'reviews'],
  },
  activities: {
    belongsTo: ['users', 'trails'],
    hasMany: ['kudos', 'territories'],
  },
  territories: {
    belongsTo: ['users', 'activities'],
    hasMany: ['territory_histories'],
  },
  territory_histories: {
    belongsTo: ['territories', 'users', 'activities'],
  },
  reviews: {
    belongsTo: ['users', 'trails'],
  },
  kudos: {
    belongsTo: ['users', 'activities'],
  },
  user_stats: {
    belongsTo: ['users'],
  },
  territory_stats: {
    belongsTo: ['users'],
  },
}
