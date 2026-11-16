# Ordered implementation plan after external decisions are approved

**Status:** Planning only. The integration code remains frozen until
external decisions are answered and approved in writing. No delivery
dates are estimated here because the plan depends on responses, access
and the real REIS/FLEXCUBE UAT environments.

## Gate 0 - Close and record decisions

1.  Assign a named owner and due date to every open decision.
2.  Store the approved FLEXCUBE inbound contract, authentication choice,
    callback authentication mode, REIS schemas, status-code mapping and
    retry/idempotency rules.
3.  Confirm KYC-only scope and record AML/TFS exclusion unless
    separately approved.
4.  Keep unresolved questions visible; do not infer LOV meanings, field
    semantics or retry safety.

**Exit criteria:** all UAT-blocking decisions have written answers,
owners and approved values.

## Gate 1 - Reference data and source contracts

1.  Obtain the actual FLEXCUBE LOV extracts, including code plus
    description and source table/column for Account Purpose `203`, `204`
    and `210`.
2.  Approve all FLEXCUBE-to-REIS mappings:
    country/nationality/residence, profession, product,
    individual/corporate account purpose, legal entity, activity,
    channel, income source and document type.
3.  Confirm the final Individual and Corporate request examples,
    `product` cardinality, country-field semantics, `tin`/`nid` rules,
    account-manager values, income multi-selection rule and Corporate
    relation model.
4.  Decide KYC version identity: new `KYC_REF_NO` per amendment or a
    documented version key if references can be reused.
5.  Decide and document the mapping-data loading, validation, approval,
    audit/versioning, promotion and rollback process.

**Exit criteria:** complete approved source-to-target mapping set and
versioned API contracts.

## Gate 2 - Environment, connectivity and security

1.  Select the production database engine and migration strategy; review
    transaction and concurrency behaviour for that engine.
2.  Provision UAT endpoints, DNS, firewall/proxy routes, TLS trust
    chain, REIS tenant and rotated credentials through the approved
    secret store.
3.  Implement approved FLEXCUBE-to-integration authentication and REIS
    callback authentication.
4.  Implement the real FLEXCUBE status-update transport (API, procedure
    or staging/interface table). If Oracle staging is selected,
    configure and test least-privilege connectivity, commit
    acknowledgement and network access.
5.  Confirm deployment model, number of instances, expected load and
    monitoring/health-check wiring.

**Exit criteria:** authenticated, observable, end-to-end network paths
exist in UAT; no TLS validation is disabled and no credentials remain in
shared test files.

## Gate 3 - Persistence, mapping and inbound integration

1.  Implement and review database migrations for the chosen database.
2.  Implement the controlled mapping-data import and validation path,
    then load approved mapping records.
3.  Finalize the FLEXCUBE inbound DTO, field validation,
    date/number/empty-value normalization and authentication.
4.  Update the corporate legal-name mapping to the approved new field;
    implement approved country, `tin`, `nid`, account-manager and
    `product` rules.
5.  Implement the Individual income-source strategy and Corporate
    source-of-income mapping from the approved rules.
6.  Implement Corporate related-person sourcing from
    `STTM_KYC_CORP_KEYPERSONS`, including relationship mapping,
    person/entity type and all required fields.
7.  Implement the approved KYC-version/idempotency key and
    duplicate/resubmission behaviour.

**Exit criteria:** valid Individual and Corporate source requests map
deterministically to the approved canonical model and REIS payload.

## Gate 4 - REIS client, retries and final-status lifecycle

1.  Implement token lifetime/401 handling and the approved bounded retry
    policy.
2.  Implement onboarding timeout/non-200 handling using the approved
    resubmission and idempotency rule; explicitly handle the possibility
    of a late callback after a timeout.
3.  Implement the callback security strategy and validate the final
    `/customerStatus` schema.
4.  Implement the approved HTTP 200 acknowledgement boundary. Ensure
    that a returned 200 corresponds to the agreed durable-success
    condition.
5.  Replace `MockFlexcubeStatusUpdater` with the real FLEXCUBE update
    mechanism.
6.  Map all approved outcomes (`CLEAN`, `PENDING`, `REJECT`, `CUSTOMER`,
    `BLOCKED`) to the agreed FLEXCUBE representation, including
    `REJECT`.
7.  Implement safe update retries/recovery, duplicate and conflicting
    callback handling, late-callback reconciliation and audit
    transitions.

**Exit criteria:** status delivery, acknowledgement, retry and recovery
behaviours match the approved sequence and are idempotent.

## Gate 5 - Operations and deployment readiness

1.  Provide operational queries and alerts for pending cases, failed
    FLEXCUBE updates, exhausted callback retries, uncertain onboarding,
    authentication failures and unmapped source values.
2.  Document the manual FLEXCUBE update/recovery runbook, owner,
    escalation path and service target.
3.  Configure health probes, structured logs without customer
    payloads/secrets, log retention, audit access and credential
    rotation.
4.  Prepare release/rollback procedure, rollback triggers, owner,
    approved release window and post-rollback checks.
5.  Verify database backup/restore and migration rollback or forward-fix
    procedure as required by the chosen platform.

**Exit criteria:** Operations can detect, diagnose and recover failures
without silently losing a final REIS decision.

## Gate 6 - Automated tests

1.  Unit tests for all field mappings, LOV failures, date/number/flag
    normalization, `tin`/`nid`, income-source rules, product cardinality
    and relationship IDs.
2.  Contract tests for final Individual/Corporate requests and the
    callback schema.
3.  Integration tests for authentication, token 401, timeout, non-200
    responses, retry bounds, duplicate `KYC_REF_NO`, amendment/version
    behaviour and late callbacks.
4.  Database/concurrency tests for simultaneous submissions, duplicate
    callbacks, conflicting statuses, multiple instances and atomic state
    transitions.
5.  FLEXCUBE updater tests for committed success, explicit failure,
    timeout, idempotent retry and recovery.
6.  Mapping-import tests for validation errors, audit trail, version
    promotion and rollback.

**Exit criteria:** automated tests pass against the selected database
and the approved API contracts.

## Gate 7 - End-to-end UAT

Run with real REIS UAT and FLEXCUBE UAT, not only mocks. Agree named
test customers and expected outcomes for:

-   `CLEAN`
-   `PENDING` followed by `CUSTOMER`
-   `PENDING` followed by `BLOCKED`
-   `REJECT`
-   duplicate submission and amended KYC version
-   duplicate/conflicting callback and unknown `systemId`
-   token expiry/401 and authentication failure
-   onboarding timeout, resend and a late callback
-   FLEXCUBE update failure, retry and manual recovery
-   Corporate onboarding with related persons and multiple operation
    countries if supported
-   unmapped reference values, invalid payloads and mapping import
    failures

Record request/response evidence, final FLEXCUBE state, audit trail and
defect disposition for each scenario.

**Exit criteria:** business, Compliance, IT/Security, FLEXCUBE and REIS
owners sign off the agreed scenarios.

## Gate 8 - Production go-live

1.  Confirm all PROD-only decisions: production database and migrations,
    volume/capacity, retention, operations, monitoring, credentials,
    support/SLA, go-live and rollback plan.
2.  Load the approved production mappings through the controlled process
    and verify their version/checksum.
3.  Rotate any credentials that appeared in test files and remove those
    files from shared locations.
4.  Run the release checklist, smoke tests and rollback rehearsal.
5.  Obtain explicit go-live approval from the named business,
    Compliance, IT/Security, Operations and integration owners.

**Exit criteria:** the approved release is deployed, observable and
recoverable, with a tested rollback path.
