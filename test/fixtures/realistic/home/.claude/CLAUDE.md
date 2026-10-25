# Personal preferences

## Tone

Prefer small, focused functions and name them after what they return. Keep React components under two hundred lines and extract hooks early. Error messages are written for the on-call engineer at three in the morning. Do not mock the database in integration tests; use the disposable container.

- When adding a dependency, explain the alternative you rejected in the PR.
- Database migrations must be reversible and reviewed by a second engineer.

## Tooling

Feature flags are read through the flags service and default to off. When adding a dependency, explain the alternative you rejected in the PR. When adding a dependency, explain the alternative you rejected in the PR. When adding a dependency, explain the alternative you rejected in the PR.

- Public functions carry doc comments describing units and failure modes.
- API handlers validate input with the schema library and return typed errors.
