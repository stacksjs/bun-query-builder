CREATE TYPE "roles_type" AS ENUM ('admin', 'member', 'guest');

CREATE TABLE "posts" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" bigint,
  "title" varchar(255),
  "body" varchar(255),
  "roles" roles_type,
  "published" varchar(255),
  "created_at" timestamp,
  "updated_at" timestamp
);