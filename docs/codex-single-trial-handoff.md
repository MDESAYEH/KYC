# Codex → Claude handoff: single-record UAT1 trial

The user explicitly told Codex to STOP now, send this handoff to Claude, and let Claude continue. Codex is no longer implementing. No commit/push/merge/deployment/live bank action is authorized.

## Locations and ownership

- Main workspace: C:\Users\moham\Documents\GitHub\KYC
- Branch: feature/reis-cif-identity-preparation; baseline HEAD cf56f0cbea9347da6a8fdf76db0fbbaaeba5d27b. All current preparation is uncommitted.
- LATEST single-trial code is in the detached worktree C:\Users\moham\Documents\Codex\2026-11-17\new-chat\work\kyc-single-trial (same baseline). It has a node_modules junction to the main workspace; NO .env was copied.
- Codex moved into this worktree after detecting Claude's auto-resumed concurrent edits. The user then stopped Claude and authorized Codex to continue, but has now handed the task back to Claude. Avoid parallel editing.
- The main workspace contains OLDER copies of the new trial files. Do not assume they match the isolated worktree. Merge/reconcile deliberately. Preserve Claude's newer seqNo propagation and status-vocabulary changes in the main workspace; do not replace whole shared files from the worktree.

## Requested target and boundaries

Only KYC_REF_NO 001ZKYC26151003Y, MOD_NO/SEQ_NO 2. Reported CIF 00005804 is comparison-only, never a fabricated/fallback source. User says read/transform succeeded but nothing was submitted.

Prepare one safe trial using existing source/mapper/client/persistence components. Verify authoritative CIF source/join, previous REIS identities, Oracle Claim, status consumer compatibility, exact-revision targeting, raw real REIS response recording/readback. Polling stays false; preserve the 58 historical E records. No real send before verification and operational approval. Do not deploy, restart, change credentials/environment, run migrations on bank DB, or send in bulk. Prior no-commit/no-push restriction remains.

## Prior CIF preparation (main workspace and worktree)

See docs/reis-cif-identity.md and outputs from the earlier task. Active KYC_WORKFLOW is CifSubmissionHoldWorkflow, not the historical KycWorkflow. Missing/invalid CIF is refused; valid CIF still held until cutover is approved. Normal polling with that hold is rejected. CifOnboardingPreview is offline only; legacy transformer/workflow remain baseline regressions, not authorized sending.

Prior completed checks: full suite 1020 passed, 4 real-Oracle tests skipped; lint, tsc and build passed. Those results predate the latest single-trial and auto-resumed Claude changes. Do not present them as a final combined-tree check.

## New single-trial implementation (latest = isolated worktree)

1. src/kyc/single-kyc-trial.scope.ts: fixed allowlisted target. Holds BOTH old KYC identity and proposed CIF out of the legacy callback path.
2. src/tools/single-kyc-trial.contract.ts: approval schema and hash/age/confirmation checks. Requires named approval, exact plan/source/claim hashes, source/lifecycle evidence, explicit old+CIF identity absence checks, isolated Oracle Claim reference, consumer status contract, exact-revision callback-route reference, stopped senders and backups. Reject-to-BLOCKED is separately approved, never implicit.
3. src/tools/single-kyc-trial.repository.ts: exact current/open MOD_NO query; refuses existing E/W/S or previously attempted N rows. Claim uses Oracle-safe binds, exact KYC/SEQ/MSGID and current/open master EXISTS. Stores request intent before sending; completes only that row, records raw response wrapper; writes CLEAN/PENDING/BLOCKED only to exact SEQ_NO=2, never MAX(SEQ_NO). Does not requeue.
4. src/tools/single-kyc-trial.ts: read-only plan, payload/source rechecks, plan fingerprint, protected before-evidence, one insert/claim at most, local CIF case persistence, one call to existing REIS client, raw-response-based status decision, readback. No automatic retries. Timeout/malformed/non-2xx => uncertain, no fabricated approval. Result-recording failure leaves W and captured evidence. Stop control checked before claim and immediately before HTTP client.
5. src/tools/single-kyc-trial.transport.ts: extends existing transport, captures ONLY onboarding raw HTTP status/body, never auth token/headers. Same existing ReisAuthClient/ReisOnboardingClient/parser are used.
6. src/tools/run-single-kyc-trial.ts: CLI preflight/send/verify. Reviewed CIF SELECT must be supplied as a file with :kycRefNo AND :seqNo, returning ONE string CIF_VALUE; no table/column/join guessed. Local SQLite opens read-only for preflight, fileMustExist, no migrations or seeds. Sending requires fresh reviewed plan/approval/protected new evidence directory/explicit confirmation/stop-file. Report path is reserved before writes.
7. IMPORTANT: CLI --mode send is CURRENTLY HARD-BLOCKED with EXACT_REVISION_CALLBACK_ROUTE_NOT_IMPLEMENTED while the trial identity is quarantined. This is intentional: REIS might return PENDING, and the legacy callback route must not write APPROVED or latest revision. Do NOT merely remove this guard or quarantine; implement/verify the approved exact-revision callback route first.
8. src/webhook/customer-status.service.ts: worktree has new trial quarantine after authentication/validation/audit and BEFORE applyFinalStatus. Returns RECONCILIATION_REQUIRED, detail SINGLE_TRIAL_CALLBACK_QUARANTINED, no business/status update. Main workspace currently has Claude's separate seqNo propagation addition; merge both hunks, do not overwrite it.
9. package.json: trial:one = nest build && node dist/tools/run-single-kyc-trial.js (exists in main as well; inspect before replacing package file).

## Tests and actual current results

- test/support/single-trial-db.ts: fake Oracle statement executor, exact allowlist and revision checks; not proof of Oracle SQL execution.
- test/single-kyc-trial.integration.spec.ts: 34 tests passed in isolated worktree. Uses synthetic Oracle, in-memory SQLite and fake HTTP REIS only. Covers source missing/blank/numeric/wrong/ambiguous CIF, approvals, historical/local identity, preflight no writes/no auth, CLEAN/PENDING raw response/readback, REJECT mapping approval, claim ORA-01745/02290/01031, concurrent MOD_NO change, backup failure, stop control, legacy callback quarantine, HTTP500/malformed/unknown status/timeout, no retry, response-recording failure, preserving all 58 synthetic E rows AND another revision of the same target.
- A test verifies a supplied/stub CLEAN cannot override a captured PENDING wire body.
- test/single-kyc-trial.oracle.spec.ts: 3 tests SKIPPED. Explicit disposable schema only, randomly named master/stage tables; no STTM table creation. Tests actual claim once, raw-response/PENDING write and another revision preservation, and changed MOD_NO rejection. The SQL adapter substitutes the master identifier ONLY into a generated test table. Fixture DDL is assumed and must be compared with bank DDL. Never point this suite at UAT1/PROD.
- Latest focused result: 34 passed, 3 skipped, 0 failed; log C:\Users\moham\Documents\Codex\2026-11-17\new-chat\work\single-trial-isolated.log.
- Isolated lint and tsc passed at the point just before that focused run. NO final full-suite/build check of the combined main workspace has been performed. Re-run after reconciliation.
- Initial older trial version had 30 tests passing in main before quarantine/stop/isolated-Oracle additions. Do not mistake that for the latest result.

## Claude's auto-resumed changes to preserve/review

Main workspace now has finalStatusVocabulary in configuration; decisionValues and toStagingFinalStatus supporting approved-blocked (default) vs clean-pending-blocked; updater exact seqNo support; seqNo propagation from workflow, webhook and recovery. Some broad formatting changes also appeared. These were NOT reverted. No environment value was changed by Codex. Validate the opt-in vocabulary and actual consumer/constraints before use; default must not silently change historical banking behavior.

## Independent peer review received

A generic, no-project-data read-only Claude CLI review flagged: in-doubt reconciliation after lost responses; fence the legacy callback path; hard allowlist + immediately-before-send stop control + restricted raw-response evidence. Worktree now contains uncertainty/no-resend handling, callback quarantine, fixed scope and stop checks. No invented external idempotency key was added because REIS's idempotency contract is unverified. Manual/read-only reconciliation is still needed after uncertainty.

## Remaining work / blockers

- Integrate latest worktree files into main preserving both agents' changes, then inspect diffs and run lint, tsc, full Jest and build. No commit/push.
- Finexta must confirm actual CIF owner/table/column/join, datatype/leading-zero representation and that this CIF belongs to this KYC before send. Reported CIF alone is not proof. No source SQL file was invented.
- REIS operations must check BOTH old KYC identifier and CIF (and reconcile any existing identity). Do not use state-changing searchOnboardCustomer as a read-only lookup.
- Actual Oracle Claim SQL and actual constraints/triggers remain unverified; run the new isolated suite only with authorized disposable schema, then obtain bank-side metadata review.
- Finexta must confirm CLEAN/PENDING/BLOCKED accepted by REIS_FINAL_STATUS AND read by FLEXCUBE. Oracle SELECT readback alone does not prove consumer behavior. Do not force CLEAN.
- Exact-revision, approved-vocabulary authenticated callback routing still needs implementation/verification. Trial callbacks currently QUARANTINE. This is a hard blocker to live CLI send, not just missing paperwork.
- Define/approve REJECT mapping; current runner preserves raw result and leaves final column null unless BLOCKED mapping is explicitly approved.
- Audit target freeze/other senders stopped; no prior identities; backups; PII evidence access/retention. A signed approval document is not automatically cryptographically verified by the current JSON hash checks.
- Prepare final runbook and blank approval template and protected read-only target SQL. No final single-trial runbook/outputs were delivered yet because the user asked to hand off now.
- CLI help and final refusal checks still need running locally after build. Suggested prepared commands (NOT executed against bank): node dist/tools/run-single-kyc-trial.js --help; preflight with --cif-sql approved-select.sql --report NEW_FILE; verify with --mode verify --report NEW_FILE. Live --mode send must remain blocked until the callback prerequisite is genuinely implemented and verified.

Codex has stopped implementing as requested. Claude is now the primary continuation agent. Do not delegate or ask Codex to keep editing concurrently.
