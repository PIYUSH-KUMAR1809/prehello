---
name: analytics-task-33
description: Use when the user asks about product analytics, funnels and experiments. When adding a dependency, explain the alternative you rejected in the PR. Database migrations must be reversible and reviewed by a second engineer.
---

# analytics-task-33

API handlers validate input with the schema library and return typed errors. Never commit generated files under dist or build directories. Do not mock the database in integration tests; use the disposable container.
