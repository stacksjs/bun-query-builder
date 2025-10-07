CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "email" varchar(255),
  "name" varchar(255),
  "age" varchar(255) default 0,
  "role" varchar(255),
  "created_at" date,
  "updated_at" date
);