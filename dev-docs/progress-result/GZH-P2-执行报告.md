# GZH-P2 执行报告(所见即所得:layout-html 入箱)

> 阶段:GZH-P2(方案 V2 第五节 P2)
> 完成时间:2026-11-03(代码 + mock 验收)
> 验收结论:**mock 6/6 全绿;微信真机验证未做(A1/A2 待用户)**,P2 尚不能标记完成

## 交付清单

| 任务 | 交付 | 状态 |
|------|------|------|
| T2.1 `publish.py --html-file` | `dev-examples/wx-article/scripts/draft_manager/publish.py`:新参数,跳过 `convert_md` 直读 HTML 文件(相对路径按文章目录解析);layout 模式 contentHash 混入 HTML 内容哈希与 `layout-file` 模式标记——同 md 换主题必触发草稿更新、与 convert_md 模式哈希永不碰撞;layout 比 md 旧时 WARN | 代码完成,mock 6/6 |
| T2.2 预览页导出渲染 HTML | bridge 新增 `article:export:request/response`(取 `renderedContent`);React"导出渲染 HTML"按钮;服务端 `/api/gzh/article/export` 写 `layout.html`(签名 URL 还原相对引用;不动正文 md) | 代码完成,E2E 覆盖 |
| T2.3 主题自动推荐/收藏 | — | 后议(方案既定;依赖真机验证结论) |

## mock 验收(`run_p2_layout_test.py`,零触网)

1. layout 模式入箱成功(`[5] DRAFT OK` + `layout mode` 标记)
2. 同 layout 复跑走复用不建新稿(`(reuse, verified`)
3. layout 变更触发草稿更新(哈希变化)
4. 切回 convert_md 模式哈希不碰撞(必视为内容变化)
5. html-file 缺失显式报错
6. 导出链路(E2E):layout.html 落盘、图片相对引用、正文 md 不动

## 真机验证清单(A1,用户操作)

1. 真实文章 `/gzh-preview` → 选主题 → 导出渲染 HTML
2. `publish.py --article-dir <dir> --cover imgs/cover-*.png --account-slot 1 --html-file layout.html`
3. 微信后台/手机端逐项比对:标题样式、引用块、代码块、表格、图片(尤其连续图布局与 GIF)
4. 若图片布局乱(A2:导出未做 grid→table 转换)→ bridge export 补 `convertGridToTable` 再验
5. 结论回写本报告与方案(不达标则 P2 降级:主题仅预览,publish 保持 convert_md)
