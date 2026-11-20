# Databases

Nivaro runs on SQL Server, Postgres and MySQL, self-hosted or on a managed service. This page
covers which engines and versions work, how to connect to each managed host, TLS, connection
poolers, and the features that need SQL Server.

## Supported engines

| Engine | `DB_CLIENT` | Minimum version | Notes |
|---|---|---|---|
| SQL Server / Azure SQL Database / Azure SQL Managed Instance | `mssql` (default) | SQL Server 2017 (14.x) | The reference engine. Every feature works. |
| Postgres | `pg` | **14** | Proven from an empty database on 14 and 16. 13 and older: not supported (see below). |
| MySQL | `mysql2` | **8.0** (8.0.13+) | Proven on 8.0 and 8.4. Aurora MySQL 3, Azure Database for MySQL 8.0 and Cloud SQL MySQL 8.0 are 8.0-compatible. 5.7 is not supported. |
| MariaDB | `mariadb` | 11.4 (being added) | `mariadb://` URLs already select it; the dialect lands with the MariaDB work. |
| SQLite | `sqlite` | 3.x (being added) | Single process only — no replicas, no separate worker/realtime processes. |

Why these minimums:

- **Postgres 14** — migrations use `CREATE OR REPLACE TRIGGER`-free DDL, `gen_random_uuid()`
  (core since 13) and generated columns (12); 14 is the oldest major version still supported by
  the Postgres project and by every managed host listed below, and the oldest proven here.
- **MySQL 8.0.13** — expression defaults on `DEFAULT (…)` columns, functional key parts,
  `JSON_TABLE` and window functions (8.0). 8.0 is proven here from an empty database.

## Connecting: `DB_URL` or `DB_*`

Either set the separate variables:

```env
DB_CLIENT=pg            # mssql | pg | mysql2
DB_HOST=db.example.com
DB_PORT=5432
DB_DATABASE=nivaro
DB_USER=nivaro
DB_PASSWORD=…
DB_SSL_MODE=verify-full
```

or one connection string, the way managed services hand them out:

```env
DB_URL=postgres://nivaro:…@db.example.com:5432/nivaro?sslmode=verify-full
```

`DB_URL_FILE=/run/secrets/db_url` reads it from a file (like every `X_FILE` setting).

| Scheme | `DB_CLIENT` |
|---|---|
| `postgres://`, `postgresql://` | `pg` |
| `mysql://` | `mysql2` |
| `mariadb://` | `mariadb` |
| `sqlserver://`, `mssql://` (also the JDBC form `jdbc:sqlserver://host:1433;database=…;user=…;password=…`) | `mssql` |

Query parameters understood:

| Parameter | Meaning |
|---|---|
| `sslmode` (`disable`, `require`, `verify-ca`, `verify-full`; `prefer`/`allow` are treated as `require`) | TLS mode → `DB_SSL_MODE` |
| `ssl` (`true`/`false`) | shorthand for `require` / `disable` |
| `ssl-mode` (MySQL: `DISABLED`, `REQUIRED`, `VERIFY_CA`, `VERIFY_IDENTITY`) | TLS mode |
| `sslrootcert`, `ssl-ca` | CA bundle path → `DB_SSL_CA` |
| `options` | Postgres startup options → `DB_OPTIONS` (e.g. `-c search_path=app`, Neon's `endpoint=ep-…`) |
| `pgbouncer=true` | says a transaction pooler sits in front → `DB_POOLER=transaction` |
| SQL Server: `encrypt`, `trustServerCertificate`, `database`/`databaseName`, `user`, `password` | as in the JDBC string |

Harmless parameters copied with a URL (`channel_binding`, `connect_timeout`,
`application_name`, `connection_limit`, `hostNameInCertificate`, `loginTimeout`, …) are accepted
and ignored; anything else is named in the boot log as ignored. Client certificates
(`sslcert`/`sslkey`) are not supported.

Percent-encode special characters in the password (`@` → `%40`, `/` → `%2F`, `#` → `%23`). In the
JDBC form a value containing `;` is wrapped in braces: `password={a;b}`.

**Precedence:** an explicit `DB_*` variable wins over the same part of the URL. When both are set
and differ, the boot log says which one is used — naming the variable, never the password. If
`DB_ENCRYPT`, `DB_TRUST_SERVER_CERT` or `DB_SSL_MODE` is set, the URL's TLS setting is not used.

The password never appears in logs. `/api/health` shows administrators the host, database and
TLS mode only; the environment viewer masks `DB_PASSWORD`, the password inside `DB_URL` /
`DB_MIGRATION_URL` (URL and JDBC forms).

## TLS

| `DB_SSL_MODE` | What is checked |
|---|---|
| `disable` | plain connection |
| `require` | encrypted; certificate not checked |
| `verify-ca` | encrypted; certificate must chain to a trusted CA (any host name) |
| `verify-full` | `verify-ca` + the certificate must name the host connected to |

`DB_SSL_CA` adds a CA bundle: a PEM file path, or the PEM text itself (`DB_SSL_CA_FILE=/path`
puts the file's text there). Without it the system CA store is used. As in libpq, a CA with
`require` verifies the chain (`verify-ca`), and a CA alone turns TLS on.

Without `DB_SSL_MODE` the older pair still works exactly as before: `DB_ENCRYPT=false` → plain;
`DB_ENCRYPT=true` + `DB_TRUST_SERVER_CERT=true` (the default) → `require`;
`DB_ENCRYPT=true` + `DB_TRUST_SERVER_CERT=false` → `verify-full`.

Per engine:

- **Postgres** — all four modes. `verify-full` against an IP address checks the IP against the
  certificate's IP entries.
- **MySQL** — all four modes. With an IP address as host, `verify-full` checks the CA only
  (mysql2 has no host check for IP addresses): use the host name.
- **SQL Server / Azure SQL** — `disable` = `encrypt: false`; `require` =
  `encrypt: true, trustServerCertificate: true`; `verify-ca` and `verify-full` =
  `encrypt: true, trustServerCertificate: false` (tedious always checks the host name).
  `DB_SSL_CA` becomes tedious `cryptoCredentialsDetails.ca`.

CA bundles per host:

| Host | CA |
|---|---|
| Amazon RDS / Aurora | `global-bundle.pem` from `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` |
| Azure Database for PostgreSQL / MySQL Flexible Server | DigiCert Global Root G2 + Microsoft RSA Root CA 2017 (concatenate both into one PEM) — or the system store, which has both |
| Google Cloud SQL | `server-ca.pem` downloaded from the instance's Connections → Security page (the instance's own CA) |
| Supabase | `prod-ca-2021.crt` from Project Settings → Database → SSL Configuration |
| Neon, Crunchy Bridge | public CAs (Let's Encrypt) — the system store is enough: `verify-full` with no `DB_SSL_CA` |
| Azure SQL Database | public CA (DigiCert) — system store |

## Recipes

Always prefer `verify-full`. Each recipe was checked against a local stand-in (same engine
version, TLS and pooler settings); no real cloud account was used.

### Amazon RDS / Aurora

```env
# RDS for PostgreSQL / Aurora PostgreSQL
DB_URL=postgres://nivaro:…@mydb.abc123.us-east-1.rds.amazonaws.com:5432/nivaro?sslmode=verify-full&sslrootcert=/certs/rds-global-bundle.pem
# RDS for MySQL / Aurora MySQL 3 (MySQL 8.0-compatible)
DB_URL=mysql://nivaro:…@mydb.cluster-abc123.us-east-1.rds.amazonaws.com:3306/nivaro?ssl-mode=VERIFY_IDENTITY&ssl-ca=/certs/rds-global-bundle.pem
```

Point at the cluster (writer) endpoint, not the reader endpoint. Through **RDS Proxy**
(`….proxy-….rds.amazonaws.com`), set `DB_MIGRATION_URL` to the instance/cluster endpoint (see
Poolers). IAM database authentication is not supported — use a password (Secrets Manager →
`DB_URL_FILE`).

### Google Cloud SQL

```env
DB_URL=postgres://nivaro:…@10.20.0.5:5432/nivaro?sslmode=verify-ca&sslrootcert=/certs/server-ca.pem
DB_URL=mysql://nivaro:…@10.20.0.5:3306/nivaro?ssl-mode=VERIFY_CA&ssl-ca=/certs/server-ca.pem
```

Cloud SQL's server certificate names the instance (`project:instance`), not its IP, so
`verify-ca` is the right mode when connecting by IP. With the Cloud SQL Auth Proxy (sidecar on
`127.0.0.1`) the proxy does the TLS: use `sslmode=disable` to the proxy.

### Azure Database for PostgreSQL / MySQL Flexible Server

```env
DB_URL=postgres://nivaro:…@myserver.postgres.database.azure.com:5432/nivaro?sslmode=verify-full
DB_URL=mysql://nivaro:…@myserver.mysql.database.azure.com:3306/nivaro?ssl-mode=VERIFY_IDENTITY
```

Flexible Server requires TLS by default (`require_secure_transport=ON`). The built-in PgBouncer
listens on port **6432** (transaction mode): use it for `DB_URL` and port 5432 for
`DB_MIGRATION_URL`.

### Azure SQL Database

Paste the JDBC string from the portal (Connection strings → JDBC) and fill in the password:

```env
DB_URL=jdbc:sqlserver://myserver.database.windows.net:1433;database=nivaro;user=nivaro@myserver;password={…};encrypt=true;trustServerCertificate=false;hostNameInCertificate=*.database.windows.net;loginTimeout=30;
```

That maps to `encrypt: true, trustServerCertificate: false`. An `encrypt=true` URL without
`trustServerCertificate` verifies the certificate (the old `DB_ENCRYPT` default trusts it).

### Neon

```env
# pooled endpoint (-pooler) for the app, direct endpoint for migrations
DB_URL=postgresql://nivaro:…@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=verify-full
DB_MIGRATION_URL=postgresql://nivaro:…@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=verify-full
```

Neon routes on the TLS server name, which node-postgres sends. Should a network path strip it,
add `options=endpoint%3Dep-cool-name-123456` (→ `DB_OPTIONS=endpoint=ep-cool-name-123456`).
`sslmode=require` in Neon's copied URL also works; `channel_binding=require` is accepted.

### Supabase

```env
# Supavisor transaction mode (port 6543) for the app …
DB_URL=postgres://postgres.abcdefghij:…@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=verify-full&sslrootcert=/certs/supabase-prod-ca-2021.crt
# … and the direct host (or session mode, port 5432 on the pooler host) for migrations
DB_MIGRATION_URL=postgres://postgres:…@db.abcdefghij.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/certs/supabase-prod-ca-2021.crt
```

The direct host `db.<ref>.supabase.co` is IPv6-only unless the IPv4 add-on is enabled; the
session pooler (port 5432 on `pooler.supabase.com`) is the IPv4 alternative for
`DB_MIGRATION_URL`. Supabase's certificate is signed by Supabase's own CA: `sslmode=require` with
no CA connects without checking, `verify-full` needs the CA file.

### Crunchy Bridge

```env
DB_URL=postgres://application:…@p.abcdefghijklmnop.db.postgresbridge.com:5432/postgres?sslmode=verify-full
```

If you enable Crunchy's PgBouncer (port 5431, transaction mode), use it for `DB_URL` and port
5432 for `DB_MIGRATION_URL`.

## Connection poolers

PgBouncer / Supavisor in transaction mode, Neon's `-pooler` endpoints, Azure Flexible Server's
PgBouncer and RDS Proxy hand each transaction to whichever server connection is free. Nivaro's
Postgres code is written for that:

| Session feature | Through a transaction pooler |
|---|---|
| Session time zone (`SET TIME ZONE 'UTC'` on each new connection) | Works: PgBouncer tracks `TimeZone` and replays it. Reads never depend on it (timestamps are parsed as UTC); only `now()` column defaults would. Managed hosts run in UTC. |
| Migration lock (`MIGRATION_SAFE_MODE=true`) | Works: a transaction advisory lock (`pg_advisory_xact_lock`) held by one open transaction for the whole run. A session lock would stay with a server connection nobody owns. |
| Pinned work (`withLongConnection`) | Works: on Postgres it is one transaction. |
| Temp tables / LISTEN-NOTIFY / named prepared statements | Not used on Postgres. |

So migrations, boot and the API all run through a transaction pooler. Still set
**`DB_MIGRATION_URL`** to the direct endpoint: migrations then run on a connection of their own,
outside pooler statement timeouts and RDS Proxy pinning. It is used only for migrations
(`pnpm migrate` and boot) and the migration lock; it must be the same engine and database. Parts
it leaves out (user, password, database, TLS) come from `DB_*`.

The boot log warns when the host looks like a transaction pooler (`-pooler.` hosts,
`pooler.supabase.com:6543`, `.proxy-….rds.amazonaws.com`, port 6432 or 6543, or `pgbouncer=true`
in the URL) and `DB_MIGRATION_URL` is not set. `DB_POOLER=transaction|session|none` overrides the
guess.

Size the pooler for Nivaro's pools: each API process opens up to `DB_POOL_MAX` (60) +
`DB_POOL_BACKGROUND_MAX` (10) client connections; with a pooler in front, lower them or raise the
pooler's client limit.

MySQL poolers (RDS Proxy for MySQL, ProxySQL): the session `SET time_zone` makes RDS Proxy pin
each connection — it works, without multiplexing. The MySQL migration lock is a session
`GET_LOCK`: run migrations on a direct connection (`DB_MIGRATION_URL`) when a proxy is in front.

## Cloud mode (nivaro-cloud tenants)

Tenant pools take a connection string per tenant. A Postgres tenant string goes to
node-postgres as is — note that node-postgres reads `sslmode=require` as `verify-full`. A MySQL
tenant string with `sslmode=` / `ssl-mode=` now gets real TLS (mysql2 used to ignore those
parameters and connect in plain text); a string without them is unchanged.

## SQL Server-only features

These work only on SQL Server / Azure SQL and are hidden or refused elsewhere:

- App-managed stored procedures (`/procedures`), procedure imports with `procedure_body`, and the
  procedure AI review/fix tools.
- SQL checks (`/database/sql-checks`) and their fix proposals — they read `sys.sql_modules`.
- Database tuning (`/database/tuning`) and the DMV panels of the Database hub (deadlocks,
  expensive SQL, index usage, blocking) — SQL Server DMVs and Query Store.
- Restore drills (`RESTORE_DRILL`) and backup age on the Telemetry recovery panel.
- Environment refresh between SQL Server databases (`/environments`).
- Custom queries and procedures written in T-SQL run only where their SQL is valid.
