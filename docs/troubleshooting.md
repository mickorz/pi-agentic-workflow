# Troubleshooting

Chinese version: [zh-CN/troubleshooting.md](zh-CN/troubleshooting.md)

## thirdparties/ is missing after clone

Expected: `thirdparties/` is git-ignored. Re-clone manually — see [getting-started.md](getting-started.md).

## dev-docs/ or dev-examples/ disappeared

Both are git-ignored and exist only on machines that created them. Recreate the structure per [CLAUDE.md](../CLAUDE.md); their content is not recoverable from git.

## Reference repo behavior does not match its docs

The two reference repos track upstream at different versions. Pin the exact commit you studied in your research notes (`dev-docs/research/`).
