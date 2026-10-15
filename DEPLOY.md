# 部署说明 · 场内物流 3D 仿真台（IIS 内网版）

本说明适用于发布包 `LogiSim-IIS-v1.1.0.zip`。站点所有脚本、样式、字体都随包发布，**服务器和客户端都不需要访问外网**。

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| 服务器 | Windows Server 2012 R2 / 2016 / 2019 / 2022，或 Windows 10/11 |
| IIS | 7.5 及以上，需启用「ASP.NET 4.5+」（用于 `api/scenarios.ashx`） |
| .NET Framework | 4.5 及以上（Windows Server 2016 起自带） |
| 数据存储 | 默认存为 JSON 文件，无需数据库；也可改用文件服务器共享目录或 SQL Server 2012+ |
| 客户端浏览器 | 新版 Chrome 或 Edge（需开启硬件加速以显示 3D），**不支持 IE** |

不需要安装 .NET Core Hosting Bundle，也不需要用 Visual Studio 编译。`.ashx` 由 IIS 在首次访问时自动编译。

## 2. 一键部署（推荐）

1. 把 `LogiSim-IIS-v1.1.0.zip` 复制到服务器并解压，例如解压到 `D:\Install\LogiSim-IIS-v1.1.0`。
2. 以**管理员身份**打开 PowerShell，进入 `deploy` 目录：

   ```powershell
   cd D:\Install\LogiSim-IIS-v1.1.0\deploy
   Set-ExecutionPolicy -Scope Process Bypass
   .\install-iis.ps1
   ```

3. 看到「服务正常」即完成，浏览器访问 `http://服务器名:8080/`。

常用参数：

| 场景 | 命令 |
| --- | --- |
| 新服务器，尚未装 IIS | `.\install-iis.ps1 -InstallFeatures -OpenFirewall` |
| 换端口 | `.\install-iis.ps1 -Port 8090` |
| 挂在已有站点下，访问 `http://服务器名/logisim/` | `.\install-iis.ps1 -AsApplication -ParentSite "Default Web Site" -AppPath logisim` |
| 方案存到厂内文件服务器 | `.\install-iis.ps1 -DataPath "\\fileserver\LogiSim\scenarios"` |
| 换安装目录 | `.\install-iis.ps1 -PhysicalPath "D:\WebSites\LogiSim"` |

脚本会完成：复制文件 → 创建应用程序池 `LogiSim`（.NET CLR v4.0，集成模式，不空闲回收）→ 创建站点或子应用 → 给数据目录授权 → 访问健康检查接口自检。

## 3. 手动部署

1. 「服务器管理器 → 添加角色和功能」勾选：Web 服务器(IIS)、静态内容、默认文档、静态内容压缩、**ASP.NET 4.x**（会自动带上 .NET 扩展性、ISAPI 扩展/筛选器）。
2. 把发布包里的 `wwwroot` 目录内容复制到 `C:\inetpub\LogiSim`。
3. IIS 管理器 → 应用程序池 → 添加 `LogiSim`，.NET CLR 版本 v4.0，托管管道模式「集成」。
4. 网站 → 添加网站：名称 `LogiSim`，物理路径 `C:\inetpub\LogiSim`，应用程序池 `LogiSim`，端口 8080。
5. 给数据目录授权（管理员命令行）：

   ```bat
   mkdir C:\inetpub\LogiSim\App_Data\scenarios
   icacls C:\inetpub\LogiSim\App_Data\scenarios /grant "IIS AppPool\LogiSim:(OI)(CI)M"
   ```

6. 浏览器打开 `http://localhost:8080/api/scenarios.ashx?action=health`，返回 `{"ok":true,...}` 即正常。

## 4. 存储方式

在站点根目录 `web.config` 的 `<appSettings>` 中修改，保存后 IIS 自动生效：

### 4.1 站点内文件（默认）

```xml
<add key="LogiSim.Storage" value="File" />
<add key="LogiSim.DataPath" value="~/App_Data/scenarios" />
```

每个方案保存为 `方案编号.json`、`方案编号.meta`、`方案编号.result.json` 三个文件。备份时复制整个目录即可。

### 4.2 厂内文件服务器

```xml
<add key="LogiSim.DataPath" value="\\fileserver\LogiSim\scenarios" />
```

IIS 默认的应用程序池虚拟账号访问网络共享时，使用 IIS 服务器的**计算机账号**（`域名\服务器名$`）。需要在文件服务器上为该计算机账号授予共享权限和 NTFS「修改」权限。也可以把应用程序池标识改为一个域服务账号，再给这个账号授权。

### 4.3 SQL Server

```xml
<add key="LogiSim.Storage" value="SqlServer" />
...
<connectionStrings>
  <add name="LogiSim" connectionString="Server=数据库服务器;Database=LogiSim;Integrated Security=True;TrustServerCertificate=True;" providerName="System.Data.SqlClient" />
</connectionStrings>
```

由 DBA 执行 `deploy\sql\create-tables.sql` 建库、建表并授权。如果应用程序池账号有建表权限，首次访问会自动建表。

从文件模式切换到 SQL Server 后，原有方案不会自动迁移。可以在页面的「导入 / 导出」中逐个下载 JSON 再导入。

## 5. 多人使用

- 方案保存在服务器上，所有人打开同一个地址看到同一批方案，修改后约 1 秒自动保存。
- 页面右上角显示存储位置：**绿色「服务器」**表示共享存储；**黄色「本机浏览器」**表示服务器接口不可用，方案只存在当前电脑的浏览器中。
- 两人同时修改同一方案时，后保存的一方不会覆盖对方。系统会把他的修改另存为「原名（我的修改 时间）」，并提示他。
- 切回浏览器窗口时，如果别人已经更新了当前方案，而你本人没有未保存的修改，页面会自动载入最新版本。
- 试用阶段保存在个人浏览器里的方案，可在「导入 / 导出」中一键上传到服务器。

### 记录修改人（可选）

默认匿名访问，修改人记为「访客 + IP」。要记录域账号：IIS 管理器 → 站点 → 身份验证 → 启用「Windows 身份验证」，禁用「匿名身份验证」。无需修改代码。

## 6. 开发电脑一键发布

首次部署完成后，以后的更新可以在开发电脑上双击 `publish.cmd` 直接发布，不用再登录服务器。

### 6.1 一次性设置（约 5 分钟）

1. **服务器**：以管理员身份运行，把站点目录共享给开发人员的域账号：

   ```powershell
   cd D:\Install\LogiSim-IIS-v1.1.0\deploy
   .\enable-remote-publish.ps1 -Publisher "域名\你的账号"
   ```

   脚本会创建隐藏共享 `LogiSim$`，并打印出一段配置内容。

2. **开发电脑**：在项目根目录新建 `publish.config.json`，填入上一步打印的内容（可参考 `publish.config.example.json`）：

   ```json
   {
     "target": "\\\\服务器名\\LogiSim$",
     "siteUrl": "http://服务器名:8080/",
     "keepBackups": 5
   }
   ```

   这个文件只在本机使用，已加入 `.gitignore`，不会提交到仓库。

3. 在开发电脑的资源管理器地址栏输入 `\\服务器名\LogiSim$`，能打开就说明权限已经生效。

### 6.2 日常发布

| 操作 | 命令 |
| --- | --- |
| 发布 | 双击 `publish.cmd` |
| 只预览会改哪些文件 | `publish.cmd -DryRun` |
| 回滚到上一版 | `publish.cmd -Rollback` |
| 回滚到指定版本 | `publish.cmd -Rollback -BackupName 20261015-173300`（名称见 `dist\backups`） |

每次发布自动完成：

1. 运行仿真内核测试（开发电脑装有 Node.js 时；未通过则停止发布）。
2. 生成发布版本号，如 `1.0.0.202610151733-ced6648`（版本 + 时间 + Git 提交号），写入静态资源地址和 `version.json`，用户刷新即可拿到新版，不受浏览器缓存影响。
3. 把服务器当前版本备份到开发电脑的 `dist\backups`（默认保留最近 5 份）。
4. 同步文件：**服务器的 `web.config` 和 `App_Data` 方案数据不会被覆盖或删除**；旧版多余文件会被清理；`index.html` 最后替换，发布过程中用户不会加载到新旧混合的页面。
5. 访问 `version.json` 和健康检查接口，确认线上已是新版本。

如果新版 `web.config` 有结构变化，脚本会把它放到服务器的 `web.config.new` 并提示你手动合并，存储设置始终以服务器为准。

可随时打开 `http://服务器名:8080/version.json` 查看线上版本、发布时间和发布人。

### 6.3 在 Visual Studio 中一键发布（可选）

「工具 → 外部工具 → 添加」：

- 标题：`发布到仿真台服务器`
- 命令：`项目目录\publish.cmd`
- 初始目录：`$(SolutionDir)`
- 勾选「使用输出窗口」

之后在「工具」菜单中点一下即可发布。用输出窗口时不会弹出「按任意键继续」。如需去掉末尾暂停，可设置环境变量 `LOGISIM_NO_PAUSE=1`。

## 7. 升级

已配置一键发布时，直接用 `publish.cmd`（见第 6 节）。也可以用新版发布包再次运行 `install-iis.ps1`：

- 站点文件被覆盖更新；
- **已有 `web.config` 保留不动**（存储方式、连接字符串不会丢），如需用新版 `web.config` 覆盖，加 `-OverwriteConfig`；
- `App_Data\scenarios` 中的方案数据不会删除。

入口页设置为不缓存，静态资源带版本号，升级后用户刷新页面即可用上新版本。

## 8. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 页面右上角显示「本机浏览器」 | 接口不可用。打开 `.../api/scenarios.ashx?action=health` 查看具体错误 |
| 访问 `scenarios.ashx` 返回 404.3 或直接显示代码 | 未安装 ASP.NET 4.x。运行 `install-iis.ps1 -InstallFeatures` 或在「添加角色和功能」中勾选 ASP.NET 4.x |
| HTTP 500.19，提示配置错误 | 通常是 IIS 缺少「静态内容压缩」等模块或配置被服务器级锁定。安装对应功能，或删除 `web.config` 中 `<urlCompression>` 一行 |
| HTTP 500.21 | 应用程序池不是 .NET v4.0，或 ASP.NET 未注册。把应用程序池改为 v4.0 / 集成模式 |
| 健康检查提示「没有写入权限」 | 为 `IIS AppPool\LogiSim` 授予数据目录「修改」权限（见第 3 节第 5 步） |
| 保存失败，提示请求过大 | 方案中的 CAD 底图超过 50 MB。压缩图片，或调大 `web.config` 中 `maxRequestLength`（KB）与 `maxAllowedContentLength`（字节） |
| 3D 区域提示「无法启动三维显示」 | 客户端浏览器未开启硬件加速，或显卡驱动过旧。Chrome/Edge 设置 → 系统 → 开启「使用图形加速」 |
| 页面一直停在「正在加载…」 | 浏览器过旧（如 IE），请使用新版 Chrome 或 Edge |
| `publish.cmd` 提示无法访问共享 | 确认服务器已运行 `enable-remote-publish.ps1`，本机能访问 `\\服务器名\LogiSim$`（445 端口）。需要用其他账号时先执行 `net use \\服务器名\LogiSim$ /user:域名\账号` |
| `publish.cmd` 提示「不像是仿真台站点目录」 | `publish.config.json` 的 target 填错了。脚本为防止误删文件主动停止，请改正路径 |

## 9. 卸载

IIS 管理器中删除站点（或子应用）和应用程序池 `LogiSim`，再删除站点目录。删除前先备份 `App_Data\scenarios`。
