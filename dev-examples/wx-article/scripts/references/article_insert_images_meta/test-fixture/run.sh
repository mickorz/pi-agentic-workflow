#!/usr/bin/env bash
# insert_images.ps1 自检：双分支插入（一句话记住前 / 章节末尾）+ 未匹配章节 FAIL 路径
# 用法：bash dev-examples/wx-article/scripts/references/article_insert_images_meta/test-fixture/run.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# realpath 归一（避免 ../ 段直接传给 PS -File）
PS1_SCRIPT="$(cd "$HERE/../scripts" && pwd)/insert_images.ps1"
MD="$HERE/sample-article.md"
MAP="$HERE/mapping.json"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# 每次重建 fixture（干净态，可重复执行）
mkdir -p "$HERE/imgs"
printf 'dummy' > "$HERE/imgs/vec-db.png"
printf 'dummy' > "$HERE/imgs/rag.png"
cat > "$MD" <<'EOF'
# 从零学AI：测试文章

## 01. 向量数据库：AI 的记忆检索柜

正文一段。

**一句话记住**：向量库是 AI 的外接记忆。

## 02. RAG：让 AI 学会开卷考试

正文一段，本节没有"一句话记住"行。
EOF
cat > "$MAP" <<'EOF'
[
  {"image": "imgs/vec-db.png", "heading": "## 01. 向量数据库：AI 的记忆检索柜", "alt": "术语插画：向量库"},
  {"image": "imgs/rag.png", "heading": "## 02. RAG：让 AI 学会开卷考试", "alt": "术语插画：RAG"},
  {"image": "imgs/none.png", "heading": "## 09. 不存在的章节", "alt": "不该插入"}
]
EOF

OUT="$(powershell -NoProfile -ExecutionPolicy Bypass -File "$PS1_SCRIPT" -ArticleDir "$HERE" -MappingPath "$MAP" 2>&1)"
RC=$?
echo "$OUT"

echo "$OUT" | grep -Fq "=== inserted 2 / 3" && ok "插入统计 2/3" || bad "插入统计期望 2/3"
[ $RC -eq 2 ] && ok "未匹配章节退出码 2" || bad "退出码期望 2，实际 $RC"
grep -Fq "![术语插画：向量库](imgs/vec-db.png)" "$MD" && ok "章节1 图已插入" || bad "章节1 未插入"
LINE_IMG=$(grep -F "imgs/vec-db.png" "$MD" | head -1 >/dev/null; grep -n "imgs/vec-db.png" "$MD" | head -1 | cut -d: -f1)
LINE_MEM=$(grep -n "一句话记住" "$MD" | head -1 | cut -d: -f1)
if [ -n "$LINE_IMG" ] && [ -n "$LINE_MEM" ] && [ "$LINE_IMG" -lt "$LINE_MEM" ]; then
  ok "图在 一句话记住 之前（img 行 $LINE_IMG < 记住行 $LINE_MEM）"
else
  bad "插入位置错误 img=$LINE_IMG mem=$LINE_MEM"
fi
grep -Fq "![术语插画：RAG](imgs/rag.png)" "$MD" && ok "章节2（无记住行）图已插入" || bad "章节2 未插入"
LINE_RAG=$(grep -n "imgs/rag.png" "$MD" | head -1 | cut -d: -f1)
LINE_H2=$(grep -n "^## 02" "$MD" | head -1 | cut -d: -f1)
if [ -n "$LINE_RAG" ] && [ -n "$LINE_H2" ] && [ "$LINE_RAG" -gt "$LINE_H2" ]; then
  ok "章节2 图在章节末尾区域内"
else
  bad "章节2 插入位置错误 rag=$LINE_RAG h2=$LINE_H2"
fi
grep -Fq "imgs/none.png" "$MD" && bad "不该插入的图出现了" || ok "未匹配图未写入"
grep -Fq "[FAIL] heading not found" <<<"$OUT" && ok "未匹配项列入 FAIL 行" || bad "未见 FAIL 行"

# 还原 fixture 为下次运行的干净输入（本次插入结果留在 sample-article.md 供人工查看，下次运行前重建）
echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
