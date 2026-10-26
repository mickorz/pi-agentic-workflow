export const meta = {
  name: 'wechat_article_assets',
  description: '用户业务资料库与预设包管理:业务介绍入库、业务图入库、JSON 预设包导入。对应 skill: wechat_article_assets',
}

// 对应 skill: .opencode-workflows/workflows/references/wechat_article_assets
// 输入 args:
//   action  : 'doc_ingest'|'image_ingest'|'preset_import'。必填
//   product : 产品名(doc_ingest/image_ingest 必填)
//   stem    : 图片中文名(image_ingest 必填)
//   content : 业务介绍内容(doc_ingest)或图片客观描述(image_ingest)
//   filename: doc_ingest 的文件名。缺省 项目介绍.md
//   bundle  : .json 预设包文件路径或白名单 URL(preset_import 必填)
//   dry_run : preset_import 时只看不写。缺省 false
//   allow_any_host : preset_import 放宽域名白名单(调试)。缺省 false
// 输出: { action, written, ok }

const SKILL = '.opencode-workflows/workflows/references/wechat_article_assets'
const action = args.action

if (action === 'doc_ingest') {
  phase('业务介绍入库')
  const result = await agent(
    '你是业务资料库管理员。执行业务介绍 .md 入库(见 下方规则 一节)。\n\n' +
    '产品名: ' + args.product + '\n' +
    '文件名: ' + (args.filename || '项目介绍.md') + '\n' +
    '内容来源: ' + (args.content ? 'args.content 提供的全文' : '读用户在对话中提供的文本') + '\n\n' +
    '流程:\n' +
    '1. ls .aws-article/products/ 看已有产品名,' + args.product + ' 已有则复用,否则新建。\n' +
    '2. 用 bash mkdir -p .aws-article/products/' + args.product + '/images/ (即便暂时为空也建骨架)。\n' +
    '3. 用 Write 工具把内容写到 .aws-article/products/' + args.product + '/' + (args.filename || '项目介绍.md') + '。\n' +
    '4. 返回完整路径。\n\n' +
    (args.content ? '内容全文:\n' + args.content + '\n' : '') +
    '完成后返回写入路径。',
    { label: '业务介绍入库', agentType: 'general', schema: {
      type: 'object',
      properties: {
        written: { type: 'string' },
        ok: { type: 'boolean' },
      },
      required: ['written', 'ok'],
    } }
  )
  return { action: 'doc_ingest', written: result.written, ok: result.ok }
}

if (action === 'image_ingest') {
  phase('业务图入库')
  const result = await agent(
    '你是业务资料库图片管理员。执行业务图入库(见 下方规则 二节)。\n\n' +
    '产品名: ' + args.product + '\n' +
    '图片中文名(stem): ' + args.stem + '\n' +
    '客观描述: ' + (args.content || '(未提供,写占位句)') + '\n' +
    '源图片路径: ' + (args.source || '请从 args.source 读取') + '\n\n' +
    '流程:\n' +
    '1. ls .aws-article/products/ 确认 ' + args.product + ' 目录存在,不存在则 mkdir -p .aws-article/products/' + args.product + '/images/。\n' +
    '2. 用 bash 把源图片复制到 .aws-article/products/' + args.product + '/images/' + args.stem + '.<原扩展名>。\n' +
    '3. 用 Write 工具写同名说明 .md: .aws-article/products/' + args.product + '/images/' + args.stem + '.md。格式: 第一行 ## 图片名,第二行起客观中文描述。描述用 args.content;未提供则写占位句(预期行为不是故障)。\n' +
    '4. 返回图片路径与说明路径。\n\n' +
    '注意: 读图定文件名、写画面描述是 Agent 的活,不要跳过。--content 不传会写占位句。',
    { label: '业务图入库', agentType: 'general', schema: {
      type: 'object',
      properties: {
        image_path: { type: 'string' },
        desc_path: { type: 'string' },
        ok: { type: 'boolean' },
      },
      required: ['image_path', 'ok'],
    } }
  )
  return { action: 'image_ingest', written: result.image_path, ok: result.ok }
}

if (action === 'preset_import') {
  phase('预设包导入')
  const dryRun = args.dry_run

  if (dryRun) {
    const preview = await agent(
      '你是预设包导入预览器。执行 --dry-run 预览(见 下方规则 三节)。\n\n' +
      '来源: ' + args.bundle + '\n\n' +
      '1. 若是 URL: 校验白名单(仅 HTTPS + aiworkskills.cn 及子域)。' + (args.allow_any_host ? '用户已开启 --allow-any-host 调试模式。' : '非白名单直接报错。') + '\n' +
      '2. 若是本地文件: 直接读取。\n' +
      '3. .json 是 JSON 格式预设包(非 ZIP)。用 Read 工具读取 JSON 内容(不写入 presets/)。结构: { config: {...}, presets: [{ path, content }] }。\n' +
      '4. presets 数组中每项的 path 为相对路径(如 structures/清单体.md),首段即白名单子目录名。白名单: closing-blocks, cover-styles, formatting, image-styles, sticker-styles, structures, title-styles。不在白名单的跳过并打日志。\n' +
      '5. 列出将写入哪些路径(替换式: 包内有该子目录则先清空本地同名再写;包内没有则本地保持)。\n' +
      '6. config: 本地已有时只输出差异 JSON 不覆盖;本地没有才写入 .aws-article/config.json。\n' +
      '7. 密钥映射: config 的 wechat_appid/wechat_appsecret/writing_model.api_key/image_model.api_key 会进 aws.env(覆盖前备份 aws.env.bak)。\n\n' +
      '返回: 将写入的路径列表, config 差异摘要, 涉及的密钥键名(不打印值), 是否有非白名单内容被跳过。',
      { label: '预览', agentType: 'general', schema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          config_diff: { type: 'string' },
          keys: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
        },
        required: ['paths'],
      } }
    )
    log('dry-run 预览完成,等待用户确认')
    await checkpoint(
      '预设包导入预览(dry-run):\n' +
      '将写入: ' + preview.paths.length + ' 个路径\n' +
      (preview.config_diff ? 'config.json 差异: 有(需手改)\n' : 'config.json: 本地无,将写入\n') +
      '涉及密钥: ' + (preview.keys && preview.keys.length ? preview.keys.join(', ') : '无') + '\n' +
      (preview.skipped && preview.skipped.length ? '跳过(非白名单): ' + preview.skipped.join(', ') + '\n' : '') +
      '\n允许=正式导入;拒绝=终止。'
    )
  }

  const result = await agent(
    '你是预设包导入执行者。正式导入 JSON 预设包(见 下方规则 三节)。\n\n' +
    '来源: ' + args.bundle + '\n' +
    (args.allow_any_host ? '已开启 --allow-any-host。\n' : '域名白名单强制(仅 aiworkskills.cn 及子域)。\n') +
    '\n执行步骤:\n' +
    '1. URL: 下载到 .aws-article/downloads/<文件名>.json(仅 aiworkskills.cn 白名单)。本地文件: 用 Read 工具读取。\n' +
    '2. JSON 结构: { config: {...}, presets: [{ path, content }] }。读取后解析。\n' +
    '3. presets 数组逐项处理: path 首段即白名单子目录(closing-blocks/cover-styles/formatting/image-styles/sticker-styles/structures/title-styles)。替换式 - 先清空本地同名目录再写;包内没有的子目录则本地保持。非白名单目录跳过并打日志。每项的 content 原样写入 .aws-article/presets/<path>(保留原格式 md/yaml)。\n' +
    '4. config: 本地已有时只把差异以 JSON 打到 stdout 不覆盖(须问过用户再手改);本地没有才写入 .aws-article/config.json。\n' +
    '5. 密钥映射: config 的 wechat_appid->WECHAT_N_APPID, wechat_appsecret->WECHAT_N_APPSECRET, writing_model.api_key->WRITING_MODEL_API_KEY, image_model.api_key->IMAGE_MODEL_API_KEY。增量写入 aws.env,覆盖前备份 aws.env.bak.<时间戳>。stderr 只打印键名不打印值。\n\n' +
    '所有写入限制在 .aws-article/ 内(除 aws.env 在仓库根)。\n' +
    '返回: 已写入路径列表, config 处理结果(写入/差异), 更新的密钥键名, 跳过的非白名单内容。',
    { label: '导入', agentType: 'general', schema: {
      type: 'object',
      properties: {
        written: { type: 'array', items: { type: 'string' } },
        config_result: { type: 'string' },
        keys_updated: { type: 'array', items: { type: 'string' } },
        ok: { type: 'boolean' },
      },
      required: ['written', 'ok'],
    } }
  )
  return { action: 'preset_import', written: result.written, config_result: result.config_result, ok: result.ok }
}

return { action: action || 'unknown', ok: false, error: '未知 action,支持: doc_ingest / image_ingest / preset_import' }
