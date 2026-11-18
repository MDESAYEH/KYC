# Callback -> revision binding (B5): review of 18/11/2026

## The risk

Revision 2 is sent to REIS, FLEXCUBE advances to revision 3, then a delayed or duplicate callback of revision 2 arrives.
It must never update revision 3.

## What the code did, and what is now enforced

| Point                                                                | Before                                                                                                                                                       | Now                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status update target                                                 | Production callers always passed the case's own `seqNo`, but `FlexcubeStatusUpdate.seqNo` was optional and, when missing, the SQL used `MAX(SEQ_NO)`          | `seqNo` is **required** by the type and by the updater (`StagingRevisionRequiredError`, nothing reaches Oracle). The `MAX(SEQ_NO)` statement no longer exists                                                                                                      |
| Revision of a callback                                               | Taken from `kyc_case.seq_no` (correct for the first revision)                                                                                                | Same, **plus** `kyc_case.revision_count` (migration `1790000000005`, back-filled with `seq_no` for existing rows, conservative) counts the revisions ever sent under the identity                                                                                  |
| Late callback of an earlier revision while a later one is pending    | Applied to the later revision (documented "residual limit")                                                                                                  | `revision_count > 1` and the case is `REIS_PENDING`: **quarantined** (`RECONCILIATION_REQUIRED`, audited, nothing applied, nothing written). Nobody guesses                                                                                                         |
| Revision N+1 sent while N is unanswered                              | Refused by `reopenForAmendment` (a revision still in progress is never overwritten)                                                                          | Unchanged; tested                                                                                                                                                                                                                                                  |
| Late callback while N+1 is only RECEIVED / after N+1 answered CLEAN  | `INCONSISTENT_STATE`, nothing applied                                                                                                                        | Unchanged; tested                                                                                                                                                                                                                                                  |

A callback is therefore applied only when its origin is **unambiguous**: exactly one revision was ever sent under that systemId
(the single-record trial, whose revision is the first ever sent under the CIF). Otherwise it needs reconciliation.

Consequence to accept: for an identity that has been amended, every callback of a PENDING revision is quarantined until REIS
provides a revision token (below). That is the safe behaviour, not a bug. There is no operator tool yet to apply a quarantined
decision; reconcile with REIS and update the staging row by hand under the existing recovery procedure.

## Does the REIS API give a stable request identifier we can persist at send time and get back in the callback?

**Not in the contract we have.** The callback sample is `{ status, systemId, customerId, systemName, ServiceType }`:

- `systemId`: our own value, identical for every revision of the identity (CIF), so it cannot separate revisions;
- `customerId`: the REIS customer, also identical across revisions;
- the onboarding response returns `reisId` / `riskCalculationId` (we store them), but nothing says the callback echoes them, and
  we have no confirmation that they are per request rather than per customer.

So B5 is **not fully safe by design**; it is safe by quarantine. Closing it needs a change or a written confirmation from
Vneuron/REIS: an identifier that we send (or receive) per submission and that the callback returns, for example a `requestId` /
`submissionId` echoed back, or the `riskCalculationId` of that submission if REIS confirms it is unique per request and returned
in the callback. With it, `applyFinalStatus` can match the persisted identifier of the current revision and apply or reject
exactly, and the `revision_count` quarantine can be relaxed. Until then the trial must send ONE revision only.

Message for Vneuron: "Does the /customerStatus callback carry, or can it carry, an identifier that is unique per submission
(for example the riskCalculationId or a requestId we send in the onboarding request)? We must attach a delayed or duplicate
callback to the exact revision that was sent."
