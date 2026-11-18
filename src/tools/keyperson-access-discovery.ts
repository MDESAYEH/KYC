import { SqlBinds } from '../flexcube/staging/flexcube-staging';
import { DiscoveryQuery } from './status-contract-discovery';

/**
 * READ-ONLY queries for two open questions found by the UAT1 discovery (17/11/2026). Nothing has been
 * assumed: these queries only produce evidence, and none returns names, identifiers or document numbers.
 *
 * Part "keyperson": KYC_KEYPERSON_TYPE exists in STTM_KYC_CORP_KEYPERSONS_CUSTOM and NOT in
 * STTM_KYC_CORP_KEYPERSONS. What are its real values, does the CUSTOM row exist for every key person,
 * and how does it relate to OWNERSHIP_TYPE (EVIDENCE ONLY: OWNERSHIP_TYPE is never used as a substitute)?
 *
 * Part "access": the account sees no CUSTOMER / CIF object. ALL_* dictionary views list only objects the
 * account may use, so "not visible" is not "does not exist". These queries show what IS visible and which
 * grants the account holds; the DBA_* variant only works for a DBA and is meant for Finexta.
 */
export function keypersonDiscoveryQueries(options: {
  owner: string;
  maxRows?: number;
}): DiscoveryQuery[] {
  const maxRows = options.maxRows ?? 200;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 500) {
    throw new Error('maxRows must be an integer from 1 to 500');
  }
  if (!/^[A-Z][A-Z0-9_$#]{0,127}$/.test(options.owner)) {
    throw new Error('owner must be an exact upper-case Oracle dictionary name');
  }
  // the owner is validated above and never comes from data; table names are constants
  const kp = `${options.owner}.STTM_KYC_CORP_KEYPERSONS`;
  const cu = `${options.owner}.STTM_KYC_CORP_KEYPERSONS_CUSTOM`;
  const b: SqlBinds = { ownerName: options.owner };
  return [
    {
      name: 'keypersonColumns',
      purpose:
        'Columns of both key-person tables: where do KYC_KEYPERSON_TYPE and OWNERSHIP_TYPE live?',
      sql: `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE
              FROM ALL_TAB_COLUMNS
             WHERE OWNER = :ownerName
               AND TABLE_NAME IN ('STTM_KYC_CORP_KEYPERSONS', 'STTM_KYC_CORP_KEYPERSONS_CUSTOM')
               AND (COLUMN_NAME LIKE '%TYPE%' OR COLUMN_NAME LIKE '%OWNER%' OR COLUMN_NAME IN ('KYC_REF_NO', 'KYC_ID', 'NAME', 'RELATIONSHIP'))
             ORDER BY TABLE_NAME, COLUMN_NAME`,
      binds: b,
    },
    {
      name: 'keypersonTypeValues',
      purpose:
        'Distinct values of KYC_KEYPERSON_TYPE in the CUSTOM table with counts (no identifiers).',
      sql: `SELECT KYC_KEYPERSON_TYPE, COUNT(*) AS N FROM ${cu}
             GROUP BY KYC_KEYPERSON_TYPE ORDER BY N DESC FETCH FIRST :maxRows ROWS ONLY`,
      binds: { maxRows },
    },
    {
      name: 'keypersonJoinIntegrity',
      purpose:
        'Does every key person have exactly one CUSTOM row on KYC_REF_NO + KYC_ID + NAME? Counts only.',
      sql: `SELECT (SELECT COUNT(*) FROM ${kp}) AS KEYPERSONS,
                    (SELECT COUNT(*) FROM ${cu}) AS CUSTOM_ROWS,
                    (SELECT COUNT(*) FROM ${kp} k WHERE NOT EXISTS (SELECT 1 FROM ${cu} c
                       WHERE c.KYC_REF_NO = k.KYC_REF_NO AND c.KYC_ID = k.KYC_ID AND c.NAME = k.NAME)) AS WITHOUT_CUSTOM,
                    (SELECT COUNT(*) FROM ${cu} c WHERE NOT EXISTS (SELECT 1 FROM ${kp} k
                       WHERE c.KYC_REF_NO = k.KYC_REF_NO AND c.KYC_ID = k.KYC_ID AND c.NAME = k.NAME)) AS CUSTOM_WITHOUT_KEYPERSON,
                    (SELECT COUNT(*) FROM (SELECT KYC_REF_NO, KYC_ID, NAME FROM ${cu}
                       GROUP BY KYC_REF_NO, KYC_ID, NAME HAVING COUNT(*) > 1)) AS DUPLICATE_CUSTOM_KEYS
               FROM DUAL`,
      binds: {},
    },
    {
      name: 'keypersonTypeVersusOwnershipType',
      purpose:
        'EVIDENCE ONLY: cross-tab of KYC_KEYPERSON_TYPE (CUSTOM) with OWNERSHIP_TYPE (key persons) and RELATIONSHIP. OWNERSHIP_TYPE is not a substitute for the party type.',
      sql: `SELECT c.KYC_KEYPERSON_TYPE, k.OWNERSHIP_TYPE, k.RELATIONSHIP, COUNT(*) AS N
              FROM ${kp} k JOIN ${cu} c
                ON c.KYC_REF_NO = k.KYC_REF_NO AND c.KYC_ID = k.KYC_ID AND c.NAME = k.NAME
             GROUP BY c.KYC_KEYPERSON_TYPE, k.OWNERSHIP_TYPE, k.RELATIONSHIP
             ORDER BY N DESC FETCH FIRST :maxRows ROWS ONLY`,
      binds: { maxRows },
    },
  ];
}

export function accessDiscoveryQueries(options: { maxRows?: number }): DiscoveryQuery[] {
  const maxRows = options.maxRows ?? 200;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 500) {
    throw new Error('maxRows must be an integer from 1 to 500');
  }
  return [
    {
      name: 'visibleCustomerObjects',
      purpose:
        'Objects named STTM_CUST% / %CUSTOMER% that the account can SEE (tables, views, synonyms). Not visible does not mean not existing.',
      sql: `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS
             WHERE OBJECT_TYPE IN ('TABLE', 'VIEW', 'SYNONYM')
               AND (OBJECT_NAME LIKE 'STTM\\_CUST%' ESCAPE '\\' OR OBJECT_NAME LIKE '%CUSTOMER%')
             ORDER BY OWNER, OBJECT_NAME FETCH FIRST :maxRows ROWS ONLY`,
      binds: { maxRows },
    },
    {
      name: 'grantsOnKycAndCustomerObjects',
      purpose:
        'Grants the account holds on STTM_KYC% and STTM_CUST% objects (grantee, privilege, table only): shows which objects were granted and which were not.',
      sql: `SELECT TABLE_SCHEMA, TABLE_NAME, PRIVILEGE, GRANTEE, GRANTOR
              FROM ALL_TAB_PRIVS
             WHERE TABLE_NAME LIKE 'STTM\\_KYC%' ESCAPE '\\' OR TABLE_NAME LIKE 'STTM\\_CUST%' ESCAPE '\\'
             ORDER BY TABLE_NAME, PRIVILEGE FETCH FIRST :maxRows ROWS ONLY`,
      binds: { maxRows },
    },
    {
      name: 'triggerTableColumns',
      purpose:
        'Columns of the trigger table STTM_CUSTOMER_CUSTOM agreed with Finexta (CUSTOMER_NO, KYC_REF_NO, READY_TO_SCAN expected): is there a date or version column?',
      sql: `SELECT OWNER, TABLE_NAME, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE
              FROM ALL_TAB_COLUMNS
             WHERE TABLE_NAME = 'STTM_CUSTOMER_CUSTOM'
             ORDER BY OWNER, COLUMN_ID FETCH FIRST :maxRows ROWS ONLY`,
      binds: { maxRows },
    },
    {
      name: 'triggerTableStatusCounts',
      purpose:
        'Counts of READY_TO_SCAN values in STTM_CUSTOMER_CUSTOM (U / P expected): is the table backfilled with old customers? Counts only, no identifiers.',
      sql: `SELECT READY_TO_SCAN, COUNT(*) AS N FROM STTM_CUSTOMER_CUSTOM
             GROUP BY READY_TO_SCAN ORDER BY N DESC FETCH FIRST :maxRows ROWS ONLY`,
      binds: { maxRows },
    },
    {
      name: 'dbaCustomerObjects',
      purpose:
        'DBA-ONLY (expected ORA-00942 for this account; run by Finexta): do STTM_CUST% objects exist and in which schema?',
      sql: `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE FROM DBA_OBJECTS
             WHERE OBJECT_TYPE IN ('TABLE', 'VIEW', 'SYNONYM') AND OBJECT_NAME LIKE 'STTM\\_CUST%' ESCAPE '\\'
             ORDER BY OWNER, OBJECT_NAME FETCH FIRST :maxRows ROWS ONLY`,
      binds: { maxRows },
    },
  ];
}
