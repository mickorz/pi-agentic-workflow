#!/usr/bin/env node
// 小绿书卡片 VLM 审图器：逐页调 qwen3-vl-plus（dashscope OpenAI 兼容端点）按清单审核。
// 用法: node review-cards.mjs --dir <output目录> --pages <pages.json> [--model qwen3-vl-plus]
// 输出: 每页一行「页<页号>: <APPROVED|REVISION_REQUIRED|REJECTED> — <意见>」
// 依赖: 环境变量 DASHSCOPE_API_KEY
import fs from "node:fs";
import path from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const dir = arg("dir");
const pagesFile = arg("pages");
const model = arg("model", "qwen3-vl-plus");
const base = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";

if (!dir || !pagesFile) {
  console.error("用法: node review-cards.mjs --dir <output目录> --pages <pages.json>");
  process.exit(2);
}
if (!process.env.DASHSCOPE_API_KEY) {
  console.error("缺 DASHSCOPE_API_KEY");
  process.exit(2);
}

const pages = JSON.parse(fs.readFileSync(pagesFile, "utf8")).pages;

const TYPE_CRITERIA = {
  screenshot:
    "【screenshot 页标准】文字清晰可读；裁切正确（不得残留地址栏/浏览器边框/无关区域）；关键代码或数据完整未被截断",
  "ai-image":
    "【ai-image 页标准】画面构图合理；与本组其他页风格一致；内容事实准确；图中不得出现错误文字/乱码文字",
  "layout-text":
    "【layout-text 页标准】排版无溢出无重叠；字体层级清晰；与画板边缘留白得当",
};

function buildPrompt(page) {
  const copy = JSON.stringify(page.copy ?? {}, null, 1);
  const emphasis = page.emphasis ? `\n强调语(emphasis): ${JSON.stringify(page.emphasis)}` : "";
  const criteria = TYPE_CRITERIA[page.source === "html" && page.layout === "screenshot-with-caption" ? "screenshot" : page.type] || TYPE_CRITERIA[page.type] || TYPE_CRITERIA["layout-text"];
  return `你是小绿书卡片审图员。这是组图第 ${page.no} 页（共 8 页），角色: ${page.role}，版式: ${page.layout}。
${criteria}

【本页应有文案（对照核验）】
${copy}${emphasis}

逐项核对并只报实际问题：
1. 图中文字与本页应有文案是否一致（多字/少字/错字/缺字/被截断都要报）
2. 是否有溢出画板、元素重叠、文字贴边、留白失衡
3. 是否有渲染残缺（半截字形、花屏、错位）
4. 首页(第1页)额外判断：标题大字在缩略图尺寸下是否仍可辨
5. screenshot 页额外判断：裁切是否干净、代码/数据是否完整

输出格式（严格一行，不要多余内容）:
页${page.no}: <APPROVED|REVISION_REQUIRED|REJECTED> — <简短中文意见；通过则写"符合标准"；有问题逐条列出>`.trim();
}

async function reviewPage(page) {
  const img = path.join(dir, String(page.no).padStart(2, "0") + ".png");
  if (!fs.existsSync(img)) return `页${page.no}: REJECTED — 文件缺失: ${img}`;
  const b64 = fs.readFileSync(img).toString("base64");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "user", content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          { type: "text", text: buildPrompt(page) },
        ]},
      ],
      max_tokens: 600,
    }),
  });
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content?.trim();
  if (!text) return `页${page.no}: REJECTED — VLM 调用失败: ${JSON.stringify(j).slice(0, 300)}`;
  return text.split("\n").filter((l) => l.trim().startsWith(`页${page.no}:`)).join("\n") || text;
}

const results = [];
for (const p of pages) {
  const line = await reviewPage(p);
  results.push(line);
  console.error(`[done] 页${p.no}`);
}
console.log(results.join("\n"));
