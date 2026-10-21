export const meta = {
  name: 'article_collect_images',
  description: '收集引用文章的图片: 扫描引用文件夹所有 md 文章里的图片引用, 下载远程图片到本地 assets 目录, 返回图片列表(描述+本地路径+来源)。不依赖 .aws-article 配置, 自包含。被 article_draft_from_topic 集成为子 workflow。',
}

// 输入 args:
//   reference_dir : 引用文件夹路径(必填)
//   assets_dir    : 图片下载目录(必填, 通常为主文档所在目录下的 assets/)
// 输出: { images, assets_dir, downloaded_count, failed_count }

phase('扫描图片引用')
const scan = await agent(
  '你是图片引用扫描器。扫描引用文件夹里的所有 markdown 文章, 提取全部图片引用。\n\n' +
  '引用文件夹: ' + args.reference_dir + '\n' +
  '图片下载目录: ' + args.assets_dir + '\n\n' +
  '步骤:\n' +
  '1. 用 Glob 工具匹配 "' + args.reference_dir + '/*.md", 列出所有 md 文件。\n' +
  '2. 用 Read 工具读每个 md 文件全文。\n' +
  '3. 用正则提取所有图片引用, 两种格式都要认:\n' +
  '   - 标准 markdown: ![描述](url)  描述可空\n' +
  '   - Obsidian wikilink: ![[文件名]]  这种是本地 vault 图片, 文件可能在 vault 里\n' +
  '4. 对每个图片引用:\n' +
  '   - 远程 URL(http/https 开头): 记为待下载\n' +
  '   - 本地路径(非 http): 记为本地图片, 尝试用 Glob 在 reference_dir 上下文找文件\n' +
  '   - 空 url 或 placeholder: 跳过\n' +
  '5. 去重: 同一 URL 只保留一条(不同文章引用同一图片时合并, source_files 列出所有来源)\n' +
  '6. 为每个远程图片生成本地文件名:\n' +
  '   - 从 URL 路径段提取 media ID(如 pbs.twimg.com/media/HTUL4h5asAAnllC 的 HTUL4h5asAAnllC)\n' +
  '   - 从 URL query 的 format 参数取扩展名(如 format=jpg -> .jpg), 无 format 参数则用 .jpg 兜底\n' +
  '   - 文件名 = media ID + 扩展名, 如 HTUL4h5asAAnllC.jpg\n' +
  '   - 如果 URL 不含.twimg.com, 用 URL 最后一段路径 + 推断扩展名\n\n' +
  '返回所有图片引用的结构化列表。',
  { label: '扫描图片', agentType: 'general', schema: {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            desc: { type: 'string', description: '图片描述(alt 文本), 可空' },
            source_url: { type: 'string', description: '远程 URL 或本地路径, 本地图片标 local' },
            is_remote: { type: 'boolean' },
            local_filename: { type: 'string', description: '本地文件名, 如 HTUL4h5asAAnllC.jpg' },
            source_files: { type: 'array', items: { type: 'string' }, description: '引用该图片的文件名列表' },
          },
        },
      },
      total_count: { type: 'number' },
      remote_count: { type: 'number' },
      local_count: { type: 'number' },
    },
    required: ['images', 'total_count'],
  } }
)

if (!scan.total_count || scan.total_count === 0) {
  log('引用文章无图片引用, 跳过图片收集')
  return {
    images: [],
    assets_dir: args.assets_dir,
    downloaded_count: 0,
    failed_count: 0,
    ok: true,
  }
}

log('扫描完成: ' + scan.total_count + ' 张图片(' + scan.remote_count + ' 远程 + ' + scan.local_count + ' 本地)')

phase('下载图片到本地')
const download = await agent(
  '你是图片下载执行者。把所有远程图片下载到本地 assets 目录, 本地图片复制过去。\n\n' +
  'assets 目录: ' + args.assets_dir + '\n' +
  '图片列表(' + scan.total_count + ' 张):\n' +
  JSON.stringify(scan.images, null, 2) + '\n\n' +
  '步骤:\n' +
  '1. 用 bash(PowerShell)创建 assets 目录:\n' +
  '   New-Item -ItemType Directory -Path "' + args.assets_dir + '" -Force | Out-Null\n\n' +
  '2. 对每个 is_remote=true 的图片, 用 bash(PowerShell)下载:\n' +
  '   Invoke-WebRequest -Uri "<source_url>" -OutFile "' + args.assets_dir + '/<local_filename>" -UseBasicParsing -TimeoutSec 30\n' +
  '   - 一次下载一张, 下载后用 Get-Item 验证文件存在且 >1KB\n' +
  '   - 失败的重试一次, 再失败则记入 failed 列表\n' +
  '   - Twitter pbs.twimg.com 图片可直接下载, 不需要特殊 headers\n\n' +
  '3. 对 is_remote=false 的本地图片, 用 bash(PowerShell)复制:\n' +
  '   Copy-Item -LiteralPath "<找到的源路径>" -Destination "' + args.assets_dir + '/<local_filename>" -Force\n' +
  '   - 如果 Glob 找不到源文件, 记入 failed 列表\n\n' +
  '4. 对每张成功下载/复制的图片, 记录:\n' +
  '   - desc: 原描述\n' +
  '   - local_path: assets_dir + "/" + local_filename\n' +
  '   - source_url: 原始 URL\n' +
  '   - source_files: 引用该图片的文件名列表\n\n' +
  '返回下载结果。',
  { label: '下载图片', agentType: 'general', schema: {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            desc: { type: 'string' },
            local_path: { type: 'string' },
            source_url: { type: 'string' },
            source_files: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      downloaded_count: { type: 'number' },
      failed_count: { type: 'number' },
      failed: { type: 'array', items: { type: 'object' }, description: '下载失败的图片列表' },
    },
    required: ['images', 'downloaded_count'],
  } }
)

log('图片收集完成: 下载 ' + download.downloaded_count + ' 张, 失败 ' + (download.failed_count || 0) + ' 张')

return {
  images: download.images || [],
  assets_dir: args.assets_dir,
  downloaded_count: download.downloaded_count || 0,
  failed_count: download.failed_count || 0,
  failed: download.failed || [],
  ok: true,
}
