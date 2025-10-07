CREATE TABLE "posts" (
  "id" SERIAL PRIMARY KEY,
  "user_id" integer,
  "title" varchar(255),
  "body" varchar(255),
  "published" boolean,
  "created_at" date,
  "updated_at" date
);