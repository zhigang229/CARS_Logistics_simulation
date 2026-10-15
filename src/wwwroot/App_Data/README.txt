此目录用于存放方案数据（File 存储模式，scenarios 子目录）。
IIS 默认禁止通过网址访问 App_Data，数据不会被外部下载。
应用程序池账号需要对本目录有「修改」权限（install-iis.ps1 会自动授权）。
备份时复制 scenarios 整个目录即可。
