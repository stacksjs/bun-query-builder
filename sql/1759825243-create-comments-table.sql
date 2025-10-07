CREATE TABLE "comments" (
  "id" SERIAL PRIMARY KEY,
  "post_id" integer,
  "user_id" integer,
  "content" varchar(255),
  "created_at" date,
  "updated_at" date
);