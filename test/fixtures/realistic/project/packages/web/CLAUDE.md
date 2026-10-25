# Web package notes

## Build

Public functions carry doc comments describing units and failure modes. Feature flags are read through the flags service and default to off. Error messages are written for the on-call engineer at three in the morning. Prefer small, focused functions and name them after what they return.

- Keep React components under two hundred lines and extract hooks early.
- Feature flags are read through the flags service and default to off.
