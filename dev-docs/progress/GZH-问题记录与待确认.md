# GZH 排版工作台:问题记录与待确认清单(P0/P1/P2 执行期,2026-11-03)

> 执行中遇到/遗留的全部问题集中在此,供最终人工确认。全部自动化验收均为绿
> (T0.1 桥接 10/10、P0 API 套件 11/11、浏览器全栈 E2E 9/9、P2 layout mock 6/6、
> gzh 路由单测 10/10、web vitest 13/13)。

## A. 需要用户拍板/操作的遗留项

| # | 事项 | 说明 | 建议 |
|---|------|------|------|
| A1 | **P2 微信真机验证未做** | `publish.py --html-file`(layout 模式)只过了 mock;微信 API 对 markdown-it HTML 的**样式保留度、连续图 grid 布局、GIF** 表现未知(风险 R4) | 挑一篇文章:`/gzh-preview` 导出 layout.html → `publish.py --html-file layout.html` 真机入一次草稿箱 → 手机端比对;不达标则 P2 降级回 P0 定位(主题仅预览) |
| A2 | **导出 HTML 未做 grid→table 转换** | huasheng 的 `copyToClipboard` 有公众号兼容转换(grid→table、section 背景包裹、代码块简化),但导出走的是 `renderedContent` 原文。公众号不支持 CSS Grid(huasheng CLAUDE.md 明确) | A1 真机验证若图片布局乱,在 bridge export 里补 `convertGridToTable`(改动小,vm 方法现成) |
| A3 | **真实 vault 端到端未跑** | 全部验收基于 fixture(DeepSeek 已入箱文章的**拷贝**,原库未动)。真实坚果云 vault 的路径/权限/obsidian 并发未实测 | 在真实文章上走一遍 G.5 排版审阅流程 |
| A4 | 代码未提交 | 全部改动在工作树待 commit(变更清单见 GZH-P0-执行报告.md) | 确认后提交 |
| A5 | **真实文章拷贝已从工作区移除(隐私)** | 本仓库 remote 为公开 GitHub;真实文章全文/图片/草稿 ID 不能入库。真实验收已完成后删除拷贝,`fixture-vault/` 已 gitignore,套件改跑 `make_fixture.py` 生成的合成夹具(同要素:5 图含 2 GIF/中文文件名/表格/引用/代码块/drafted 状态),全部套件在合成夹具上复验全绿 | 无需动作;换机器跑套件会自动生成合成夹具 |

## B. 执行中发现并已修复的问题(留档)

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| B1 | E2E reload 后内容丢失(首次偶现) | 竞态:fetch 命中缓存秒回,宿主在 bridge 注册监听器之前 postMessage,消息丢失 | 宿主一律等 `editor:ready` 才注入(双就绪 effect + 幂等键),bridge 侧 ready 前消息排队兜底 |
| B2 | 保存后签名 URL 残留 | `new URL("d=1&f=2", base)` 把 query 当**路径**解析,searchParams 全空 | 补前导 `?` 再解析 |
| B3 | 导出 layout.html 仍含签名 URL | markdown-it 渲染 HTML 属性时把 `&` 转义为 `&amp;`,f 参数键变成 `amp;f` | 还原前 `&amp;` → `&` |
| B4 | yaml style 双追加 | append 分支 push 一次、concat 又一次 | 重写为单分支 + 尾空行归一 |
| B5 | P0 套件抓不到 token(两种) | ① banner 是**全角冒号**`）:`,ASCII 匹配落空;② readline 阻塞死锁 | 正则 `Bearer\s+hex` 抓取 + 后台线程收输出 |
| B6 | 僵尸 Server 占端口导致套件假失败 | 前次超时运行未清进程 | 套件失败时先查端口占用;跑套件前 `Get-NetTCPConnection` 清场 |
| B7 | 编辑误替换 publish.py `--clear-pending` 参数 | edit oldText 选错锚点 | 已恢复,`py_compile` 验证 |

## C. 认知修正(与设计文档/假设不符的事实)

1. **主题键名**:styles.js 实际 18 个键(`wechat-ft`/`wechat-anthropic`/`latepost-depth`/`warm-docs`...),非设计文档所述 13 个及 `medium`/`ai-coder` 简写;SKILL.md 推荐表已用实际键名。
2. **localStorage 时序**:huasheng 的持久化读取发生在 app.js 同步执行链(mounted 前段),bridge 必须在 app.js **之前**加载才能做 hosted 隔离——已实现(index.html 补丁插在 app.js 前)。
3. **publish 复用语义**:同内容复跑打印 `[5] DRAFT OK ...(reuse, verified)`,不是静默——P2 测试初版断言按"无 DRAFT OK"写,判错实现;已修正为断 reuse 标记。
4. **存量单测失败 18 个**:HEAD 干净工作树同样失败(idea-article/write/symlink/writeEcosystemConfig 系列),与本次改动无关;本次净增 10 个单测全绿。

## D. 明确不做/后议(按方案既定边界)

- T2.3 主题自动推荐与收藏:依赖 P2 真机验证结论,后议。
- 生产模式静态部署(Fastify serve web/dist + /huasheng):P0 以 vite dev 验收,部署需求出现时再做(方案 4.2 已留位)。
- huasheng index.html 引 Google Analytics(gtag,正式域名才统计):本地 dev 无影响,不处理。
- AI 排版质量检查(P3 级):未启动。
