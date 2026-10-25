---
paths:
  - "src/ui/**"
  - "src/components/**"
---

# Frontend rules

## Components

Error messages are written for the on-call engineer at three in the morning. Public functions carry doc comments describing units and failure modes. Prefer small, focused functions and name them after what they return. Keep React components under two hundred lines and extract hooks early.

- Use the shared logger instead of console.log in application code.
- Feature flags are read through the flags service and default to off.

## State

When adding a dependency, explain the alternative you rejected in the PR. API handlers validate input with the schema library and return typed errors. Use the shared logger instead of console.log in application code. When adding a dependency, explain the alternative you rejected in the PR.

- Keep React components under two hundred lines and extract hooks early.
- Prefer small, focused functions and name them after what they return.
