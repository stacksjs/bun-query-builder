import { Database } from 'bun:sqlite'
import { existsSync, unlinkSync } from 'node:fs'

const DB_PATH = './benchmark.db'

console.log('Setting up benchmark database...')

// Remove existing database
if (existsSync(DB_PATH)) {
  unlinkSync(DB_PATH)
  console.log('Removed existing database')
}

// Create new database
const db = new Database(DB_PATH)

// Create tables
db.run(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    age INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)

db.run(`
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`)

console.log('Created tables')

// Insert sample data
const users = []
for (let i = 1; i <= 1000; i++) {
  users.push({
    name: `User ${i}`,
    email: `user${i}@example.com`,
    age: 20 + (i % 50),
    active: i % 10 !== 0 ? 1 : 0,
  })
}

const insertUser = db.prepare('INSERT INTO users (name, email, age, active) VALUES (?, ?, ?, ?)')
for (const user of users) {
  insertUser.run(user.name, user.email, user.age, user.active)
}

console.log(`Inserted ${users.length} users`)

// Insert posts
const posts = []
for (let i = 1; i <= 5000; i++) {
  posts.push({
    title: `Post ${i}`,
    content: `This is the content of post ${i}`,
    published: i % 3 === 0 ? 1 : 0,
    user_id: (i % 1000) + 1,
  })
}

const insertPost = db.prepare('INSERT INTO posts (title, content, published, user_id) VALUES (?, ?, ?, ?)')
for (const post of posts) {
  insertPost.run(post.title, post.content, post.published, post.user_id)
}

console.log(`Inserted ${posts.length} posts`)

db.close()

console.log('Database setup complete!')
