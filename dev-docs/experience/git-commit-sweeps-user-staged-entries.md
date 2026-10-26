# git commit 误卷入用户暂存区条目（两次同款事故）

## 问题现象

仓库里存在**用户预先暂存**的条目（`M .gitmodules`、`A thirdparties/wewrite` 子模块，用户 m00105 要求加入、明确保留 staged 等 commit）。

Agent 完成自己的功能改动后执行：

```bash
git add <自己的 8 个文件>
git commit -m "..."        # ← 裸 commit，把 index 里全部内容（含用户暂存）一起提交
```

结果 commit 里混入 `.gitmodules` + `thirdparties/wewrite`（gitlink mode 160000）。

- 第 1 次：VR 阶段 A（commit 误含 escape symlink mode 120000 + 用户暂存，amend 又卷入 → 最终 `git reset --soft b30ca1d` 后 path-scoped 重提交）。
- 第 2 次：VR 阶段 D（commit 46961fb 误含用户暂存 → `git reset --soft HEAD~1` 后 pathspec 重提交为 6ba2d82）。

两次都靠 soft reset + 按路径提交修复，未丢任何内容；但这是重复踩坑，必须预防。

## 排查过程

`git commit` 提交的是**整个 index**，不是"我刚 add 的那些文件"。`git status --short` 里第一列为 M/A 的都是已暂存条目——裸 commit 会一并带走。

## 根因

1. 裸 `git commit -m` 没有 pathspec，语义是"提交 index 全部"。
2. 提交前只看了自己改动的文件清单，没有检查 `git status` 是否已有**他人/用户的暂存条目**。
3. 一次 `git commit --amend` 修复时引入了新的暂存内容，越修越乱。

## 解决方案

修复（历史 commit 已污染时）：

```bash
git reset --soft HEAD~1            # 回退 commit，全部内容回到 index（含用户暂存，原样保留）
git commit -m "..." -- <path1> <path2> ...   # pathspec 提交：只提交自己的路径
git status --short                 # 验证：用户暂存条目（M/A 第一列）原样保留
git show --stat HEAD               # 验证：commit 只含自己的文件
```

预防（以后一律这样做）：

1. **commit 前必查 `git status --short`**：只要第一列（staged）存在非自己 add 的条目，禁用裸 commit。
2. **一律用 pathspec commit**：`git commit -m "..." -- <明确路径列表>`，即使 index 干净也保持习惯（显式优于隐式）。
3. **修复已污染 commit 永远不要用 amend**，amend 同样吃整个 index；用 `reset --soft` + pathspec commit。
4. 提交后立即 `git show --stat HEAD` 核对文件清单再继续。

## 预防/注意事项

- 该仓库是长期多主体协作仓库：用户会提前暂存内容（如子模块 wewrite），Agent 的 commit 必须与用户暂存严格隔离。
- pathspec commit 提交的是这些路径的**工作树当前状态**；确保 add 过且工作树无后续未暂存修改，或先 `git add` 再 pathspec commit。
- Windows 检出风险：永远不要把 symlink（mode 120000）或非预期 gitlink（160000）提交进库。
