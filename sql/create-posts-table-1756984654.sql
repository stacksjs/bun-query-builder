CREATE TABLE posts (
  id BIGSERIAL PRIMARY KEY,
  user_id bigint,
  title varchar(255),
  body varchar(255),
  published varchar(255),
  created_at timestamp,
  updated_at timestamp
);