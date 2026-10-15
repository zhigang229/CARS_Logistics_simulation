<#
.SYNOPSIS
    一键发布：把当前代码发布到内网 IIS 服务器（通过共享目录）。

.DESCRIPTION
    1. 读取 publish.config.json（服务器共享路径、站点地址）
    2. 运行仿真内核测试（电脑装有 Node.js 时）
    3. 生成发布目录：静态资源版本号加上时间戳，写入 version.json
    4. 备份服务器上的当前版本到本机 dist\backups（用于回滚）
    5. 同步文件到服务器：保留服务器的 web.config 和 App_Data 方案数据，删除旧版多余文件，最后替换 index.html
    6. 访问 version.json 与健康检查接口，确认新版本已生效

.EXAMPLE
    .\publish.cmd                 发布
.EXAMPLE
    .\publish.cmd -DryRun         只列出将要变更的文件，不实际发布
.EXAMPLE
    .\publish.cmd -Rollback       回滚到上一次发布前的版本
.EXAMPLE
    .\publish.cmd -Rollback -BackupName 20261015-173300
#>
param(
    [string]$Config = "",
    [switch]$DryRun,
    [switch]$SkipTests,
    [switch]$Rollback,
    [string]$BackupName = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function P() { $p = $args[0]; for ($i = 1; $i -lt $args.Count; $i++) { $p = Join-Path $p $args[$i] }; return $p }

function Invoke-Robocopy([string[]]$RoboArgs) {
    & robocopy @RoboArgs | Out-Host
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，返回码 $LASTEXITCODE" }
}

function Test-Site([string]$url, [string]$expectBuild) {
    $last = $null
    for ($i = 1; $i -le 5; $i++) {
        try {
            $info = $null
            try {
                $v = Invoke-WebRequest -Uri ($url + "version.json?t=" + [DateTime]::Now.Ticks) -UseBasicParsing -TimeoutSec 20
                $info = $v.Content | ConvertFrom-Json
            } catch { if ($expectBuild) { throw } }
            if (-not $info) { $info = @{ build = "（首次部署版本，无版本信息）" } }
            $h = Invoke-WebRequest -Uri ($url + "api/scenarios.ashx?action=health") -UseBasicParsing -TimeoutSec 60
            $health = $h.Content | ConvertFrom-Json
            if ($expectBuild -and $info.build -ne $expectBuild) { throw "线上版本是 $($info.build)，期望 $expectBuild" }
            if (-not $health.ok) { throw "健康检查失败：$($h.Content)" }
            return @{ info = $info; health = $health }
        } catch { $last = $_.Exception.Message; Start-Sleep -Seconds 2 }
    }
    throw "自检失败：$last"
}

# ---------------------------------------------------------------- 配置
if (-not $Config) { $Config = P $root "publish.config.json" }
if (-not (Test-Path $Config)) {
    throw "找不到发布配置 $Config。`n请复制 publish.config.example.json 为 publish.config.json，填写服务器共享路径和站点地址（服务器上运行 deploy\enable-remote-publish.ps1 会打印出来）。"
}
$cfg = Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$target = [string]$cfg.target
$siteUrl = ([string]$cfg.siteUrl).TrimEnd("/") + "/"
$keep = 5; if ($cfg.keepBackups) { $keep = [int]$cfg.keepBackups }
if (-not $target -or -not $cfg.siteUrl) { throw "publish.config.json 中 target 和 siteUrl 必须填写" }

Step "检查目标 $target"
if (-not (Test-Path $target)) {
    throw "无法访问 $target。请确认：1) 服务器已运行 enable-remote-publish.ps1；2) 本机能访问该服务器的共享（445 端口）；3) 如需其他账号，先执行 net use $target /user:域\账号"
}
if (-not (Test-Path (P $target "api" "scenarios.ashx"))) {
    throw "$target 中没有 api\scenarios.ashx，不像是仿真台站点目录。为防止误删文件已停止。首次部署请在服务器上运行 install-iis.ps1。"
}
Ok "目标可访问"

$backupRoot = P $root "dist" "backups"
$excludeDirs = @("App_Data", "aspnet_client")

# ---------------------------------------------------------------- 回滚
if ($Rollback) {
    Step "回滚"
    if (-not (Test-Path $backupRoot)) { throw "没有备份可回滚（$backupRoot 不存在）" }
    if ($BackupName) { $bk = P $backupRoot $BackupName }
    else { $bk = (Get-ChildItem $backupRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName }
    if (-not $bk -or -not (Test-Path $bk)) { throw "找不到备份 $BackupName" }
    Ok "使用备份 $(Split-Path -Leaf $bk)"
    if ($DryRun) { Invoke-Robocopy (@($bk, $target, "/MIR", "/L", "/NJH", "/NP", "/XF", "web.config", "/XD") + $excludeDirs); return }
    Invoke-Robocopy (@($bk, $target, "/MIR", "/R:2", "/W:2", "/NJH", "/NJS", "/NP", "/NDL", "/XF", "web.config", "index.html", "/XD") + $excludeDirs)
    Copy-Item (P $bk "index.html") (P $target "index.html") -Force
    $r = Test-Site $siteUrl ""
    Ok "已回滚，线上版本 $($r.info.build)"
    return
}

# ---------------------------------------------------------------- 版本信息
$src = P $root "src" "wwwroot"
$appJs = [IO.File]::ReadAllText((P $src "assets" "js" "app.js"), $utf8)
if ($appJs -notmatch "const APP_VERSION='([^']+)'") { throw "未能从 app.js 读取版本号" }
$ver = $Matches[1]
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$build = "$ver." + (Get-Date -Format "yyyyMMddHHmm")
$commit = ""
if (Get-Command git -ErrorAction SilentlyContinue) {
    $commit = (& git -C $root rev-parse --short HEAD 2>$null)
    $dirty = (& git -C $root status --porcelain 2>$null)
    if ($commit) { $build += "-$commit" }
    if ($dirty) { $build += "-dirty"; Warn "有未提交的修改，本次发布版本号带 -dirty 标记。建议先提交再发布。" }
}

# ---------------------------------------------------------------- 测试
if (-not $SkipTests) {
    Step "运行测试"
    if (Get-Command node -ErrorAction SilentlyContinue) {
        & node (P $root "tests" "sim-core.test.js") | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "测试未通过，已停止发布。确认要跳过请加 -SkipTests" }
        Ok "测试通过"
    } else { Warn "本机未安装 Node.js，跳过仿真内核测试" }
}

# ---------------------------------------------------------------- 生成发布目录
Step "生成发布目录（版本 $build）"
$stage = P ([IO.Path]::GetTempPath()) "LogiSim-publish-$stamp"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item (P $src "*") $stage -Recurse -Force
$stageData = P $stage "App_Data" "scenarios"
if (Test-Path $stageData) { Remove-Item $stageData -Recurse -Force }
$indexPath = P $stage "index.html"
$index = [IO.File]::ReadAllText($indexPath, $utf8)
$stamped = $index.Replace("?v=$ver", "?v=$build")
if ($stamped -eq $index) { throw "index.html 中没有找到 ?v=$ver，版本号不一致" }
[IO.File]::WriteAllText($indexPath, $stamped, $utf8)
$who = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { "$env:USERNAME" }
$versionJson = '{"version":"' + $ver + '","build":"' + $build + '","commit":"' + $commit + '","publishedAt":"' + (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz") + '","publishedBy":"' + $who.Replace("\", "\\") + '","machine":"' + $env:COMPUTERNAME + '"}'
[IO.File]::WriteAllText((P $stage "version.json"), $versionJson, $utf8)
Ok $stage

if ($DryRun) {
    Step "预览将要变更的文件（不会实际发布）"
    Invoke-Robocopy (@($stage, $target, "/MIR", "/L", "/NJH", "/NP", "/XF", "web.config", "/XD") + $excludeDirs)
    Remove-Item $stage -Recurse -Force
    return
}

# ---------------------------------------------------------------- 备份
Step "备份服务器当前版本"
$bk = P $backupRoot $stamp
New-Item -ItemType Directory -Force -Path $bk | Out-Null
Invoke-Robocopy (@($target, $bk, "/E", "/R:2", "/W:2", "/NJH", "/NJS", "/NP", "/NFL", "/NDL", "/XD") + $excludeDirs)
Ok "已备份到 $bk"
Get-ChildItem $backupRoot -Directory | Sort-Object Name -Descending | Select-Object -Skip $keep | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }

# ---------------------------------------------------------------- 发布
Step "同步文件到服务器"
Invoke-Robocopy (@($stage, $target, "/MIR", "/R:2", "/W:2", "/NJH", "/NJS", "/NP", "/NDL", "/XF", "web.config", "index.html", "/XD") + $excludeDirs)
Copy-Item $indexPath (P $target "index.html") -Force
Ok "文件已同步（服务器 web.config 与方案数据保持不变）"

$srcCfg = [IO.File]::ReadAllText((P $src "web.config"), $utf8)
$srvCfgPath = P $target "web.config"
if (Test-Path $srvCfgPath) {
    $srvCfg = [IO.File]::ReadAllText($srvCfgPath, $utf8)
    $norm = { param($t) ($t -replace '<add key="LogiSim\.[^"]+" value="[^"]*" />', '') -replace '<add name="LogiSim" connectionString="[^"]*"', '' -replace '\s+', '' }
    if ((& $norm $srcCfg) -ne (& $norm $srvCfg)) {
        [IO.File]::WriteAllText((P $target "web.config.new"), $srcCfg, $utf8)
        Warn "新版 web.config 有结构变化，已放到服务器 web.config.new，请对照后手动合并（存储设置以服务器为准）。"
    }
}
Remove-Item $stage -Recurse -Force

# ---------------------------------------------------------------- 自检
Step "自检 $siteUrl"
$r = Test-Site $siteUrl $build
Ok "线上版本 $($r.info.build)，存储 $($r.health.storage)"

Write-Host ""
Write-Host "发布完成。用户刷新页面即可使用新版本。" -ForegroundColor Green
Write-Host "如需回滚：publish.cmd -Rollback"
