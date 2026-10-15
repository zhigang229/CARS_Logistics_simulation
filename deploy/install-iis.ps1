#Requires -RunAsAdministrator
<#
.SYNOPSIS
    将「场内物流 3D 仿真台」部署或升级到本机 IIS。

.DESCRIPTION
    1. （可选）安装 IIS 与 ASP.NET 4.x 功能
    2. 复制站点文件；升级时保留已有 web.config 和方案数据
    3. 创建或更新应用程序池（.NET CLR v4.0，集成模式）
    4. 创建独立站点，或在已有站点下创建子应用
    5. 为应用程序池账号授予数据目录的修改权限
    6. 调用 api/scenarios.ashx?action=health 自检

.EXAMPLE
    .\install-iis.ps1
    新建站点 LogiSim，端口 8080，访问 http://服务器名:8080/

.EXAMPLE
    .\install-iis.ps1 -AsApplication -ParentSite "Default Web Site" -AppPath logisim
    作为子应用发布，访问 http://服务器名/logisim/

.EXAMPLE
    .\install-iis.ps1 -DataPath "\\fileserver\LogiSim\scenarios"
    方案数据存到厂内文件服务器共享目录

.EXAMPLE
    .\install-iis.ps1 -InstallFeatures -OpenFirewall
    先安装 IIS / ASP.NET 功能，并在防火墙放行端口
#>
param(
    [string]$SiteName = "LogiSim",
    [int]$Port = 8080,
    [string]$PhysicalPath = "C:\inetpub\LogiSim",
    [string]$AppPoolName = "LogiSim",
    [switch]$AsApplication,
    [string]$ParentSite = "Default Web Site",
    [string]$AppPath = "logisim",
    [string]$DataPath = "",
    [switch]$OverwriteConfig,
    [switch]$InstallFeatures,
    [switch]$OpenFirewall
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path (Split-Path -Parent $here) "wwwroot"

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

if (-not (Test-Path (Join-Path $source "index.html"))) {
    throw "找不到站点文件：$source。请在解压后的发布包 deploy 目录中运行本脚本。"
}

# ---------------------------------------------------------------- 1. IIS 功能
if ($InstallFeatures) {
    Step "安装 IIS 与 ASP.NET 4.x 功能"
    if (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue) {
        Install-WindowsFeature Web-Server, Web-Default-Doc, Web-Static-Content, Web-Http-Errors, Web-Stat-Compression, `
            Web-Asp-Net45, Web-Net-Ext45, Web-ISAPI-Ext, Web-ISAPI-Filter, Web-Mgmt-Console | Out-Null
    } else {
        $features = "IIS-WebServerRole", "IIS-WebServer", "IIS-DefaultDocument", "IIS-StaticContent", "IIS-HttpErrors", `
            "IIS-HttpCompressionStatic", "IIS-NetFxExtensibility45", "IIS-ISAPIExtensions", "IIS-ISAPIFilter", "IIS-ASPNET45", "IIS-ManagementConsole"
        Enable-WindowsOptionalFeature -Online -FeatureName $features -All -NoRestart | Out-Null
    }
    Ok "功能已安装"
}

Import-Module WebAdministration

# ---------------------------------------------------------------- 2. 复制文件
Step "复制站点文件到 $PhysicalPath"
$isUpgrade = Test-Path (Join-Path $PhysicalPath "web.config")
New-Item -ItemType Directory -Force -Path $PhysicalPath | Out-Null
$robocopyArgs = @($source, $PhysicalPath, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XD", (Join-Path $source "App_Data\scenarios"))
if ($isUpgrade -and -not $OverwriteConfig) {
    $robocopyArgs += @("/XF", "web.config")
    Warn "检测到已有部署：保留现有 web.config（存储方式、连接字符串不变）。如需覆盖请加 -OverwriteConfig"
}
& robocopy @robocopyArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制文件失败，robocopy 返回 $LASTEXITCODE" }
Ok "文件已复制（升级时不会删除已有方案数据）"

# ---------------------------------------------------------------- 3. 数据目录配置
$webConfig = Join-Path $PhysicalPath "web.config"
if ($DataPath -ne "") {
    Step "设置方案数据目录：$DataPath"
    [xml]$cfg = Get-Content -Path $webConfig -Encoding UTF8
    $node = $cfg.configuration.appSettings.add | Where-Object { $_.key -eq "LogiSim.DataPath" }
    $node.value = $DataPath
    $cfg.Save($webConfig)
    Ok "web.config 已更新"
}
[xml]$cfgNow = Get-Content -Path $webConfig -Encoding UTF8
$storage = ($cfgNow.configuration.appSettings.add | Where-Object { $_.key -eq "LogiSim.Storage" }).value
$dataSetting = ($cfgNow.configuration.appSettings.add | Where-Object { $_.key -eq "LogiSim.DataPath" }).value
if ($dataSetting.StartsWith("~")) {
    $dataDir = Join-Path $PhysicalPath ($dataSetting.TrimStart("~").TrimStart("/").Replace("/", "\"))
} else {
    $dataDir = $dataSetting
}

# ---------------------------------------------------------------- 4. 应用程序池
Step "配置应用程序池 $AppPoolName"
$poolPath = "IIS:\AppPools\$AppPoolName"
if (-not (Test-Path $poolPath)) { New-WebAppPool -Name $AppPoolName | Out-Null; Ok "已创建" } else { Ok "已存在，更新设置" }
Set-ItemProperty $poolPath -Name managedRuntimeVersion -Value "v4.0"
Set-ItemProperty $poolPath -Name managedPipelineMode -Value "Integrated"
Set-ItemProperty $poolPath -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)
try { Set-ItemProperty $poolPath -Name startMode -Value "AlwaysRunning" } catch { Warn "当前 IIS 版本不支持 AlwaysRunning，已跳过（不影响使用）" }

# ---------------------------------------------------------------- 5. 站点 / 子应用
if ($AsApplication) {
    Step "在站点「$ParentSite」下创建子应用 /$AppPath"
    if (-not (Test-Path "IIS:\Sites\$ParentSite")) { throw "找不到站点「$ParentSite」" }
    $appIisPath = "IIS:\Sites\$ParentSite\$AppPath"
    if (Test-Path $appIisPath) {
        Set-ItemProperty $appIisPath -Name physicalPath -Value $PhysicalPath
        Set-ItemProperty $appIisPath -Name applicationPool -Value $AppPoolName
        Ok "已更新"
    } else {
        New-WebApplication -Site $ParentSite -Name $AppPath -PhysicalPath $PhysicalPath -ApplicationPool $AppPoolName | Out-Null
        Ok "已创建"
    }
    $binding = (Get-WebBinding -Name $ParentSite | Select-Object -First 1).bindingInformation.Split(":")
    $sitePort = $binding[1]
    $localUrl = "http://localhost:$sitePort/$AppPath/"
} else {
    Step "创建站点 $SiteName（端口 $Port）"
    $sitePathIis = "IIS:\Sites\$SiteName"
    if (Test-Path $sitePathIis) {
        Set-ItemProperty $sitePathIis -Name physicalPath -Value $PhysicalPath
        Set-ItemProperty $sitePathIis -Name applicationPool -Value $AppPoolName
        Ok "站点已存在，已更新路径与应用程序池（绑定保持不变）"
        $sitePort = (Get-WebBinding -Name $SiteName | Select-Object -First 1).bindingInformation.Split(":")[1]
    } else {
        $inUse = Get-WebBinding | Where-Object { $_.bindingInformation -like "*:$($Port):*" }
        if ($inUse) { throw "端口 $Port 已被其他站点占用，请用 -Port 指定其他端口，或用 -AsApplication 作为子应用发布" }
        New-Website -Name $SiteName -Port $Port -PhysicalPath $PhysicalPath -ApplicationPool $AppPoolName | Out-Null
        Ok "已创建"
        $sitePort = $Port
    }
    $localUrl = "http://localhost:$sitePort/"
    if ($OpenFirewall) {
        $ruleName = "LogiSim HTTP $sitePort"
        if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $sitePort -Action Allow | Out-Null
        }
        Ok "防火墙已放行 TCP $sitePort"
    }
}

# ---------------------------------------------------------------- 6. 权限
if ($storage -ne "SqlServer") {
    Step "授予应用程序池对数据目录的修改权限"
    if ($dataDir.StartsWith("\\")) {
        Warn "数据目录是网络共享：$dataDir"
        Warn "IIS AppPool 虚拟账号访问网络共享时使用服务器计算机账号（域\服务器名$）。"
        Warn "请在文件服务器上为该计算机账号授予共享与 NTFS 的「修改」权限，或把应用程序池标识改为域服务账号。"
    } else {
        New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
        & icacls $dataDir /grant "IIS AppPool\$($AppPoolName):(OI)(CI)M" | Out-Null
        Ok "$dataDir → IIS AppPool\$AppPoolName（修改）"
    }
} else {
    Step "存储方式为 SqlServer"
    Warn "请确认数据库已创建，并为 IIS AppPool\$AppPoolName 授权（见 deploy\sql\create-tables.sql）"
}

# ---------------------------------------------------------------- 7. 自检
Step "自检"
Start-Sleep -Seconds 2
try {
    $resp = Invoke-WebRequest -Uri ($localUrl + "api/scenarios.ashx?action=health") -UseBasicParsing -TimeoutSec 60
    Ok ("服务正常：" + $resp.Content)
} catch {
    Warn ("自检失败：" + $_.Exception.Message)
    Warn "常见原因：未安装 ASP.NET 4.x 功能（加 -InstallFeatures 重新运行）、数据目录无写权限、数据库连接失败。详见 DEPLOY.md「常见问题」。"
}

Write-Host ""
Write-Host "部署完成。" -ForegroundColor Green
Write-Host "  本机访问：$localUrl"
Write-Host ("  内网访问：" + $localUrl.Replace("localhost", $env:COMPUTERNAME))
Write-Host "  数据存储：$storage  $(if ($storage -ne 'SqlServer') { $dataDir })"
