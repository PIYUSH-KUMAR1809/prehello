## What and why

## Checks
- [ ] `npm run typecheck` and `npm test` pass
- [ ] New behaviour has a test (and a fixture or hostile-input test if it parses untrusted text)
- [ ] Output changes: I read the golden diff
- [ ] No file contents, secrets or absolute home paths reach any output
- [ ] Numbers stay labelled estimates; unmeasured is never 0
- [ ] `CHANGELOG.md` / README updated if a flag or output changed
