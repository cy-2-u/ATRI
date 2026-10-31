[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$root = 'D:\work\新建文件夹\xing'
$repo = 'cy-2-u/ATRI'
$work = Join-Path $env:TEMP 'xing-push'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force -Path $work | Out-Null

# ---- 1. 收集要推送的文件（尊重 .gitignore 语义：排除构建/运行/本地产物） ----
$excludeDirs = '\\(node_modules|dist|data|backups|sandbox)(\\|$)'
$excludeFiles = '\.(db|db-wal|db-shm|log)$|^\.env$|^\.env\.'
$files = Get-ChildItem -Recurse -File $root |
  Where-Object { $_.FullName -notmatch $excludeDirs -and $_.FullName -notmatch $excludeFiles } |
  ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\', '/') } |
  Sort-Object
Write-Output "待推送文件数: $($files.Count)"

# ---- 2. 当前 head ----
$ref = gh api "repos/$repo/git/ref/heads/main" | ConvertFrom-Json
$headSha = $ref.object.sha
Write-Output "当前 main: $headSha"

# ---- 3. 逐文件创建 blob（base64 全走 --input 文件体，避开命令行长度限制） ----
$entries = @()
$i = 0
foreach ($rel in $files) {
  $i++
  $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root ($rel -replace '/', '\')))
  $b64 = [Convert]::ToBase64String($bytes)
  $body = Join-Path $work 'blob.json'
  @{ content = $b64; encoding = 'base64' } | ConvertTo-Json -Compress | Set-Content -Path $body -Encoding UTF8 -NoNewline
  $sha = gh api "repos/$repo/git/blobs" --input $body --jq '.sha'
  if (-not $sha) { throw "blob 失败: $rel" }
  $entries += @{ path = $rel; mode = '100644'; type = 'blob'; sha = $sha }
  if ($i % 20 -eq 0) { Write-Output "  blob $i/$($files.Count)" }
}
Write-Output "blob 全部完成"

# ---- 4. 全量替换树（不带 base_tree：不在清单里的旧文件自动从最新提交消失） ----
$treeBody = Join-Path $work 'tree.json'
@{ tree = $entries } | ConvertTo-Json -Depth 5 -Compress | Set-Content -Path $treeBody -Encoding UTF8 -NoNewline
$treeSha = gh api "repos/$repo/git/trees" --input $treeBody --jq '.sha'
if (-not $treeSha) { throw 'tree 失败' }
Write-Output "tree: $treeSha"

# ---- 5. 提交并快进 main ----
$msg = @'
xing v5.0.0：全量重写上线版

- 她的自由：删除熔断闸门，异常只观察不拦截；边界写进设计文档
- 夜间整理拍（相近/矛盾记忆对合并替代）、心跳白日梦、在追的事（pursuit）
- 节律统计进 /api/status 与管理页；beat 专用历史窗口与短查询跳过嵌入（缓存/用量优化）
- 13 步迁移链折叠为幂等引导，4.0 旧库就地升级；测试合并为 6 个领域文件
- 全量验证：typecheck/format/配对 51↔44/50 测试/构建/冒烟/月度模拟全绿
'@
$commitBody = Join-Path $work 'commit.json'
@{ message = $msg; tree = $treeSha; parents = @($headSha) } | ConvertTo-Json -Depth 4 -Compress |
  Set-Content -Path $commitBody -Encoding UTF8 -NoNewline
$commitSha = gh api "repos/$repo/git/commits" --input $commitBody --jq '.sha'
if (-not $commitSha) { throw 'commit 失败' }
$updateBody = Join-Path $work 'ref.json'
@{ sha = $commitSha; force = $false } | ConvertTo-Json -Compress | Set-Content -Path $updateBody -Encoding UTF8 -NoNewline
$updated = gh api -X PATCH "repos/$repo/git/refs/heads/main" --input $updateBody --jq '.object.sha'
Write-Output "main 已更新: $updated"
Write-Output "提交: https://github.com/$repo/commit/$commitSha"
Remove-Item -Recurse -Force $work
