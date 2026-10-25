`sarif-schema-2.1.0.json` is the OASIS SARIF 2.1.0 JSON schema (published by OASIS at
https://docs.oasis-open.org/sarif/sarif/v2.1.0/ and mirrored by SchemaStore). It is a test-only fixture:
`test/sarif.test.ts` validates every SARIF document prehello produces against it, offline, with ajv.
It is not shipped in the npm package (`files` whitelist) and is not loaded at runtime.
