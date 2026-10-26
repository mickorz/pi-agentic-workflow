# WX-P3.1 执行报告——预算上限提升 + 标题确定性优先级修复

日期：2026-10-26 ｜ 状态：代码与配置已交付；草稿标题线上更新待用户取消定时发布

## 背景（用户真机实测反馈两条）

1. **m00280**：「执行又出问题了 ⚠️ 已达单轮预算上限（llm_requests）」——实际任务成功（run-mvpdpav2-yj6o completed，7 agents，插图 7 张，草稿入箱，completed 通知已送达）；被拦停的只是会话循环（agent 模式单轮默认 maxLlmRequests=12，完整 prepare 全程 ~8.5 分钟必撞限）。
2. **m00343**：「发布的草稿把我原文标题改掉了」——插图工作流给无 article.yaml 的文章生成元数据时，LLM suggested_title 越权当选（根因与修复详见 `dev-docs/experience/2026-10-26-article-yaml-title-llm-overwrite.md`）。

## 交付内容

### 1. 标题确定性优先级（article_insert_images_meta.js）

- 扫描后确定性计算 `mdStem`（md 文件名去扩展名）；title 硬优先级：args.title > 原 yaml title > mdStem；suggested_title 仅兜底，禁止「原题不符」式替换；digest 同步收紧（原值保留，缺失才用建议）。无图早退路径输出 title 同步。
- 线上修复：轻食店文章 article.yaml title 已改回《订单暴涨10倍，月销10万+，一家轻食店是如何通过AI做到的》。
- pi-workflow validate 通过；P1 门禁不受影响（I2/I3 直调 insert_images.py / check_state.py，不经过该 JS 提示词）。

### 2. 服务单轮预算上限提升（wechat service）

- `service stop` + `start` 重建（restart 无法改参数），新增 `--agent-limits 60,100,900000`（LLM 请求 12→60、工具调用 20→100、时长 5→15 分钟）。
- 全部原 flags 保留：--registry am-p0/registry.json --scripts dev-examples --data .pi-wechat --routing-mode agent --auto-approve 6 流程白名单。
- 验证：PM2 online（pid 23781，restarts=0），ecosystem.config.cjs 落有 `"--agent-limits","60,100,900000"`，registry 22 条 sha 8b4c6bcb。

## 遗留与待办

- **草稿标题线上未更新**：重跑 publish.py 报 `errcode=53407: 定时发布中，无法删除或修改`（草稿已在后台设定时发布）。待用户取消定时后重跑 publish.py 即可（state 完好，自动走 draft_update，media_id 不变）。
- **worker 进程完成后不退出**：run-mvpdpav2-yj6o completed 但执行进程 pid 11033 残留（idle，经 PM2 subreaper 收养，PPID=God Daemon）。本轮 service stop 时随树清理；疑似 open handle 未关，待根因排查（不影响结果正确性，journal 已落终态）。
- 标题优先级修复目前只覆盖 article_insert_images_meta.js（prepare 链）；其它写 article.yaml 的链路（如 humanize/github-article）如有同类「LLM 可覆盖确定性字段」提示词，后续按同一原则收紧。
