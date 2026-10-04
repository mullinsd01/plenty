-- Can this database user do everything Plenty's first migration needs? Run it BEFORE choosing a host for good, as
-- the user that will be in DATABASE_URL, against the empty database you made for Plenty:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/probe-database.sql
--   docker run --rm -i postgres:16 psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < deploy/probe-database.sql   (no psql installed)
--
-- It makes a role and a schema and removes them again. The pg_trgm extension stays: the migration wants it anyway.
-- "OK" at the end means yes. An error says what the host won't allow ("permission denied to create role" means this
-- user has no CREATEROLE: see docs/deploy.md, "Choose a Postgres host").

create role plenty_probe nologin;          -- the migration creates the restricted role plenty_app the same way
grant plenty_probe to current_user;        -- ...and grants it to itself
set role plenty_probe;                     -- the app switches into plenty_app like this on every request
reset role;
create schema plenty_probe_schema;         -- the migration creates a schema called app
create extension if not exists pg_trgm;    -- forgiving search
drop schema plenty_probe_schema;
drop role plenty_probe;

select 'OK: this database user can do everything the first migration needs' as result;
