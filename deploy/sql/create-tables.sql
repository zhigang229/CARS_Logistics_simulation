/*
  场内物流 3D 仿真台 · SQL Server 建库建表脚本（可选）

  仅在 web.config 中 LogiSim.Storage = SqlServer 时需要。
  若应用程序池账号有建表权限，首次访问时会自动建表，可以只执行第 3 步授权。
  适用于 SQL Server 2012 及以上版本。
*/

-- 1. 建库（已有数据库可跳过，并把下方 USE 改成实际库名）
IF DB_ID(N'LogiSim') IS NULL
    CREATE DATABASE LogiSim;
GO

USE LogiSim;
GO

-- 2. 建表：每行一个方案，Data 为方案 JSON，Result 为最近一次仿真结果摘要
IF OBJECT_ID(N'dbo.LogiSimScenario', N'U') IS NULL
CREATE TABLE dbo.LogiSimScenario (
    Id        NVARCHAR(64)  NOT NULL CONSTRAINT PK_LogiSimScenario PRIMARY KEY,
    Name      NVARCHAR(200) NOT NULL,
    Data      NVARCHAR(MAX) NOT NULL,
    Result    NVARCHAR(MAX) NULL,
    Rev       INT           NOT NULL,   -- 版本号，用于多人同时编辑时的冲突检测
    UpdatedAt DATETIME2(0)  NOT NULL,   -- UTC 时间
    UpdatedBy NVARCHAR(128) NULL
);
GO

-- 3. 为 IIS 应用程序池授权
--    SQL Server 与 IIS 在同一台服务器：使用 [IIS APPPOOL\LogiSim]
--    SQL Server 在另一台服务器：改为 IIS 服务器的计算机账号 [域名\服务器名$]，或应用程序池使用的域服务账号
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'IIS APPPOOL\LogiSim')
    CREATE LOGIN [IIS APPPOOL\LogiSim] FROM WINDOWS;
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'IIS APPPOOL\LogiSim')
    CREATE USER [IIS APPPOOL\LogiSim] FOR LOGIN [IIS APPPOOL\LogiSim];
GO
ALTER ROLE db_datareader ADD MEMBER [IIS APPPOOL\LogiSim];
ALTER ROLE db_datawriter ADD MEMBER [IIS APPPOOL\LogiSim];
GO
