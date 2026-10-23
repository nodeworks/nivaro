-- Cloud-mode fixture (profile cloud): the meta database nivaro-cloud keeps, with its
-- cloud_tenants table as api/src/middleware/tenant.ts reads it. The tenant databases are SQL
-- Server (tenant_a / tenant_b on the stack's mssql): Postgres tenants cannot be provisioned from
-- this repo today (migration 095 and ~20 others run T-SQL with no dialect guard). Rows are
-- inserted by the cloud suite.
CREATE DATABASE cloud_meta;
\connect cloud_meta
CREATE TABLE cloud_tenants (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  subdomain text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  db_client text NOT NULL DEFAULT 'pg',
  db_connection_string text NOT NULL
);
