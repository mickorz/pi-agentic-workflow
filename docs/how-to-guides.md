# How-To Guides

Chinese version: [zh-CN/how-to-guides.md](zh-CN/how-to-guides.md)

## Add a reference repo

```bash
git clone <upstream-url> thirdparties/<repo-name>
```

Use `--depth 1` for large repos. Never commit `thirdparties/`.

## Record a research note

Create `dev-docs/research/YYYY-MM-DD-<topic>.md`. Suggested structure: question → method → findings → implications. Note the upstream commit you studied.

## Promote an experiment

1. Validate in `dev-examples/<topic>/`.
2. Land the result in the main tree.
3. If readers need it, document in `docs/` (English + zh-CN).
4. Delete the sandbox directory.
