Dear Shamseddin,

Thank you for the clarifications shared so far. We have reviewed the responses and would like to close the remaining technical points required to finalize the REIS KYC integration and prepare for end-to-end UAT testing.

To avoid repeating the points already clarified, could you please help us confirm the following outstanding items?

**1. Final API schemas**

- Please share the final approved JSON schemas and sample requests for Individual and Corporate onboarding.
- Please clarify any differences between the documented field definitions and examples, particularly whether `product` should be sent as a string or an array.
- Please share the final `/customerStatus` callback schema, including required and optional fields, data types, and sample payloads for `CUSTOMER` and `BLOCKED`.
- Please confirm the remaining prerequisites and expected delivery date for the final Corporate Postman collection.

**2. Authentication token handling**

- What is the token validity period?
- What is the expected handling when an onboarding request returns HTTP 401 because the token has expired or is invalid?
- Should the Integration API obtain a new token and retry the request? If so, what retry rule should be followed?

**3. Onboarding timeout, resend, and duplicate prevention**

We noted your guidance that an onboarding request affected by a timeout or network interruption should be treated as failed and resent.

- Is resending the request with the same `systemId` idempotent and safe?
- Could resending create a duplicate customer or onboarding case?
- If the original request was processed but its response was lost, is there an API or lookup mechanism to retrieve the original result?
- How should we handle a callback received from the original request after a resend has already been submitted?
- What is the recommended procedure for distinguishing an unprocessed request from a processed request whose response was lost?

**4. Callback retry policy**

We noted the previously shared information about the final retry around midnight. To implement the complete recovery process, please confirm:

- The total number of callback attempts and the interval between attempts.
- The timeout applied to each attempt.
- Which HTTP response codes trigger another attempt.
- Whether callback redelivery can be requested after automatic retries are exhausted.
- Whether the Bank should return HTTP 200 only after the final status has been successfully processed and committed in FLEXCUBE.

**5. Status transition rules**

We have noted the initial statuses `CLEAN`, `PENDING`, and `REJECT`, as well as the final callback statuses `CUSTOMER` and `BLOCKED`.

Please clarify whether `REJECT` is always a final initial onboarding outcome or can also be delivered through `/customerStatus`. Please also confirm the expected processing sequence for each status and whether any additional callback is expected after an initial `REJECT`.

**6. Corporate relationship rules**

- Please clarify the exact meaning of the “individual only” note for the `MANAGER`, `EXECUTIVE`, `CEO`, `CFO`, and `AUTHORIZED` relationship types.
- Does this restriction refer to the type of related person or to the relationship types permitted in a Corporate onboarding request?
- Please provide a complete Corporate request example containing related persons and the applicable relationship IDs.

**7. Country and document-field definitions**

- Please confirm the intended meaning of `citizenship_customer`, as the documentation describes it as the country of residence.
- Please confirm whether `incorp_country` must represent the Corporate entity’s own country of incorporation rather than its parent company’s country.
- Please confirm the accepted document-type codes for `tin`, including the exact Passport code, and how the document number should be provided in `nid`.
- Please confirm the expected representation of `operation_country` when multiple countries apply.

**8. UAT error-handling scenarios**

Please share the expected responses and recommended handling for authentication failures, validation errors, duplicate onboarding requests, timeouts, and other technical errors.

We would also appreciate your support in identifying test cases for `CLEAN`, `PENDING` followed by `CUSTOMER`, `PENDING` followed by `BLOCKED`, and `REJECT`, including timeout and duplicate-submission scenarios.

For each outstanding item, please provide the applicable specification or sample where available, so that we can record the agreed behavior in the integration design.

Thank you for your continued support.

Best regards,  
Mohammed Esayeh