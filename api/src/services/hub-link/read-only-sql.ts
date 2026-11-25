import { maskSql } from '../sql-checks/tokenizer.js'

/**
 * Whether a custom query's SQL is provably a READ, for Hub smoke checks (strict on purpose: a
 * query it refuses simply cannot be a smoke check). Judged on the text with comments and string
 * literals blanked (services/sql-checks/tokenizer.ts maskSql), so a keyword inside a literal or a
 * comment neither refuses nor passes anything:
 *
 *  - ONE statement (a single trailing `;` is fine), starting with SELECT or WITH;
 *  - none of the words that write, change a session or reach outside: INSERT UPDATE DELETE MERGE
 *    TRUNCATE INTO (SELECT … INTO makes a table) EXEC EXECUTE CALL CREATE ALTER DROP RENAME
 *    GRANT REVOKE DENY DECLARE SET USE BEGIN COMMIT ROLLBACK SAVE TRANSACTION WAITFOR SHUTDOWN
 *    KILL BACKUP RESTORE DBCC BULK OPENROWSET OPENQUERY OPENDATASOURCE OPENXML COPY PRAGMA
 *    ATTACH DETACH VACUUM LOCK HANDLER LOAD OUTFILE DUMPFILE, `NEXT VALUE FOR`, and the
 *    functions nextval / setval / lo_import / lo_export / pg_read_file / dblink;
 *  - no `sp_` / `xp_` names (system procedures) and no `@@` variable that is not a read.
 *
 * Answers null when it is a read, else a short reason.
 */

const WRITE_WORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'TRUNCATE',
  'INTO',
  'EXEC',
  'EXECUTE',
  'CALL',
  'CREATE',
  'ALTER',
  'DROP',
  'RENAME',
  'GRANT',
  'REVOKE',
  'DENY',
  'DECLARE',
  'SET',
  'USE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVE',
  'TRANSACTION',
  'WAITFOR',
  'SHUTDOWN',
  'KILL',
  'BACKUP',
  'RESTORE',
  'DBCC',
  'BULK',
  'OPENROWSET',
  'OPENQUERY',
  'OPENDATASOURCE',
  'OPENXML',
  'COPY',
  'PRAGMA',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'LOCK',
  'HANDLER',
  'LOAD',
  'OUTFILE',
  'DUMPFILE'
]
const WORD_RE = new RegExp(String.raw`(?<![\w@#$.])(${WRITE_WORDS.join('|')})(?![\w$])`, 'i')
const FUNC_RE =
  /(?<![\w$])(nextval|setval|lo_import|lo_export|pg_read_file|pg_ls_dir|dblink\w*)\s*\(/i

export function readOnlySqlRefusal(sql: unknown): string | null {
  if (typeof sql !== 'string' || !sql.trim()) return 'it has no SQL'
  if (sql.length > 200_000) return 'its SQL is too long to check'
  const masked = maskSql(sql).trim().replace(/;\s*$/, '')
  if (masked.includes(';')) return 'it holds more than one statement'
  if (!/^\(*\s*(SELECT|WITH)\b/i.test(masked)) return 'it does not start with SELECT or WITH'
  const word = WORD_RE.exec(masked)
  if (word) return `it uses ${word[1].toUpperCase()}`
  if (/\bNEXT\s+VALUE\s+FOR\b/i.test(masked)) return 'it takes a sequence value'
  const fn = FUNC_RE.exec(masked)
  if (fn) return `it calls ${fn[1].toLowerCase()}()`
  if (/(?<![\w$])(sp|xp)_\w+/i.test(masked)) return 'it names a system procedure'
  return null
}
