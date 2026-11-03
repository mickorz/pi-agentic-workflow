/**
 * GZH 预览工作台编辑器桥(T0.1 最小实现)
 *
 * 协议与设计:dev-docs/planning/2026-11-03-GZH排版工作台执行方案.md(方案 V2 D1/D1.6)
 * 约定:
 *   - 独立打开(非 iframe)时本脚本完全静默,编辑器零行为变化(零回归原则)
 *   - hosted 模式(iframe 内)把 localStorage 的 markdownInput/currentStyle 两键改道
 *     sessionStorage 的 hosted: 前缀,编辑器持久化代码零改动,独立草稿永不被污染
 *   - editor:ready 以 window.editorVm.md 就绪为准(mounted 是 async,md 初始化在其内部)
 *   - 消息类型:article:load / style:change / article:get:request(宿主->编辑器);
 *     editor:ready / article:dirty / article:get:response(编辑器->宿主)
 * 注释与实现均为 UTF-8;不使用任何 Emoji。
 */
(function () {
  'use strict';

  // 非 iframe 场景:独立模式,不做任何事
  if (window.self === window.top) return;

  var HOSTED_KEYS = ['markdownInput', 'currentStyle'];
  var PREFIX = 'hosted:';

  // ---------- hostedMode 存储隔离(Storage 原型补丁,仅拦截 localStorage 两键) ----------
  // localStorage 按 Origin 隔离而非 URL 路径:同源 iframe 会覆盖用户独立草稿,故改道。
  // sessionStorage 按"标签页+Origin"隔离:预览会话随标签页结束,天然不残留。
  var proto = Object.getPrototypeOf(localStorage);
  var origSetItem = proto.setItem;
  var origGetItem = proto.getItem;
  proto.setItem = function (k, v) {
    if (this === localStorage && HOSTED_KEYS.indexOf(k) >= 0) {
      return origSetItem.call(sessionStorage, PREFIX + k, String(v));
    }
    return origSetItem.call(this, k, v);
  };
  proto.getItem = function (k) {
    if (this === localStorage && HOSTED_KEYS.indexOf(k) >= 0) {
      return origGetItem.call(sessionStorage, PREFIX + k);
    }
    return origGetItem.call(this, k);
  };

  // ---------- 桥接状态 ----------
  var sessionId = null;
  var ready = false;
  var pending = []; // editor:ready 前缓存的宿主消息
  // 上次同步基线,用于 dirty 对比(轮询,不侵入编辑器 watch;上报延迟 <= 400ms)
  var baseline = { markdown: null, style: null };

  function post(msg) {
    // 同源部署;sessionId 在 article:load 之前为 null,宿主以消息类型区分阶段
    var payload = Object.assign({ sessionId: sessionId }, msg);
    window.parent.postMessage(payload, window.location.origin);
  }

  function vm() {
    return window.editorVm || null;
  }

  function styleExists(id) {
    return typeof STYLES !== 'undefined' && STYLES && Object.prototype.hasOwnProperty.call(STYLES, id);
  }

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    var v = vm();
    if (msg.type === 'article:load') {
      sessionId = msg.sessionId || null;
      if (!v) return;
      // 先主题后正文:两次赋值各自触发 watch 的 renderMarkdown,顺序无副作用
      if (msg.style && styleExists(msg.style)) v.currentStyle = msg.style;
      if (typeof msg.markdown === 'string') v.markdownInput = msg.markdown;
      baseline = { markdown: v.markdownInput, style: v.currentStyle };
    } else if (msg.type === 'style:change') {
      if (v && msg.styleId && styleExists(msg.styleId)) {
        v.currentStyle = msg.styleId;
        baseline.style = msg.styleId;
      }
    } else if (msg.type === 'article:get:request') {
      if (!v) return;
      post({
        type: 'article:get:response',
        requestId: msg.requestId,
        markdown: v.markdownInput,
        style: v.currentStyle,
      });
    } else if (msg.type === 'article:export:request') {
      // 导出当前渲染 HTML(内联样式已烘焙;图片保持原引用,由后端还原相对路径)
      if (!v) return;
      var html = v.renderedContent || '';
      post({
        type: 'article:export:response',
        requestId: msg.requestId,
        html: html,
        style: v.currentStyle,
      });
    }
  }

  window.addEventListener('message', function (ev) {
    // 来源校验:仅同源且来自宿主窗口
    if (ev.origin !== window.location.origin) return;
    if (!ev.source || ev.source !== window.parent) return;
    if (!ready) { pending.push(ev.data); return; }
    handle(ev.data);
  });

  // ---------- editor:ready:等 mounted 异步链完成(this.md 就绪) ----------
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    var v = vm();
    if ((v && v.md) || tries > 200) {
      // 10s 仍未就绪也放行:核心编辑数据仍可读写,仅首帧预览可能延迟
      clearInterval(timer);
      ready = true;
      post({ type: 'editor:ready' });
      pending.splice(0).forEach(handle);
    }
  }, 50);

  // ---------- dirty 轮询 ----------
  setInterval(function () {
    if (!ready || !sessionId) return;
    var v = vm();
    if (!v) return;
    if (baseline.markdown !== null && v.markdownInput !== baseline.markdown) {
      baseline.markdown = v.markdownInput;
      post({ type: 'article:dirty', dirtyType: 'content' });
    }
    if (baseline.style !== null && v.currentStyle !== baseline.style) {
      baseline.style = v.currentStyle;
      post({ type: 'article:dirty', dirtyType: 'style' });
    }
  }, 400);
})();
