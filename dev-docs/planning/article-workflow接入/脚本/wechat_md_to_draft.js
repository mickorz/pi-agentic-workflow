export const meta = {
  name: 'wechat_md_to_draft',
  description: '写作稿直发草稿箱:从 .md(含 frontmatter)+ 用户指定封面,自动转 HTML/上传图/建草稿/打开草稿箱。对应 skill: wechat_md_to_draft',
}

// 对应 skill: references/wechat_md_to_draft
// 输入 args:
//   article_dir : 文章目录(必填,含 1 个 .md 写作稿 + 正文图)
//   cover       : 封面图绝对路径(必填,用户指定)
//   account     : 账号槽位序号或名称。不传则列账号让用户选
// 输出: { media_id, publish_completed, ok, error }

// 发布脚本绝对路径(workflow 通过它调用参数化的 PowerShell 脚本)。
// 换机器时改这一行。
const PUBLISH_SCRIPT = 'C:/Users/zhangqi95/.claude/workflows/references/wechat_md_to_draft/scripts/publish.ps1'
// 发布完成后在浏览器打开的草稿箱 URL。
// token 是公众号后台网页登录态,会过期;失效时登录 mp.weixin.qq.com 后从浏览器地址栏复制最新 token 替换。
const DRAFT_BOX_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card&token=1269319492&lang=zh_CN'

phase('读配置与前置检查')
const configCheck = await agent(
  '你是公众号发布前置检查员。请:\n\n' +
  '1. 仓库根定位:从 ' + args.article_dir + ' 向上找含 .aws-article 的祖先目录,即为仓库根。\n' +
  '2. 读 仓库根/aws.env 的 WECHAT_N_APPID/APPSECRET 键是否存在(只看键,不打印值)。\n' +
  '3. 读 仓库根/.aws-article/config.json 的 publish_method, wechat_accounts, wechat_{i}_name, default_author, need_open_comment, only_fans_can_comment。\n' +
  '4. 在 ' + args.article_dir + ' 下找 .md 写作稿(排除 article/draft/review 开头和含"审稿"的),取文件名最长的一个。解析 frontmatter 的 title/description。author 用 config.default_author。\n' +
  '5. 确认封面 ' + args.cover + ' 文件存在。\n' +
  '6. 扫描 .md 正文里 ![alt](path) 的图片引用,确认每张图在 article_dir 下真实存在(路径相对 article_dir)。\n\n' +
  '用户指定账号: ' + (args.account || '未指定,需从 config 列账号') + '\n\n' +
  '返回 JSON: { publish_method, accounts[], ready, title, author, digest, cover_exists, img_refs[], issues }。',
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
      img_refs: { type: 'array', items: { type: 'string' } },
      issues: { type: 'string' },
    },
    required: ['ready'],
  } }
)

if (!configCheck.ready) {
  return { ok: false, publish_completed: false, issues: configCheck.issues || '前置检查未通过' }
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
await checkpoint(
  '即将发布到微信公众号草稿箱:\n' +
  '标题: ' + (configCheck.title || '(待脚本解析)') + '\n' +
  '作者: ' + (configCheck.author || '') + '\n' +
  '摘要: ' + (configCheck.digest ? (configCheck.digest.slice(0, 40) + '...') : '') + '\n' +
  '封面: ' + args.cover + '\n' +
  '正文图: ' + ((configCheck.img_refs && configCheck.img_refs.length) || 0) + ' 张\n' +
  '账号: ' + ((account && account.name) || account || '默认') + '\n\n' +
  '模式: draft (仅入草稿箱,不群发)\n' +
  '允许=执行发布;拒绝=终止。'
)

phase('执行发布')
const publishResult = await agent(
  '你是公众号发布执行者。请用 bash 工具执行发布脚本(一条命令):\n\n' +
  'powershell -NoProfile -ExecutionPolicy Bypass -File "' + PUBLISH_SCRIPT + '" -ArticleDir "' + args.article_dir + '" -Cover "' + args.cover + '"\n\n' +
  '脚本流程: 向上找仓库根 → 找 .md 写作稿(排除 article/draft/审稿) → 解析 frontmatter(title/description) → .md 转 HTML(微信 inline 样式) → 扫描 .md 图片引用 → 读 aws.env 换 token → 上传封面到 add_material → 上传正文图到 uploadimg → 替换 HTML 图片路径为微信 URL → 调 draft/add 建草稿 → 写 publish.log + article.yaml + 复制 article.md。\n\n' +
  '脚本 stdout 含 "[5] DRAFT OK media_id=xxx" 行,解析拿到 draft media_id。stdout 末尾 "=== ALL DONE draft_media_id=xxx ===" 表示全流程成功。\n' +
  '若 stdout 含 "[FAIL]",按四分类报错(网络/鉴权/内容/配额),不重试,把 FAIL 行原文放进 error 字段。\n' +
  '脚本含中文路径,已存为 UTF-8 with BOM,PowerShell 5.1 能正确读;curl.exe 在中文 Windows 上能处理中文文件名。\n\n' +
  '四项门禁(全过才 publish_completed=true): a) 找到 .md  b) 封面存在  c) .md 无 placeholder  d) 拿到 draft media_id。\n\n' +
  '返回 JSON: { media_id, publish_completed, ok, error }。',
  { label: '发布', agentType: 'general', schema: {
    type: 'object',
    properties: {
      media_id: { type: 'string' },
      publish_completed: { type: 'boolean' },
      ok: { type: 'boolean' },
      error: { type: 'string' },
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
