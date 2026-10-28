# idea_files.py 状态持久化双重白名单——STATE_SETTABLE 与 YAML_KEYS 不同步会静默丢数据

> 沉淀日期：2026-10-28（WT-P1 交付，方案 V1.2 第七节风险 1 要求）

## 问题现象

给 `idea_files.py` 的 `state --set` 新增状态字段（如 `writingTemplate.id`）后：命令返回 `{"ok": true}`，看似写入成功；但重新读取 `article.yaml` 时新字段消失，任务恢复时绑定信息丢失，且全程无任何报错。

## 排查过程

1. WT 方案 V1.1 评审（第二轮）指出：`state --set` 走 `STATE_SETTABLE` 白名单校验（L133），通过后字段进内存 state dict——到此为止一切正常。
2. 读码发现序列化是**另一处独立白名单**：`render_state_yaml()`（L293）调用 `emit(state, YAML_KEYS, 0)`，`YAML_KEYS`（L99）是固定顶层键列表，**只输出列表内的键**——不在列表里的键被静默跳过。
3. 只加 `STATE_SETTABLE` 不加 `YAML_KEYS`：校验过、内存有、落盘丢。

## 根因

状态字段的"可写"与"可序列化"是两道独立闸门（校验白名单 + 序列化键序白名单），二者必须同步修改，缺一处即静默丢数据。这是把"字段集固定"同时当校验契约和序列化契约用带来的暗坑。

## 解决方案

1. `STATE_SETTABLE` 加点路径键（如 `writingTemplate.id: str`）；
2. **`YAML_KEYS` 必须同步加对应顶层键**（如 `"writingTemplate"`，注意是顶层键名不是点路径）；
3. 交付必须带落盘往返测试：`state --set` 三键 → `read article.yaml` → 断言字段与值逐字一致（已固化在 `template_store_Example.py` 的 `yaml.roundtrip-persisted` 断言）。

## 预防/注意事项

- 以后任何给 `article.yaml` 加状态字段的改动，检查清单第一条：**两处白名单都改了吗**。
- 旧任务无新键是合法状态（可选字段），`load_state_yaml` 缺键不报错，不要强制补空。
- 读写两端 js 侧解析顶层键时注意缩进：顶层键顶格（无缩进），子键两空格——正则写错缩进会导致绑定检测恒为 null，表现为"首次绑定逻辑跑到已绑定任务上"（WT-P1 门禁调试中实际踩到，W5 用例超时暴露）。
