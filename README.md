# 场内物流 3D 仿真台（IIS 内网版）

在浏览器中搭建车间场地，规划 AGV 与小料车的物流路线，设置站点停留时间，并运行 3D 动态仿真。仿真输出车辆利用率、配送准时率和路段拥堵等指标，用于比较不同物流方案。

- **纯内网运行**：Three.js、Vue、字体全部随站点发布，不访问任何外网资源。
- **部署简单**：静态页面 + 一个 `.ashx` 接口，IIS 首次访问时自动编译，无需 Visual Studio 构建、无需 .NET Core。
- **多人共享**：方案保存在服务器上，可选 JSON 文件、厂内文件服务器或 SQL Server；多人同时编辑时自动检测冲突，不会互相覆盖。
- **离线兜底**：服务器接口不可用时，自动改用本机浏览器存储，页面照常可用。

部署步骤见 **[DEPLOY.md](DEPLOY.md)**。

## 功能

| 模块 | 内容 |
| --- | --- |
| 1 车间场地 | 货架、工位台、装配线、线边料架、充电桩、墙体、立柱、功能区域；拖拽移动、拉伸、旋转、调高；导入 CAD 导出的图片作为底图 |
| 2 路网规划 | 连续点击绘制路段，自动吸附节点与拆分路段；单向/双向、限速；路网与路线校验 |
| 3 站点与停留 | 取料、送料、空箱回收、充电、待命站点；停留时间支持固定值、均匀分布、正态分布 |
| 4 车辆与路线 | 潜伏顶升 AGV、牵引车 + 料车、叉车式 AGV、人工小料车；路线停靠顺序、车辆数、Milk Run 计划周期；理论循环时间估算 |
| 5 仿真分析 | 1–200 倍速与极速计算；路口互斥、跟车、转弯降速、自动回充；利用率、送料次数、准时率、等待占比、甘特图、拥堵热力图、事件日志、方案对比 |

## 目录结构

```
src/wwwroot/                 IIS 站点根目录（发布包里的 wwwroot）
  index.html                 入口页
  web.config                 IIS 配置：MIME、压缩、缓存、安全头、存储方式
  api/scenarios.ashx         方案存储接口（C# 5，IIS 运行时编译）
  assets/css/app.css
  assets/js/sim-core.js      仿真内核，不依赖界面，可在 Node.js 中测试
  assets/js/app.js           界面、三维渲染、存储适配
  assets/vendor/             three.js r128、Vue 3.4.21、字体（均附许可证）
  App_Data/                  默认方案数据目录（IIS 禁止外部访问）
publish.cmd                  开发电脑一键发布（调用 tools/publish.ps1）
publish.config.example.json  发布配置示例，复制为 publish.config.json 后填写
deploy/
  install-iis.ps1            首次部署 / 升级脚本（在服务器上运行）
  enable-remote-publish.ps1  开启一键发布：共享站点目录给开发人员（在服务器上运行一次）
  sql/create-tables.sql      SQL Server 建库建表与授权脚本（可选）
tests/sim-core.test.js       仿真内核回归测试
tools/
  publish.ps1                一键发布 / 预览 / 回滚
  build-release.sh / .ps1    生成发布包 dist/LogiSim-IIS-v<版本>.zip
  check-api.sh               用 Mono 编译并测试 scenarios.ashx（Linux）
  testhost/                  仅用于测试的接口宿主
DEPLOY.md                    部署说明
CHANGELOG.md                 版本记录
```

## 本地开发

**Visual Studio**：「文件 → 打开 → 网站」，选择 `src/wwwroot`，用 IIS Express 运行即可，接口与正式环境一致。

**只改前端**：直接双击 `src/wwwroot/index.html` 也能用。此时没有服务器接口，方案保存在本机浏览器中，页面右上角显示「本机浏览器」。

## 测试

```bash
node tests/sim-core.test.js     # 仿真内核：指标、无死锁、无重叠、可复现
tools/check-api.sh              # 接口：C# 5 编译 + 15 项接口测试（需要 mono-devel）
```

## 发布

### 一键发布到服务器（日常更新）

服务器上运行一次 `deploy/enable-remote-publish.ps1`，开发电脑上配置 `publish.config.json`，之后双击 `publish.cmd` 即可：测试 → 备份线上版本 → 同步文件（保留服务器配置与数据）→ 自检。`publish.cmd -Rollback` 回滚。详见 [DEPLOY.md 第 6 节](DEPLOY.md)。

### 生成离线发布包（首次部署或交给他人部署）

1. 修改版本号：`assets/js/app.js` 的 `APP_VERSION`、`api/scenarios.ashx` 的 `ApiVersion`、`index.html` 中的 `?v=`（三处需一致，打包脚本会检查）。
2. 打包：Linux 运行 `tools/build-release.sh`，Windows 运行 `tools\build-release.ps1`。
3. 把 `dist/LogiSim-IIS-v<版本>.zip` 复制到服务器，按 [DEPLOY.md](DEPLOY.md) 部署或升级。

## 接口

全部返回 JSON；写操作只接受 POST，且必须带请求头 `X-LogiSim-Client`。

| 请求 | 说明 |
| --- | --- |
| `GET  api/scenarios.ashx?action=health` | 服务状态、存储方式、当前用户 |
| `GET  api/scenarios.ashx?action=list` | 方案列表，含最近一次仿真结果摘要 |
| `GET  api/scenarios.ashx?action=get&id=` | 读取方案 |
| `POST api/scenarios.ashx?action=save&id=&rev=&name=` | 保存方案；`rev=-1` 表示新建；版本不一致返回 409 |
| `POST api/scenarios.ashx?action=result&id=` | 保存仿真结果摘要 |
| `POST api/scenarios.ashx?action=delete&id=&rev=` | 删除方案 |

## 第三方组件

- [three.js](https://threejs.org/) r128 — MIT
- [Vue](https://vuejs.org/) 3.4.21 — MIT
- Barlow Condensed、JetBrains Mono 字体 — SIL Open Font License 1.1
