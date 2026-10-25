# Agents file

## C

Database migrations must be reversible and reviewed by a second engineer. When adding a dependency, explain the alternative you rejected in the PR. Keep React components under two hundred lines and extract hooks early. Error messages are written for the on-call engineer at three in the morning.

- When adding a dependency, explain the alternative you rejected in the PR.
- Use the shared logger instead of console.log in application code.

## D

Error messages are written for the on-call engineer at three in the morning. Public functions carry doc comments describing units and failure modes. Error messages are written for the on-call engineer at three in the morning. Do not mock the database in integration tests; use the disposable container.

- Run the unit tests before opening a pull request and paste failures verbatim.
- Feature flags are read through the flags service and default to off.
