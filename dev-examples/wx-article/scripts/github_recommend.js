export const meta = {
  name: 'github_recommend',
  description: 'GitHub 项目推荐总编排: 研究(Workflow A) -> 检查 -> 文章(Workflow B) -> 检查 -> 汇总返回。薄编排层: 只串联与失败归因, 不实现业务逻辑; B 失败时知识库已保留可单独重跑。',
}

// 输入 args:
//   repoUrl      : GitHub 地址(必填)
//   angle        : 写作角度(可选, 透传给 B, 缺省 recommend)
//   category     : 预指定分类(可选, 透传给 A)
//   force        : 强制重新研究/另写一篇(可选, 分别透传)
//   title        : 预指定文章标题(可选, 透传给 B)
//   kb_root / workspace_dir: 透传
// 输出: { ok, projectId, researchReused, articleId, articleDir, status, missing[], report }

phase('研究（Workflow A）')
const research = await workflow('./github_research.js', {
  repoUrl: args.repoUrl,
  ...(args.category ? { category: args.category } : {}),
  ...(args.force ? { force: true } : {}),
  ...(args.kb_root ? { kb_root: args.kb_root } : {}),
})
await check(() => research && research.ok === true,
  '研究阶段失败: ' + JSON.stringify(research && (research.issues || research.report || research)))
log('研究完成: ' + research.projectId + (research.reused ? '（复用已有档案）' : '（新归档）'))

phase('文章（Workflow B）')
const article = await workflow('./github_article.js', {
  projectId: research.projectId,
  ...(args.angle ? { angle: args.angle } : {}),
  ...(args.force ? { force: true } : {}),
  ...(args.title ? { title: args.title } : {}),
  ...(args.kb_root ? { kb_root: args.kb_root } : {}),
  ...(args.workspace_dir ? { workspace_dir: args.workspace_dir } : {}),
})
await check(() => article && article.ok === true,
  '文章阶段失败（知识库已保留 projectId=' + research.projectId + '，可单独重跑 github-article）: ' +
  JSON.stringify(article && (article.issues || article.report || article)))

phase('汇总')
return {
  ok: true,
  projectId: research.projectId,
  researchReused: research.reused === true,
  articleId: article.articleId,
  articleDir: article.articleDir,
  status: article.status,
  missing: article.missing || [],
  report: (research.reused ? '[复用档案] ' : '[新研究] ') + research.projectId +
    '\n[文章] ' + article.report,
}
