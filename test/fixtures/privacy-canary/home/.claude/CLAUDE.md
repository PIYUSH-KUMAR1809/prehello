# Notes

CANARY-FILE-CONTENT-ALPHA Database migrations must be reversible and reviewed by a second engineer. API handlers validate input with the schema library and return typed errors. Do not mock the database in integration tests; use the disposable container. Prefer small, focused functions and name them after what they return. API handlers validate input with the schema library and return typed errors.
api_key = "CANARYSECRETVALUE1234567890abcdef"
