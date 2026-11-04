[http://127.0.0.1:4317/gzh-preview?dir=E%3A%5CObsidian%5Cnewsky%5C60_Workspace%5C%E5%86%99%E4%BD%9C%5C%E5%8D%95%E7%AF%87%5C20261029%5Cthinkrail+IDE](http://127.0.0.1:4317/gzh-preview?dir=E%3A%5CObsidian%5Cnewsky%5C60_Workspace%5C%E5%86%99%E4%BD%9C%5C%E5%8D%95%E7%AF%87%5C20261029%5Cthinkrail+IDE)



&nbsp;

用鼠标滚轮 能够正常调节文章 滚动条



但是使用拖动滚动条时，会出现一直抖动，没办法正常拖动 

---

## 处理结果(2026-11-03)

- 根因:huasheng_editor app.js 双向滚动同步,rAF 解锁早于异步 scroll 事件派发,且编辑器→预览(行比例)与预览→编辑器(锚点插值)映射不对称,程序化滚动互发回写形成乒乓;拖动滚动条时持续打架即抖动,滚轮离散事件收敛快故不明显
- 实测:单次程序化滚动 pv=600 触发 3+3 互写,pv 漂移至 506、ta 两跳(416→312)
- 修复:补丁 4(确认应答模式,见 thirdparties/huasheng_editor/README-PATCH.md);复测单次滚动恰 1+1 事件、位置全程稳定;T0.1 桥接回归 10/10
