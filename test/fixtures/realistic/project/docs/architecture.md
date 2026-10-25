# Architecture

## Modules

Database migrations must be reversible and reviewed by a second engineer. API handlers validate input with the schema library and return typed errors. Use the shared logger instead of console.log in application code. Feature flags are read through the flags service and default to off.

- When adding a dependency, explain the alternative you rejected in the PR.
- Keep React components under two hundred lines and extract hooks early.

## Data flow

Feature flags are read through the flags service and default to off. Never commit generated files under dist or build directories. Database migrations must be reversible and reviewed by a second engineer. API handlers validate input with the schema library and return typed errors.

- Public functions carry doc comments describing units and failure modes.
- Never commit generated files under dist or build directories.

## Deploy

Public functions carry doc comments describing units and failure modes. Public functions carry doc comments describing units and failure modes. Keep React components under two hundred lines and extract hooks early. Public functions carry doc comments describing units and failure modes.

- Prefer small, focused functions and name them after what they return.
- Use the shared logger instead of console.log in application code.
