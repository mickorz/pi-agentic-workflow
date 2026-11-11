# xiaolvshu 踩坑清单（pitfalls）

规划/制作/审图/发布各阶段的"必须避免"。每条：现象 -> 一句话解法（-> 全文）。新坑按编号追加，首发实战（mcode-stack 2026-11-10）提纯为主。

## 规划阶段

1. **标题超 20 字**：微信小绿书后台标题上限 20 字，draft/add 接口不拦（32 字曾入箱成功）、后台编辑/发表才拦——接口不报错不等于规则不存在。-> 三处护栏已就位（publish.py STICKER_TITLE_MAX / validate_pages.py TITLE_MAX / 规划提示词），规划时直接按 <=20 字写，定稿前 `len()` 一下。（dev-docs/experience/xiaolvshu-title-limit-20.md）

2. **大字行孤字尾行**：h-display 固定 124px 约 7 汉字/行、quote 64px 约 13 字/行，超容量的行自动折行，常出"末行只有 1~2 字"的硬伤（首发"合集/地/惯。"三条）。-> 规划阶段按容量手工断行（字段里写 \n），断在语义边界，品牌名不拆行，末行 >=4 字。（dev-docs/experience/sticker-cover-title-newline-collapsed.md）

3. **以为注入器会自动缩字号**：封面靠 --chars 自适应，其余 display 字段固定 124px 不缩——"每张卡自行 inline 调字号"是模板设计约定，注入器不会替你缩。-> 文案长度在规划阶段管住，别指望渲染端兜底。（同上）

4. **pages.json.title 与 --title 不一致**：两者都进发布 hash，不一致会让下次不带 --title 的重跑 hash 漂移，触发一次毫无内容的 draft_update（重传全部素材）。-> 改标题时两处一起改；发布后核一眼 publish-state.json 的 hash 来源。（dev-docs/experience/xiaolvshu-title-limit-20.md）

## 制作阶段

5. **截图页用过扁横幅**：宽高比 >2:1 的 banner（如仓库 hero 图）contain 进 3:4 卡片只剩一条细带，等于没放。-> 过扁图直接不用；大地图类素材定位成"概览页"（列标题可读、图注承载要点）并在规划时想清楚。（首发实战，AP-S1-执行报告）

6. **render.mjs 多次 --only 只有最后一个生效**：`--only xhs-01 --only xhs-02` 只渲 xhs-02。-> 多页重渲逐条跑（每页一条命令）。（首发实战）

7. **normalize_cards 的 --cards-dir 传错层级**：传成文章目录会把 render 产物路径找成 `<文章目录>/render/`，全页报"渲染产物缺失"，且旧 manifest 已被挪走。-> 该参数传 `<文章目录>/_cards`；失败后重跑 normalize 即恢复。（首发实战）

8. **pages.json 改了但没重 normalize**：manifest 与 pages sha 绑定，不重绑则 verify/发布门直接拒。-> pages.json 任何变更后按序：build_html -> render（变更页）-> normalize -> 受影响页 mark_review -> verify。（首发实战；normalize 对未变页幂等继承审核）

9. **弱网下字体内嵌渲染超时**：render.mjs 默认内嵌 Noto Serif SC，下载可超 5 分钟。-> 直接 `--no-embed`（浏览器在线字体渲染），产出合规；离线确定性链路（mock/冒烟）一律 --no-embed。（首发实战）

## 审图阶段

10. **审图 agent 误读"缺字/截断"**：读图 OCR 假阴性率高（首发 5 判 4 误："合集/地/惯。"全部实际完好），直接采信会白白重渲甚至改错文案。-> 凡"疑似缺字/截断"，亲自开图逐字转录核验后才可采信；核验通过即推翻，notes 写明核验方式。（dev-docs/experience/sticker-review-agent-misread-truncation.md）

## 发布阶段

11. **跳过 prepare 直接 execute**：execute 必须带 `--approval <指纹>`，指纹来自 prepare 且绑定 pages/manifest/图片/标题/配文/账号——内容任一变化旧指纹作废。-> 流程固定为 prepare -> 人工批准 -> 同参数 execute；改了任何内容就重新 prepare。（T5 设计，P0-1）

12. **盲目重试 UNKNOWN**：发布网络不确定时 publish.py 进 pending 保护，自动重试可能重复入箱。-> 按 [HOLD]/pending 提示人工核对草稿箱，`--resolve-media-id <id>`（已产生草稿）或 `--clear-pending`（未产生）恢复后再重跑。（AP-S0/AP-S1 设计）

13. **后台定时发布锁草稿**：草稿在后台被设了定时发布后被微信锁定，draft_update 报 errcode 53407。-> 先在后台取消定时再更新。（gzh-article-craft G.5 同款坑，newspic 同理）

## workflow / CLI 层

14. **resume 时多个 readline 抢输入**：管道喂多个 y 时第二个 readline 面对已 EOF 的 stdin，进程退出停回等待态。-> `printf 'y\n' | pi-workflow resume <runId> --yes`：--yes 跳过副作用窗口确认，全流程只剩 checkpoint 一个 readline。（dev-docs/experience/pi-workflow-non-tty-checkpoint-pipe.md）

15. **command 节点无输出超时就加超时/重起**：往往是瞬超时（首发 validate_pages 180s 超时，同命令手动秒过）。-> 先手动复跑同一命令，秒过即直接 `pi-workflow resume <runId> --non-interactive`（journal 回放已完成节点，不重跑 LLM 不重复副作用）；复现才查环境。（dev-docs/experience/sticker-runner-probe-transient-timeout.md）

16. **--json 输出中文解析失败**：GBK 代码页终端下 --json 的中文可能混入导致 json.loads 失败。-> 先 `pi-workflow status <runId>` 确认实际状态，别只信 stdout。（dev-docs/experience/pi-workflow-non-tty-checkpoint-pipe.md）

17. **display 标题字段换行被吞**：注入器 display 级字段必须走 esc_multiline（\n -> <br>），esc() 会把 \n 折叠成空格，封面"三行设计"变自然折行、品牌名被拆（已修复：components.py 三处）。-> 新增组件片段时 display 字段一律 esc_multiline，esc 只给单行小字。（dev-docs/experience/sticker-cover-title-newline-collapsed.md）

18. **双源漂移**：页面规划规范同时活在 skill（规范源）与 workflow 规划 agent 提示词（执行快照）里。-> 改规划规范先改本 skill，再对照同步 wechat_sticker_cards.js 提示词并重过 Gate B；发现两边不一致以 skill 为准并登记修正。
19. **图形页图比例 ≠ 图框比例**：screenshot 组件嵌竖版/异比例图会三连坑——gz CSS 默认 object-fit:cover 裁切、well 3x4（1205px）加上标题区超出 1440 画板底部被裁、fit 缩放后图内小字不可读。-> 图形页资产先定 well 比例再按同比例画图；**well_ratio=1x1 + 正方形图（800x800 viewBox / 1600x1600 PNG @2x）是竖版图形页最稳组合**（比例相同 = contain/cover/fill 等价，免疫一切 fit 坑）。（dev-docs/experience/sticker-graphic-page-ratio-font-cache.md）
20. **render.mjs 字体内嵌下载超时**：字体内嵌要从 raw.githubusercontent.com 拉 Noto Serif/Sans SC，国内直连超时，workflow 里 300s 强杀直接 fail。-> 走代理预下载 9 个 TTF 到 `~/.cache/guizang-design/fonts/<pin 前12>/ofl/...`（文件名把 `[` `]` 换 `_`），并 mkdir `<skill>/fonts/`（fetchFont 首次要写 lock.json）；预置后 embed 全程离线。或临时 `--no-embed` 降级。（dev-docs/experience/sticker-graphic-page-ratio-font-cache.md）
21. **像素取证不要手写 PNG 解码器**：手写 zlib unfilter + 裁剪重编码链路产出损坏文件（zai 看到尺寸错乱+纯黑），此前"琥珀 0 像素"结论亦不可信。-> 卡片像素统计用 chrome canvas getImageData（页面 evaluate 内解码，100% 可靠）；zai 对变形拉伸图的"重复实例/截断"判定需封闭式三问 + 结构性修复（比例匹配）兜底，不依赖单次视觉判断。（同上）
