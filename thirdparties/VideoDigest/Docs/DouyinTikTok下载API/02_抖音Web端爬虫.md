# 02 抖音 Web 端爬虫

> 源码：`crawlers/douyin/web/`（web_crawler.py、utils.py、endpoints.py、models.py、abogus.py、config.yaml）

## 1. 功能清单

`DouyinWebCrawler` 提供的方法（全部 async，返回抖音原始 JSON）：

| 方法 | 功能 | 关键参数 |
| --- | --- | --- |
| fetch_one_video | 单个作品详情（视频/图集/实况） | aweme_id |
| fetch_user_post_videos | 用户作品列表（翻页） | sec_user_id, max_cursor, count |
| fetch_user_like_videos | 用户喜欢列表 | sec_user_id, max_cursor, count |
| fetch_user_collection_videos | 用户收藏列表（需登录 Cookie） | cookie, cursor, count |
| fetch_user_mix_videos | 合集作品列表 | mix_id, cursor, count |
| fetch_user_live_videos | 直播间信息（webcast_id 或 room_id） | webcast_id / room_id |
| fetch_live_gift_ranking | 直播礼物排行榜 | room_id, rank_type |
| handler_user_profile | 用户主页信息 | sec_user_id |
| fetch_video_comments | 视频评论列表（翻页） | aweme_id, cursor, count |
| fetch_video_comments_reply | 评论回复列表 | item_id, comment_id, cursor, count |
| fetch_hot_search_result | 热搜榜 | 无参 |
| gen_real_msToken / gen_ttwid / gen_verify_fp / gen_s_v_web_id | 生成各类签名前置凭证 | 无参或 Cookie |
| get_x_bogus / get_a_bogus | 对任意接口地址生成签名（调试用） | url, user_agent |
| get_sec_user_id / get_aweme_id / get_webcast_id | 从分享链接提取各类 ID | 分享短链文本 |
| get_all_* 系列 | 批量提取 ID | 分享链接数组 |
| update_cookie | 运行中热更新 Cookie | cookie 字符串 |

对应的 FastAPI 端点在 `app/api/endpoints/douyin_web.py`（前缀 `/douyin/web/`），共 22 个 GET/POST 端点，纯参数透传，无额外逻辑。

## 2. API 端点表（endpoints.py 摘要）

```text
作品详情     https://www.douyin.com/aweme/v1/web/aweme/detail/
用户作品     https://www.douyin.com/aweme/v1/web/aweme/post/
用户喜欢A    https://www.douyin.com/aweme/v1/web/aweme/favorite/
用户收藏     https://www.douyin.com/aweme/v1/web/aweme/listcollection/
合集作品     https://www.douyin.com/aweme/v1/web/mix/aweme/
用户主页     https://www.douyin.com/aweme/v1/web/user/profile/other/
评论         https://www.douyin.com/aweme/v1/web/comment/list/
热搜         https://www.douyin.com/aweme/v1/web/hot/search/list/
直播间       https://live.douyin.com/webcast/room/enter/
弹幕         https://www.douyin.com/aweme/v1/web/danmaku/get_v2/
搜索         https://www.douyin.com/aweme/v1/web/general/search/single/
```

完整清单见 `crawlers/douyin/web/endpoints.py`（约 40 个地址，含直播 WSS、SSO 域名）。

## 3. 请求构造流程（以 fetch_one_video 为例）

```python
# 1. 固定请求头（来自 crawlers/douyin/web/config.yaml）
kwargs = await self.get_douyin_headers()
# 2. pydantic 参数模型（PostDetail 只有 aweme_id 一个业务参数，
#    BaseRequestModel 基类带 device_platform / version_code / aid 等十几个固定设备参数）
params = PostDetail(aweme_id=aweme_id)
# 3. 生成 a_bogus 签名（msToken 置空后参与签名）
params_dict["msToken"] = ''
a_bogus = BogusManager.ab_model_2_endpoint(params_dict, user_agent)
# 4. 拼接最终地址
endpoint = f"{POST_DETAIL}?{urlencode(params_dict)}&a_bogus={a_bogus}"
# 5. httpx GET
```

关键规则：

- **User-Agent 必须保持默认值**（Chrome 90 指纹），与 a_bogus 签名绑定；
- **Cookie 是唯一需要用户提供的输入**，配置样例里的公开 Cookie 可解析多数公开视频；收藏等接口必须登录 Cookie；
- BaseCrawler（httpx 封装）提供 3 次重试、50 并发、10 秒超时。

## 4. a_bogus 签名（移植难点）

- 位置：`crawlers/douyin/web/abogus.py`（635 行）+ `utils.py` 的 `BogusManager.ab_model_2_endpoint`；
- 输入：参数字典（msToken 置空）+ User-Agent；输出：`a_bogus` 查询参数；
- 依赖 `pycryptodomex` 与 `gmssl`（国密 SM3/SM4 相关），为纯 Python 实现，不依赖浏览器或 Node 签名服务；
- 旧版 `xbogus.py` 已失效（2024-06 抖音切换），仅存档。

移植路径二选一：

1. **算法直译**：abogus.py 是纯数学变换，逐函数翻译成 TS（工作量最大，无运行时依赖）；
2. **寻找现成 JS 实现**：社区有多个 a_bogus 的 JS/TS 移植（f2 项目、douyin 变种爬虫库），直接 npm 引入（推荐，工作量最小）。

## 5. ID 提取（utils.py）

`AwemeIdFetcher.get_aweme_id(url)` 流程：

1. `extract_valid_urls` 从分享文本里抽出 URL（支持 v.douyin.com 短链、iesdouyin 链接）；
2. 短链跟随重定向拿真实 URL；
3. 正则从 URL 中抓 `video/(\d+)`、`note/(\d+)` 或 `modal_id=(\d+)`；
4. 抓不到时（纯短链且重定向后仍是首页）请求 `https://www.iesdouyin.com/share/video/{id}` 页面正则兜底。

`SecUserIdFetcher`、`WebCastIdFetcher` 同理（正则分别抓 `user/([^/?]+)`、`live/(\d+)`）。

## 6. msToken 与 ttwid（TokenManager）

| 凭证 | 生成方式 | 用途 |
| --- | --- | --- |
| ttwid | POST `https://ttwid.bytedance.com/ttwid/union/register/` 固定 body | 基础设备凭证，配置里已内置长期值 |
| 真实 msToken | POST `https://mssdk.bytedance.com/web/report` 带加密 strData | 高级场景（当前 a_bogus 链路置空 msToken 也可用） |
| verify_fp / s_v_web_id | 本地随机串按位拼装 | 部分接口的辅助参数 |

移植结论：vcli 只需抄 `ttwid` 生成函数 + 配置内置值；真实 msToken 的 report 加密链路可跳过（fetch_one_video 不依赖）。

## 7. 移植到 vcli 的步骤

1. 新建 `src/lib/douyin.ts`：
   - 常量：endpoints 表、固定 headers（UA/Cookie 从 vcli 配置或环境变量读取）；
   - `fetchOneVideo(awemeId)`：构造参数 + a_bogus 签名 + fetch；
   - `getAwemeId(shareText)`：短链解析（vcli 的 `detectPlatform` 已有抖音短链识别，复用）；
2. 签名：`npm 引入现成 a_bogus JS 实现`（或先跑通"公开 cookie + 无签名"看接口是否容忍，再决定补签名）；
3. cookie 来源：vcli 已有 cdp-cli 导出 cookie 的机制（`cookies.ts`），抖音 cookie 可走同一条路，比 DDA 的手抄 config.yaml 更自动化；
4. 响应字段提取（视频直链示例）：
   ```text
   $.aweme_detail.video.play_addr.url_list[0]     无水印视频直链
   $.aweme_detail.desc                            文案
   $.aweme_detail.author.nickname                 作者
   $.aweme_detail.statistics                      点赞/评论/分享数
   $.aweme_detail.images                          图集图片（aweme_type=68/2/150）
   ```
