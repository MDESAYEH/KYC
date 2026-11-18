-- READ-ONLY DISCOVERY FOR UAT1 (dictionary views only). PREPARED FOR REVIEW: NOT RUN.
-- Generated from src/tools/cif-source-discovery.ts and src/tools/status-contract-discovery.ts
-- (a test fails if this file and the code drift). Run with SELECT-only rights, bind-aware tooling.
-- Binds: :ownerName / :tableName exact dictionary names (upper case) or NULL where allowed,
--        :nameFragment (CIF, then CUSTOMER, then KYC in separate runs), :maxRows <= 500.
-- Nothing here returns customer data: metadata, trigger/consumer code lines, and one grouped COUNT.
-- See docs/uat1-readonly-discovery-runbook.md for what to run, in which order, and how to read it.

-- ===== PART A: where does the CIF live? (candidates only, never a verified source) =====

-- A:columns
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

-- A:keys
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

-- A:foreignKeys
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

-- A:synonyms
SELECT OWNER, SYNONYM_NAME, TABLE_OWNER, TABLE_NAME, DB_LINK
              FROM ALL_SYNONYMS
             WHERE (:ownerName IS NULL OR OWNER = :ownerName OR TABLE_OWNER = :ownerName)
               AND (:tableName IS NULL OR TABLE_NAME = :tableName OR SYNONYM_NAME = :tableName)
             ORDER BY OWNER, SYNONYM_NAME
             FETCH FIRST :maxRows ROWS ONLY;

-- ===== PART B: what does REIS_FINAL_STATUS accept and who reads it? (owner = the staging table owner) =====

-- B:statusColumn - Type, length, nullability and default of REIS_FINAL_STATUS and PROCESS_STATUS.
SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, CHAR_LENGTH, NULLABLE, DATA_DEFAULT
              FROM ALL_TAB_COLUMNS
             WHERE OWNER = :ownerName AND TABLE_NAME = :tableName
               AND COLUMN_NAME IN ('REIS_FINAL_STATUS', 'PROCESS_STATUS')
             ORDER BY COLUMN_NAME;

-- B:checkConstraints - Every CHECK constraint of the table: which values may PROCESS_STATUS / REIS_FINAL_STATUS hold, and is it enabled and validated.
SELECT c.CONSTRAINT_NAME, c.STATUS, c.VALIDATED, k.COLUMN_NAME, c.SEARCH_CONDITION
              FROM ALL_CONSTRAINTS c
              LEFT JOIN ALL_CONS_COLUMNS k ON k.OWNER = c.OWNER
               AND k.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND k.TABLE_NAME = c.TABLE_NAME
             WHERE c.OWNER = :ownerName AND c.TABLE_NAME = :tableName AND c.CONSTRAINT_TYPE = 'C'
             ORDER BY c.CONSTRAINT_NAME, k.POSITION
             FETCH FIRST :maxRows ROWS ONLY;

-- B:triggers - Triggers on the table (they can reject or rewrite a status even when the CHECK allows it).
SELECT TRIGGER_NAME, TRIGGER_TYPE, TRIGGERING_EVENT, STATUS, COLUMN_NAME, WHEN_CLAUSE
              FROM ALL_TRIGGERS
             WHERE TABLE_OWNER = :ownerName AND TABLE_NAME = :tableName
             ORDER BY TRIGGER_NAME
             FETCH FIRST :maxRows ROWS ONLY;

-- B:triggerCodeMentioningTheColumns - Only the trigger source LINES that mention REIS_FINAL_STATUS or PROCESS_STATUS (the validation rules).
SELECT s.NAME, s.LINE, s.TEXT
              FROM ALL_SOURCE s
              JOIN ALL_TRIGGERS g ON g.OWNER = s.OWNER AND g.TRIGGER_NAME = s.NAME
             WHERE s.TYPE = 'TRIGGER' AND g.TABLE_OWNER = :ownerName AND g.TABLE_NAME = :tableName
               AND (UPPER(s.TEXT) LIKE '%REIS_FINAL_STATUS%' OR UPPER(s.TEXT) LIKE '%PROCESS_STATUS%')
             ORDER BY s.NAME, s.LINE
             FETCH FIRST :maxRows ROWS ONLY;

-- B:consumers - Database objects (views, procedures, packages, triggers) that reference the staging table: where FLEXCUBE logic may read it.
SELECT d.OWNER, d.NAME, d.TYPE
              FROM ALL_DEPENDENCIES d
             WHERE d.REFERENCED_OWNER = :ownerName AND d.REFERENCED_NAME = :tableName
               AND d.REFERENCED_TYPE = 'TABLE'
             ORDER BY d.OWNER, d.TYPE, d.NAME
             FETCH FIRST :maxRows ROWS ONLY;

-- B:consumerCodeMentioningTheStatus - Source lines of those objects that mention REIS_FINAL_STATUS: how the value is READ (CLEAN / PENDING / BLOCKED / APPROVED?).
SELECT s.OWNER, s.NAME, s.TYPE, s.LINE, s.TEXT
              FROM ALL_SOURCE s
              JOIN ALL_DEPENDENCIES d ON d.OWNER = s.OWNER AND d.NAME = s.NAME AND d.TYPE = s.TYPE
             WHERE d.REFERENCED_OWNER = :ownerName AND d.REFERENCED_NAME = :tableName
               AND d.REFERENCED_TYPE = 'TABLE'
               AND UPPER(s.TEXT) LIKE '%REIS_FINAL_STATUS%'
             ORDER BY s.OWNER, s.NAME, s.TYPE, s.LINE
             FETCH FIRST :maxRows ROWS ONLY;

-- B:tableDdl - The exact DDL, to replay it in an ISOLATED schema (needs SELECT_CATALOG_ROLE; ORA-31603 means not granted).
SELECT DBMS_METADATA.GET_DDL('TABLE', :tableName, :ownerName) AS DDL FROM DUAL;

-- B:statusDistribution - Counts of values already stored in REIS_FINAL_STATUS (no identifiers). The table name cannot be a bind: it was validated.
SELECT NVL(REIS_FINAL_STATUS, '(null)') AS REIS_FINAL_STATUS, COUNT(*) AS N
              FROM REIS_KYC.STTM_KYC_REIS_PAYLOAD_CUSTOM
             GROUP BY REIS_FINAL_STATUS
             ORDER BY 1;

-- ===== PART D: key-person type column (evidence only, OWNERSHIP_TYPE is NOT a substitute) =====
-- Binds: :ownerName = OBPPRD (exact), :maxRows <= 500. In the SQL below the owner is written as OBPPRD.

-- D:keypersonColumns
-- Columns of both key-person tables: where do KYC_KEYPERSON_TYPE and OWNERSHIP_TYPE live?
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE
              FROM ALL_TAB_COLUMNS
             WHERE OWNER = :ownerName
               AND TABLE_NAME IN ('STTM_KYC_CORP_KEYPERSONS', 'STTM_KYC_CORP_KEYPERSONS_CUSTOM')
               AND (COLUMN_NAME LIKE '%TYPE%' OR COLUMN_NAME LIKE '%OWNER%' OR COLUMN_NAME IN ('KYC_REF_NO', 'KYC_ID', 'NAME', 'RELATIONSHIP'))
             ORDER BY TABLE_NAME, COLUMN_NAME;

-- D:keypersonTypeValues
-- Distinct values of KYC_KEYPERSON_TYPE in the CUSTOM table with counts (no identifiers).
SELECT KYC_KEYPERSON_TYPE, COUNT(*) AS N FROM OBPPRD.STTM_KYC_CORP_KEYPERSONS_CUSTOM
             GROUP BY KYC_KEYPERSON_TYPE ORDER BY N DESC FETCH FIRST :maxRows ROWS ONLY;

-- D:keypersonJoinIntegrity
-- Does every key person have exactly one CUSTOM row on KYC_REF_NO + KYC_ID + NAME? Counts only.
SELECT (SELECT COUNT(*) FROM OBPPRD.STTM_KYC_CORP_KEYPERSONS) AS KEYPERSONS,
                    (SELECT COUNT(*) FROM OBPPRD.STTM_KYC_CORP_KEYPERSONS_CUSTOM) AS CUSTOM_ROWS,
                    (SELECT COUNT(*) FROM OBPPRD.STTM_KYC_CORP_KEYPERSONS k WHERE NOT EXISTS (SELECT 1 FROM OBPPRD.STTM_KYC_CORP_KEYPERSONS_CUSTOM c
                       WHERE c.KYC_REF_NO = k.KYC_REF_NO AND c.KYC_ID = k.KYC_ID AND c.NAME = k.NAME)) AS WITHOUT_CUSTOM,
                    (SELECT COUNT(*) FROM OBPPRD.STTM_KYC_CORP_KEYPERSONS_CUSTOM c WHERE NOT EXISTS (SELECT 1 FROM OBPPRD.STTM_KYC_CORP_KEYPERSONS k
                       WHERE c.KYC_REF_NO = k.KYC_REF_NO AND c.KYC_ID = k.KYC_ID AND c.NAME = k.NAME)) AS CUSTOM_WITHOUT_KEYPERSON,
                    (SELECT COUNT(*) FROM (SELECT KYC_REF_NO, KYC_ID, NAME FROM OBPPRD.STTM_KYC_CORP_KEYPERSONS_CUSTOM
                       GROUP BY KYC_REF_NO, KYC_ID, NAME HAVING COUNT(*) > 1)) AS DUPLICATE_CUSTOM_KEYS
               FROM DUAL;

-- D:keypersonTypeVersusOwnershipType
-- EVIDENCE ONLY: cross-tab of KYC_KEYPERSON_TYPE (CUSTOM) with OWNERSHIP_TYPE (key persons) and RELATIONSHIP. OWNERSHIP_TYPE is not a substitute for the party type.
SELECT c.KYC_KEYPERSON_TYPE, k.OWNERSHIP_TYPE, k.RELATIONSHIP, COUNT(*) AS N
              FROM OBPPRD.STTM_KYC_CORP_KEYPERSONS k JOIN OBPPRD.STTM_KYC_CORP_KEYPERSONS_CUSTOM c
                ON c.KYC_REF_NO = k.KYC_REF_NO AND c.KYC_ID = k.KYC_ID AND c.NAME = k.NAME
             GROUP BY c.KYC_KEYPERSON_TYPE, k.OWNERSHIP_TYPE, k.RELATIONSHIP
             ORDER BY N DESC FETCH FIRST :maxRows ROWS ONLY;

-- ===== PART E: privileges versus naming (why is CUSTOMER / CIF not visible?) =====

-- E:visibleCustomerObjects
-- Objects named STTM_CUST% / %CUSTOMER% that the account can SEE (tables, views, synonyms). Not visible does not mean not existing.
SELECT OWNER, OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS
             WHERE OBJECT_TYPE IN ('TABLE', 'VIEW', 'SYNONYM')
               AND (OBJECT_NAME LIKE 'STTM\_CUST%' ESCAPE '\' OR OBJECT_NAME LIKE '%CUSTOMER%')
             ORDER BY OWNER, OBJECT_NAME FETCH FIRST :maxRows ROWS ONLY;

-- E:grantsOnKycAndCustomerObjects
-- Grants the account holds on STTM_KYC% and STTM_CUST% objects (grantee, privilege, table only): shows which objects were granted and which were not.
SELECT TABLE_SCHEMA, TABLE_NAME, PRIVILEGE, GRANTEE, GRANTOR
              FROM ALL_TAB_PRIVS
             WHERE TABLE_NAME LIKE 'STTM\_KYC%' ESCAPE '\' OR TABLE_NAME LIKE 'STTM\_CUST%' ESCAPE '\'
             ORDER BY TABLE_NAME, PRIVILEGE FETCH FIRST :maxRows ROWS ONLY;

-- E:dbaCustomerObjects
-- DBA-ONLY (expected ORA-00942 for this account; run by Finexta): do STTM_CUST% objects exist and in which schema?
SELECT OWNER, OBJECT_NAME, OBJECT_TYPE FROM DBA_OBJECTS
             WHERE OBJECT_TYPE IN ('TABLE', 'VIEW', 'SYNONYM') AND OBJECT_NAME LIKE 'STTM\_CUST%' ESCAPE '\'
             ORDER BY OWNER, OBJECT_NAME FETCH FIRST :maxRows ROWS ONLY;

-- E:triggerTableColumns
-- Columns of the trigger table STTM_CUSTOMER_CUSTOM agreed with Finexta (CUSTOMER_NO, KYC_REF_NO, READY_TO_SCAN expected): is there a date or version column?
SELECT OWNER, TABLE_NAME, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE
              FROM ALL_TAB_COLUMNS
             WHERE TABLE_NAME = 'STTM_CUSTOMER_CUSTOM'
             ORDER BY OWNER, COLUMN_ID FETCH FIRST :maxRows ROWS ONLY;

-- E:triggerTableStatusCounts
-- Counts of READY_TO_SCAN values in STTM_CUSTOMER_CUSTOM (U / P expected): is the table backfilled with old customers? Counts only, no identifiers.
SELECT READY_TO_SCAN, COUNT(*) AS N FROM STTM_CUSTOMER_CUSTOM
             GROUP BY READY_TO_SCAN ORDER BY N DESC FETCH FIRST :maxRows ROWS ONLY;
