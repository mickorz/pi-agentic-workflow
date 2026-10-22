# V2 Web 本地威胁模型与测试记录

> 范围：本地单用户（`127.0.0.1` + 本地 token）。不做公网/多用户/SaaS——那些场景必须另有网关层。
> 结论先行：token 双头恒时比较、跨 Origin 全拒、路径白名单+realpath、body 1MB 上限、每 IP 限流、API 全 JSON 无 HTML 输出点、浏览器永不直接触碰文件系统/密钥/Pi SDK。

## 1. 资产与边界

| 资产 | 暴露面 | 防线 |
|---|---|---|
| Pi SDK 凭证（`~/.pi/agent/auth.json`） | 仅 Server 进程持有 | 浏览器只经白名单 workflow 间接触发；凭证不出 Server 进程，任何 API 响应不含凭证（脱敏测试锁定） |
| 任意代码执行（workflow 即 JS） | POST /api/runs | `projectRoots` 显式白名单 + `resolveWorkflowPath` 三重校验（未知项目不暴露存在性 / 绝对路径与 `..` 段拒绝 / realpath 落点必须在白名单根内——symlink 越权拒绝） |
| 本地文件系统 | workflow 运行时 | 与 CLI 同一 DSL 权限模型（explore 只读 / general 可写），checkpoint 外部副作用走人工审批 |
| Run 数据（manifest/journal/events） | GET /api/runs* | token 保护；事件流不含凭证/env（哨兵扫描测试锁定） |

## 2. 威胁与对策（逐条）

| # | 威胁 | 对策（实现） | 测试证据 |
|---|---|---|---|
| T1 | 无凭证直连 API | 全路由（除 /api/health）token 必须；401 带 requestId | `tests/unit/web-security.test.ts`（无/错 token 401） |
| T2 | token 走 URL 泄漏（日志/Referer） | 只认 `Authorization: Bearer` 与 `X-PI-Workflow-Token` 双头，恒时比较（timingSafeEqual）；SSE 同规，query 带 token 仍 401 | web-security（SSE query token 401） |
| T3 | 跨站请求（恶意网页借浏览器发本地请求） | 带 Origin 头的请求仅允许本机同源三形态，其余 403；默认零 CORS 头（OPTIONS 预检也拒） | web-security（跨 Origin GET/POST 403） |
| T4 | 路径穿越 / symlink 越权运行任意 JS | 白名单 + realpath 落点校验 | `tests/unit/web-projects.test.ts`（`../` 段、绝对路径、symlink 指向白名单外全拒）；G-P1 E13 实跑 |
| T5 | 请求体炸弹 | Fastify `bodyLimit: 1MB` → 413 `PAYLOAD_TOO_LARGE`；内联 source 256KB / args 64KB 上限 | `tests/unit/web-security-extra.test.ts` |
| T6 | 暴力重试/DoS | 每 IP 滑动窗口限流（默认 60s/600 次）→ 429；run 并发上限 → 429 `RUN_LIMIT_REACHED` | web-security（限流）+ web-security-extra（HTTP 级并发 429） |
| T7 | XSS（workflow 名/日志/checkpoint 问题带 HTML） | API 全 `application/json`（无 text/html 输出点）；前端 React 文本渲染（转义） | web-security-extra（content-type 断言）+ `web/e2e/xss.spec.ts`（onerror/`<script>`/img 注入全字面渲染、`window.__xss` 未定义、pageerror=0） |
| T8 | 错误响应泄漏内部细节 | 结构化错误体 `{code,message,details?,requestId}`；无堆栈帧/stack 字段/env 值/token 回显 | web-security-extra（脱敏全响应扫描） |
| T9 | Schema 混入未知字段绕过 | 四个 POST 路由 JSON Schema `additionalProperties:false`（Fastify ajv `removeAdditional:false` 显式关闭静默剥离） | web-security（未知字段 400） |
| T10 | 审批伪造/双击重复执行 | 决策带 `expectedVersion` 乐观并发；重复决策 409 或幂等重放 200，**run.completed 恰一次** | `dev-examples/v2-web/fault-suite.sh` F4/F4b（34/34）+ `web/e2e/e15-checkpoint.spec.ts`（UI/API 双路竞争） |

## 3. 明确不防（并说明为什么）

- **本机恶意进程**：token 在启动横幅明文打印给本机用户——同机任意进程本就可读进程列表/文件，边界在操作系统账户级。
- **浏览器扩展/用户自伤**：用户自己把 token 粘去恶意站点属于钓鱼范畴，Origin 校验可挡常规 CSRF 型借道。
- **公网暴露**：`--host` 允许改绑定地址，但文档与默认值只给 127.0.0.1；公网部署不在 V2 范围。

## 4. 复跑方式

```bash
npm test                                    # 含 web-security / web-security-extra / web-projects 全部安全单测
cd web && npx playwright test --project=mock   # 浏览器 XSS / 竞争去重
python3 dev-examples/v2-web/fault_suite.py    # 真进程故障注入（F4 审批竞争）
```
