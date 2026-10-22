export const meta = {
  name: 'wechat_article_publish',
  description: '公众号 API 直连发布:图文入草稿箱或群发,素材上传与发布前检查。对应 skill: wechat_article_publish',
}

// 对应 skill: references/wechat_article_publish(已复制入本仓库)
// 输入 args:
//   article_dir    : 本篇目录(必填,含 article.html + cover.* + imgs/)
//   account        : 账号槽位序号或名称。不传则列账号让用户选
//   publish_method : 'draft'|'published'|'none'。缺省读 config.json
//   force_publish  : 单次强制带发布(draft 下 full --publish)。缺省 false
//   skip_confirm   : 跳过多账号选择与发布前确认两个 checkpoint(缺省 false)。微信链路必传 true,
//                    授权语义由外层 external-side-effect 批准链承担
// 输出: { media_id, publish_id, publish_completed, ok }

if (!args.article_dir) {
  throw new Error('缺少必填参数 article_dir(本篇目录,含 article.html + cover.* + imgs/)')
}

// 公众号配置根:凭证已集成到本仓库 wx-article 目录(.aws-article/config.json + aws.env,均已 gitignore),
// 不再从文章目录向上找。换机器/换位置时传 args.config_dir 覆盖(指向含 .aws-article/ 与 aws.env 的目录)。
// skill 资料目录:默认本仓库内绝对路径(相对启动 cwd 不可靠),换机器改这一行或传 args.skill_dir。
const CONFIG_ROOT = args.config_dir || 'E:/WorkProjects/pi-agentic-workflow/dev-examples/wx-article'
const SKILL = args.skill_dir || 'E:/WorkProjects/pi-agentic-workflow/dev-examples/wx-article/scripts/references/wechat_article_publish'

// 发布完成后在浏览器打开的草稿箱 URL。
// 注意: token 是公众号后台网页登录态,会过期;失效时登录 mp.weixin.qq.com 后从浏览器地址栏复制最新 token 替换。
const DRAFT_BOX_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card&token=1269319492&lang=zh_CN'

phase('读配置与账号选择')
const configCheck = await agent(
  '你是公众号发布前置检查员。请读配置并列出账号(见 下方规则 第0-2步):\n\n' +
  '1. 公众号配置根(固定路径,不 article_dir 向上找): ' + CONFIG_ROOT + '\n' +
  '2. 读 ' + CONFIG_ROOT + '/.aws-article/config.json 的 publish_method, wechat_accounts, wechat_publish_slot, wechat_{i}_name。\n' +
  '3. 读 ' + CONFIG_ROOT + '/aws.env 的 WECHAT_N_APPID / WECHAT_N_APPSECRET(只看键是否存在,不打印值)。\n' +
  '4. 读本篇 ' + args.article_dir + '/article.yaml 的 publish_completed, title, author, digest, content_source。\n' +
  '5. 确认 ' + args.article_dir + '/article.html 存在、文章目录下有 cover.(png|jpg|jpeg|webp)(不在 imgs/)、article.md 与 article.html 均不含 placeholder。\n' +
  '6. 若 publish_method=none,立即返回说明(不调任何微信接口)。\n\n' +
  '用户指定账号: ' + (args.account || '未指定,需从 config 列账号') + '\n' +
  'publish_method: ' + (args.publish_method || '读 config') + '\n\n' +
  '返回 JSON: publish_method, 账号列表(name+序号+是否配齐凭证), 本篇产物检查结果(各 [OK]/[FAIL]), 是否就绪。',
  { label: '检查', agentType: 'general', schema: {
    type: 'object',
    properties: {
      publish_method: { type: 'string' },
      accounts: { type: 'array', items: { type: 'object' } },
      ready: { type: 'boolean' },
      issues: { type: 'string' },
    },
    required: ['publish_method', 'ready'],
  } }
)

if (configCheck.publish_method === 'none') {
  log('publish_method=none,不调微信接口')
  return { publish_completed: false, ok: true, skipped: true }
}

if (!configCheck.ready) {
  return { publish_completed: false, ok: false, issues: configCheck.issues }
}

phase('确认账号与发布')
let account = args.account
if (!account && configCheck.accounts && configCheck.accounts.length > 1 && args.skip_confirm !== true) {
  log('有 ' + configCheck.accounts.length + ' 个账号,需确认选用')
  const approved = await checkpoint(
    '检测到多个公众号账号:\n' +
    configCheck.accounts.map((a, i) => (i + 1) + '. ' + (a.name || 'slot ' + (i + 1)) + (a.ready ? '' : ' (凭证不全)')).join('\n') + '\n\n' +
    '允许=使用第 1 个(或 args.account 指定的);拒绝=终止,请用 args.account 指定槽位后重跑。'
  )
  account = configCheck.accounts[0]
}
if (!account && configCheck.accounts && configCheck.accounts.length === 1) {
  account = configCheck.accounts[0]
}

const finalMethod = args.force_publish ? 'published' : (args.publish_method || configCheck.publish_method || 'draft')
log('即将以 ' + finalMethod + ' 模式发布' + (args.skip_confirm === true ? '(skip_confirm,跳过内部确认;授权由外层批准链承担)' : ',等待用户最终确认'))
if (args.skip_confirm !== true) {
  await checkpoint(
    '即将发布到微信公众号(账号: ' + (account && account.name ? account.name : account || '默认') + ')\n' +
    '模式: ' + finalMethod + (finalMethod === 'draft' ? ' (仅入草稿箱)' : ' (草稿+提交群发)') + '\n\n' +
    '允许=执行发布;拒绝=终止。发布前会再做一次 pre-publish-checklist 检查。'
  )
}

phase('发布前检查与执行')
const publishResult = await agent(
  '你是公众号发布执行者。完成发布前检查与一键发布(见 下方规则 第3-6步 + references/pre-publish-checklist.md)。\n\n' +
  '配置检查结果: ' + JSON.stringify(configCheck) + '\n' +
  '选定账号: ' + JSON.stringify(account) + '\n' +
  '最终模式: ' + finalMethod + '\n' +
  '本篇目录: ' + args.article_dir + '\n\n' +
  '执行步骤(用 bash + curl 调微信 API,见 ' + SKILL + '/api-reference.md):\n' +
  '1. 发布前检查: 按 ' + SKILL + '/pre-publish-checklist.md 逐项核对(article.html/cover.*/imgs/article.yaml 齐全,无 placeholder)。\n' +
  '2. 从 aws.env 读 WECHAT_N_APPID/APPSECRET(N=账号槽位)。\n' +
  '3. 换 access_token: GET api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=<APPID>&secret=<APPSECRET>。token 只在内存短期缓存,不落盘。\n' +
  '4. 上传封面素材: POST api.weixin.qq.com/cgi-bin/material/add_material?type=image (multipart 上传 cover.*),拿 media_id。\n' +
  '5. 上传正文图: 逐张 POST api.weixin.qq.com/cgi-bin/media/uploadimg (multipart),拿每张 URL。\n' +
  '6. 替换 article.html 中 imgs/ 路径为微信返回的 URL。\n' +
  '7. 建草稿: POST api.weixin.qq.com/cgi-bin/draft/add JSON articles 数组(含 title/author/digest/content/thumb_media_id)。\n' +
  (finalMethod === 'published' || args.force_publish ? '8. 提交发布: POST api.weixin.qq.com/cgi-bin/freepublish/submit 拿 publish_id。\n' : '8. draft 模式不调 freepublish。\n') +
  '9. 把 stdout/stderr 一起重定向到 ' + args.article_dir + '/publish.log。\n\n' +
  '四项门禁(写回 publish_completed 前缺一不可):\n' +
  'a. article.html 存在\n' +
  'b. 文章目录下有 cover.*\n' +
  'c. article.md 与 article.html 均不含 placeholder\n' +
  'd. 发布命令成功并拿到回执(media_id 或 publish_id)\n\n' +
  '四项全过才写回 article.yaml 的 publish_completed=true;否则只标记已提交草稿未闭环。\n' +
  '发布失败时按四分类(网络/鉴权/内容/配额)报错,不要只说发布失败。\n\n' +
  '用 Write 工具更新 ' + args.article_dir + '/article.yaml 的 publish_completed 字段。\n' +
  '返回 JSON: media_id, publish_id, publish_completed, ok, 失败原因(若有)。',
  { label: '发布', agentType: 'general', schema: {
    type: 'object',
    properties: {
      media_id: { type: 'string' },
      publish_id: { type: 'string' },
      publish_completed: { type: 'boolean' },
      ok: { type: 'boolean' },
      error: { type: 'string' },
    },
    required: ['ok', 'publish_completed'],
  } }
)

phase('确认回执')
log('发布完成: ok=' + publishResult.ok + ' publish_completed=' + publishResult.publish_completed)
if (publishResult.ok && publishResult.publish_completed && args.skip_confirm !== true) {
  await checkpoint('发布闭环完成。media_id=' + (publishResult.media_id || '') + ' publish_id=' + (publishResult.publish_id || '') + '\n允许=结束;拒绝=标记问题。')

  phase('打开草稿箱')
  log('发布闭环完成,打开浏览器跳转公众号草稿箱供预览')
  const openResult = await agent(
    '你是发布后助手。发布已完成,请用 bash 工具打开默认浏览器跳转到微信公众号草稿箱。\n\n' +
    '执行命令(Windows PowerShell):\n' +
    'Start-Process "' + DRAFT_BOX_URL + '"\n\n' +
    '注意: URL 含 & 符号,在 PowerShell 里必须用双引号包裹整个 URL,否则 & 会被当成命令分隔符。\n' +
    'URL 中 token 是公众号后台网页登录态,会过期。若打开后要求重新登录或页面异常,提示用户登录 mp.weixin.qq.com 后从浏览器地址栏复制最新 token 替换 wechat_article_publish.js 里的 DRAFT_BOX_URL。\n\n' +
    '返回 JSON: { opened: boolean, url: string, note: string }。',
    { label: '打开草稿箱', agentType: 'general', schema: {
      type: 'object',
      properties: {
        opened: { type: 'boolean' },
        url: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['opened'],
    } }
  )
  log('打开草稿箱: opened=' + openResult.opened)
}

return {
  media_id: publishResult.media_id || '',
  publish_id: publishResult.publish_id || '',
  publish_completed: publishResult.publish_completed,
  ok: publishResult.ok,
  error: publishResult.error || '',
}
