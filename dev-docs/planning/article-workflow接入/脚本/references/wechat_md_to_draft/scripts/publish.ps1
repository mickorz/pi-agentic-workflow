param(
  [Parameter(Mandatory=$true)][string]$ArticleDir,
  [Parameter(Mandatory=$true)][string]$Cover
)
# 写作稿直发草稿箱脚本: .md(含 frontmatter) + 指定封面 -> 微信草稿箱
# 由 workflow wechat_md_to_draft.js 调用
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 向上找仓库根(含 .aws-article 的祖先)
$repoRoot = $ArticleDir
while ($repoRoot -and -not (Test-Path -LiteralPath (Join-Path $repoRoot ".aws-article"))) {
  $parent = [System.IO.Path]::GetDirectoryName($repoRoot)
  if (-not $parent -or $parent -eq $repoRoot) { break }
  $repoRoot = $parent
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot ".aws-article"))) {
  Write-Output "[FAIL] cannot find repo root (.aws-article) from $ArticleDir"; exit 1
}
$envFile = Join-Path $repoRoot "aws.env"
$configPath = Join-Path $repoRoot ".aws-article\config.json"
$base = "https://api.weixin.qq.com"

# 找 .md 写作稿(排除 article/draft/审稿/review 开头,取最长名)
$mdCandidates = Get-ChildItem -LiteralPath $ArticleDir -Filter *.md | Where-Object { $_.Name -notmatch '^(article|draft|review)' -and $_.Name -notmatch '审稿' } | Sort-Object Name.Length -Descending
if (-not $mdCandidates -or $mdCandidates.Count -eq 0) { Write-Output "[FAIL] no .md found in $ArticleDir"; exit 1 }
$mdPath = $mdCandidates[0].FullName
Write-Output "[md] $($mdCandidates[0].Name)"

# 读凭证
$vars = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
  if ($line -match '^\s*(\w+)\s*=\s*(.+?)\s*$') { $vars[$matches[1]] = $matches[2] }
}

# 读 .md + frontmatter
$md = Get-Content -LiteralPath $mdPath -Raw -Encoding UTF8
$title = ''; $description = ''
if ($md -match '(?ms)^---\r?\n(.*?)\r?\n---') {
  $fm = $matches[1]
  if ($fm -match '(?m)^title\s*:\s*"?(.+?)"?\s*$') { $title = $matches[1] }
  if ($fm -match '(?m)^description\s*:\s*"?(.+?)"?\s*$') { $description = $matches[1] }
}
$cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$author = $cfg.default_author; if (-not $author) { $author = 'AI奇点' }
$digest = $description; if (-not $digest) { $digest = $title }
Write-Output "[meta] title=$title | author=$author | digestLen=$($digest.Length)"

# markdown -> HTML
function Render-Table($sb, $rows) {
  [void]$sb.AppendLine('<table style="width:100%;border-collapse:collapse;margin:0 0 24px;font-size:14px;">')
  $hdr = $rows[0] -split '\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
  $th = ($hdr | ForEach-Object { '<th style="border:1px solid #DDD;padding:8px;background:#F7F7F9;text-align:left;">' + $_ + '</th>' }) -join ''
  [void]$sb.AppendLine('<thead><tr>' + $th + '</tr></thead><tbody>')
  for ($i = 2; $i -lt $rows.Count; $i++) {
    $cells = $rows[$i] -split '\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
    $td = ($cells | ForEach-Object { '<td style="border:1px solid #DDD;padding:8px;">' + $_ + '</td>' }) -join ''
    [void]$sb.AppendLine('<tr>' + $td + '</tr>')
  }
  [void]$sb.AppendLine('</tbody></table>')
}

function Convert-Md($text) {
  $text = [regex]::Replace($text, '(?s)^---\r?\n.*?\r?\n---\r?\n', '')
  $lines = $text -split "`r?`n"
  $openSection = @'
<section style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;font-size:16px;color:#1F1F1F;line-height:1.95;letter-spacing:0.5px;">
'@
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine($openSection)
  $inList = $false; $tableRows = @()
  foreach ($line in $lines) {
    $t = $line.Trim()
    if ($t -eq '') {
      if ($inList) { [void]$sb.AppendLine('</ul>'); $inList = $false }
      if ($tableRows.Count -gt 0) { Render-Table $sb $tableRows; $tableRows = @() }
      continue
    }
    if ($t -match '^###\s+(.*)') { if ($inList) { [void]$sb.AppendLine('</ul>'); $inList = $false }; if ($tableRows.Count -gt 0) { Render-Table $sb $tableRows; $tableRows = @() }; [void]$sb.AppendLine('<h3 style="margin:24px 0 12px;font-size:18px;font-weight:700;color:#1F1F1F;">' + $matches[1] + '</h3>'); continue }
    if ($t -match '^##\s+(.*)') { if ($inList) { [void]$sb.AppendLine('</ul>'); $inList = $false }; if ($tableRows.Count -gt 0) { Render-Table $sb $tableRows; $tableRows = @() }; [void]$sb.AppendLine('<h2 style="margin:30px 0 16px;font-size:20px;font-weight:700;color:#1F1F1F;">' + $matches[1] + '</h2>'); continue }
    if ($t -match '^#\s*(.*)') { continue }
    if ($t -match '^-{3,}$' -or $t -match '^\*{3,}$') { if ($inList) { [void]$sb.AppendLine('</ul>'); $inList = $false }; if ($tableRows.Count -gt 0) { Render-Table $sb $tableRows; $tableRows = @() }; [void]$sb.AppendLine('<hr style="border:none;border-top:1px solid #E5E5E5;margin:24px 0;">'); continue }
    if ($t -match '^!\[([^\]]*)\]\(([^)]+)\)') { if ($inList) { [void]$sb.AppendLine('</ul>'); $inList = $false }; if ($tableRows.Count -gt 0) { Render-Table $sb $tableRows; $tableRows = @() }; $alt = $matches[1]; $src = $matches[2]; [void]$sb.AppendLine('<figure style="margin:0 0 24px;"><img src="' + $src + '" alt="' + $alt + '" style="display:block;width:100%;border-radius:8px;"><figcaption style="font-size:13px;color:#999;margin-top:6px;text-align:center;">' + $alt + '</figcaption></figure>'); continue }
    if ($t -match '^\|') { if ($inList) { [void]$sb.AppendLine('</ul>'); $inList = $false }; $tableRows += $t; continue }
    if ($t -match '^- (.*)') { if (-not $inList) { [void]$sb.AppendLine('<ul style="margin:0 0 20px;padding-left:20px;">'); $inList = $true }; [void]$sb.AppendLine('<li style="margin:0 0 8px;line-height:1.8;">' + $matches[1] + '</li>'); continue }
    if ($inList) { [void]$sb.AppendLine('</ul>'); $inList = $false }
    if ($tableRows.Count -gt 0) { Render-Table $sb $tableRows; $tableRows = @() }
    $p = $t
    $p = [regex]::Replace($p, '\[([^\]]+)\]\(([^)]+)\)', '<a href="$2" style="color:#5B5B95;text-decoration:none;">$1</a>')
    $p = [regex]::Replace($p, '\*\*([^\*]+)\*\*', '<strong style="font-weight:700;">$1</strong>')
    $p = [regex]::Replace($p, '(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)', '<em>$1</em>')
    [void]$sb.AppendLine('<p style="margin:0 0 20px;text-align:justify;line-height:1.95;">' + $p + '</p>')
  }
  if ($inList) { [void]$sb.AppendLine('</ul>') }
  if ($tableRows.Count -gt 0) { Render-Table $sb $tableRows }
  [void]$sb.AppendLine('</section>')
  return $sb.ToString()
}

$html = Convert-Md $md
Write-Output "[html] generated $($html.Length) chars"

# 扫描 .md 图片引用
$imgRefs = [regex]::Matches($md, '!\[[^\]]*\]\(([^)]+)\)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
Write-Output "[imgs] found $($imgRefs.Count) image refs"

# 拿 token
$tokenUrl = "$base/cgi-bin/token?grant_type=client_credential&appid={0}&secret={1}" -f $vars['WECHAT_1_APPID'], $vars['WECHAT_1_APPSECRET']
$tr = Invoke-RestMethod -Uri $tokenUrl
if (-not $tr.access_token) { Write-Output "[FAIL] TOKEN errcode=$($tr.errcode) errmsg=$($tr.errmsg)"; exit 1 }
$token = $tr.access_token
Write-Output "[1] TOKEN OK"

# 上传封面
$thumbApi = "$base/cgi-bin/material/add_material?access_token=$token&type=image"
$thumbRaw = & curl.exe -s -X POST $thumbApi -F "media=@$Cover"
$thumbResp = $thumbRaw | ConvertFrom-Json
if (-not $thumbResp.media_id) { Write-Output "[FAIL] THUMB errcode=$($thumbResp.errcode) errmsg=$($thumbResp.errmsg) raw=$thumbRaw"; exit 1 }
$thumbMediaId = $thumbResp.media_id
Write-Output "[2] THUMB OK media_id=$thumbMediaId"

# 上传正文图(按 imgRefs 路径)
$imgMap = @{}; $idx = 0
foreach ($ref in $imgRefs) {
  $imgPath = (Join-Path $ArticleDir $ref) -replace '/', '\'
  if (-not (Test-Path -LiteralPath $imgPath)) { Write-Output "[FAIL] IMG not found: $ref"; exit 1 }
  $idx++; $u = "$base/cgi-bin/media/uploadimg?access_token=$token"
  $raw = & curl.exe -s -X POST $u -F "media=@$imgPath"
  $resp = $raw | ConvertFrom-Json
  if (-not $resp.url) { Write-Output "[FAIL] IMG $idx $ref errcode=$($resp.errcode) errmsg=$($resp.errmsg)"; exit 1 }
  $imgMap[$ref] = $resp.url
  Write-Output "[3] IMG $idx/$($imgRefs.Count) $ref OK"
}

# 替换 HTML 图片路径为微信 URL(兼容 / 和 \)
foreach ($ref in $imgMap.Keys) {
  $html = $html.Replace($ref, $imgMap[$ref])
  $refBack = $ref -replace '/', '\'
  $html = $html.Replace($refBack, $imgMap[$ref])
}
$left = [regex]::Matches($html, '(?:src|href)="(?:引用|imgs|图片|placeholder)') | ForEach-Object { $_.Value }
if ($left) { Write-Output "[WARN] leftover: $($left -join '; ')" }
Write-Output "[4] html after replace $($html.Length) chars"

# draft/add
$draftApi = "$base/cgi-bin/draft/add?access_token=$token"
$bodyObj = @{
  articles = @(@{
    title = $title; author = $author; digest = $digest; content = $html
    thumb_media_id = $thumbMediaId; content_source_url = ""
    need_open_comment = [int]$cfg.need_open_comment; only_fans_can_comment = [int]$cfg.only_fans_can_comment
  })
}
$bodyJson = $bodyObj | ConvertTo-Json -Depth 5
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)
$draftResp = Invoke-RestMethod -Uri $draftApi -Method Post -ContentType "application/json; charset=utf-8" -Body $bodyBytes
if (-not $draftResp.media_id) { Write-Output "[FAIL] DRAFT errcode=$($draftResp.errcode) errmsg=$($draftResp.errmsg)"; exit 1 }
$draftMediaId = $draftResp.media_id
Write-Output "[5] DRAFT OK media_id=$draftMediaId"

# 产物
Add-Content -LiteralPath (Join-Path $ArticleDir "publish.log") -Value "[publish] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') account=$($vars['WECHAT_1_APPID']) thumb=$thumbMediaId draft=$draftMediaId imgs=$($imgMap.Count) method=draft" -Encoding UTF8
$yaml = "title: $title`nauthor: $author`ndigest: $digest`npublish_completed: true`ncontent_source: $(Split-Path -Leaf $mdPath)`n"
Set-Content -LiteralPath (Join-Path $ArticleDir "article.yaml") -Value $yaml -Encoding UTF8
Copy-Item -LiteralPath $mdPath -Destination (Join-Path $ArticleDir "article.md") -Force
Write-Output "[6] publish.log + article.yaml + article.md saved"
Write-Output "=== ALL DONE draft_media_id=$draftMediaId ==="
