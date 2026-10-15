<#
.SYNOPSIS
    在 Windows 上生成 IIS 发布包：dist\LogiSim-IIS-v<版本>.zip
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$appJs = Get-Content "src\wwwroot\assets\js\app.js" -Raw -Encoding UTF8
if ($appJs -notmatch "const APP_VERSION='([^']+)'") { throw "未能从 app.js 读取版本号" }
$ver = $Matches[1]
$index = Get-Content "src\wwwroot\index.html" -Raw -Encoding UTF8
foreach ($f in @("assets/js/app.js?v=$ver", "assets/js/sim-core.js?v=$ver", "assets/css/app.css?v=$ver")) {
    if (-not $index.Contains($f)) { throw "index.html 中缺少 $f（版本号不一致）" }
}

$name = "LogiSim-IIS-v$ver"
$out = Join-Path $root "dist\$name"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
$zip = Join-Path $root "dist\$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

Copy-Item "src\wwwroot" (Join-Path $out "wwwroot") -Recurse
$scen = Join-Path $out "wwwroot\App_Data\scenarios"
if (Test-Path $scen) { Remove-Item $scen -Recurse -Force }
Copy-Item "deploy" (Join-Path $out "deploy") -Recurse
Copy-Item "DEPLOY.md", "README.md", "CHANGELOG.md" $out

Compress-Archive -Path $out -DestinationPath $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$hash  $name.zip" | Set-Content "$zip.sha256" -Encoding ASCII
Write-Host "已生成 $zip"
Write-Host "SHA256 $hash"
