# P1a ObsidianService 手动测试指南

> 日期：2026-10-24 · 对应实现：Phase R/W/F/V（commits bfdabc9 → 3368fd0 → d2404c3 → 26bef95 → 5503b89）
> 覆盖：只读查询面（vault_query.py / obsidian Reader / obsidian-note-search）、写面（vault_writer.py / O_EXCL / 台账幂等 / unknown 人工核对）、权限隔离（capabilities+authorized 双门）、微信审批链真机验收（方案 §7.1–§7.5）
> 约定：每条用例给出**步骤 / 预期 / 证据**；结果记入文末测试记录表。时序难控的用例已程序化进 CI（`tests/unit/obsidian-*.test.ts`），本指南只保留需要人手与真机的部分。

## 0. 环境准备

```bash
cd <仓库根>                        # pi-agentic-workflow
npm ci && npm run build            # 必须先 build（全局命令指向 dist）
npm link                           # 全局命令 pi-workflow（符号链接，rebuild 后自动生效）
pi-workflow --version              # 验证可用
python3 --version                  # 后端要求 python3（纯标准库，无需 pip）
```

- 模型：**不传 `--model`**，默认模型读 `~/.pi/agent/settings.json`（`defaultProvider` + `defaultModel`）；换模型改该文件，不改命令。
- **vault 配置链**（读写后端共用，优先级从高到低）：
  1. `--vault-root` 旗标（仅后端直调）
  2. `OBSIDIAN_VAULT_ROOT` 环境变量
  3. 仓库根 `obsidian.config.json`（gitignored；键 `vault_root`、`scope_aliases`）
  4. 兼容 `dev-examples/wx-article/.aws-article/config.json`（现网真实 vault=坚果云同步目录）
- **台账位置**：`<配置根>/.obsidian-ops/ledger.jsonl`（配置根=第 3/4 层命中的目录；两目录均已 gitignore）。可用 `PI_OBSIDIAN_LEDGER_ROOT` 覆盖。
- 本指南 A/B 组用**临时 vault**（不碰真库）；C 组真机验收才写真实 vault（建议专用 `灵感/验收` 前缀，测完手动删）。

```bash
export MT=/tmp/mt-p1a-vault
mkdir -p "$MT/灵感" "$MT/公众号"
printf '# 种子笔记\n\n含有 p1a_unique_token 的正文。\n' > "$MT/灵感/种子笔记.md"
printf '# 入门笔记\n' > "$MT/公众号/AI入门.md"
```

## 1. 五分钟冒烟

```bash
python3 dev-examples/wx-article/scripts/draft_manager/vault_query.py \
  --action list --vault-root "$MT"
# 预期：{"ok": true, ..., "total": 2, ...items 含两条 .md}；exit 0

echo 冒烟内容 | python3 dev-examples/wx-article/scripts/draft_manager/vault_writer.py \
  --action create --rel 灵感/冒烟.md --operation-id smoke000000000001 \
  --vault-root "$MT" --ledger-root "$MT"
# 预期：{"ok": true, "action": "create", "status": "created", ...}
```

## 2. A 组：后端直测（python CLI，无需微信/模型）

### A1 配置链三层

```bash
# 层2：env
OBSIDIAN_VAULT_ROOT="$MT" python3 dev-examples/wx-article/scripts/draft_manager/vault_query.py --action list
# 层3：obsidian.config.json（在任意工作目录向上能找到仓库根时命中）
python3 dev-examples/wx-article/scripts/draft_manager/vault_query.py --action list   # 现网=真实 vault，只读安全
# 全部落空（模拟）
cd /tmp && OBSIDIAN_VAULT_ROOT= python3 <仓库根>/dev-examples/wx-article/scripts/draft_manager/vault_query.py --action list
```
预期：前两条 `ok:true` 且 vault_root 分别为 `$MT` / 坚果云路径；第三条 `ok:false`（issues 提示 vault 根未配置）。

### A2 查询面契约（list / read / search）

```bash
Q=dev-examples/wx-article/scripts/draft_manager/vault_query.py
python3 $Q --action list --vault-root "$MT" --limit 1          # truncated:true，items 按路径字典序
python3 $Q --action read  --vault-root "$MT" --path 灵感/种子笔记.md   # 全文+size
python3 $Q --action search --vault-root "$MT" --query P1A_UNIQUE_TOKEN  # 大小写不敏感命中 1
python3 $Q --action search --vault-root "$MT" --query 什么都没有的词    # total:0, ok:true
python3 $Q --action list --vault-root "$MT" --budget-ms 0        # truncated:true + truncated_reason:"scan_budget"
python3 $Q --action read  --vault-root "$MT" --path ../secrets.md       # ok:false（拒绝越界）
```
预期：与注释一致；`read` 超 512KB（自造大文件验证）报 `ok:false` 且 issues 带实际尺寸。

### A3 O_EXCL 排他 + 冲突

```bash
W=dev-examples/wx-article/scripts/draft_manager/vault_writer.py
echo 第一次 | python3 $W --action create --rel 灵感/排他.md --operation-id excl000000000001 --vault-root "$MT" --ledger-root "$MT"
echo 第二次 | python3 $W --action create --rel 灵感/排他.md --operation-id excl000000000002 --vault-root "$MT" --ledger-root "$MT"
```
预期：第一次 `created`；第二次 `ok:false, code:"conflict"`（绝不覆盖）；文件内容仍是「第一次」。

### A3b 父目录自动创建（话术「保存到灵感」结构）

```bash
echo 测试 | python3 $W --action create --rel "灵感/为什么学了那么多AI框架还是做不出产品/idea.md" \
  --operation-id mkdir00000000001 --vault-root "$MT" --ledger-root "$MT"
```
预期：`status:"created"`，`灵感/为什么学了那么多AI框架还是做不出产品/` 目录自动生成；再以不同 operationId 同 rel 创建 → `conflict`（文件级 O_EXCL 不变）。

### A4 幂等（同 operationId 同内容重试）

```bash
echo 幂等内容 | python3 $W --action create --rel 灵感/幂等.md --operation-id idem000000000001 --vault-root "$MT" --ledger-root "$MT"
echo 幂等内容 | python3 $W --action create --rel 灵感/幂等.md --operation-id idem000000000001 --vault-root "$MT" --ledger-root "$MT"
echo 篡改内容 | python3 $W --action create --rel 灵感/幂等.md --operation-id idem000000000001 --vault-root "$MT" --ledger-root "$MT"
```
预期：第一次 `created`；第二次 `status:"idempotent"`（台账 done 命中，**零重复写**，mtime 不变）；第三次 `ok:false`（同键不同内容拒绝复用）。

### A5 unknown：started-无-done → 人工核对

```bash
python3 - << 'PY'
import json, os
p = os.path.join(os.environ["MT"], ".obsidian-ops", "ledger.jsonl")
rec = json.dumps({"ts": "2026-10-24T00:00:00Z", "event": "started",
                  "operationId": "dead000000000001", "action": "append",
                  "rel": "灵感/悬置.md", "contentDigest": "x", "bytes": 1})
open(p, "a", encoding="utf-8").write(rec + "\n")
PY
echo 再写 | python3 $W --action append --rel 灵感/悬置.md --operation-id dead000000000001 --vault-root "$MT" --ledger-root "$MT"
```
预期：`ok:false, code:"unknown"`，issues 含「人工」核对提示且给出台账路径；**该次不写文件**（手工核对台账后另行处理）。

### A6 台账核对通道

```bash
python3 $W --dump --ledger-root "$MT"
```
预期：`{"ok": true, "ledger": ".../.obsidian-ops/ledger.jsonl", "events": [...]}`；每个成功写操作 `started→done` 成对；缺 `--action` 且非 dump 时报 invalid 提示。

## 3. B 组：workflow 层（CLI，无需微信；检索用例会调模型）

### B1 capabilities 元数据校验

```bash
pi-workflow validate dev-examples/wx-article/scripts/obsidian_note_create.js
pi-workflow validate dev-examples/wx-article/scripts/obsidian_note_search.js
```
预期：均 `valid:true`；create/append 的 meta 含 `capabilities:['obsidian-write']`，search 无该字段。

### B2 只读 workflow 可直跑（Reader 注入全局）

```bash
cd dev-examples/wx-article
OBSIDIAN_VAULT_ROOT="$MT" pi-workflow run scripts/obsidian_note_search.js \
  --args '{"query":"p1a_unique_token","scope":"灵感"}'
```
预期：✅ 完成，agents:1；result 含 `ok:true, total:1`，items[0].path=`灵感/种子笔记.md`。

### B3 写 workflow 直跑被拒（§3 权限隔离负例）

```bash
OBSIDIAN_VAULT_ROOT="$MT" PI_OBSIDIAN_LEDGER_ROOT="$MT" pi-workflow run scripts/obsidian_note_create.js \
  --args '{"rel":"灵感/直跑.md","content":"x","operationId":"clitest00000001"}'
```
预期：❌ `ReferenceError: obsidianWrite is not defined`——CLI run 不经审批链（无 authorized），能力门不注入写面；**这是设计行为**，写面唯一入口=微信审批链（C 组）。

## 4. C 组：微信审批链真机验收（方案 §7.1/§7.2/§7.3）

> 前置：真实 vault（`.aws-article/config.json` 已指向坚果云）；手机微信已扫码登录（登录与消息格式详见 `dev-docs/guides/2026-10-21-wechat-input-formats.md`、`dev-docs/guides/2026-10-21-am-p0-manual-test.md`）。

### C0 启动

```bash
cd <仓库根>
pi-workflow wechat start --registry dev-examples/wx-article/registry.json \
  --scripts dev-examples/wx-article --data .pi-wechat
# （或 am-p0 registry：--registry dev-examples/am-p0/registry.json --scripts dev-examples）
```

### C1 保存灵感 → 审批卡 → 批准 → O_EXCL 创建（§7.1）

1. 微信发消息（话术供参考，路由靠 keywords/description）：
   「保存灵感：AI 工作流三要素=触发+工具+审查；写到 灵感/验收-三要素.md」
2. 预期收到审批卡：`⏳ 待审批流程 / 流程：obsidian-note-create / 目标：灵感/验收-三要素.md / 操作：创建笔记（内容摘要 xxxxxxxx） / 预览：…≤80字… / 编号：pa-xxxx`
3. 回复「批准」。
4. **证据**：
   - 微信收到创建确认（含真实文件位置 rel）；
   - `ls "<vault>/灵感/验收-三要素.md"` 存在且内容逐字与消息一致；
   - 台账 `python3 <仓库根>/dev-examples/wx-article/scripts/draft_manager/vault_writer.py --dump --ledger-root dev-examples/wx-article` 出现 `started→done`（operationId 与审批一致）。

### C2 冲突检查（§7.1 前半）

把 C1 同样消息**原样再发一次**。
预期：预检命中「目标笔记已存在（O_EXCL 将拒绝创建），未创建审批」——不出现新审批卡。

### C3 微信搜笔记（§7.2）

微信发：「搜笔记：三要素」
预期：直接执行（read-only 无审批），回复命中列表，第一条含 `灵感/验收-三要素.md`——**检索到刚创建的内容**。

### C4 幂等重试（§7.3）

1. 重复「批准」同一条审批（或断电/重启进程后重发同样灵感消息再批准）。
预期：审批级 `alreadyExecuted`（不二次启动、runId 同前）；若消息内容完全一致则审批项去重复用。
2. 台账层面复核：同一 operationId 只有一对 `started/done`，文件未被重复写（`--dump` 只有一条 done；文件尾部无重复段落）。

### C5 追加笔记（append 审批链）

微信发：「追加笔记 灵感/验收-三要素.md：补充——审查环节必须确定性门禁」→ 审批卡 `操作：追加内容（内容摘要 …）` → 批准。
预期：文件尾部出现追加段；台账新增 append 的 `started→done`。追加不存在的笔记 → 预检直接拒绝，不建审批卡。

## 5. D 组：同步语义与平台（§7.4 / Windows）

- **本机断言**（C1 完成即成立）：写入落在坚果云 CloudStorage 目录，云盘接管同步。
- **跨机断言**：在第二台设备（含 Windows 机）等待同步完成后，Obsidian/文件系统可打开 `灵感/验收-三要素.md` 且内容一致；顺手在 Windows 机跑 `python3 dev-examples/wx-article/scripts/draft_manager/run_resolver_suite.py` 补 Phase 0 Windows 闸门。
- 平台差异（信号/进程语义）见 `dev-docs/experience/windows-signal-semantics-stop.md`；Windows 不适用的信号用例输出 SKIP 属预期。

## 6. 回归门禁（改代码后必跑）

```bash
npm run build && npm test          # 预期 393 tests，392 pass，0 fail，1 平台 SKIP
python3 dev-examples/wx-article/scripts/draft_manager/run_resolver_suite.py   # PASS=18 FAIL=0 SKIP=1
```

## 7. 测试记录表

| 用例 | 日期 | 结果 | 备注/证据 |
|---|---|---|---|
| A1 配置链 | | | |
| A2 查询契约 | | | |
| A3 O_EXCL | | | |
| A4 幂等 | | | |
| A5 unknown | | | |
| A6 台账 dump | | | |
| B1 validate | | | |
| B2 检索直跑 | | | |
| B3 写面直跑被拒 | | | |
| C1 保存灵感全链 | | | |
| C2 冲突检查 | | | |
| C3 搜笔记 | | | |
| C4 幂等重试 | | | |
| C5 追加 | | | |
| D 跨机/Windows | | | |
