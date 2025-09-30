CREATE TABLE test_users (
  id BIGSERIAL PRIMARY KEY,
  role role_type,
  status status_type,
  name varchar(255)
);