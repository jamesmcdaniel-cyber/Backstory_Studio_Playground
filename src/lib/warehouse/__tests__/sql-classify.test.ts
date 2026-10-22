import test from 'node:test'
import assert from 'node:assert/strict'
import { sqlIsReadOnly } from '../sql-classify'
import { warehouseToolIsWrite } from '../tools'

test('SELECT, SHOW, DESCRIBE and WITH…SELECT are reads', () => {
  for (const sql of [
    'SELECT * FROM accounts',
    '  select replace(name, \'x\', \'y\') as clean, insert(name, 1, 0, \'a\') from t',
    '(SELECT 1) UNION (SELECT 2)',
    'show tables in schema sales',
    'DESCRIBE TABLE accounts',
    'desc table accounts',
    'WITH recent AS (SELECT * FROM orders WHERE d > current_date - 7) SELECT count(*) FROM recent',
    '-- a comment saying DELETE\nSELECT 1',
    "SELECT 'DROP TABLE x; DELETE FROM y' AS s",
    'SELECT 1; SELECT 2;',
    'select last_update, updated_by from audit',
  ]) {
    assert.equal(sqlIsReadOnly(sql), true, sql)
  }
})

test('everything else — DML, DDL, CALL, SYSTEM$ calls, CTE-fed writes, mixed scripts — is a write', () => {
  for (const sql of [
    'INSERT INTO t VALUES (1)',
    'update t set a = 1',
    'DELETE FROM t',
    'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE',
    'CREATE TABLE t AS SELECT * FROM s',
    'DROP TABLE t',
    'GRANT SELECT ON t TO ROLE r',
    'CALL refresh_all()',
    'COPY INTO t FROM @stage',
    'USE WAREHOUSE big',
    'EXPLAIN SELECT 1',
    'SELECT SYSTEM$CANCEL_ALL_QUERIES(1)',
    'WITH s AS (SELECT 1 AS id) INSERT INTO t SELECT * FROM s',
    'WITH s AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM s)',
    'SELECT 1; DELETE FROM t',
    '/* SELECT */ TRUNCATE TABLE t',
    '',
    '   ',
  ]) {
    assert.equal(sqlIsReadOnly(sql), false, sql)
  }
  assert.equal(sqlIsReadOnly(undefined), false)
})

test('a query tool is classified per call; a job run is always a write', () => {
  assert.equal(warehouseToolIsWrite('snowflake_sql_query', { statement: 'select 1' }), false)
  assert.equal(warehouseToolIsWrite('snowflake_sql_query', { statement: 'delete from t' }), true)
  assert.equal(warehouseToolIsWrite('databricks_sql_query', { statement: 'SHOW SCHEMAS' }), false)
  assert.equal(warehouseToolIsWrite('databricks_sql_query', { statement: 'OPTIMIZE t' }), true)
  // Without the call's args a query tool CAN write, so it counts as one.
  assert.equal(warehouseToolIsWrite('databricks_sql_query'), true)
  assert.equal(warehouseToolIsWrite('databricks_run_job', { jobId: '1' }), true)
})
