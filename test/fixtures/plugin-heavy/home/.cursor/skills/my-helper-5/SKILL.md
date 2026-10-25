---
name: my-helper-5
description: Use when the user asks about my own workflows. Do not mock the database in integration tests; use the disposable container. Database migrations must be reversible and reviewed by a second engineer.
---

# my-helper-5

Database migrations must be reversible and reviewed by a second engineer. Feature flags are read through the flags service and default to off. Never commit generated files under dist or build directories.
