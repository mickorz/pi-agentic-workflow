# WX-MOCK Gate B：路由关键词分词 OR 语义与 RUNNER 退出码透传（小绿书卡片化 T6）

- 日期：2026-11-06
- 场景：小绿书卡片化 T6（工作流 wechat_sticker_cards.js 注册 + Gate B 三场景）
- 相关：`dist/gateway/wechat/route-stub.js`、`dist/dispatch/intent-router.js`（IR-007 白名单）、
  方案 `dev-docs/planning/2026-11-05-小绿书卡片化接入执行方案.md`

## 坑 1：route-stub 关键词是"分词 OR 检索"语义，规则关键词必须互斥

**现象**：三步场景里 C1（关键词 gatbf1）与 C2（关键词 gatbdup）互斥不相似，但 C2 的消息
"banana-fry 重复防护" 被 **apple-pie 规则**（C1 的规则）命中——C2 跑成了 full 全链。

**根因**：route-stub 的 ifPromptContains 匹配**不是整串子串**，而是按空格**分词后逐词
query-contains-keyword 检索**（与生产 Router 的 keyword 检索同语义，见 P1.6 教训）。
规则 1 关键词 "小绿书卡片GateB mockstikercards" 分词后含 "小绿书卡片GateB"，
C2 消息以 "小绿书卡片GateB" 开头 → 含该词 → 命中规则 1。

**解决**：同一场景多步骤的关键词必须**互斥且语义无关联**（用 apple-pie/banana-fry/cherry-ice
这类毫无关联的词），并从场景 vars 里删掉会被全局替换干扰的通用词。

**预防**：写多步 WX-MOCK 场景时，先看 `route-stub.js` 的匹配实现再定关键词；
每步关键词用毫无关联的专有标记词（如场景名缩写+序号但避免公共前缀——公共前缀
gatbf1/gatbdup/gatbu 也误命中过，前 3 字符 gate 相同仍算"相似"）。

## 坑 2：node -e RUNNER 把非 0 退出码统一映射成 1，吞掉 UNKNOWN 语义

**现象**：fixture 经 RUNNER 调 publish_sticker_cards（UNKNOWN rc=2），fixture 断言
`exitCode !== 2` 失败——实际拿到 1。

**根因**：RUNNER（node -e 包装 python）`process.exit(r.status === 0 ? 0 : 1)`——
UNKNOWN=2 被折叠成 1，上层无法区分 UNKNOWN 与 FAILED。

**解决**：`process.exit(r.status)` 透传原码；上层 `exitCode === 0` 判成功、其他值按语义区分。

**预防**：凡"退出码携带语义"的链路，包装层必须透传原码；测试断言要覆盖语义码（如断言
UNKNOWN 场景 rc===2），否则映射 bug 会被"全绿"掩盖。

## 坑 3：workflow 运行时是 ESM 沙箱，顶层 require 不可用

**现象**：fixture 顶层 `require("zlib")`/`const make_png = ...`（隐式全局）在 workflow
运行时抛 `require is not defined` / 严格模式赋值错误。

**根因**：workflow 脚本经 `parseWorkflowScript`（ESM 解析 + meta 提取）后放入 **vm 沙箱**
执行（无宿主内建注入）；顶层 require 不存在，严格模式禁止隐式全局。

**解决**：文件/PNG 操作全部放进 `node -e` 子进程脚本（子进程有完整 require）；fixture
工作流里变量全部显式声明。

**预防**：workflow/fixture 脚本里出现顶层 require 一律视为错误；静态检查法——
`node -e "new Function(...)"` 语法检查 + grep 顶层 require。

## 坑 4：WX-MOCK 多步场景的服务状态残留（未完全定案，绕过方案有效）

**现象**：三步场景中 C2 命中了 C1 的路由规则（坑 1）、且出现完成消息丢失等诡异现象；
把三步拆成三个独立单步场景后全部稳定通过。

**结论**：多步场景下 route-stub/服务存在某种状态残留或匹配干扰（未深挖根因）。
**绕过**：Gate B 场景拆成"一个场景一个确定性断言"的单步形态（本来就是合法形态）。

**预防**：需要多断言时优先拆多个单步场景文件；多步场景仅用于步骤间有真实状态依赖的用例。

## 相关文件

- `dev-examples/manual-test/wechat-mock/scenarios/fixtures/mock-sticker-cards.js`
- `dev-examples/manual-test/wechat-mock/scenarios/sticker-cards-{full,duplicate,unknown}.json`
- `dev-examples/wx-article/scripts/wechat_sticker_cards.js`（正式工作流）
