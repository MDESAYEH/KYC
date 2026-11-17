import { SqlRow } from '../../src/flexcube/staging/flexcube-staging';
import { KycSubmissionResult } from '../../src/kyc/kyc-submission.result';

/** Cut-off used by the polling tests (every default MAKER_DT_STAMP of the fake is after it). */
export const SINCE = '2026-11-16';

/** Synthetic retail KYC detail row (STTM_KYC_RETAIL + _CUSTOM + OTHER_TYPES). */
export const INDIVIDUAL_ROW: SqlRow = {
  FIRST_NAME: ' Testfirst ',
  LAST_NAME: 'Testlast',
  BIRTH_DATE: new Date(1990, 0, 31),
  BIRTH_PLACE: null,
  PASSPORT_NO: 'P123',
  PASSPORT_EXPIRY_DATE: new Date(2030, 11, 1),
  PEP: 'N',
  RELATION_PEP: 'N',
  NATIONALITY: 'LY',
  LOCAL_ADDR_COUNTRY: 'LY',
  OCCUPATION: 'PRSE',
  ACC_PURPOSE: 'JOBS',
  RESIDENT: 'Y',
  FUNDS_SOURCE: 'BUSN',
  TOTAL_INCOME: 3000,
  ACCOUNT_MANAGER_LOGIN: 'amgr',
  ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
  DISTRIBUTION_CHANNEL: '00',
};

/** Synthetic corporate KYC detail row (STTM_KYC_CORPORATE + _CUSTOM). */
export const CORPORATE_ROW: SqlRow = {
  CRP_BUSINESS_NAME: 'Test Co',
  PARENT_CMPNY_COUNTRY: 'LY',
  LEGAL_ENTITY: 'LIMCO',
  ACTIVITY: 'COMM',
  ACC_PURPOSE: 'COMM',
  FUNDS_SOURCE: 'CCMP',
  ANNUAL_TURNOVER: 500000,
  PEP: 'N',
  ACCOUNT_MANAGER_LOGIN: 'amgr',
  ACCOUNT_MANAGER_EMAIL: 'amgr@example.test',
  DISTRIBUTION_CHANNEL: '00',
};

/** A workflow result: REIS answered. */
export const onboarded = (status = 'CLEAN'): KycSubmissionResult =>
  ({
    outcome: 'ONBOARDED',
    reisOnboardingStatus: status,
    kycCase: {},
    reisRequest: { systemId: 'X' },
    reisResponse: { status },
  }) as unknown as KycSubmissionResult;
