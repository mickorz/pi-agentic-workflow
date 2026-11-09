# image-use E_CRASH 后 ChatGPT composer 残留草稿挡住全部重试

- 日期：2026-11-09
- 场景：Memory 篇 batch 生图，01 中心图首次生成进程崩溃（E_CRASH/unknown），此后所有重试 0 请求或秒失败
- 关联：gzh-article-craft F 阶段；pitfalls #6（failed 空跑）的姊妹坑——unknown 语义 + composer 残留

## 问题现象

1. 首次 batch：four-layers 条目 `E_CRASH`、状态 unknown、无产物文件
2. 带 `retry_failed:true` 重跑 workflow：0.1 秒结束，日志竟报 `succeeded=2/2`，但 manifest 里 four-layers 仍是 unknown、文件不存在——**汇总口径虚报，不可信**
3. executor 直跑（generate.mjs --mode batch --retry-failed）：requests_issued=0，静默不生成
4. 再看 stderr 才见真因：`ChatGPT composer is not empty; prompt not submitted. Clear the ChatGPT composer ... (a leftover draft is restored in new chats) or start a fresh chat, then retry.`

## 根因

崩溃发生在"提示词已敲进 ChatGPT 输入框、提交动作未完成"的瞬间，草稿留在 composer 里；image-use 的防误提交检查（composer 非空即拒发）把后续每次重试全部挡下。unknown 状态默认**禁自动重试**（扣费不确定，需显式 `--retry-unknown`），且 workflow 汇总在含 unknown 时可能虚报 succeeded——判断真实状态只能看 image-manifest.json 的 entries。

## 解决方案（chrome-use 清草稿，已实测）

```bash
chrome-use open "https://chatgpt.com/"   # relay 驱动当前 Chrome
sleep 3
chrome-use eval "(() => { const el = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable=\"true\"]'); if (!el) return 'no composer'; el.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); return 'cleared, residual=' + (el.textContent||'').length; })()"
# 返回 residual=0 后，重跑 generate.mjs --mode batch --retry-failed，一次通过（80s 生成成功）
```

## 预防/注意事项

1. **重试生图失败先看 stderr 尾部**（image-use 的完整报错都在 `[image-use] exit=N 完整 stderr 尾部`），`requests_issued=0` 必有静默拦截原因
2. **判断生成真实状态只认 manifest entries**，workflow [RESULT] 的 succeeded 计数在含 unknown 条目时可能虚报
3. unknown 条目重试必须显式 `--retry-unknown`（article_image_generate.js args 透传 `retry_unknown:true`）；failed 用 `retry_failed:true`
4. E_CRASH 类中断后先清 composer 再重试，比"开新聊天"可靠（草稿会在新聊天里被恢复）
