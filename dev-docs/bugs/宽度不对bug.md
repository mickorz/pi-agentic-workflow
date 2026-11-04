[http://127.0.0.1:4317/gzh-preview?dir=E%3A%5CObsidian%5Cnewsky%5C60_Workspace%5C%E5%86%99%E4%BD%9C%5C%E5%8D%95%E7%AF%87%5C20261029%5Cthinkrail+IDE](http://127.0.0.1:4317/gzh-preview?dir=E%3A%5CObsidian%5Cnewsky%5C60_Workspace%5C%E5%86%99%E4%BD%9C%5C%E5%8D%95%E7%AF%87%5C20261029%5Cthinkrail+IDE)



页面中

&nbsp;

&lt;header&gt; 的宽度 正常



&lt;main&gt; 包含的文章板块 宽度小了，左右两边有大量的空白，需要对比一下原版的，是不是改了什么导致的



---

## 处理结果(2026-11-03)

- 根因:非 huasheng 改动。工作台全局样式 main { max-width: 1080px; margin: 0 auto }(Dashboard/NewRun 窄内容居中设计)把预览页一并限宽,宽屏下左右大空白
- 修复:styles.css 增加 main:has(> .gzh-preview) { max-width: none; padding: 12px 16px } —— 仅预览页全幅,其余页面布局不动
- 实测:viewport 1386 下 main 由 1080 -> 1386 全幅,编辑器 iframe 1354
