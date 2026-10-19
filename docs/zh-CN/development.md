# 贡献者指南

本调研仓库的开发约定。英文版见 [../development.md](../development.md)

## 仓库约定

- 读者向文档放 `docs/`，进 git（英文 + zh-CN，同名同结构）。
- 开发过程文档（设计、调研、计划、进度）放 `dev-docs/`，不进 git。
- 试验与临时产物放 `dev-examples/`，不进 git。
- 完整规则见 [CLAUDE.md](../../CLAUDE.md)

## 调研工作流

1. 调研发现、对比与想法记录到 `dev-docs/research/`。
2. 可执行的设计方案移入 `dev-docs/design/`。
3. 里程碑通过 `dev-docs/progress/` 与 `dev-docs/progress-result/` 跟踪（每阶段一份独立报告）。
4. 踩坑与解决方案沉淀到 `dev-docs/experience/`。

## 提交规范

简短的祈使句标题；相关文件合并为一个提交。
