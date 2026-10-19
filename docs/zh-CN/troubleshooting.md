# 常见问题排查

英文版见 [../troubleshooting.md](../troubleshooting.md)

## clone 之后 thirdparties/ 不见了

符合预期：`thirdparties/` 被 git 忽略。手动重新克隆即可，见 [getting-started.md](getting-started.md)。

## dev-docs/ 或 dev-examples/ 消失了

两者都被 git 忽略，只存在于创建它们的机器上。按 [CLAUDE.md](../../CLAUDE.md) 重建目录结构；其内容无法从 git 恢复。

## 参考仓库行为与文档不一致

两个参考仓库跟随不同版本的上游。在调研笔记（`dev-docs/research/`）中固定你实际研究的 commit。
