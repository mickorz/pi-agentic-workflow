# 抖音 CDP 抓音频在 Windows 全灭的三重根因（SW 拦截 + URL 特征变更 + CRLF）

> 日期：2026-10-26 · 发现于 videodigest Windows 真机冒烟（Chrome 155 / Win11）

## 问题现象

CDP 通道三轮全报"未抓到 media-audio 资源"；页内 `performance.getEntriesByType('resource')`
恒 0 条媒体记录；挂 page 会话的 `Network.requestWillBeSent` 也抓不到。但 video 元素实际在播
（currentTime 前进、readyState=4），媒体数据确实在加载。

## 排查过程

1. 页内 eval 发现 console 有 "Service worker registration success" —— 怀疑 SW；
2. reload 页面 + page 会话挂 Network 监听：能看到 `v26-weba.douyinvod.com/...` 媒体请求，
   但 URL 里**没有 `media-audio` 特征**（P0 在 Mac 上的特征串），全量 URL 是
   `douyinvod.com` + `mime_type=video_mp4` + `br=<码率>`；
3. ffprobe 两条不同 `br` 的流：都是 AAC 音轨 + 视频轨的混合 MP4（低码率那条 446k 也含完整音轨）；
4. SW 会话挂监听有时也抓不到 —— 首次访问时 SW 尚未注册完成，收集器扫不到 SW target，
   之后媒体请求全走 SW（page 会话不可见）→ 表现为时好时坏。

## 根因

1. **URL 特征变更**：抖音新版播放器媒体 URL 是 `douyinvod.com` 域，无 `media-audio` 路径段，
   按 P0 特征串匹配恒空；
2. **SW 拦截**：媒体分片请求被 `www.douyin.com/sw.js` 接管，既不进 performance
   resource timing，也不进 page 会话的 Network 域，必须挂 SW target；
3. **SW 注册竞态**：首次访问 SW 晚于收集器 attach 出现，一次性扫描会漏挂。

## 解决方案（cdp-grab.ts）

- 新增 `openNetworkCollector`：CDP WebSocket 同时挂 page + 同域 service_worker 会话，
  监听 `Network.requestWillBeSent`；
- URL 甄别 `isBetterAudioUrl`：`media-audio || douyinvod.com`，douyinvod 取最低 `br=`
  码率（转写只需音轨，446k 混合流最小最快）；
- `refreshSws()`：每轮 attempt 重扫 `/json` 补挂新出现的 SW target；
- 页内 GRAB_JS 的 performance 通道同步加 douyinvod 特征作 legacy/主通道互备。
- 音频文件是混合 MP4（无 .m4a 扩展名问题），ffmpeg 按内容识别，下游转 wav 不受影响。

## 预防/注意事项

- 同一工作流跨平台（Mac→Windows）验收时，页面行为类特征（URL 模式、SW、播放策略）
  都可能不同，优先用网络层（CDP Network 域）而不是页内 API（performance）做观测，
  并同时挂 page + SW 会话。
- 顺带修的第四个小坑：`archive_inspire.py` 在 Windows 文本模式把 `\n` 写成 `\r\n`，
  破坏 frontmatter 断言 —— `write_text(..., newline="\n")` 显式 LF。

## 补充：抖音风控降级壳页（2026-10-26 同日发现）

高频访问同视频页后，抖音会**间歇性**下发降级壳页：`document.title` 为空、
video 元素存在但 `readyState` 恒 0、无任何媒体请求（页面壳资源正常加载，百余条请求）。
在同一坏 tab 上重试毫无意义（实测三连败）；换新 tab 重开 = 独立重掷（新页即中）。

修复（cdp-grab.ts grabMediaViaCdp）：
1. 每次 attempt 换新 tab（关旧页 + `cdpOpenTabId` 新页），attempt 间 4 秒冷却；
2. page 会话 `Network.setBypassServiceWorker: true`——SW 磁盘缓存全命中时媒体请求
   不过网络（两通道都看不见，抓取随机失败），bypass 后请求直连，page 会话与
   performance 记录均可见；旧版 Chrome 不支持则静默忽略；
3. SW 会话附加全程 best-effort（连接失败静默降级 performance 通道，不阻断抓取）。

验证：修复后连续 4 轮 extract 全部第 1 次尝试命中。
