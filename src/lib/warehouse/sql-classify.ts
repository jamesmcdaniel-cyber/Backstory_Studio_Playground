/**
 * Is this SQL a read?
 *
 * Drives the write classification of the warehouse query tools: a read runs
 * like any read tool, anything else is a write — audited as one, refused by a
 * read-only step policy and, on an agent that requires approval, queued for a
 * human. So the rule is deliberately narrow and fails toward "write":
 *
 *   read   SELECT …, SHOW …, DESCRIBE/DESC …, WITH … SELECT …, (SELECT …)
 *   write  everything else — DML, DDL, GRANT, CALL, COPY, PUT, USE, EXECUTE …,
 *          a WITH that feeds an INSERT/UPDATE/DELETE/MERGE, a SELECT that calls
 *          a SYSTEM$ function (several of those act: cancel queries, abort
 *          sessions), and any script with more than one statement unless every
 *          statement is a read.
 *
 * Comments and quoted text are blanked before scanning, so a keyword inside a
 * string literal or a comment never decides anything.
 */

const READ_HEADS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC'])
/**
 * Statement verbs that can follow a CTE. Function names that share a word with
 * a verb (REPLACE(), INSERT() in Databricks) are why a plain SELECT is not
 * scanned for these: a SELECT cannot write, and a false "write" would put every
 * string-cleaning query behind approval.
 */
const DML_AFTER_CTE = /\b(INSERT\s+(INTO|OVERWRITE)|UPDATE\s+[\w."`]+\s+SET|DELETE\s+FROM|MERGE\s+INTO|CREATE|DROP|ALTER|TRUNCATE|COPY\s+INTO|GRANT|REVOKE|CALL)\b/

/** Blank out comments and quoted strings/identifiers, keeping statement separators. */
export function stripSqlNoise(sql: string): string {
  let out = ''
  let index = 0
  while (index < sql.length) {
    const char = sql[index]
    const next = sql[index + 1]
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end
      out += ' '
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      out += ' '
      continue
    }
    if (char === '$' && next === '$') {
      // Snowflake dollar-quoted string.
      const end = sql.indexOf('$$', index + 2)
      index = end === -1 ? sql.length : end + 2
      out += " '' "
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      let cursor = index + 1
      while (cursor < sql.length) {
        if (sql[cursor] === '\\' && char === "'") { cursor += 2; continue }
        if (sql[cursor] === char) {
          if (sql[cursor + 1] === char) { cursor += 2; continue }
          break
        }
        cursor += 1
      }
      index = cursor + 1
      out += char === "'" ? " '' " : ' x '
      continue
    }
    out += char
    index += 1
  }
  return out
}

function statementIsRead(statement: string): boolean {
  const upper = statement.toUpperCase().replace(/^[\s(]+/, '')
  const head = /^([A-Z]+)/.exec(upper)?.[1] ?? ''
  if (/SYSTEM\$/.test(upper)) return false
  if (READ_HEADS.has(head)) return true
  if (head === 'WITH') return /\bSELECT\b/.test(upper) && !DML_AFTER_CTE.test(upper)
  return false
}

export function sqlIsReadOnly(sql: unknown): boolean {
  if (typeof sql !== 'string' || !sql.trim()) return false
  const statements = stripSqlNoise(sql).split(';').map((part) => part.trim()).filter(Boolean)
  return statements.length > 0 && statements.every(statementIsRead)
}
