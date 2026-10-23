export const meta = {
  name: 'wechat_md_to_draft',
  description: '写作稿直发草稿箱:从 .md(含 frontmatter)+ 用户指定封面,自动转 HTML/上传图/建草稿/打开草稿箱。对应 skill: wechat_md_to_draft',
}

// 对应 skill: references/wechat_md_to_draft
// 输入 args:
//   article_dir : 文章目录(必填,含 1 个 .md 写作稿 + 正文图)
//   cover       : 封面图绝对路径(可选;不传则自动找:文章目录根 cover.* 优先,其次 imgs/ 下 cover 前缀图复制出来;两处都没有直接中断报错)
//   account     : 账号槽位序号或名称。不传则列账号让用户选
//   account_slot: 账号槽位数字(直接透传 publish.py --account-slot,默认 1)
//   skip_confirm: 跳过两个 checkpoint(仅在外层已获有效授权时透传,如 prepare 流程/微信网关批准链;不是通用绕过开关)
//   mock / mock_store / inject: 测试透传给 draft_manager/publish.py(生产不传)
// 输出: { media_id, publish_completed, ok, error }

// 发布脚本路径(P1 重接):draft_manager/publish.py——状态机+原子锁+账号透传+同内容复用,
// 不再写 article.yaml;旧脚本(references/.../publish.py)保留但不再被本流程调用。
// 相对启动 cwd(约定从仓库根启动 wechat start / pi-workflow run);换布局时用 args.publish_script 覆盖。
// 公众号配置根:凭证已集成到本仓库 wx-article 目录(.aws-article/config.json + aws.env,均已 gitignore),
// 不再从文章目录向上找;换机器传 args.config_dir 覆盖。
const PUBLISH_SCRIPT = args.publish_script || 'dev-examples/wx-article/scripts/draft_manager/publish.py'
const CONFIG_ROOT = args.config_dir || 'dev-examples/wx-article'
// 发布完成后在浏览器打开的草稿箱 URL。
// token 是公众号后台网页登录态,会过期;失效时登录 mp.weixin.qq.com 后从浏览器地址栏复制最新 token 替换。
const DRAFT_BOX_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card&token=1269319492&lang=zh_CN'
// Python 解释器真探测(Store 占位符问题,见 experience/windows-python-subprocess-gbk-and-python3-alias.md)
const PY_PROBE = 'PY=""; for c in python3 python py; do if "$c" -c "import sys" 2>/dev/null; then PY="$c"; break; fi; done; [ -n "$PY" ] || { echo "[FAIL] no usable python on PATH"; exit 49; }'

phase('读配置与前置检查')
const configCheck = await agent(
  '你是公众号发布前置检查员。请:\n\n' +
  '1. 公众号配置根(固定路径,不从 article_dir 向上找): ' + CONFIG_ROOT + '\n' +
  '2. 读 ' + CONFIG_ROOT + '/aws.env 的 WECHAT_N_APPID/APPSECRET 键是否存在(只看键,不打印值)。\n' +
  '3. 读 ' + CONFIG_ROOT + '/.aws-article/config.json 的 publish_method, wechat_accounts, wechat_{i}_name, default_author, need_open_comment, only_fans_can_comment。\n' +
  '4. 在 ' + args.article_dir + ' 下找 .md 写作稿(排除 article/draft/review 开头和含"审稿"的),取文件名最长的一个。解析 frontmatter 的 title/description。author 用 config.default_author。\n' +
  '5. 封面自动定位(用户指定 cover=' + (args.cover || '未指定') + ' 时直接用它):依次 (a)文章目录根找 cover.(png|jpg|jpeg|webp); (b)imgs/ 下找 cover 开头的图片文件(如 cover-xxx.png),找到后用 bash 复制到文章目录根为 cover.png(保持原扩展名)。拿到则 cover_exists=true 且 cover_path=最终封面绝对路径;两处都没有则 cover_exists=false 且 ready=false,issues 写明缺失,不要向用户追问封面路径。\n' +
  '6. 扫描 .md 正文里 ![alt](path) 的图片引用,确认每张图在 article_dir 下真实存在(路径相对 article_dir)。\n\n' +
  '用户指定账号: ' + (args.account || '未指定,需从 config 列账号') + '\n\n' +
  '返回 JSON: { publish_method, accounts[], ready, title, author, digest, cover_exists, cover_path, img_refs[], issues }。',
  { label: '检查', agentType: 'general', schema: {
    type: 'object',
    properties: {
      publish_method: { type: 'string' },
      accounts: { type: 'array', items: { type: 'object' } },
      ready: { type: 'boolean' },
      title: { type: 'string' },
      author: { type: 'string' },
      digest: { type: 'string' },
      cover_exists: { type: 'boolean' },
      cover_path: { type: 'string' },
      img_refs: { type: 'array', items: { type: 'string' } },
      issues: { type: 'string' },
    },
    required: ['ready'],
  } }
)

if (!configCheck.ready || !configCheck.cover_exists) {
  return {
    ok: false,
    publish_completed: false,
    issues: configCheck.issues || '前置检查未通过',
    ...(configCheck.cover_exists === false
      ? { error: '未找到封面:文章目录根无 cover.*,imgs/ 下也无 cover 前缀图片。请把封面图放入文章目录或其 imgs/ 下(文件名以 cover 开头)后重试' }
      : {}),
  }
}

phase('确认账号')
let account = args.account
if (!account && configCheck.accounts && configCheck.accounts.length > 1) {
  log('有 ' + configCheck.accounts.length + ' 个账号,需确认选用')
  await checkpoint(
    '检测到多个公众号账号:\n' +
    configCheck.accounts.map((a, i) => (i + 1) + '. ' + (a.name || 'slot ' + (i + 1))).join('\n') + '\n\n' +
    '允许=使用第 1 个;拒绝=终止,请用 args.account 指定槽位后重跑。'
  )
  account = configCheck.accounts[0]
}
if (!account && configCheck.accounts && configCheck.accounts.length === 1) {
  account = configCheck.accounts[0]
}

phase('确认发布')
if (args.skip_confirm !== true) {
  await checkpoint(
    '即将发布到微信公众号草稿箱:\n' +
    '标题: ' + (configCheck.title || '(待脚本解析)') + '\n' +
    '作者: ' + (configCheck.author || '') + '\n' +
    '摘要: ' + (configCheck.digest ? (configCheck.digest.slice(0, 40) + '...') : '') + '\n' +
    '封面: ' + (configCheck.cover_path || args.cover || '(自动定位)') + '\n' +
    '正文图: ' + ((configCheck.img_refs && configCheck.img_refs.length) || 0) + ' 张\n' +
    '账号: ' + ((account && account.name) || account || '默认') + '\n\n' +
    '模式: draft (仅入草稿箱,不群发)\n' +
    '允许=执行发布;拒绝=终止。'
  )
}

phase('执行发布')
const publishResult = await agent(
  '你是公众号发布执行者。请用 bash 工具执行发布脚本(一条命令):\n\n' +
  PY_PROBE + '; "$PY" "' + PUBLISH_SCRIPT + '" --article-dir "' + args.article_dir + '" --cover "' + (configCheck.cover_path || args.cover) + '"' +
  (args.account_slot ? ' --account-slot ' + args.account_slot : '') +
  (configCheck.title ? ' --title "' + configCheck.title + '"' : '') +
  (configCheck.digest ? ' --digest "' + configCheck.digest + '"' : '') +
  (configCheck.author ? ' --author "' + configCheck.author + '"' : '') +
  (args.mock ? ' --mock' : '') +
  (args.mock_store ? ' --mock-store "' + args.mock_store + '"' : '') +
  (args.inject ? ' --inject "' + args.inject + '"' : '') + '\n\n' +
  '脚本流程(v2,状态机): 找 .md 写作稿(唯一合法才自动,多候选需 --md-file) -> 解析 frontmatter -> 转 HTML(微信 inline 样式) -> 扫描图片引用 -> 内容快照与 Hash -> 同内容复用(draft/get 核对)或变更走 draft/update,否则 draft/add -> 写 publish-state.json 与 publish.log(不写 article.yaml)。\n\n' +
  'stdout 契约: "[5] DRAFT OK media_id=xxx"(可能带 "(reuse,...)" 或 "(updated)" 后缀)为成功行; 末尾 "=== ALL DONE draft_media_id=xxx ===" 表示全流程成功。\n' +
  '失败语义(按进程退出码与行前缀,不重试): 退出码 1 + "[FAIL] ..." 为明确失败(四分类:网络/鉴权/内容/配额),FAIL 行原文放 error; 退出码 2 + "[UNKNOWN] ..." 为结果不确定(需人工核对草稿箱后用 --resolve-media-id 恢复,publish_completed=false, error 注明需人工核对); 退出码 3 + "[LOCKED] ..." 为文章正被其他任务处理(稍后重试)。\n' +
  '脚本为 Python 标准库实现,跨平台(Mac/Windows)一致。\n\n' +
  '四项门禁(全过才 publish_completed=true): a) 找到 .md  b) 封面存在  c) .md 无 placeholder  d) 拿到 draft media_id。\n\n' +
  '返回 JSON: { media_id, publish_completed, ok, error, mode(reuse|updated|add,取自 [5] 行后缀,无则空) }。',
  { label: '发布', agentType: 'general', schema: {
    type: 'object',
    properties: {
      media_id: { type: 'string' },
      publish_completed: { type: 'boolean' },
      ok: { type: 'boolean' },
      error: { type: 'string' },
      mode: { type: 'string' },
    },
    required: ['ok', 'publish_completed'],
  } }
)

phase('打开草稿箱')
if (publishResult.ok && publishResult.publish_completed) {
  log('发布完成 media_id=' + publishResult.media_id + ',打开浏览器跳转草稿箱')
  await agent(
    '请用 bash 工具执行(Windows PowerShell):\n' +
    'Start-Process "' + DRAFT_BOX_URL + '"\n\n' +
    '注意: URL 含 & 符号,在 PowerShell 里必须用双引号包裹整个 URL,否则 & 会被当成命令分隔符。\n' +
    'token 是公众号后台网页登录态,会过期。若打开后要求重新登录或页面异常,提示用户登录 mp.weixin.qq.com 后从浏览器地址栏复制最新 token 替换 wechat_md_to_draft.js 里的 DRAFT_BOX_URL。\n\n' +
    '返回 JSON: { opened: boolean, note: string }。',
    { label: '打开草稿箱', agentType: 'general', schema: {
      type: 'object',
      properties: { opened: { type: 'boolean' }, note: { type: 'string' } },
      required: ['opened'],
    } }
  )
} else {
  log('发布未成功或未闭环,跳过打开草稿箱')
}

return {
  media_id: publishResult.media_id || '',
  publish_completed: publishResult.publish_completed,
  ok: publishResult.ok,
  error: publishResult.error || '',
}
