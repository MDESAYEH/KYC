# CIF identity preparation and submission hold — 17 November 2026

Status: **partially implemented, NOT ready for UAT1 deployment or sending**.
Baseline: `cf56f0cbea9347da6a8fdf76db0fbbaaeba5d27b`. Work is uncommitted on
`feature/reis-cif-identity-preparation`. No Oracle, REIS or deployment action was performed.

## A. Current state and identity inventory

The new business rule is **primary REIS systemId = FLEXCUBE CIF**, with `KYC_REF_NO` retained
as an internal KYC reference. It supersedes historical statements that required systemId = KYC_REF_NO.
No identifier fallback, invented CIF, automatic identity merge or historical requeue is permitted.

| Area / source | Historical behavior and consequence for CIF |
| --- | --- |
| `flexcube/source/flexcube-kyc.queries.ts`, `flexcube-kyc-source.ts` | Individual/corporate detail SQL selects no verified CIF; neither loader populates CUSTOMER_NO. No guessed SQL has been added. |
| `flexcube/dto/flexcube-customer.request.ts`, `flexcube-to-canonical.mapper.ts` | Optional CUSTOMER_NO maps to nullable customerNo, separately from required KYC_REF_NO. This DTO name does not verify the Oracle source. |
| `canonical/canonical-kyc-customer.ts` | customerNo is the candidate CIF concept; kycRefNo remains internal. |
| `reis/canonical-to-reis.transformer.ts`, `reis/dto/` | Historical transformer sets primary systemId from kycRefNo. Retained as field-mapping baseline, NOT approved for sending. Offline CIF preview overrides only the primary envelope identity. Configured systemName is preserved. |
| `kyc/kyc.workflow.ts` | Historical workflow asserts systemId = KYC_REF_NO, creates/reopens one local case and sends. It is no longer the application KYC_WORKFLOW provider. Existing direct-construction tests are explicitly baseline regressions. |
| `kyc/kyc.module.ts`, `flexcube-sync/flexcube-sync.module.ts` | Active application entry is the fail-closed CIF hold; polling enabled with this hold is rejected before constructing the source/service. No environment changes. |
| `persistence/kyc-case.ts`, entity, repository, migrations | Unique indexes exist on kyc_ref_no AND reis_system_id. Repository create defaults to kycRefNo if systemId is omitted: historical semantics, not a CIF fallback to be reused. No migration was introduced or executed. |
| `persistence/typeorm-kyc-case.repository.ts` amendments | A higher seqNo reopens the SAME case, clearing submission/final fields. It retains the existing identity. A pure assignment change could send a new identity while persisting the old one. |
| `webhook/customer-status.service.ts`, DTO, webhook repositories | Callback resolves the exact persisted reis_system_id, then writes back using the case's kycRefNo. No fuzzy lookup by names/customer numbers. Historical identifiers are not automatically translated into CIF. |
| `flexcube/staging/staging-submission.repository.ts` | INSERT/claim/complete/failure/recovery remain keyed by KYC_REF_NO + SEQ_NO, with UUID MSGID. No CIF substitution or staging-row migration. |
| `flexcube/staging/staging-flexcube-status-updater.ts` | Final status targets MAX(SEQ_NO) for that KYC. This can misroute a late callback after reopening a case. A submission-specific status-update contract is needed before CIF amendments. |
| `flexcube/flexcube-to-canonical.mapper.ts` related persons | Related identity remains company KYC_REF_NO + '-' + KYC_ID; parentKycRefNo still checks the original KYC. Preview rejects primary-CIF/relation collisions. Global uniqueness and stability across different KYC references remain unconfirmed. |
| `operations/` recovery and operational queries | Recovery uses persisted case KYC/customer values, not a guessed CIF lookup. Existing identifier-bearing operational summaries must be access controlled; no customer IDs were added to logs. |
| `tools/sqlite-local-evidence.ts`, reconciliation tools | Legacy callback lookup is by KYC reference, not an independently verified KYC-to-CIF alias set. Cannot prove non-delivery under CIF. Do NOT use these tools to reconcile CIF identities or to restore the 58 E rows. |

## B. Authoritative CIF source and timing: unresolved

No confirmed owner/table/column/join, cardinality or business lifecycle has been established.
The repository's older `confirmed-vs-tbd.md` and `external-decisions-required.md` record that
CUSTOMER_NO is unavailable at initial submission and is linked during customer creation; other
notes leave submission-time availability open. The new request establishes the desired identity,
but does not resolve that contradictory timing evidence.

If CIF is only created AFTER REIS approval, initial onboarding under CIF is a circular dependency.
Finexta/Bank must approve earlier CIF allocation/reservation, a later trigger, or a different
explicit lifecycle. Do not substitute KYC_REF_NO or fabricate a temporary number.

### Read-only discovery, prepared but NOT executed

`cif-source-discovery.sql` contains four SELECTs, generated from
`src/tools/cif-source-discovery.ts`, with binds validated by the existing Oracle bind guard:

1. Columns, data types, lengths, nullability and comments, searched by a bound literal fragment.
2. Primary/unique key columns, with constraint status and validation state.
3. Foreign-key links including both owners and matching composite-key positions.
4. Synonym owner, target and DB link metadata; no DB link is followed.

Use bind-aware approved tooling with ownerName/tableName = NULL initially, nameFragment = CIF,
then CUSTOMER, then KYC in separate column-search runs, and maxRows = 100 (hard maximum 500 in
the builder). After finding candidates, repeat keys/FKs/synonyms with the exact case-sensitive
owner/table names returned by metadata. The search is case-insensitive; the identifiers are bound,
never concatenated. If a result reaches the cap, narrow the search; it is not a complete inventory.

These SELECTs expose only metadata accessible to the current user. Empty results do not prove
absence; privileges, synonyms, remote targets, views, or naming may hide the source. A matching
column name or FK is evidence to discuss with Finexta, not confirmation of business meaning.
No business-data lookup or inferred join has been supplied. Timing cannot be proved from a column
name or nullability. Numeric storage also does not tell us how leading zeros should be rendered.

Oracle dictionary references: [ALL_CONSTRAINTS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_CONSTRAINTS.html)
and [ALL_CONS_COLUMNS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_CONS_COLUMNS.html).
These document the constraint metadata; compatibility of the prepared SQL with the bank's Oracle
version, permissions and real schema is still untested.

## C. Implemented preparation

- `reis/cif-identity.ts`: typed MISSING_CIF / INVALID_CIF errors; accepts one nonblank string,
  trims boundary whitespace, preserves leading zeros, refuses numbers/objects/multiple values.
  No approved bank CIF format exists, so no numeric-only pattern, padding or guessed length is applied.
- `reis/cif-onboarding-preview.ts`: offline payload preview using existing mappings, with primary
  systemId = customerNo, unchanged systemName, unchanged canonical KYC and related identities.
  Returns `{submissionAllowed:false, sourceVerified:false, request:...}`, deliberately not a client
  request object. Not registered in Nest and has no sending/persistence dependency.
- `kyc/cif-submission-hold.workflow.ts`: active KYC_WORKFLOW rejects missing/invalid CIF and holds
  valid CIF as CIF_CUTOVER_NOT_APPROVED. It creates no case and calls no client. No config bypass.
- Enabled polling with the hold fails before source/staging service construction. Disabled polling
  stays inert. This does not change deployed settings or disable historical callback processing.
- Canonical/DTO comments and documentation clearly mark historical KYC_REF_NO identity claims as
  superseded. Existing Oracle source, staging SQL, reconciliation behavior and database schema are unchanged.

## D. Identity integrity and unresolved contracts

The same CIF produces the same primary identity in repeated offline previews, even for different
KYC references. That is not authorization to submit: source data could be wrong, or several valid
KYC revisions might refer to one customer. The current unique reis_system_id index refuses a second
local KYC case with the same CIF; it has NOT been weakened or repurposed.

Before sending, distinguish a stable customer identity from separate KYC submission/revision identity.
Vneuron must confirm existing-customer update semantics and how a callback identifies the specific
submission. A callback carrying CIF and status alone cannot distinguish two revisions of one customer;
REIS customerId is a customer identifier too, not automatically a revision token. Sequential sends
alone do not rule out a delayed duplicate from a previous revision. Do not reopen/requeue until resolved.

Persisted legacy identities remain unchanged. Before sending CIF for an existing customer, Bank/Vneuron
must inventory old KYC-reference identities and approve a verifiable alias/migration/reconciliation
process (including late legacy callbacks and audit/rollback). REIS auto-merge is NOT assumed.
The local default identity rule and unique-case schema need deliberate replacement when that contract
is approved, not an automatic rewrite of existing cases or a guessed migration.

## E. Validation and limits

Local test results are recorded in the accompanying completion report. New tests cover CIF preview,
typed missing/invalid/ambiguous handling, leading zeros, stable identity across two KYC references,
related-party preservation/collision, read-only discovery binds, polling/submission holds, preservation
of 58 synthetic E rows, isolated CIF callback-to-KYC correlation and uniqueness/legacy boundaries.

The historical lifecycle suite explicitly overrides the application hold ONLY for its fake-server
baseline regressions. A separate current-application test exercises the held provider with no calls.
This is not evidence that the new CIF submission lifecycle is implemented or ready.

Not implemented/testable yet: verified Oracle CIF retrieval for individuals/corporates, official CIF
format, real source uniqueness, CIF existing-customer updates, approved amendment callback correlation,
real historical identity migration, or end-to-end bank behavior. The four real Oracle staging tests
still require an approved isolated schema and must not target UAT1/production.

## F. Required confirmations

**Finexta:** exact schema/table/view/column and data type; verified KYC_REF_NO-to-CIF join for both
customer types; expected cardinality and handling of duplicate/ambiguous matches; MOD_NO/history
semantics; whether CIF is available and committed before initial onboarding; CIF allocation timing
relative to REIS approval; documented string representation, leading zeros and any approved format;
authoritative update destination keyed to the correct KYC revision.

**Vneuron:** customer uniqueness scope (systemName/tenant/form), same-CIF update/upsert semantics,
different KYC records for one CIF, revision identifiers echoed in callbacks, delayed/duplicate callbacks,
old-to-new identity migration/alias and rollback procedure, relation identity namespace and stability.

**Bank IT/business:** approve those contracts and any lifecycle change, provide one explicitly authorized
synthetic UAT customer, reconcile any old REIS identity before new submission, and keep polling disabled.

## G. Deployment readiness

**Not ready for UAT1 cutover or deployment as a working CIF integration.** This local preparation
deliberately holds submissions. No Oracle or REIS calls were made, no 58-row repair was run, no
environment/credential/service setting was edited, and no commit, push, merge or deployment was done.

## H. Later single-record verification (requires separate authorization)

1. Obtain written source/timing/identity/callback/migration decisions. Resolve any circular dependency.
2. Validate confirmed SQL against an isolated Oracle fixture/schema, including 0/1/multiple matches,
   both customer types, revisions and leading-zero representation. Obtain local tests for the complete
   new submission lifecycle before replacing the hold; do not simply remove it or wire the legacy workflow.
3. Reconcile legacy identities with Vneuron and approve audit/rollback. Do not change the 58 E rows.
4. Keep polling disabled. Capture protected consistent local backups and read-only evidence for ONE
   authorized record, its KYC_REF_NO/MOD_NO/CIF and the absence/migration of an old REIS identity.
5. Preview locally and review the payload under restricted access; identifiers/payloads never go to logs.
6. After explicit permission, use a controlled single-record path (not a batch poll/reconciliation requeue).
   Verify stable CIF systemId, original KYC_REF_NO/SEQ_NO/MSGID staging keys and one local submission.
7. Verify immediate/final status and an authenticated, revision-correlated callback update ONLY the
   authorized staging revision. Test a duplicate/late callback in the isolated environment first.
8. Compare before/after counts and protected audit evidence; stop on ambiguity. No automatic resend,
   historic repair, polling enablement or rollout follows a successful test.

## Changed-file inventory

- `CLAUDE.md`
- `README.md`
- `docs/cif-source-discovery.sql`
- `docs/confirmed-vs-tbd.md`
- `docs/customer-status-webhook.md`
- `docs/external-decisions-required.md`
- `docs/flexcube-inbound-contract-draft.md`
- `docs/flexcube-sync.md`
- `docs/persistence.md`
- `docs/reis-cif-identity.md`
- `docs/transformation.md`
- `docs/uat-readiness.md`
- `docs/workflow.md`
- `src/canonical/canonical-kyc-customer.ts`
- `src/flexcube-sync/flexcube-sync.module.ts`
- `src/flexcube/dto/flexcube-customer.request.ts`
- `src/kyc/cif-submission-hold.workflow.spec.ts`
- `src/kyc/cif-submission-hold.workflow.ts`
- `src/kyc/kyc-submission.result.ts`
- `src/kyc/kyc.module.ts`
- `src/reis/canonical-to-reis.transformer.ts`
- `src/reis/cif-identity.ts`
- `src/reis/cif-onboarding-preview.spec.ts`
- `src/reis/cif-onboarding-preview.ts`
- `src/tools/cif-source-discovery.spec.ts`
- `src/tools/cif-source-discovery.ts`
- `test/app.e2e.spec.ts`
- `test/app.module.spec.ts`
- `test/cif-correlation.integration.spec.ts`
- `test/customer-lifecycle.integration.spec.ts`

## Final local validation

Full Jest run: **1020 passed, 0 failed, 4 skipped**, 48 suites passed and one skipped (1024 tests total).
Lint, TypeScript no-emit checking and build passed. The skipped suite is the real Oracle staging
integration suite, not an end-to-end CIF check. No source SQL was run against Oracle.
