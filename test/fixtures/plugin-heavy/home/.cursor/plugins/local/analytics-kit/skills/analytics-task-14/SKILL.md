---
name: analytics-task-14
description: Use when the user asks about product analytics, funnels and experiments. Do not mock the database in integration tests; use the disposable container. Prefer small, focused functions and name them after what they return.
---

# analytics-task-14

Public functions carry doc comments describing units and failure modes. Do not mock the database in integration tests; use the disposable container. Run the unit tests before opening a pull request and paste failures verbatim.
