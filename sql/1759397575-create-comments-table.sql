CREATE TABLE "comments" (
  "id" BIGSERIAL PRIMARY KEY,
  "post_id" bigint,
  "author" varchar(255),
  "body" varchar(255),
  "created_at" timestamp
);