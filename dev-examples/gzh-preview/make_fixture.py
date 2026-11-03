#!/usr/bin/env python3
"""GZH 排版工作台验收夹具生成器(合成文章,隐私安全)。

背景:真实已入箱文章(DeepSeek 篇)仅用于一次性真实验收(报告已记录);仓库公开,
真实文章全文/图片/草稿 ID 不得入库,故套件日常跑合成夹具——覆盖同样的要素:
封面图/多图/GIF(可渲染)/表格/引用/代码块/中文图片文件名/publish-state(drafted)。

用法:python dev-examples/gzh-preview/make_fixture.py [--force]
输出:[OK] fixture ready: <路径>(已存在且未 --force 时 [SKIP])
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixture-vault" / "单篇" / "20261102-DeepSeek超级智能体"

# 1x1 透明 PNG / GIF(浏览器可正常渲染,naturalWidth=1)
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAB"
    "h6FO1AAAAABJRU5ErkJggg=="
)
GIF = base64.b64decode("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==")

MD = """# 一句话解释DeepSeek刚开源的超级智能体super-agent

![文章封面](imgs/cover-超级智能体.png)

DeepSeek 开源了 Super-agent 研究原型。它不是更聪明的模型,而是让 AI 成为数字同事的工作系统。

## 一、Super-agent 是什么

![中心图](imgs/01-超级智能体对比.png)

长在线、多任务并行、事件驱动、Watchdog 自恢复,四个特性构成一个工作系统。

> 与传统 Agent 框架最大的区别:不是等用户发指令,而是持续在线处理事件流。

| 特性 | 传统 Agent | Super-agent |
|---|---|---|
| 在线方式 | 问答式 | 长在线 |
| 任务并行 | 单任务 | 多任务并行 |

## 二、人机分工怎么闭环

![人机分工](imgs/02-人机分工闭环.gif)

人负责目标与判断,AI 负责执行与自恢复,Watchdog 兜底。

```js
const agent = new SuperAgent({ watchdog: true });
agent.on("event", async (e) => agent.handle(e));
```

## 三、适用环境

![适用环境](imgs/03-适用环境四象限.gif)

高频事件、明确边界的场景最先受益;低频场景收益有限。

## 四、架构一览

![架构](imgs/04-Super-agent架构.png)

事件总线 + 调度器 + 执行器 + Watchdog,四层结构。
"""

YAML = """title: 一句话解释DeepSeek刚开源的超级智能体super-agent
digest: DeepSeek 开源了 Super-agent 研究原型:长在线、多任务并行、事件驱动、Watchdog 自恢复。一篇讲透。
author: AI奇点
content_source: 一句话解释DeepSeek刚开源的超级智能体super-agent.md
"""

IMGS = {
    "cover-超级智能体.png": PNG,
    "01-超级智能体对比.png": PNG,
    "02-人机分工闭环.gif": GIF,
    "03-适用环境四象限.gif": GIF,
    "04-Super-agent架构.png": PNG,
}

STATE = {
    "articleId": "20261102-DeepSeek超级智能体",
    "articlePath": "fixture",
    "accounts": {
        "wxtest0000000000": {
            "status": "drafted",
            "draftMediaId": "fixture-mock-draft-id",
            "thumbMediaId": "fixture-mock-thumb-id",
            "contentHash12": "fixture000000",
            "updatedAt": "2026-11-02T12:00:00",
            "pendingOperation": None,
        }
    },
}


def main() -> int:
    force = "--force" in sys.argv
    if FIXTURE.exists() and not force:
        print(f"[SKIP] fixture 已存在: {FIXTURE}(重建加 --force)")
        return 0
    imgs = FIXTURE / "imgs"
    imgs.mkdir(parents=True, exist_ok=True)
    (FIXTURE / "一句话解释DeepSeek刚开源的超级智能体super-agent.md").write_text(MD, encoding="utf-8")
    (FIXTURE / "article.yaml").write_text(YAML, encoding="utf-8")
    (FIXTURE / "publish-state.json").write_text(json.dumps(STATE, ensure_ascii=False, indent=2), encoding="utf-8")
    for name, data in IMGS.items():
        (imgs / name).write_bytes(data * 64)  # 放大体积,避免过小被当空文件
    print(f"[OK] fixture ready: {FIXTURE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
