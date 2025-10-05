import type { Generated, Selectable } from 'kysely'

export interface UserTable {
  id: Generated<number>
  name: string
  email: string
  age: number | null
  active: boolean
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface PostTable {
  id: Generated<number>
  title: string
  content: string
  published: boolean
  user_id: number
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface Database {
  users: UserTable
  posts: PostTable
}

export type User = Selectable<UserTable>
export type Post = Selectable<PostTable>
