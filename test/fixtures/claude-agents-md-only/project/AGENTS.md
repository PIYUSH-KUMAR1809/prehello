# Agents file

## C

Keep React components under two hundred lines and extract hooks early. When adding a dependency, explain the alternative you rejected in the PR. Prefer small, focused functions and name them after what they return. API handlers validate input with the schema library and return typed errors.

- Prefer small, focused functions and name them after what they return.
- Error messages are written for the on-call engineer at three in the morning.

## D

Never commit generated files under dist or build directories. Database migrations must be reversible and reviewed by a second engineer. Public functions carry doc comments describing units and failure modes. When adding a dependency, explain the alternative you rejected in the PR.

- Feature flags are read through the flags service and default to off.
- Run the unit tests before opening a pull request and paste failures verbatim.
