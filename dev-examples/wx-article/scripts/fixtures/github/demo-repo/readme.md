# demo-repo

一个用于测试的示例项目。提供基于配置的任务编排能力，支持常见自动化场景。

## 功能

- 基于配置文件定义任务流程
- 支持失败重试与超时控制
- 提供 CLI 与 HTTP 两种触发方式
- 测试覆盖率达 87%（CI 报告）

## 快速开始

```bash
pip install demo-repo
demo run --config flow.yaml
```

## 适用场景

批量数据处理、定时任务编排、轻量 CI 流水线。
