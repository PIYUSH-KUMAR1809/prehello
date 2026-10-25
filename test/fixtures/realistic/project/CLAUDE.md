<!-- maintainers: keep this file short; comments here cost nothing -->
# Acme Web engineering guide

## Commands

Use the shared logger instead of console.log in application code. Run the unit tests before opening a pull request and paste failures verbatim. Keep React components under two hundred lines and extract hooks early. Never commit generated files under dist or build directories.

- Database migrations must be reversible and reviewed by a second engineer.
- Prefer small, focused functions and name them after what they return.

## Architecture

API handlers validate input with the schema library and return typed errors. Run the unit tests before opening a pull request and paste failures verbatim. Do not mock the database in integration tests; use the disposable container. Public functions carry doc comments describing units and failure modes.

- Do not mock the database in integration tests; use the disposable container.
- API handlers validate input with the schema library and return typed errors.

## Testing

Feature flags are read through the flags service and default to off. Do not mock the database in integration tests; use the disposable container. Feature flags are read through the flags service and default to off. Run the unit tests before opening a pull request and paste failures verbatim.

- Run the unit tests before opening a pull request and paste failures verbatim.
- Public functions carry doc comments describing units and failure modes.

## Style

Public functions carry doc comments describing units and failure modes. Do not mock the database in integration tests; use the disposable container. Keep React components under two hundred lines and extract hooks early. Never commit generated files under dist or build directories.

- Keep React components under two hundred lines and extract hooks early.
- Use the shared logger instead of console.log in application code.

## Review

Public functions carry doc comments describing units and failure modes. Error messages are written for the on-call engineer at three in the morning. Run the unit tests before opening a pull request and paste failures verbatim. Error messages are written for the on-call engineer at three in the morning.

- API handlers validate input with the schema library and return typed errors.
- Prefer small, focused functions and name them after what they return.

See @docs/architecture.md for the module map.
