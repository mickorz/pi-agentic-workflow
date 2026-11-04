# gzh-preview 打开后显示 UNAUTHORIZED/404 JSON：旧 dist 未重建 + 三个连环坑

- 日期：2026-11-04
- 场景：G.5 排版审阅用 `open_preview.py`（chrome-use 免粘贴打开器）打开工作台，页面显示 `{"code":"UNAUTHORIZED",...}` 原始 JSON
- 关联脚本：`dev-examples/gzh-preview/open_preview.py`（已补预检）

## 问题现象

chrome-use 打开 `http://127.0.0.1:4317/gzh-preview?dir=<文章目录>` 后，页面内容是一段裸 JSON（先是 UNAUTHORIZED，重设 token 后变成 `Route GET:/gzh-preview not found` 404）。

## 排查过程

1. localStorage token 检查：`chrome-use eval` 读回 `pi-workflow-web.token` 显示"有"——但只验存在不验正确（13 天前旧会话的随机 token 残留在 localStorage）
2. 直接 `curl -H "Authorization: Bearer <固定token>" /gzh-preview` → **404 Route not found**：不是鉴权问题，是路由没注册
3. 启动横幅没有"工作台"行；`grep -r gzh-preview dist/` 为空；`dist/cli/index.js` mtime=10-28，而 gzh-preview 功能是 11-04 pull 的提交 → **服务跑的是旧构建**

## 根因

`pi-workflow` 全局命令指向仓库 `dist/cli/index.js`（npm link 约定），**pull 新代码后没有 rebuild**，运行中的 web server 没有新路由代码。gzh 路由注册条件：`gzhVaultRoot` 解析成功（.aws-article/config.json ✓）+ webDist 存在——两者在旧 dist 进程里都不满足，路由不注册，请求落到 Fastify JSON 404 兜底。

连环坑（次生）：
- **localStorage 旧 token 残留**：服务曾以随机 token 跑过 13 天，用户手贴过的旧 token 一直在，掩盖了"token 错"与"路由无"的区别
- **`pkill -f "dist/cli/index.js web"` 自杀**：模式字符串出现在我自己 bash 命令行里，pkill 把当前命令连带杀死（exit 1 且后续链路中断）；改用 `lsof -iTCP:4317` 找 PID 再 kill
- **EADDRINUSE**：上一条 pkill 自杀导致旧进程未被杀、新进程起不来

## 解决方案

```bash
npm run build && (cd web && npm run build)   # 重建 cli dist + web/dist
kill <旧PID>                                  # lsof -nP -iTCP:4317 -sTCP:LISTEN 找
nohup pi-workflow web > /tmp/pi-workflow-web.log 2>&1 &
# 横幅出现「工作台：…/gzh-preview」= 路由已注册
chrome-use eval "localStorage.setItem('pi-workflow-web.token','<新token>'); location.reload()"
```

## 预防/注意事项

1. **pull 后必 rebuild**：凡走全局 `pi-workflow`（bin→dist/）的路径，pull 含 server/web 改动的提交后先 `npm run build && (cd web && npm run build)`；横幅无"工作台"行=旧 dist 的可靠信号
2. `open_preview.py` 已加 `/gzh-preview` HTML 可达性预检（404/JSON 即 FAIL 并给出 rebuild 指引），以后不会再把错误页推给用户
3. pkill 别用会匹配自身命令行的模式；杀端口进程统一 `lsof -iTCP:<port> -sTCP:LISTEN` 取 PID
4. 验 token 要验"值相等"不是"存在"：固定 token 后 localStorage 可能残留旧随机 token
