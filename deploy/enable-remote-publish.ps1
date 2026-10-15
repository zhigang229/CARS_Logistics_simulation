#Requires -RunAsAdministrator
<#
.SYNOPSIS
    在 IIS 服务器上一次性开启「远程一键发布」：把站点目录共享给开发人员。

.DESCRIPTION
    创建隐藏共享（默认 LogiSim$，以 $ 结尾的共享在网上邻居中不显示），
    并为指定的开发人员域账号授予共享「更改」权限和 NTFS「修改」权限。
    之后开发人员在自己电脑上运行 publish.cmd 即可发布，无需登录服务器。

.EXAMPLE
    .\enable-remote-publish.ps1 -Publisher "CARRIER\zhangsan"

.EXAMPLE
    .\enable-remote-publish.ps1 -Publisher "CARRIER\zhangsan","CARRIER\lisi" -PhysicalPath "D:\WebSites\LogiSim"
#>
param(
    [Parameter(Mandatory = $true)][string[]]$Publisher,
    [string]$PhysicalPath = "C:\inetpub\LogiSim",
    [string]$ShareName = "LogiSim$"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path (Join-Path $PhysicalPath "api") "scenarios.ashx"))) {
    throw "$PhysicalPath 不是仿真台站点目录（缺少 api\scenarios.ashx）。请先运行 install-iis.ps1 完成首次部署。"
}

$share = Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue
if ($share) {
    if ($share.Path -ne $PhysicalPath) { throw "共享 $ShareName 已存在，但指向 $($share.Path)。请用 -ShareName 指定其他名称。" }
    foreach ($p in $Publisher) { Grant-SmbShareAccess -Name $ShareName -AccountName $p -AccessRight Change -Force | Out-Null }
    Write-Host "共享 $ShareName 已存在，已追加授权" -ForegroundColor Green
} else {
    New-SmbShare -Name $ShareName -Path $PhysicalPath -ChangeAccess $Publisher -Description "场内物流 3D 仿真台 发布目录" | Out-Null
    Write-Host "已创建共享 $ShareName → $PhysicalPath" -ForegroundColor Green
}

foreach ($p in $Publisher) {
    & icacls $PhysicalPath /grant "$($p):(OI)(CI)M" | Out-Null
    Write-Host "已授予 $p 对 $PhysicalPath 的修改权限" -ForegroundColor Green
}

$unc = "\\$env:COMPUTERNAME\$ShareName"
$binding = $null
try {
    Import-Module WebAdministration -ErrorAction Stop
    $site = Get-Website | Where-Object { $_.physicalPath -eq $PhysicalPath } | Select-Object -First 1
    if ($site) { $binding = ($site.bindings.Collection | Select-Object -First 1).bindingInformation.Split(":")[1] }
} catch { }
$url = if ($binding) { "http://$($env:COMPUTERNAME):$binding/" } else { "http://$($env:COMPUTERNAME):8080/" }

Write-Host ""
Write-Host "完成。请把下面内容保存为开发电脑上项目根目录的 publish.config.json：" -ForegroundColor Cyan
Write-Host ""
Write-Host "{"
Write-Host ('  "target": "' + $unc.Replace("\", "\\") + '",')
Write-Host ('  "siteUrl": "' + $url + '",')
Write-Host '  "keepBackups": 5'
Write-Host "}"
Write-Host ""
Write-Host "如果站点是作为子应用发布的（例如 http://服务器/logisim/），请把 siteUrl 改成实际地址。" -ForegroundColor Yellow
