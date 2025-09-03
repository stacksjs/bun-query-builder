CREATE TABLE comments (
  id BIGSERIAL PRIMARY KEY,
  post_id bigint,
  author varchar(255),
  body varchar(255),
  created_at timestamp
);
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email varchar(255),
  name varchar(255),
  role varchar(255),
  created_at timestamp,
  updated_at timestamp
);
CREATE TABLE posts (
  id BIGSERIAL PRIMARY KEY,
  user_id bigint,
  title varchar(255),
  body varchar(255),
  published varchar(255),
  created_at timestamp,
  updated_at timestamp
);
ALTER TABLE comments ADD CONSTRAINT comments_post_id_fk FOREIGN KEY (post_id) REFERENCES posts(id);
ALTER TABLE posts ADD CONSTRAINT posts_user_id_fk FOREIGN KEY (user_id) REFERENCES users(id);
CREATE UNIQUE INDEX users_users_email_unique ON users (email);