Dear Business and Compliance Teams,

As part of finalizing the REIS KYC integration with FLEXCUBE, we need to confirm the Bank’s business rules and approve the reference-data mappings required for onboarding and final status processing.

Could you please review and confirm the following items, and identify the responsible owner for each decision?

**1. Reference-data mapping approval**

Please nominate the business owner responsible for reviewing and approving the final mapping between FLEXCUBE values and REIS values.

The mapping will cover:

- Individual and Corporate Account Purpose.
- Profession / Occupation.
- Product.
- Legal Entity.
- Activity / Industry Sector.
- Distribution Channel.
- Individual and Corporate Source of Income.
- Nationality and country-related fields.
- Identification Document Type.
- Corporate relationship types.

The final mapping will be prepared using the actual FLEXCUBE codes and descriptions and the allowed REIS values. Any value without a confirmed mapping should remain flagged as unresolved until approved.

**2. Corporate Account Purpose codes 203, 204, and 210**

We are requesting the complete Corporate Account Purpose LOV extract from FLEXCUBE, including the exact descriptions of codes `203`, `204`, and `210`.

Once that extract is received, please confirm the business meaning and intended usage of each code and approve its corresponding REIS mapping.

Please also confirm whether all three codes belong to Corporate Account Purpose and whether any of them are restricted to particular customer or account categories.

We will not assign meanings to these numeric codes based on the numbers alone.

**3. Individual and Corporate Source of Income**

Please confirm the Bank’s business rule for Individual customers when more than one source of income is selected.

In particular, should the integration:

- Send one source according to a Bank-approved priority rule;
- Send a combined value, if an approved REIS value exists; or
- Require the customer record to contain a single selected value?

Please also confirm the rule for Corporate Source of Income and the expected handling when no source is provided.

We will validate the final decision against the available FLEXCUBE LOVs and the REIS field requirements before approving the mapping.

**4. Country-field business definitions**

Please confirm the intended business meaning and source of each of the following fields:

- Nationality.
- Citizenship.
- Country of Residence.
- Country of Incorporation.
- Country of Operation.

In particular, please confirm that the Corporate country of incorporation refers to the entity being onboarded, rather than its parent company.

The REIS documentation describes `citizenship_customer` as the country of residence. We need to confirm the Bank’s intended data meaning and then agree the correct mapping with REIS.

**5. KYC status and authorization rules**

Please confirm the Bank’s approved business handling for the following outcomes:

- `CLEAN`
- `PENDING`
- `REJECT`
- `CUSTOMER`
- `BLOCKED`

Please specify which outcomes permit authorization, which require the customer or transaction to remain restricted, and how an initial `REJECT` should be represented in FLEXCUBE.

Please also confirm whether Force Release is permitted, the approval roles required, the conditions for using it, and the audit requirements.

**6. KYC amendments and rescreening**

Please confirm which changes to an existing customer’s data should trigger a new REIS screening or onboarding request.

Please also clarify how the Bank expects to handle a new result that relates to an earlier KYC version while a newer version is already being processed.

**7. Account Manager identification**

Please confirm whether the Account Manager fields should represent the assigned Relationship Manager, the KYC creator, or another designated Bank user.

Please identify the approved source and expected handling if the required login or email is unavailable.

**8. Ownership and approval timeline**

Please nominate an owner and target date for each of the decisions above.

The approved mapping and business rules will be shared with the integration team and used as the reference for UAT test cases and acceptance criteria.

Thank you for your cooperation.

Best regards,  
Mohammed Esayeh