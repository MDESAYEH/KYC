-- PREPARATION ONLY: no query has been run against Oracle.
-- All statements query Oracle dictionary views only; no business data or DDL/DML.
-- Use bind-aware tooling. Bind :ownerName and :tableName to exact metadata names (or NULL),
-- :maxRows to 100 (max 500), :nameFragment to CIF, CUSTOMER, then KYC in separate runs.
-- A name match is a candidate, not a verified CIF source. No automatic data joins or DB-link traversal.
-- Result limit is per query; if reached, narrow the owner/table and repeat.

-- columns
SELECT c.OWNER, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE,
                   c.DATA_LENGTH, c.CHAR_LENGTH, c.NULLABLE, cc.COMMENTS
              FROM ALL_TAB_COLUMNS c
              LEFT JOIN ALL_COL_COMMENTS cc ON cc.OWNER = c.OWNER
               AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME
             WHERE (:ownerName IS NULL OR c.OWNER = :ownerName)
               AND (:tableName IS NULL OR c.TABLE_NAME = :tableName)
               AND (INSTR(UPPER(c.COLUMN_NAME), UPPER(:nameFragment)) > 0
                 OR INSTR(UPPER(cc.COMMENTS), UPPER(:nameFragment)) > 0)
             ORDER BY c.OWNER, c.TABLE_NAME, c.COLUMN_ID
             FETCH FIRST :maxRows ROWS ONLY;

-- keys
SELECT c.OWNER, c.TABLE_NAME, c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE,
                   c.STATUS, c.VALIDATED, k.COLUMN_NAME, k.POSITION
              FROM ALL_CONSTRAINTS c
              JOIN ALL_CONS_COLUMNS k ON k.OWNER = c.OWNER
               AND k.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND k.TABLE_NAME = c.TABLE_NAME
             WHERE c.CONSTRAINT_TYPE IN ('P', 'U')
               AND (:ownerName IS NULL OR c.OWNER = :ownerName)
               AND (:tableName IS NULL OR c.TABLE_NAME = :tableName)
             ORDER BY c.OWNER, c.TABLE_NAME, c.CONSTRAINT_NAME, k.POSITION
             FETCH FIRST :maxRows ROWS ONLY;

-- foreignKeys
SELECT fk.OWNER, fk.TABLE_NAME, fc.COLUMN_NAME, fc.POSITION,
                   fk.CONSTRAINT_NAME, fk.STATUS, fk.VALIDATED,
                   pk.OWNER AS TARGET_OWNER, pk.TABLE_NAME AS TARGET_TABLE,
                   pc.COLUMN_NAME AS TARGET_COLUMN
              FROM ALL_CONSTRAINTS fk
              JOIN ALL_CONS_COLUMNS fc ON fc.OWNER = fk.OWNER
               AND fc.CONSTRAINT_NAME = fk.CONSTRAINT_NAME AND fc.TABLE_NAME = fk.TABLE_NAME
              JOIN ALL_CONSTRAINTS pk ON pk.OWNER = fk.R_OWNER
               AND pk.CONSTRAINT_NAME = fk.R_CONSTRAINT_NAME
              JOIN ALL_CONS_COLUMNS pc ON pc.OWNER = pk.OWNER
               AND pc.CONSTRAINT_NAME = pk.CONSTRAINT_NAME AND pc.TABLE_NAME = pk.TABLE_NAME
               AND pc.POSITION = fc.POSITION
             WHERE fk.CONSTRAINT_TYPE = 'R'
               AND (:ownerName IS NULL OR fk.OWNER = :ownerName OR pk.OWNER = :ownerName)
               AND (:tableName IS NULL OR fk.TABLE_NAME = :tableName OR pk.TABLE_NAME = :tableName)
             ORDER BY fk.OWNER, fk.TABLE_NAME, fk.CONSTRAINT_NAME, fc.POSITION
             FETCH FIRST :maxRows ROWS ONLY;

-- synonyms
SELECT OWNER, SYNONYM_NAME, TABLE_OWNER, TABLE_NAME, DB_LINK
              FROM ALL_SYNONYMS
             WHERE (:ownerName IS NULL OR OWNER = :ownerName OR TABLE_OWNER = :ownerName)
               AND (:tableName IS NULL OR TABLE_NAME = :tableName OR SYNONYM_NAME = :tableName)
             ORDER BY OWNER, SYNONYM_NAME
             FETCH FIRST :maxRows ROWS ONLY;
