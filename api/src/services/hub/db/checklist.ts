// What a DBA must create for a database requested on a manual server: the same database, login
// and rights an automatic server would get (plan decision 2), as a list the creation panel and
// the Databases tab show. Pure; nothing secret (the password is the DBA's, entered in the Hub).
import type { HubDbServer } from './servers.js'

export interface ChecklistItem {
  label: string
  value: string
  note?: string
}

const DEFAULT_MSSQL_COLLATION = 'SQL_Latin1_General_CP1_CI_AS'

export function dbaChecklist(
  server: HubDbServer,
  database_name: string,
  login_name: string
): ChecklistItem[] {
  const items: ChecklistItem[] = [
    {
      label: 'Server',
      value: `${server.name} (${server.host}${server.port ? `:${server.port}` : ''})`
    },
    { label: 'Database name', value: database_name }
  ]

  switch (server.engine) {
    case 'mssql':
      items.push({
        label: 'Collation',
        value: server.collation ?? DEFAULT_MSSQL_COLLATION,
        note: 'CREATE DATABASE … COLLATE'
      })
      break
    case 'pg':
      items.push({
        label: 'Encoding',
        value: 'UTF8',
        note: "CREATE DATABASE … ENCODING 'UTF8' TEMPLATE template0"
      })
      break
    case 'mysql2':
      items.push({ label: 'Character set', value: 'utf8mb4 / utf8mb4_0900_ai_ci' })
      break
    case 'mariadb':
      items.push({ label: 'Character set', value: 'utf8mb4 / utf8mb4_unicode_ci' })
      break
  }

  const loginNote: Record<HubDbServer['engine'], string> = {
    mssql: 'A SQL login (CHECK_POLICY = ON) with a strong password',
    pg: 'A role with LOGIN and a strong password',
    mysql2: `CREATE USER '${login_name}'@'${server.user_host ?? '%'}' with a strong password`,
    mariadb: `CREATE USER '${login_name}'@'${server.user_host ?? '%'}' with a strong password`
  }
  items.push({ label: 'Login', value: login_name, note: loginNote[server.engine] })

  const rightsNote: Record<HubDbServer['engine'], string> = {
    mssql: 'A user in this database for the login, member of db_owner. No server roles.',
    pg: 'The login owns the database (OWNER), REVOKE CONNECT … FROM PUBLIC. No superuser, CREATEDB or CREATEROLE.',
    mysql2: `GRANT ALL PRIVILEGES ON ${database_name}.* — nothing on *.*`,
    mariadb: `GRANT ALL PRIVILEGES ON ${database_name}.* — nothing on *.*`
  }
  items.push({
    label: 'Rights',
    value: 'Owner of this database only',
    note: rightsNote[server.engine]
  })

  if (server.engine === 'mssql')
    items.push({
      label: 'Read committed snapshot',
      value: 'ON',
      note: `ALTER DATABASE ${database_name} SET READ_COMMITTED_SNAPSHOT ON`
    })

  items.push({
    label: 'Leave it empty',
    value: 'No tables',
    note: 'The app creates its own tables on first start; the Hub accepts only an empty database.'
  })

  if (server.notes) items.push({ label: 'Server notes', value: server.notes })

  items.push({
    label: 'Then',
    value: 'Enter the connection in the Hub',
    note: 'Databases → Set connection. The password goes only there; the Hub checks the database before it continues.'
  })
  return items
}
