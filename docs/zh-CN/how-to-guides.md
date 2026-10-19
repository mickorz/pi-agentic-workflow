# 操作指南

英文版见 [../how-to-guides.md](../how-to-guides.md)

## 新增参考仓库

```bash
git clone <上游地址> thirdparties/<仓库名>
```

仓库较大时可加 `--depth 1`。`thirdparties/` 永远不提交。

## 记录调研笔记

新建 `dev-docs/research/YYYY-MM-DD-<主题>.md`，建议结构：问题 → 方法 → 发现 → 结论。记录所研究的上游 commit。

## 试验毕业流程

1. 在 `dev-examples/<主题>/` 中验证通过。
2. 将成果合入正式目录。
3. 读者需要了解时，在 `docs/` 补充文档（英文 + zh-CN）。
4. 删除沙盒中对应目录。
