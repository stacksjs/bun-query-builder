/**
 * Test Data Seeder
 *
 * Generates realistic, interconnected test data based on Stacks models
 * This mirrors how data would look in a real TrailBuddy database
 */

// Runtime types derived from models (for test data)
export interface UserRecord {
  id: number
  name: string
  email: string
  password?: string
  avatar?: string
  bio?: string
  location?: string
  active: boolean
  role: 'admin' | 'user' | 'moderator'
  created_at: string
  updated_at: string
}

export interface TrailRecord {
  id: number
  name: string
  location: string
  distance: number
  elevation: number
  difficulty: 'easy' | 'moderate' | 'hard'
  rating: number
  review_count: number
  estimated_time: string
  image?: string
  tags?: string
  latitude?: number
  longitude?: number
  description?: string
  created_at: string
  updated_at: string
}

export interface ActivityRecord {
  id: number
  user_id: number
  trail_id: number
  activity_type: 'Trail Run' | 'Hike' | 'Walk' | 'Bike'
  distance: number
  duration: string
  pace?: string
  elevation?: number
  kudos_count: number
  notes?: string
  gpx_data?: string
  completed_at: string
  created_at: string
  updated_at: string
}

export interface TerritoryRecord {
  id: number
  user_id: number
  activity_id: number
  parent_territory_id?: number | null
  name: string
  polygon_data: string
  bounding_box?: string
  center_lat: number
  center_lng: number
  area_size: number
  perimeter?: number
  status: 'active' | 'contested'
  conquest_count: number
  claimed_at: string
  created_at: string
  updated_at: string
}

export interface TerritoryHistoryRecord {
  id: number
  territory_id: number
  user_id: number
  activity_id?: number
  previous_owner_id?: number | null
  event_type: 'claimed' | 'conquered' | 'defended' | 'split'
  area_at_event: number
  previous_ownership_duration?: number
  notes?: string
  created_at: string
  updated_at: string
}

export interface ReviewRecord {
  id: number
  user_id: number
  trail_id: number
  rating: number
  title?: string
  content: string
  visit_date?: string
  conditions?: 'excellent' | 'good' | 'fair' | 'poor' | 'muddy' | 'icy'
  helpful_count: number
  photos?: string
  created_at: string
  updated_at: string
}

export interface KudosRecord {
  id: number
  user_id: number
  activity_id: number
  giver_id: number
  created_at: string
  updated_at: string
}

export interface UserStatsRecord {
  id: number
  user_id: number
  total_distance: number
  total_time: string
  total_elevation: number
  trails_completed: number
  current_streak: number
  longest_streak: number
  weekly_rank: number
  total_activities: number
  total_kudos_received: number
  total_kudos_given: number
  created_at: string
  updated_at: string
}

export interface TerritoryStatsRecord {
  id: number
  user_id: number
  total_territories_owned: number
  total_area_owned: number
  territories_claimed: number
  territories_conquered: number
  territories_lost: number
  territories_defended: number
  longest_ownership_days: number
  largest_territory_area: number
  weekly_rank: number
  all_time_rank: number
  created_at: string
  updated_at: string
}

// Sample locations for realistic geo data
const LOCATIONS = [
  { city: 'San Francisco', state: 'CA', lat: 37.7749, lng: -122.4194 },
  { city: 'Los Angeles', state: 'CA', lat: 34.0522, lng: -118.2437 },
  { city: 'Seattle', state: 'WA', lat: 47.6062, lng: -122.3321 },
  { city: 'Portland', state: 'OR', lat: 45.5152, lng: -122.6784 },
  { city: 'Denver', state: 'CO', lat: 39.7392, lng: -104.9903 },
]

const TRAIL_NAMES = [
  'Sunrise Summit Trail', 'Redwood Loop', 'Canyon Vista Path',
  'Waterfall Creek Trail', 'Eagle Peak Route', 'Coastal Bluff Walk',
  'Pine Forest Trail', 'Meadow View Loop', 'Rocky Ridge Path', 'River Run Trail',
]

/**
 * Generate complete seed data with proper relationships
 */
export function generateSeedData() {
  const now = new Date()

  // === USERS ===
  const users: UserRecord[] = [
    {
      id: 1,
      name: 'Alex Runner',
      email: 'alex@trailbuddy.com',
      password: 'hashed_password_1',
      avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=alex',
      bio: 'Ultra marathon runner, 50+ trails completed',
      location: 'San Francisco, CA',
      active: true,
      role: 'admin',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-15T00:00:00Z',
    },
    {
      id: 2,
      name: 'Sam Hiker',
      email: 'sam@trailbuddy.com',
      password: 'hashed_password_2',
      avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=sam',
      bio: 'Weekend warrior, love scenic views',
      location: 'Los Angeles, CA',
      active: true,
      role: 'user',
      created_at: '2024-01-05T00:00:00Z',
      updated_at: '2024-01-20T00:00:00Z',
    },
    {
      id: 3,
      name: 'Jordan Walker',
      email: 'jordan@trailbuddy.com',
      password: 'hashed_password_3',
      avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=jordan',
      bio: 'Just getting started with trail running',
      location: 'Seattle, WA',
      active: true,
      role: 'user',
      created_at: '2024-01-10T00:00:00Z',
      updated_at: '2024-01-25T00:00:00Z',
    },
    {
      id: 4,
      name: 'Taylor Peak',
      email: 'taylor@trailbuddy.com',
      password: 'hashed_password_4',
      bio: 'Mountain enthusiast',
      location: 'Denver, CO',
      active: true,
      role: 'moderator',
      created_at: '2024-01-15T00:00:00Z',
      updated_at: '2024-01-30T00:00:00Z',
    },
    {
      id: 5,
      name: 'Inactive User',
      email: 'inactive@trailbuddy.com',
      password: 'hashed_password_5',
      active: false,
      role: 'user',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    },
  ]

  // === TRAILS ===
  const trails: TrailRecord[] = TRAIL_NAMES.map((name, index) => {
    const loc = LOCATIONS[index % LOCATIONS.length]
    return {
      id: index + 1,
      name,
      location: `${loc.city}, ${loc.state}`,
      distance: Math.round((3 + Math.random() * 15) * 10) / 10,
      elevation: Math.round(200 + Math.random() * 2000),
      difficulty: (['easy', 'moderate', 'hard'] as const)[index % 3],
      rating: Math.round((3.5 + Math.random() * 1.5) * 10) / 10,
      review_count: Math.floor(50 + Math.random() * 500),
      estimated_time: `${Math.floor(1 + Math.random() * 4)}h ${Math.floor(Math.random() * 4) * 15}m`,
      image: `https://images.unsplash.com/photo-155163281156${index}?w=800`,
      tags: ['forest', 'views', 'dog-friendly', 'running', 'family'].slice(0, 2 + (index % 3)).join(','),
      latitude: loc.lat + (Math.random() - 0.5) * 0.1,
      longitude: loc.lng + (Math.random() - 0.5) * 0.1,
      description: `Beautiful trail near ${loc.city} with amazing ${index % 2 === 0 ? 'mountain' : 'coastal'} views.`,
      created_at: `2024-01-${String(1 + index).padStart(2, '0')}T00:00:00Z`,
      updated_at: `2024-01-${String(10 + index).padStart(2, '0')}T00:00:00Z`,
    }
  })

  // === ACTIVITIES ===
  const activities: ActivityRecord[] = []
  let activityId = 1
  const activityTypes = ['Trail Run', 'Hike', 'Walk', 'Bike'] as const

  // Generate activities for each active user
  for (const user of users.filter(u => u.active)) {
    const activityCount = user.id === 1 ? 15 : user.id === 2 ? 10 : 5
    for (let i = 0; i < activityCount; i++) {
      const trail = trails[Math.floor(Math.random() * trails.length)]
      const type = activityTypes[Math.floor(Math.random() * activityTypes.length)]
      const dayOffset = Math.floor(Math.random() * 30)
      activities.push({
        id: activityId++,
        user_id: user.id,
        trail_id: trail.id,
        activity_type: type,
        distance: Math.round(trail.distance * (0.8 + Math.random() * 0.4) * 10) / 10,
        duration: `${Math.floor(Math.random() * 3)}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`,
        pace: `${Math.floor(6 + Math.random() * 10)}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`,
        elevation: Math.round(trail.elevation * (0.8 + Math.random() * 0.4)),
        kudos_count: Math.floor(Math.random() * 50),
        notes: i % 3 === 0 ? 'Great conditions today!' : undefined,
        completed_at: new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000).toISOString(),
        created_at: new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000).toISOString(),
      })
    }
  }

  // === TERRITORIES ===
  const territories: TerritoryRecord[] = []
  let territoryId = 1

  // User 1 (Alex) owns 3 territories
  for (let i = 0; i < 3; i++) {
    const loc = LOCATIONS[i]
    const activity = activities.find(a => a.user_id === 1)!
    territories.push({
      id: territoryId++,
      user_id: 1,
      activity_id: activity.id,
      name: `${loc.city} Downtown Zone`,
      polygon_data: JSON.stringify({
        type: 'Polygon',
        coordinates: [[
          [loc.lng - 0.01, loc.lat - 0.01],
          [loc.lng + 0.01, loc.lat - 0.01],
          [loc.lng + 0.01, loc.lat + 0.01],
          [loc.lng - 0.01, loc.lat + 0.01],
          [loc.lng - 0.01, loc.lat - 0.01],
        ]],
      }),
      bounding_box: `${loc.lat - 0.01},${loc.lng - 0.01},${loc.lat + 0.01},${loc.lng + 0.01}`,
      center_lat: loc.lat,
      center_lng: loc.lng,
      area_size: 50000 + Math.floor(Math.random() * 100000),
      perimeter: 2000 + Math.floor(Math.random() * 1000),
      status: 'active',
      conquest_count: Math.floor(Math.random() * 5),
      claimed_at: `2024-01-${String(5 + i).padStart(2, '0')}T12:00:00Z`,
      created_at: `2024-01-${String(5 + i).padStart(2, '0')}T12:00:00Z`,
      updated_at: `2024-01-${String(10 + i).padStart(2, '0')}T12:00:00Z`,
    })
  }

  // User 2 (Sam) owns 2 territories
  for (let i = 0; i < 2; i++) {
    const loc = LOCATIONS[3 + i]
    const activity = activities.find(a => a.user_id === 2)!
    territories.push({
      id: territoryId++,
      user_id: 2,
      activity_id: activity.id,
      name: `${loc.city} Park District`,
      polygon_data: JSON.stringify({
        type: 'Polygon',
        coordinates: [[
          [loc.lng - 0.02, loc.lat - 0.02],
          [loc.lng + 0.02, loc.lat - 0.02],
          [loc.lng + 0.02, loc.lat + 0.02],
          [loc.lng - 0.02, loc.lat + 0.02],
          [loc.lng - 0.02, loc.lat - 0.02],
        ]],
      }),
      center_lat: loc.lat,
      center_lng: loc.lng,
      area_size: 80000 + Math.floor(Math.random() * 50000),
      perimeter: 3000 + Math.floor(Math.random() * 500),
      status: i === 0 ? 'contested' : 'active',
      conquest_count: Math.floor(Math.random() * 3),
      claimed_at: `2024-01-${String(10 + i).padStart(2, '0')}T14:00:00Z`,
      created_at: `2024-01-${String(10 + i).padStart(2, '0')}T14:00:00Z`,
      updated_at: `2024-01-${String(15 + i).padStart(2, '0')}T14:00:00Z`,
    })
  }

  // === TERRITORY HISTORY ===
  const territoryHistories: TerritoryHistoryRecord[] = []
  let historyId = 1

  for (const territory of territories) {
    // Initial claim
    territoryHistories.push({
      id: historyId++,
      territory_id: territory.id,
      user_id: territory.user_id,
      activity_id: territory.activity_id,
      event_type: 'claimed',
      area_at_event: territory.area_size,
      notes: 'Initial claim via loop run',
      created_at: territory.claimed_at,
      updated_at: territory.claimed_at,
    })

    // Add conquest attempt for contested territory
    if (territory.status === 'contested') {
      territoryHistories.push({
        id: historyId++,
        territory_id: territory.id,
        user_id: 3,
        previous_owner_id: territory.user_id,
        event_type: 'defended',
        area_at_event: territory.area_size,
        previous_ownership_duration: 5 * 24 * 60 * 60,
        notes: 'Defense successful - attacker did not complete loop',
        created_at: '2024-01-20T10:00:00Z',
        updated_at: '2024-01-20T10:00:00Z',
      })
    }
  }

  // === REVIEWS ===
  const reviews: ReviewRecord[] = []
  let reviewId = 1

  for (const user of users.filter(u => u.active)) {
    const reviewCount = user.id === 1 ? 5 : 3
    for (let i = 0; i < reviewCount; i++) {
      const trail = trails[(user.id + i) % trails.length]
      reviews.push({
        id: reviewId++,
        user_id: user.id,
        trail_id: trail.id,
        rating: Math.floor(3 + Math.random() * 3),
        title: ['Amazing trail!', 'Great views', 'Nice workout', 'Beautiful scenery', 'Worth the climb'][i % 5],
        content: `This is a ${trail.difficulty} trail that I really enjoyed. The views from the top are incredible and the path is well maintained.`,
        visit_date: `2024-01-${String(10 + i).padStart(2, '0')}`,
        conditions: (['excellent', 'good', 'fair'] as const)[i % 3],
        helpful_count: Math.floor(Math.random() * 50),
        created_at: `2024-01-${String(15 + i).padStart(2, '0')}T09:00:00Z`,
        updated_at: `2024-01-${String(15 + i).padStart(2, '0')}T09:00:00Z`,
      })
    }
  }

  // === KUDOS ===
  const kudos: KudosRecord[] = []
  let kudosId = 1

  // Users give kudos to each other's activities
  for (const activity of activities.slice(0, 20)) {
    const potentialGivers = users.filter(u => u.id !== activity.user_id && u.active)
    const giverCount = Math.floor(Math.random() * Math.min(3, potentialGivers.length))
    for (let i = 0; i < giverCount; i++) {
      kudos.push({
        id: kudosId++,
        user_id: activity.user_id,
        activity_id: activity.id,
        giver_id: potentialGivers[i].id,
        created_at: activity.created_at,
        updated_at: activity.created_at,
      })
    }
  }

  // === USER STATS ===
  const userStats: UserStatsRecord[] = users.filter(u => u.active).map((user, index) => {
    const userActivities = activities.filter(a => a.user_id === user.id)
    const userKudosReceived = kudos.filter(k => k.user_id === user.id)
    const userKudosGiven = kudos.filter(k => k.giver_id === user.id)

    return {
      id: index + 1,
      user_id: user.id,
      total_distance: userActivities.reduce((sum, a) => sum + a.distance, 0),
      total_time: user.id === 1 ? '156h 32m' : user.id === 2 ? '78h 15m' : '25h 10m',
      total_elevation: userActivities.reduce((sum, a) => sum + (a.elevation || 0), 0),
      trails_completed: new Set(userActivities.map(a => a.trail_id)).size,
      current_streak: user.id === 1 ? 12 : user.id === 2 ? 5 : 2,
      longest_streak: user.id === 1 ? 45 : user.id === 2 ? 21 : 8,
      weekly_rank: user.id === 1 ? 3 : user.id === 2 ? 15 : 89,
      total_activities: userActivities.length,
      total_kudos_received: userKudosReceived.length,
      total_kudos_given: userKudosGiven.length,
      created_at: user.created_at,
      updated_at: user.updated_at,
    }
  })

  // === TERRITORY STATS ===
  const territoryStats: TerritoryStatsRecord[] = users.filter(u => u.active).map((user, index) => {
    const userTerritories = territories.filter(t => t.user_id === user.id)

    return {
      id: index + 1,
      user_id: user.id,
      total_territories_owned: userTerritories.length,
      total_area_owned: userTerritories.reduce((sum, t) => sum + t.area_size, 0),
      territories_claimed: user.id === 1 ? 5 : user.id === 2 ? 3 : 1,
      territories_conquered: user.id === 1 ? 2 : user.id === 2 ? 1 : 0,
      territories_lost: user.id === 1 ? 0 : user.id === 2 ? 1 : 0,
      territories_defended: user.id === 1 ? 3 : user.id === 2 ? 1 : 0,
      longest_ownership_days: user.id === 1 ? 45 : user.id === 2 ? 20 : 5,
      largest_territory_area: Math.max(...userTerritories.map(t => t.area_size), 0),
      weekly_rank: user.id === 1 ? 1 : user.id === 2 ? 5 : 50,
      all_time_rank: user.id === 1 ? 12 : user.id === 2 ? 45 : 234,
      created_at: user.created_at,
      updated_at: user.updated_at,
    }
  })

  return {
    users,
    trails,
    activities,
    territories,
    territoryHistories,
    reviews,
    kudos,
    userStats,
    territoryStats,
  }
}

export type SeedData = ReturnType<typeof generateSeedData>
