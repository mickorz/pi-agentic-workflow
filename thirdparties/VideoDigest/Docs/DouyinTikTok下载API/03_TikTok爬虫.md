# 03 TikTok 爬虫

> 源码：`crawlers/tiktok/web/`（web_crawler.py、utils.py、endpoints.py、models.py、config.yaml）与 `crawlers/tiktok/app/`

## 1. 两条解析路径

| 路径 | 类 | 接口 | 现状 |
| --- | --- | --- | --- |
| Web 端 | TikTokWebCrawler | tiktok.com Web API（需要 X-Bogus 签名） | 元数据/评论/用户列表可用 |
| App 端 | TikTokAPPCrawler | api-feed 接口（HOME_FEED + aweme_id） | 单视频解析主力，带 10 次重试 |

2024-09 起 hybrid 解析单视频改走 App 端（hybrid_crawler.py 注释记录），Web 端 fetch_one_video 被绕开。

## 2. 功能清单

TikTokWebCrawler 方法：

| 方法 | 功能 |
| --- | --- |
| fetch_one_video | 单视频详情（itemId） |
| fetch_user_profile | 用户主页（secUid 或 uniqueId） |
| fetch_user_post | 用户作品列表（cursor 翻页） |
| fetch_user_like | 用户喜欢列表 |
| fetch_user_collect | 用户收藏（需登录 Cookie） |
| fetch_user_play_list | 用户播放列表 |
| fetch_user_mix | 合集列表 |
| fetch_post_comment / fetch_post_comment_reply | 评论与回复 |
| fetch_user_fans / fetch_user_follow | 粉丝与关注列表 |
| gen_xbogus | X-Bogus 签名生成 |
| get_sec_user_id / get_aweme_id / get_unique_id | 从分享链接提取 ID |

TikTokAPPCrawler 方法：只有 `fetch_one_video`（走 feed 接口取 aweme_list[0]，校验 aweme_id 一致，tenacity 重试 10 次）。

## 3. App 端单视频解析原理

不直接请求"视频详情"接口，而是把目标 aweme_id 作为参数请求信息流接口 HOME_FEED，从返回的 aweme_list 里找到 aweme_id 匹配的那条。类比理解：不去仓库点货，而是"点一份同款外卖"从送来的整箱里挑出目标。

配置要点（`crawlers/tiktok/web/config.yaml`）：

- UA 是 TikTok App 指纹（com.ss.android.ugc.trill/xxx 格式）；
- 有特殊请求头 `x-ladon`；
- 需要代理（TikTok 域名国内不可达），config 有 proxies 字段。

## 4. X-Bogus 签名（Web 端）

- 位置：`crawlers/tiktok/web/utils.py` 的 `BogusManager` 系列（与抖音 xbogus.py 同源算法）；
- 纯 Python 实现，输入参数字典 + UA，输出签名串拼到 URL；
- msToken/ttwid 生成逻辑与抖音一致（TokenManager 类）。

## 5. ID 提取

`get_aweme_id(url)`：从分享文本抽 URL，短链（vt.tiktok.com）跟随重定向，正则抓 `/video/(\d+)` 或 `/photo/(\d+)`；`get_unique_id` 抓 `@([^/?]+)`。

## 6. 移植到 vcli 的步骤

1. 新建 `src/lib/tiktok.ts`：
   - App 端 fetchOneVideo：常量 UA/headers + HOME_FEED 端点 + 参数模型 → fetch（需代理配置支持，vcli 可读 `HTTPS_PROXY` 环境变量，fetch 原生支持 `proxy` 选项需 undici ProxyAgent）；
   - `getAwemeId`：短链解析（vcli detectPlatform 已识别 tiktok 域名）；
2. 响应字段（App 端）：
   ```text
   $.video.play_addr.url_list[0]      无水印视频
   $.desc                             文案
   $.author.nickname                  作者
   $.statistics                       互动数据
   $.image_post_info                  图集（aweme_type=150）
   ```
3. 取舍建议：
   - vcli 的 digest 场景只需要"单视频元数据 + 音频"，App 端单方法即可覆盖，Web 端的用户列表/评论等方法按需再移植；
   - TikTok 增量价值低于抖音（yt-dlp 对 TikTok 支持成熟），优先级最低。

## 7. 风险提示

- App 端 feed 接口对 IP 风控敏感，国内网络必须配代理，成功率与代理质量强相关；
- `x-ladon` 等自定义头是硬编码魔法值，接口升级时容易整体失效；
- DDA 自己也在 fetch_one_video 上标了 @deprecated，说明该路径不稳定，移植时做好失败降级（回退 yt-dlp）。
