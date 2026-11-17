import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SingleTrialApproval } from '../tools/single-kyc-trial.contract';
import { evaluateTrialGates, TrialGate } from './single-kyc-trial.gates';
import { singleTrialCallbackIsHeld, SINGLE_KYC_TRIAL } from './single-kyc-trial.scope';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const expected = {
  planSha256: 'p'.repeat(64),
  sourceSqlSha256: 's'.repeat(64),
  claimSqlSha256: 'c'.repeat(64),
};
const complete = (): SingleTrialApproval => ({
  approvedBy: 'Named Approver',
  approvedAt: '2026-11-17T11:45:00Z',
  planSha256: expected.planSha256,
  sourceSqlSha256: expected.sourceSqlSha256,
  claimSqlSha256: expected.claimSqlSha256,
  sourceReference: 'Finexta mail 17/11 CIF join',
  cifSourceAndJoinVerified: true,
  cifAvailableBeforeSubmission: true,
  oldAndCifIdentitiesAbsent: true,
  reisIdentityCheckReference: 'Vneuron ticket 123',
  isolatedOracleClaimTestReference: 'isolated run 7/7 passed',
  cleanPendingBlockedContractReference: 'Finexta DDL + consumer confirmation',
  exactRevisionCallbackRoutingReference: 'Vneuron revision answer Q-V3',
  pollingAndOtherSendersStopped: true,
  backupsVerified: true,
  rejectToBlockedApproved: false,
});
const gates = (
  over: Partial<Parameters<typeof evaluateTrialGates>[0]> = {},
  approval = complete(),
) =>
  evaluateTrialGates({
    vocabulary: 'clean-pending-blocked',
    pollEnabled: false,
    approval,
    expected,
    now: NOW,
    ...over,
  });

describe('conditions to lift the two single-trial gates (reported, never lifted here)', () => {
  it('everything satisfied: nothing unmet (a REVIEWED change may then lift the gates)', () => {
    expect(gates()).toEqual({ unmet: [], mayBeLiftedByReviewedChange: true });
  });

  it('the defaults are far from satisfied: every condition is listed for the operator', () => {
    const r = evaluateTrialGates({ vocabulary: 'approved-blocked', pollEnabled: false });
    expect(r.unmet).toEqual(['VOCABULARY_NOT_CLEAN_PENDING_BLOCKED', 'APPROVAL_MISSING']);
    expect(r.mayBeLiftedByReviewedChange).toBe(false);
  });

  it.each<
    [
      TrialGate,
      (a: SingleTrialApproval) => void,
      Partial<Parameters<typeof evaluateTrialGates>[0]>?,
    ]
  >([
    ['VOCABULARY_NOT_CLEAN_PENDING_BLOCKED', () => undefined, { vocabulary: 'approved-blocked' }],
    ['POLLING_ENABLED', () => undefined, { pollEnabled: true }],
    ['APPROVAL_STALE_OR_INVALID', (a) => void (a.approvedAt = '2026-11-17T10:00:00Z')],
    ['APPROVAL_STALE_OR_INVALID', (a) => void (a.approvedAt = '2026-11-18T10:00:00Z')],
    ['APPROVAL_STALE_OR_INVALID', (a) => void (a.approvedBy = '  ')],
    ['EVIDENCE_HASH_MISMATCH', (a) => void (a.planSha256 = 'x')],
    ['EVIDENCE_HASH_MISMATCH', (a) => void (a.sourceSqlSha256 = 'x')],
    ['EVIDENCE_HASH_MISMATCH', (a) => void (a.claimSqlSha256 = 'x')],
    [
      'FINEXTA_STATUS_CONTRACT_REFERENCE_MISSING',
      (a) => void (a.cleanPendingBlockedContractReference = ''),
    ],
    [
      'ORACLE_CLAIM_TEST_REFERENCE_MISSING',
      (a) => void (a.isolatedOracleClaimTestReference = 'n/a'),
    ],
    ['CIF_SOURCE_NOT_VERIFIED', (a) => void (a.cifSourceAndJoinVerified = false)],
    ['CIF_SOURCE_NOT_VERIFIED', (a) => void (a.sourceReference = '')],
    ['CIF_NOT_AVAILABLE_BEFORE_SUBMISSION', (a) => void (a.cifAvailableBeforeSubmission = false)],
    ['REIS_IDENTITIES_NOT_CHECKED', (a) => void (a.oldAndCifIdentitiesAbsent = false)],
    ['REIS_IDENTITIES_NOT_CHECKED', (a) => void (a.reisIdentityCheckReference = '')],
    [
      'CALLBACK_ROUTING_REFERENCE_MISSING',
      (a) => void (a.exactRevisionCallbackRoutingReference = ''),
    ],
    ['SENDERS_NOT_STOPPED', (a) => void (a.pollingAndOtherSendersStopped = false)],
    ['BACKUPS_NOT_VERIFIED', (a) => void (a.backupsVerified = false)],
    [
      'REJECT_MAPPING_NOT_DECIDED',
      (a) => void delete (a as Partial<SingleTrialApproval>).rejectToBlockedApproved,
    ],
  ])('losing exactly one condition is reported alone: %s', (gate, mutate, extra = {}) => {
    const a = complete();
    mutate(a);
    const r = gates(extra, a);
    expect(r.unmet).toEqual([gate]);
    expect(r.mayBeLiftedByReviewedChange).toBe(false);
  });

  it('REJECT may be approved either way, but the decision must be explicit', () => {
    expect(gates({}, { ...complete(), rejectToBlockedApproved: true }).unmet).toEqual([]);
    expect(gates({}, { ...complete(), rejectToBlockedApproved: false }).unmet).toEqual([]);
  });

  it('a satisfied list does NOT lift anything: the quarantine and the CLI refusal are still in the code', () => {
    expect(gates().mayBeLiftedByReviewedChange).toBe(true);
    expect(singleTrialCallbackIsHeld(SINGLE_KYC_TRIAL.expectedCif)).toBe(true);
    expect(singleTrialCallbackIsHeld(SINGLE_KYC_TRIAL.kycRefNo)).toBe(true);
    const cli = readFileSync(join(__dirname, '..', 'tools', 'run-single-kyc-trial.ts'), 'utf8');
    expect(cli).toContain('EXACT_REVISION_CALLBACK_ROUTE_NOT_IMPLEMENTED');
    const webhook = readFileSync(
      join(__dirname, '..', 'webhook', 'customer-status.service.ts'),
      'utf8',
    );
    expect(webhook).toContain('SINGLE_TRIAL_CALLBACK_QUARANTINED');
  });
});
