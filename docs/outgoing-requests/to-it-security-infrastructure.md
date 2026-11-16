Dear IT, Security, and Infrastructure Teams,

To complete the technical readiness assessment for the REIS KYC integration, we need to confirm the security, connectivity, monitoring, and operational-recovery arrangements for UAT and Production.

Please review and confirm the following items.

**1. FLEXCUBE to Bank Integration API authentication**

Please confirm the approved authentication mechanism for requests sent from FLEXCUBE to the Bank Integration API.

Please specify the required headers or credentials, TLS requirements, network restrictions, and the team responsible for configuring and validating the connection.

**2. REIS callback authentication**

REIS has advised that the supported callback authentication options are `NONE`, `BASIC`, `BEARER`, and `NTLM`.

Please confirm which option is approved by Bank Security and specify:

- The authentication configuration required on the Bank endpoint.
- Credential or token ownership and lifecycle.
- The approved location for storing secrets.
- Any required TLS, certificate, or IP allowlisting configuration.

Please coordinate with REIS once the Bank’s selected option is approved.

**3. UAT connectivity and environment configuration**

Please confirm the readiness and ownership of the following:

- Bank Integration API UAT URL.
- REIS UAT base URL and tenant configuration.
- DNS and routing requirements.
- Firewall rules and IP allowlisting.
- TLS certificates and certificate validation.
- Required credentials and secret-store configuration.
- Connectivity from FLEXCUBE to the Bank Integration API.
- Connectivity from REIS to the Bank’s callback endpoint.

Please identify any outstanding network or security prerequisites and provide the expected completion dates.

**4. Monitoring and operational recovery**

Please confirm the planned approach for monitoring failed onboarding requests, unsuccessful callbacks, and FLEXCUBE status-update failures.

We need to identify:

- Where integration errors and processing statuses will be recorded.
- How operational teams will identify requests requiring manual intervention.
- Who is responsible for reprocessing failed records.
- How duplicate processing will be prevented during recovery.
- How failed callbacks and final-status updates will be reconciled.
- Whether alerts will be generated for prolonged `PENDING` cases and exhausted retry attempts.

**5. Manual recovery procedure**

REIS has advised that a manual FLEXCUBE update may be required if callback retries are exhausted.

Please identify the responsible operational team and confirm the required approval, reconciliation, audit, and verification steps for such cases.

The procedure should ensure that the final status recorded in FLEXCUBE is consistent with the authoritative result in REIS.

**6. Deployment and health checks**

Please confirm the deployment and runtime requirements for the Bank Integration API, including:

- Hosting and service ownership.
- Service startup and recovery behavior.
- Health-check endpoint and monitoring.
- Log retention and access control.
- Alerting and escalation.
- Backup and recovery requirements, where applicable.

**7. UAT sign-off**

Please identify the IT/Security representative who will confirm that the UAT connectivity and security configuration are complete.

Please provide an owner and target date for each outstanding prerequisite so the integration team can schedule the end-to-end tests.

Thank you for your support.

Best regards,  
Mohammed Esayeh