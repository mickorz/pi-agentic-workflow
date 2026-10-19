# Testing

Research-stage: no automated tests yet. Chinese version: [zh-CN/testing.md](zh-CN/testing.md)

## Acceptance Checklist

- `ls dev-docs/` lists exactly the 9 category subdirectories.
- `docs/` and `docs/zh-CN/` stay in sync: same filenames and section structure.
- Links from `README.md` resolve.
- `thirdparties/`, `dev-docs/`, `dev-examples/` never appear in `git status`.

## Future

Once workflow scripts land, add a minimal end-to-end smoke run per workflow and document the expected output here.
