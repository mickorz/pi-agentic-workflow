# Getting Started

From zero to a working local checkout of this research project. Chinese version: [zh-CN/getting-started.md](zh-CN/getting-started.md)

## Prerequisites

- Git
- Node.js ≥ 20 (optional, only needed to run the third-party reference repos)

## Install

```bash
git clone https://github.com/mickorz/pi-agentic-workflow.git
cd pi-agentic-workflow
```

`thirdparties/` is git-ignored and never committed. Fetch the reference repos on demand:

```bash
git clone https://github.com/QuintinShaw/pi-dynamic-workflows thirdparties/pi-dynamic-workflows
git clone https://github.com/mickorz/opencode-dynamicworkflows thirdparties/opencode-dynamicworkflows
```

## Verify

```bash
ls thirdparties
# after fetching: opencode-dynamicworkflows  pi-dynamic-workflows
```

## First Run

This repo is research-stage: there is no runnable code yet. Start by reading the reference repos' docs:

- `thirdparties/pi-dynamic-workflows/README.md`
- `thirdparties/opencode-dynamicworkflows/README.md`

Research notes live in `dev-docs/research/` (not in git).

## Next Steps

- Guides: [how-to-guides.md](how-to-guides.md)
- Troubleshooting: [troubleshooting.md](troubleshooting.md)
