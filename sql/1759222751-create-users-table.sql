CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email varchar(255),
  name varchar(255),
  role varchar(255),
  created_at timestamp,
  updated_at timestamp
);