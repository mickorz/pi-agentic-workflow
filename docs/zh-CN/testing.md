# 验收清单

研究阶段：暂无自动化测试。英文版见 [../testing.md](../testing.md)

## 验收检查项

- `ls dev-docs/` 恰好列出 9 个分类子目录。
- `docs/` 与 `docs/zh-CN/` 保持同步：同名文件、同章节结构。
- `README.md` 中的链接可正常跳转。
- `thirdparties/`、`dev-docs/`、`dev-examples/` 不出现在 `git status` 中。

## 未来计划

工作流脚本落地后，为每个工作流添加最小端到端冒烟运行，并在本文档记录预期输出。
