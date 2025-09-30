CREATE TYPE role_type AS ENUM ('admin', 'member', 'guest');

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email varchar(255),
  name varchar(255),
  role role_type,
  created_at timestamp,
  updated_at timestamp
);