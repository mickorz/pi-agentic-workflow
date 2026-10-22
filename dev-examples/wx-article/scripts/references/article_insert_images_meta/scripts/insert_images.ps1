param(
  [Parameter(Mandatory=$true)][string]$ArticleDir,
  [string]$MdFile = '',
  [Parameter(Mandatory=$true)][string]$MappingPath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $ArticleDir)) { Write-Output "[FAIL] article_dir not found: $ArticleDir"; exit 1 }
if (-not (Test-Path -LiteralPath $MappingPath)) { Write-Output "[FAIL] mapping not found: $MappingPath"; exit 1 }

if (-not $MdFile) {
  $cands = Get-ChildItem -LiteralPath $ArticleDir -Filter *.md |
    Where-Object { $_.Name -notmatch '^(article|draft|review)' -and $_.Name -notmatch '审稿' -and $_.Name -notmatch 'pre-humanize' } |
    Sort-Object Length -Descending
  if (-not $cands -or $cands.Count -eq 0) { Write-Output "[FAIL] no .md found in $ArticleDir"; exit 1 }
  $MdFile = $cands[0].FullName
}
if (-not (Test-Path -LiteralPath $MdFile)) { Write-Output "[FAIL] md not found: $MdFile"; exit 1 }
Write-Output "[md] $MdFile"

$mapping = Get-Content -LiteralPath $MappingPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($mapping -isnot [System.Array]) { $mapping = @($mapping) }

$text = [System.IO.File]::ReadAllText($MdFile, [System.Text.Encoding]::UTF8)
$nl = if ($text -match "`r`n") { "`r`n" } else { "`n" }
$lines = New-Object System.Collections.ArrayList
foreach ($l in ($text -split "`r?`n")) { [void]$lines.Add($l) }

$inserted = 0
$failed = @()
foreach ($m in $mapping) {
  $image = [string]$m.image
  $heading = [string]$m.heading
  $alt = [string]$m.alt
  if (-not $alt) { $alt = '术语插画' }
  if (-not $image -or -not $heading) { $failed += "missing image/heading ($image)"; continue }

  $hkey = $heading.Trim()
  $hi = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].Trim() -eq $hkey) { $hi = $i; break } }
  if ($hi -lt 0) { for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].Trim().StartsWith($hkey)) { $hi = $i; break } } }
  if ($hi -lt 0) { $failed += "heading not found: $heading"; continue }

  $ai = -1
  for ($i = $hi + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -match '^##\s') { break }
    if ($lines[$i] -match '^\*\*一句话记住') { $ai = $i; break }
  }
  if ($ai -lt 0) {
    $ai = $lines.Count
    for ($i = $hi + 1; $i -lt $lines.Count; $i++) { if ($lines[$i].Trim() -match '^##\s') { $ai = $i; break } }
  }

  $marker = '![' + $alt + '](' + $image + ')'
  $lines.Insert($ai, '')
  $lines.Insert($ai, $marker)
  $lines.Insert($ai, '')
  $inserted++
  Write-Output ("[OK] " + $image + " -> " + $heading.Trim())
}

[System.IO.File]::WriteAllText($MdFile, ($lines -join $nl), (New-Object System.Text.UTF8Encoding($true)))

$final = [System.IO.File]::ReadAllText($MdFile, [System.Text.Encoding]::UTF8)
$imgCount = ([regex]::Matches($final, '!\[[^\]]*\]\(imgs/')).Count
Write-Output ("=== inserted $inserted / $($mapping.Count) ; md img markers now: $imgCount ===")
if ($failed.Count -gt 0) {
  foreach ($f in $failed) { Write-Output ("[FAIL] " + $f) }
  exit 2
}
Write-Output "=== ALL DONE ==="
