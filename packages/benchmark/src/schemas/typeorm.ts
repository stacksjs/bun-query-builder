/* eslint-disable ts/ban-ts-comment */
// @ts-nocheck
import { Column, CreateDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number

  @Column()
  name!: string

  @Column({ unique: true })
  email!: string

  @Column({ nullable: true })
  age?: number

  @Column({ default: true })
  active!: boolean

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date

  @OneToMany(() => Post, post => post.user)
  posts!: Post[]
}

@Entity('posts')
export class Post {
  @PrimaryGeneratedColumn()
  id!: number

  @Column()
  title!: string

  @Column()
  content!: string

  @Column({ default: false })
  published!: boolean

  @Column({ name: 'user_id' })
  userId!: number

  @ManyToOne(() => User, user => user.posts)
  user!: User

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date
}
