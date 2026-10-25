---
name: code-review
description: Review a diff for correctness, security and style. Use when the user asks for a review.
---

# code-review

## When to use

Run the unit tests before opening a pull request and paste failures verbatim. Error messages are written for the on-call engineer at three in the morning. Feature flags are read through the flags service and default to off. Error messages are written for the on-call engineer at three in the morning.

- Database migrations must be reversible and reviewed by a second engineer.
- Never commit generated files under dist or build directories.

## Steps

Use the shared logger instead of console.log in application code. Prefer small, focused functions and name them after what they return. Use the shared logger instead of console.log in application code. Database migrations must be reversible and reviewed by a second engineer.

- Do not mock the database in integration tests; use the disposable container.
- Public functions carry doc comments describing units and failure modes.

## Checks

Never commit generated files under dist or build directories. Do not mock the database in integration tests; use the disposable container. Keep React components under two hundred lines and extract hooks early. Database migrations must be reversible and reviewed by a second engineer.

- Use the shared logger instead of console.log in application code.
- Run the unit tests before opening a pull request and paste failures verbatim.
