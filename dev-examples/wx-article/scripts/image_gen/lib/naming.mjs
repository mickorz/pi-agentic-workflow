// 配图文件名命名约定（IMG-L：用户定版 2026-10-28）：
//   封面：cover-<中文主题>.png（落文章根目录，check_state cover_state root 分支 / cover_resize 2.35:1 全兼容）
//   正文：NN-<中文标题去空格>.png（NN = heading 章节号两位；章节号语义 = 序号 N 对应第 N 个 ## 章节，
//         与 insert_images.py 序号确定性映射天然对齐；无章节号的 heading 回退图片顺序号）
//   文件名安全：去空格与 IMG_REF 截断坑字符（括号/引号等），中文保留（微信/Obsidian 实践验证），限长防超 128。
//   稳定 ID 语义不变：约定只影响"首次分配"（plan 无 filename 时），已锁定 filename 的条目不受影响。

/** 中文数字 → 阿拉伯数字（支持 一~十九，足够图位上限 12）；解析失败返回 null */
export function cnNumToArabic(cn) {
  const digit = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (cn === "十") return 10;
  const m = cn.match(/^十([一二三四五六七八九])$/);
  if (m) return 10 + digit[m[1]];
  if (digit[cn]) return digit[cn];
  return null;
}

/** 从 heading（如 "## 二、AI 正在打破前后端的技术边界"）提取章节号；无章节号返回 null */
export function chapterNoFromHeading(heading) {
  const m = String(heading ?? "").match(/^#{0,4}\s*[（(]?([一二三四五六七八九十]{1,2})[）)]?[、..::\s]/);
  return m ? cnNumToArabic(m[1]) : null;
}

/** 主题文本 → 安全文件名主体：去 md 前缀/章节序号、去空格与 IMG_REF 截断坑字符、限长 */
export function topicStem(text, maxLen = 24) {
  let s = String(text ?? "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[（(]?[一二三四五六七八九十]{1,2}[）)]?[、..::\s]/, "")
    .replace(/[\s（）()「」『』《》"'：:；;，,。.？?！!【】\[\]——…·\-—/\\#*]+/g, "")
    .trim();
  return s.slice(0, maxLen) || null;
}

/**
 * 首次分配正文图 filename：章节号优先，回退图片顺序号。
 * @param heading plan/convert 的条目标题
 * @param seq 图片顺序号（1 起）
 * @param fallbackStem 无主题文本时的兜底（如 term-01）
 */
export function bodyFilename(heading, seq, fallbackStem) {
  const nn = chapterNoFromHeading(heading) ?? seq;
  const stem = topicStem(heading) ?? fallbackStem;
  return `${String(nn).padStart(2, "0")}-${stem}.png`;
}

/** 首次分配封面 filename：cover-<中文主题>.png；主题取 heading/concept/兜底 */
export function coverFilename(heading, concept, fallback = "cover") {
  const stem = topicStem(heading, 20) ?? topicStem(concept, 20) ?? fallback;
  return `cover-${stem}.png`;
}
