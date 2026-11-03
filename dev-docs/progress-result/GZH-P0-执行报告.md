# GZH-P0 执行报告(排版工作台工具闭环)

> 阶段:GZH-P0(方案 `dev-docs/planning/2026-11-03-GZH排版工作台执行方案.md` V2)
> 完成时间:2026-11-03
> 验收结论:**全绿**。T0.1 桥接 10/10、P0 API 套件 11/11、浏览器全栈 E2E 9/9、gzh 路由单测 10/10
> 问题与待确认清单:`dev-docs/progress/GZH-问题记录与待确认.md`

## 交付清单

| 模块 | 文件 | 说明 |
|------|------|------|
| 编辑器快照+补丁 | `thirdparties/huasheng_editor/`(app.js 1 行、index.html 1 行补丁) | 暴露组件代理 `window.editorVm`;bridge 先于 app.js 加载;README-PATCH 登记 |
| 编辑器桥 | `thirdparties/huasheng_editor/bridge.js` | 8 消息(6 基础 + export 请求/响应);hostedMode 存储隔离(Storage 原型补丁改道 sessionStorage);iframe 外零行为 |
| 服务端路由 | `src/server/gzh-routes.ts` | `/api/gzh/articles`(列表)、`/api/gzh/article`(加载+图片签名重写)、`/api/gzh/article/save`(锁+baseHash 409+双文件回滚)、`/api/gzh/article/export`(P2,layout.html)、`/gzh-img`(HMAC 签名图片,免 Bearer);article_lock.py 同协议锁;vault root 解析(env > .aws-article/config.json) |
| Web 前端 | `web/src/pages/GzhPreview.tsx`、`web/src/api/gzh.ts`、`web/vite.config.ts` | `/gzh-preview` 路由:文章列表/加载/双 dirty/保存/导出;vite `/huasheng` 静态映射 + `/gzh-img` 代理;editor:ready 双就绪注入(竞态修复 B1) |
| CLI | `src/cli/commands/web.ts` | vault root 自动解析注入,解析失败不阻塞启动 |
| 验收资产 | `dev-examples/gzh-preview/`(check_t01.mjs、run_p0_suite.py、check_e2e.mjs、run_p2_layout_test.py、make_fixture.py、test-host.html) | 可重复执行;真实验收用 DeepSeek 已入箱文章拷贝完成并记录后**已删除**(公开仓库隐私,见问题记录 A5);日常跑 `make_fixture.py` 合成夹具(要素等同),全部套件在合成夹具上复验全绿 |
| 单测 | `tests/unit/gzh-routes.test.ts` | 10 用例:鉴权/列表/加载重写/签名五连/保存往返/baseHash/style 独立/锁冲突+接管/逃逸+多候选/导出还原 |

## 验收结果(对照方案第七节)

| 项 | 结果 | 证据 |
|----|------|------|
| 图片一致性 | PASS | E2E:5 张图(含 2 GIF、中文文件名)全部 naturalWidth>0 |
| GIF | PASS | 签名路由 `image/gif` + `GIF8` 魔数;E2E 含 GIF:true |
| 保存一致性 | PASS | E2E:保存→关闭→重开,内容一致(diff 仅人工改动) |
| 未保存提醒 | PASS | contentDirty 触发 beforeunload 拦截(代码层);E2E dirty 指示亮起/清零 |
| 发布校验联动 | PASS | P0 套件:保存后 `check_state.py` 正常运行(prepare_ready=true,style 新字段不破坏) |
| 模板独立性 | PASS | 单测+套件双验证:只切主题 md 字节级不变,yaml 单 style 行 |
| 发布隔离 | PASS | `/api/gzh/publish` 404;gzh API 面无任何发布端点 |
| 路径安全 | PASS | `?dir=` 越界 403(resolve+realpath 双校验);图片文件名含路径 403 |
| 鉴权 | PASS | 错误 token 401;签名过期/篡改 403 |
| 自动套件 | PASS | T0.1 10/10、P0 套件 11/11、E2E 9/9 |

## 关键实现决策(偏离/细化方案处)

1. **注入竞态修复**(B1):宿主不再直接发送 `article:load`,一律等 `editor:ready` 与 article 双就绪(幂等键 `dir#ready`),防 fetch 快于 bridge 监听器注册时消息丢失;bridge ready 前消息排队兜底。
2. **`&amp;` 反转义**(B3):markdown-it 渲染 HTML 属性时转义 `&`,图片引用还原前必须先反转义,否则 f 参数解析失败。
3. **URL query 解析**(B2):`new URL` 首参必须补 `?`,否则 query 串被当路径。
4. 验收素材:真实已入箱文章(DeepSeek 篇)拷贝入 fixture;表格/引用/代码块由单测 fixture md 覆盖(真实文章无这些元素,markdown-it 标准渲染)。

## 回归

- 根仓库单测:512 用例,471 通过,**18 失败为存量**(HEAD 干净树复现,与本次无关;本次净增 10 用例全绿)。
- typecheck:0 错误。web vitest:13/13。web build:通过。
