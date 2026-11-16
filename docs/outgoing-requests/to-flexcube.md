Dear Abhilash,

Thank you for the updates shared so far regarding the FLEXCUBE changes.

To finalize the integration mapping and confirm the end-to-end status update process, we need your support with the following outstanding technical details.

**1. FLEXCUBE outbound API contract**

Please provide the final details for the interface from FLEXCUBE to the Bank Integration API:

- Endpoint URL and HTTP method.
- Final request JSON schema and sample payloads for Individual and Corporate customers.
- Mandatory and optional fields, data types, and date formats.
- Authentication method and required headers.
- The source table, column, screen field, or UDF for each field in the request.

Please also confirm which team will provide the final interface contract and when it will be available.

**2. Corporate relationship source and mapping**

We understand that the proposed source is `STTM_KYC_CORP_KEYPERSONS`, with the relationship maintained through the `RELATIONSHIP` LOV.

Please provide:

- The relevant table columns and data types for the related person’s identifier, relationship, PEP information, and other attributes required by REIS.
- The key used to associate each related person with the correct Corporate customer.
- The complete Relationship LOV, including all codes and descriptions.
- The expected mapping of each FLEXCUBE relationship code to the REIS `relationshipId`.
- The expected structure for sending these related persons in the Corporate request.

Please also confirm how relationships described as “individual only” will be handled in the Corporate onboarding process.

**3. Corporate legal name and incorporation country**

We understand that a new text field will be introduced for the Corporate legal name.

Please confirm the exact source field and API property that will supply `business_name`, and confirm whether the new field represents the customer’s legal name rather than `BUSINESS_NATURE`.

Regarding the available field named “Parent Company Country of Incorporation”, please confirm whether it represents the Corporate customer’s own incorporation country or the parent company’s country. If it represents the parent company, please identify the source field for the Corporate customer’s own country of incorporation.

Please also confirm how multiple operation countries will be stored and exposed to the Integration API.

**4. Corporate Account Purpose and other reference LOVs**

Please extract and share the complete current LOV for **Corporate Account Purpose**, including every code and its exact description as maintained in FLEXCUBE.

In particular, please include the actual LOV entries for `203`, `204`, and `210`, showing:

- The source table and column or screen/LOV name.
- The exact code.
- The description displayed in FLEXCUBE.
- Any customer-type or usage restrictions, if configured.

Please do not infer or assign business meanings to these numeric codes. We need the actual FLEXCUBE descriptions so the Bank can validate their meaning and approve the REIS mapping.

Please provide the same code-and-description extract for Individual Account Purpose and the other relevant reference lists, including Profession, Product, Legal Entity, Activity, Distribution Channel, Source of Income, Document Type, and country-related fields.

For each list, please indicate whether the values are already available or whether changes or new LOVs/UDFs are still required.

**5. Source of Income fields**

Please share the exact field names, LOV codes, and descriptions for Individual and Corporate Source of Income.

For Individual customers, please confirm whether multiple sources can be selected, how the selections are stored, and how they will be exposed to the Integration API.

For Corporate customers, please confirm the field name and LOV values for the new Corporate Source of Income field.

The Bank will confirm the business rule for multiple income sources once the available FLEXCUBE values and the REIS field requirements are clear.

**6. KYC reference and customer identifiers**

We understand that `KYC_REF_NO` is mapped during customer creation.

Please confirm:

- Whether `KYC_REF_NO` will be sent to REIS as `systemId`.
- When `KYC_REF_NO` is generated and how uniqueness is ensured.
- Whether `CUSTOMER_NO` exists when the initial onboarding request is submitted.
- How the KYC reference is linked to the customer number after creation.
- Which identifier will be used to locate the correct record when the final REIS callback arrives.
- How resubmissions or updated KYC records are distinguished from earlier submissions.

**7. Final status update mechanism**

The previous response mentioned that the final status update is handled “based on CODE level”. We need the actual technical implementation details to complete this part of the integration.

Please confirm:

- The API, interface table, custom table, stored procedure, service, or other mechanism used to update FLEXCUBE after the final REIS result.
- The table names and relevant columns, where applicable.
- The FLEXCUBE status codes and their meanings for `CLEAN`, `PENDING`, `REJECT`, `CUSTOMER`, and `BLOCKED`.
- The identifier used to locate the relevant KYC/customer record.
- The authorization impact of each status.
- The response and recovery behavior if the update fails.

Please provide a sample or sequence diagram showing how a final `CUSTOMER` or `BLOCKED` callback updates the FLEXCUBE record.

**8. Retry and failed-update recovery**

We noted the earlier response confirming retry support on the FLEXCUBE side. Please clarify the implementation details:

- Which component performs the retry?
- What are the retry count, interval, and stop conditions?
- Are failed updates recorded in a queue or staging table?
- Is repeating the same update idempotent?
- How are duplicate callbacks and network timeouts handled?
- What is the operational procedure for reprocessing a record that could not be updated?
- Is there an audit trail for automatic retries and manual recovery?

**9. UAT readiness**

Please confirm the expected delivery date for the outstanding interface details, reference-data extracts, and status-update mechanism.

Please also advise when the UAT endpoint, connectivity prerequisites, and test customer references will be available.

Our priority is to obtain the final source-field mapping, the complete LOV extracts, and the exact final-status update mechanism so that all parties can validate the integration without relying on assumptions.

Thank you for your support.

Best regards,  
Mohammed Esayeh