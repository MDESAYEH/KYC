# Questions by party (ready to send)

Each section can be sent as is. Tags: **[UAT]** needed before
end-to-end UAT, **[PROD]** needed before production. Please answer
with concrete values (field names, codes, examples, dates) wherever
possible. Where a previous reply was ambiguous, the earlier wording is
quoted. The integration code remains frozen until the relevant decisions
are approved in writing.

---

## 1. FLEXCUBE team

### Request contract and authentication

1.  **[UAT]** Will FLEXCUBE send one request per KYC record, in
    real time, or in batches? What are the HTTP method and the
    URL/endpoint you will call?
2.  **[UAT]** What is the final JSON structure (please send a
    complete example for an Individual and a Corporate customer)? Which
    fields are mandatory and which optional?
3.  **[UAT]** What formats will be used for dates (`BIRTH_DATE`,
    issue and expiry dates), decimal numbers (`MONTHLY_INCOME`,
    `FIN_INFO`), Y/N flags and empty values (empty string, null, field
    omitted)?
4.  **[UAT]** Which authentication method will FLEXCUBE use when
    calling the Bank Integration API (API key, mTLS, Basic, OAuth,
    network allowlist, other), and who provisions the credentials? You
    said this will be discussed internally: by when can we expect the
    answer?
5.  **[UAT]** What response and error format does FLEXCUBE expect
    from the Integration API (success, validation error, duplicate
    `KYC_REF_NO`, temporary failure)? Will FLEXCUBE resend on an error?

### Identifiers

6.  **[UAT]** You said `KYC_REF_NO` is mapped while the customer
    is created. Please confirm whether `CUSTOMER_NO` is unavailable at
    the first submission, and provide the maximum length/format and
    uniqueness rule for `KYC_REF_NO`. If an existing customer's KYC data
    is amended and must be screened again, does FLEXCUBE generate a
    **new `KYC_REF_NO` for each version**, or reuse the previous one? If
    it reuses it, what identifies the amendment/version and how is a
    legitimate rescreen distinguished from a duplicate submission?
7.  **[PROD]** After the customer is created, how does FLEXCUBE keep
    the link between `KYC_REF_NO` and `CUSTOMER_NO`, and which
    identifier will you use when we report the final status?

### Final status update to FLEXCUBE

8.  **[UAT]** You answered "Final status update based on CODE
    level". Please explain the exact mechanism (API, interface/staging
    table, stored procedure, other), the table/fields/parameters
    updated, the identifier used, and when the update occurs. If this
    uses an Oracle interface/staging table, please provide the
    database/service endpoint, schema and table names, required
    privileges, network path, transaction/commit behaviour, and how the
    integration can reliably detect success or failure.
9.  **[UAT]** Which FLEXCUBE code/value represents each REIS
    outcome: **CLEAN, PENDING, REJECT, CUSTOMER, BLOCKED**? REIS states
    that REJECT (onboarding prohibited) must be reflected in FLEXCUBE;
    what does FLEXCUBE do for each outcome?
10. **[UAT]** You confirmed the update is idempotent on the
    FLEXCUBE side. Does it return an acknowledgement we can rely on
    (success/failure, reason)? Does FLEXCUBE retry or recover on its own
    if an update fails, or must the Bank resend?

### Individual customers

11. **[UAT]** Identification document: you said "the default will
    be 'pass'; if TIN data is available the value to pass is 'code'".
    Please restate precisely: what do we receive when TIN is empty, and
    what when it is filled? Which fields hold the document type, the
    document number, issue date and expiry date?
12. **[UAT]** `relation_pep`: please give the field name of the
    Y/N checkbox. Is there an equivalent for Corporate customers?
13. **[UAT]** Source of income (individual): what are the names of
    the new LOV fields and the code of each value? When several are
    selected, will FLEXCUBE send all selected values or only one? In
    what format (list, flags)?
14. **[UAT]** Resident: you confirmed values `Y` or `N`. Please
    confirm `Y` = resident and `N` = non-resident.
15. **[UAT]** REIS describes `citizenship` as "Residence Country".
    Which FLEXCUBE field holds the customer's nationality and which
    holds the country of residence? Which of them should feed REIS
    `nationality` and `citizenship`?
16. **[UAT]** What are the exact field names for first name, last
    name, place of birth, profession (LOV `STTM_KYC_OTHER_TYPES` /
    OCCUPATION), account purpose, and distribution channel?

### Corporate customers

17. **[UAT]** Legal name: you will introduce a new text field.
    What is its name and location, is it mandatory, and what is its
    maximum length? (REIS confirmed `business_name` is the legal name,
    not the business nature.)
18. **[UAT]** Country of incorporation: the field you named is
    "Parent Company Country of Incorporation". REIS needs the country of
    incorporation of the customer entity itself. Does this field contain
    the customer's own country? If not, can a new field be added?
19. **[UAT]** The new LOVs on the `STDKYCMN` screen (Operation
    Country, Legal Entity, Activity, Distribution Channel, Product):
    what are the exact field names and the list of codes? Is the Product
    LOV the same as the existing `PRODUCT_CODE`? Please also confirm
    whether the FLEXCUBE Product value is sent to REIS as one value or
    multiple values.
20. **[UAT]** Operation Country: can several countries be
    selected? If yes, how will they be sent?
21. **[UAT]** Corporate Source of Income (renamed from "Main
    Source of Funds"): field name, code list, and confirmation that it
    carries exactly one value.
22. **[UAT]** Other corporate fields: source of `FIN_INFO`
    (financial information, numeric), and of `TRADE_NO` (commercial
    register number).
23. **[UAT]** Related persons: for `STTM_KYC_CORP_KEYPERSONS`,
    please list all columns. For each key person we need, for an
    individual: first name, last name, date of birth, nationality,
    country of residence, optional place of birth, document
    type/number/issue/validity; for an organization: legal name,
    country, optional commercial register number. Which columns provide
    these? Is there an indicator whether the key person is an individual
    or an organization? How many key persons per customer?
24. **[UAT]** Relationship types: what are the codes in the
    `RELATIONSHIP` LOV (the Bank will confirm)? When will the final
    relation mapping be available, and how will relations be included in
    the request?
25. **[UAT]** Fields currently marked NA / "Bank data" in the
    workbook: which will be added as new fields or UDFs, which are
    mandatory, and by when?
26. **[UAT]** Please provide a source extract (actual code plus
    exact description) for Corporate Account Purpose values `203`, `204`
    and `210`, including the source table/column and LOV definition.
    Please do not infer descriptions from the numeric values. The Bank
    Business/Compliance owner will approve their meaning and REIS
    mapping.

### UAT

27. **[UAT]** Which FLEXCUBE UAT environment and endpoint will
    call us, and when can test KYC records be created? Please provide
    cases for a first submission and, if supported, a corrected/amended
    KYC version, and confirm whether each version receives a unique
    `KYC_REF_NO`.

---

## 2. Bank / Compliance / Business

### Reference data

1.  **[UAT]** Please provide the approved FLEXCUBE-code to
    REIS-code mapping tables for: nationality/country, profession,
    product, account purpose (individual), account purpose (corporate),
    legal entity, activity, distribution channel, source of income
    (individual and corporate), and document type. Please include the
    actual FLEXCUBE code and description from the source LOV/table, the
    approved REIS value, and the approval owner. Please confirm which
    workbook items remain "Bank to provide" (red) or "Bank to verify"
    (green). Do not infer the meaning of numeric codes from the code
    alone. Please also specify the approved process and owner for
    loading, reviewing, versioning, and promoting mapping data between
    development, UAT and production (including whether a controlled
    CSV/Excel import is required).
2.  **[UAT]** Document types: which REIS document-type codes are
    approved for `tin`, and which FLEXCUBE value maps to each (for
    example how "pass" maps to the REIS passport code)? What happens to
    values not in the list?
3.  **[UAT]** Corporate Account Purpose values **203, 204 and
    210**: please provide the exact source LOV description for each
    value, confirm whether each is valid for Corporate Account Purpose,
    and provide its approved REIS equivalent (or confirm it is invalid).
    The FLEXCUBE team should extract the actual code/description; the
    Bank Business/Compliance owner should approve the meaning and
    mapping.
4.  **[UAT]** Corporate relationship types: which REIS
    `relationshipId` (6-15 for organization relations, 1-7 for
    individual relations) corresponds to each FLEXCUBE `RELATIONSHIP`
    code?

### Business rules

5.  **[UAT]** Individual source of income with several selections:
    which single REIS value should be sent (for example a priority
    order, a "multiple sources" code, or reject the request)? Please
    give the rule and an example.
6.  **[UAT]** Account manager: which values should FLEXCUBE pass
    in `account_manager_login` and `account_manager_email` (the branch
    officer, a fixed integration user, a REIS user)? FLEXCUBE asked us
    for the value to pass.
7.  **[UAT]** Resubmission and KYC versions: after a rejected
    request, timeout, failed call or corrected data error, may the same
    `KYC_REF_NO` be submitted again, or must a corrected/amended KYC
    version receive a new reference? Who triggers each retry (FLEXCUBE,
    integration service or operator), under which error conditions and
    limits? REIS advises resending after a timeout; does the Bank
    approve this despite the duplicate-onboarding risk, and what rule
    applies if the original request was processed but its response was
    lost?
8.  **[UAT]** After a timeout, REIS may later send a final
    CUSTOMER/BLOCKED callback for that customer. Should it be applied
    automatically (under which checks), or approved by an operator
    first?
9.  **[UAT]** What business action and FLEXCUBE status/code apply
    to each outcome (CLEAN, PENDING, REJECT, CUSTOMER, BLOCKED)? For
    example, may an account be opened after CLEAN, and what happens
    after REJECT? Please also record explicitly whether this
    integration's approved scope is **KYC screening only**, with AML/TFS
    screening and related decisioning excluded unless separately
    approved as a distinct scope.

### Operations and data

10. **[PROD]** Who performs the manual FLEXCUBE update when REIS'
    callback retries are exhausted or a FLEXCUBE update fails, within
    what time, and what is the escalation path?
11. **[PROD]** After how long should a case still waiting for a final
    result (PENDING) raise an alert?
12. **[PROD]** REIS states that `instruction` and `errorMessage`
    contain no personal or sensitive data and have no maximum length.
    May we log them? For how long do we retain the stored case records
    and callback audit, and who may view them?

---

## 3. REIS team

### Callback (`POST /customerStatus`)

1.  **[UAT]** You listed NONE, BASIC, BEARER and NTLM. Which do
    you recommend? How is BEARER sent (header name and format)? Are mTLS
    or a fixed list of source IP addresses available? How are the
    credentials configured in REIS and rotated?
2.  **[UAT]** Retry policy: you said REIS makes "a final retry at
    around midnight". What are the callback timeout, retry interval and
    maximum number of attempts? Are there earlier retries, and in which
    named time zone is "midnight" (including daylight-saving handling,
    if applicable)? Are 3xx/4xx/5xx/timeouts all retried? Is any 2xx
    other than 200 (for example 202 or 204) treated as success?
3.  **[UAT]** Is the final payload exactly `status`, `systemId`,
    `customerId`, `systemName`, `ServiceType`? Which are always present?
    Is `systemId` always a string? Is there an event identifier? Are
    CLEAN or REJECT ever sent through the callback?
4.  **[UAT]** Can REIS send duplicate callbacks, or change a
    customer's final status later (CUSTOMER then BLOCKED)? How should
    the Bank treat a status change after the first final status?
5.  **[UAT]** Can REIS trigger a test callback to our UAT endpoint
    on demand, and from which IP addresses will callbacks originate?

### `searchOnboardCustomer`

6.  **[UAT]** You advise resending after a timeout. If we resend
    with the **same `systemId`**: does REIS create a duplicate customer
    or case, or return the same result (is the call idempotent / does it
    search existing customers first)? What if the first request was
    already processed?
7.  **[UAT]** After a timeout and a resend, is a later callback
    for that `systemId` the authoritative final result?
8.  **[UAT]** Error handling: besides CLEAN, PENDING and REJECT,
    are there other statuses? When does a response carry a non-empty
    `errorMessage`, and is it only informational for REJECT? Are
    validation errors returned as HTTP 4xx or as 200 with
    `errorMessage`? Which HTTP codes can the API return, and is
    resending safe after each?
9.  **[UAT]** Token: what is the lifetime of the authentication
    token, and is there a limit on authentication calls per minute? (The
    current working flow authenticates before every onboarding request.)
    If `searchOnboardCustomer` returns HTTP 401, should we authenticate
    again and retry the same request once? Please specify whether that
    retry is safe and whether repeated 401 responses should stop
    processing.

### Payload details

10. **[UAT]** Corporate onboarding: please share the Corporate
    Postman example as soon as possible. Please confirm the exact format
    of `operation_country` (array of codes), whether the Corporate
    envelope differs from the Individual one, and whether `product` is
    represented as a single string/code or an array in both Individual
    and Corporate payloads.
11. **[UAT]** Relations: relationship ids 7, 10, 13, 14, 15 are
    described as "individual only" in the Organization Relations table,
    yet formId 4 carries `business_name` and formId 3 accepts only ids
    1-7. How do we send an individual who is CEO, MANAGER, EXECUTIVE,
    CFO or AUTHORIZED of a corporate customer: which formId and which
    fields?
12. **[UAT]** `citizenship` is described as "Residence Country" in
    the relation form. Is it the same for `citizenship_customer` and
    `citizenship` of the main form? Why are
    `nationality_customer`/`nationality` and
    `citizenship_customer`/`citizenship` both required, and must the
    pairs be equal?
13. **[UAT]** `pep`: the specification sample shows `"pep": "No"`
    (text) while the working Postman sends boolean `false`. Which is
    correct for `pep` and `relation_pep`?
14. **[UAT]** Field limits: maximum lengths of names and text
    fields, maximum number of relations per request, maximum payload
    size.

### Reference data and environment

15. **[UAT]** Please provide the authoritative REIS code lists
    (nationality/country, profession, product, account purpose
    individual and organization, legal entity, activity, distribution
    channel, source of income, document type), whether codes are
    case-sensitive or tenant specific, and how changes are communicated.
16. **[UAT]** UAT environment: confirm the base URL and tenant,
    the certificate chain (which CA signs the UAT certificate so we can
    trust it, not disable validation), source IP addresses, availability
    windows, and whether UAT test data can be reset.
17. **[UAT]** Can REIS produce each outcome on demand for named
    test customers (CLEAN, PENDING then CUSTOMER, PENDING then BLOCKED,
    REJECT)? Please also confirm that the UAT user's role set allows
    onboarding (the integration user is expected to have the onboarding
    permission).
18. **[PROD]** Production: separate tenant and credentials, base URL,
    SLA, support contacts, and the process for rotating credentials.

---

## 4. Infrastructure / Security

1.  **[UAT]** Webhook authentication: which of REIS' modes (NONE,
    BASIC, BEARER, NTLM) is approved for `/customerStatus`, and are IP
    allowlisting or an API gateway also required? Who issues and rotates
    the credentials? (BASIC sends credentials in plain text and needs
    TLS; NONE would leave the endpoint open.)
2.  **[UAT]** FLEXCUBE to Integration API authentication: which
    method is approved by Bank security?
3.  **[UAT]** Network for UAT: where will the Integration API run,
    which DNS names will it use, and which firewall/proxy rules are
    needed for bank-to-REIS UAT over HTTPS, REIS-to-bank callback, and
    FLEXCUBE-to-Integration API traffic? Is an outbound proxy required?
    If FLEXCUBE status updates use an Oracle interface/staging table,
    what network route, host/port, schema/service account and database
    privileges are required, and who provisions them?
4.  **[UAT]** TLS: which certificate will the Integration API
    present (internal CA?), and how will the REIS UAT certificate chain
    be installed in the trust store of the host? (Certificate validation
    will not be disabled.)
5.  **[UAT]** Secrets: which secret store holds the REIS
    credentials and webhook credentials, how are they injected as
    environment variables, and who rotates them? Note: the current UAT
    credentials exist in plain text in test files and a token appears in
    a results file; they should be rotated and the files removed from
    shared locations.
6.  **[PROD]** Production database: which engine and version, hosting,
    high availability, backup and retention, who owns schema migrations,
    DBA review, and the required isolation/locking behaviour. If Oracle:
    schema/user, privileges and time zone handling.
7.  **[PROD]** Runtime and capacity: hosting model (VM, container),
    approved Node.js version, process manager, number of instances (the
    final-status handling must be reviewed for multiple instances),
    CI/CD and configuration management. What are the expected KYC
    submissions per day, expected peak requests per minute/second,
    concurrent submissions, and required response-time/SLA targets? What
    load level must be demonstrated before go-live?
8.  **[PROD]** Monitoring and logging: log platform and retention,
    alerts, how `/health/live` and `/health/ready` are wired into
    monitoring (readiness deliberately never calls REIS).
9.  **[PROD]** Security review: is a penetration test or architecture
    review required before go-live? Is database encryption at rest
    required? Is rate limiting or a WAF in front of the public webhook
    required (unauthenticated calls create audit records)? Please
    identify the production go-live decision owner, rollback decision
    owner, approved release window, rollback triggers and the tested
    rollback procedure.

---

## 5. Joint (FLEXCUBE team + Bank + REIS)

1.  **[UAT]** Agree the UAT customers (CIF / unique `KYC_REF_NO`)
    and scenarios with expected results: CLEAN; PENDING then CUSTOMER;
    PENDING then BLOCKED; REJECT; duplicate submission; duplicate
    callback; conflicting callback; unknown `systemId`; authentication
    failure; timeout then resend; FLEXCUBE update failure and manual
    recovery; Corporate with related persons.
2.  **[UAT]** Agree who owns each open answer above, the date each
    will be provided, and the UAT and go-live dates.
3.  **[UAT]** Agree the exact end-to-end sequence for a Corporate
    customer with related persons (which request carries the relations,
    when the customer number is created, and when the final status is
    written back).
4.  **[UAT]** Agree the callback acknowledgement boundary: does
    HTTP 200 mean only that the callback was durably recorded, or that
    the FLEXCUBE status update has successfully committed? REIS has
    stated that a non-200 response triggers retry and that a 200 is
    treated as success. If 200 is returned before the FLEXCUBE update
    succeeds, the Bank must own reliable retry/recovery for the update;
    if 200 is withheld until the update commits, agree how transient
    failures and exhausted REIS retries are handled.
5.  **[UAT/PROD]** Agree expected daily and peak KYC volume,
    concurrency, payload/related-person volume, and whether the service
    will run as one instance or multiple instances. Confirm the
    performance/load-test target and who signs it off.
6.  **[UAT]** Agree the mapping-data lifecycle: source extract
    format, who prepares and approves the mapping, who imports it,
    validation and audit/versioning requirements, and how an approved
    mapping release is promoted and rolled back across development, UAT
    and production.
7.  **[PROD]** Agree the named time zone for REIS's
    approximately-midnight retry, production go-live date/window,
    rollback criteria, rollback owner, and post-rollback verification
    steps.

---

## 6. Decisions that must be recorded jointly before implementation

1.  **[UAT] Callback acknowledgement policy:** Record whether the
    webhook returns HTTP 200 after durable internal persistence or only
    after a successful FLEXCUBE update commit. This is a bank-side
    architecture decision to agree with REIS's retry semantics; it is
    not yet implemented.
2.  **[UAT] KYC versioning and idempotency:** Record whether every
    amended/rescreened version gets a new `KYC_REF_NO`. If references
    can be reused, define the version key and distinguish a legitimate
    rescreen from a duplicate.
3.  **[UAT] FLEXCUBE update transport:** Record whether status
    updates use an API, stored procedure, or Oracle interface/staging
    table. If a database interface is selected, document the
    connectivity, credentials, privileges, commit acknowledgement and
    operational owner.
4.  **[UAT] Mapping release process:** Record the approved source
    extract, import mechanism, reviewer/approver, audit trail,
    versioning, environment promotion and rollback process.
5.  **[UAT/PROD] Capacity and deployment topology:** Record daily/peak
    volume, concurrency, instance count, performance target and
    load-test sign-off.
6.  **[PROD] Release and rollback:** Record the REIS midnight time
    zone, go-live window, rollback triggers, owners and verification
    procedure.

**Scope boundary:** The current project is KYC integration only. AML/TFS
screening and decisioning are excluded unless separately approved and
documented as a distinct scope.

**Implementation boundary:** Receiving answers closes
external-information blockers only. It does not mean the remaining code,
migrations, mapping data, operational controls, unit/integration tests
or end-to-end UAT have been completed. No code change is implied by this
question list.
