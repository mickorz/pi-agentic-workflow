# 抖音音频提取连续失败：resource timing buffer 打满致 CDP 抓取空手

- 日期：2026-11-10
- 场景：videodigest-extract 微信任务 11-06、11-10 两次连续失败（11-05 及以前正常）
- 修复提交：`836ff34`（src/lib/cdp-grab.ts）

## 问题现象

- CDP 方案 B：视频页能打开、video 元素在、能播放，但"未抓到 media-audio 资源（播放未触发或资源未加载）"3 次尝试全空手
- 回落 yt-dlp：cookie 正常（64 条登录态），抖音 web detail JSON 仍 403（a_bogus 风控，P0 已实证 yt-dlp 对抖音不可用，回落是死路）
- 重试一次同链路同死

## 排查过程（诊断方法可复用）

1. `.pi-workflows/runs/<id>/manifest.json` 看 workflow 级 error（只有最终 yt-dlp 错）；`.pi-wechat/tasks.jsonl` 按状态筛失败任务
2. 手动跑 adapter CLI 复现，拿到被回落掩盖的原始错："CDP 抓取音频 URL 失败（3 次尝试）：未抓到 media-audio 资源"
3. `cdp-cli launch --port 9223` + `new`/`eval` 实测页面：video 在、duration 正常、play() 成功；`performance.getEntriesByType('resource')` 227 条里 `media-audio`/`media-video`/`douyinvod` 全部 **0 命中**
4. 关键测量：buffer 已到 **250/250 封顶**——抖音 11-06 起静态资源（161 条 douyinstatic 等）先打满 buffer，媒体分片请求发生在打满之后，**根本不进 entries**；代码里既有的 `setResourceTimingBufferSize(10000)` 扩容补丁跑不过页面加载速度
5. 转机：`document.querySelector('video').currentSrc` 直接就是签名 CDN URL（v11-weba.douyinvod.com）；带 Referer/UA curl 实测 206 + 合法 MP4

## 根因

抓取逻辑依赖 resource timing 关键字过滤；抖音加载行为变化（静态资源量↑）使 buffer 在媒体加载前打满，过滤恒空。另发现 src 曾加 `douyinvod` 关键字兜底但 **dist 未重建**（dist gitignore，本机 dist 是旧构建），补丁从未生效。

## 解决方案

`GRAB_JS` 改为：关键字命中（保持优先，抖音恢复时无感）→ `video.currentSrc`（http 开头才用）兜底。currentSrc 可能是纯音频流（v11-weba）或含音轨的视频流，下游 downloadAudioFile + ffmpegToWav 均兼容。

端到端验证：抓取 + 3.6MB 下载 + 百炼转写 353 字全通；两笔失败存量任务（7705269715614125339 / 7704936204348900537）已补跑归档。

## 预防/注意事项

1. **改 adapter/src 后必须 `npm run build` 重建 dist**——dist 在 gitignore 里，跨机器 pull 只更新 src，旧 dist 会静默跑旧逻辑（本次 src 的 douyinvod 兜底就这样被吞了）
2. 诊断 CDP 抓取类失败的标准三板斧：manifest error → 手动 CLI 复现看原始错 → cdp-cli eval 实测页面（元素在吗/buffer 满吗/关键字命中吗/currentSrc 是什么）
3. yt-dlp 对抖音的 403 是已知终态（a_bogus），回落链路等于无兜底——CDP 通道失败要当主故障修，不要被"回落也失败"的表象带偏
