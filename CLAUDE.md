# wpp-bot

## Agent skills

This repo uses the [mattpocock/skills](https://github.com/mattpocock/skills) engineering set as the **primary** workflow (installed under `.claude/skills/`). The `superpowers` plugin stays available as a fallback; when both offer an equivalent, prefer the Matt Pocock skill.

Idea→ship spine: `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement` → `/tdd` → `/code-review`. Router: `/ask-matt` when unsure which skill fits.

### Issue tracker

Issues are tracked as GitHub issues on `LeoAlvarenga404/wpp-bot` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.
