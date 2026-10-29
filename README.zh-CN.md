[English](README.md) | **简体中文（完整译文）**

<h1 align="center">MGU 自定义应用</h1>

<p align="center"><b>为 BMW MGU 主机（iDrive 7）打造的自定义应用，使用独立 GPU 渲染引擎，以真正的 60 fps 绘制。</b><br>同时提供一套完整的应用开发工具。</p>

<p align="center"><b>Translation by：抖音 小白科技杂物社 · BiliBili 小白151 · GitHub <a href="https://github.com/JackieZ123430">JackieZ123430</a></b></p>

> 本文完整翻译自同一提交中的 [英文 README](README.md)，保留原文的章节、示例、参数和媒体。原作者及第三方版权归各自权利人所有；中文翻译署名不替代原项目版权。另见 [翻译署名与来源](NOTICE.zh-CN.md)。

<p align="center">
  <img alt="60 fps" src="https://img.shields.io/badge/frame%20rate-60%20fps-2ea44f?style=for-the-badge">
  <img alt="OpenGL ES 2" src="https://img.shields.io/badge/render-OpenGL%20ES%202-1c6dd0?style=for-the-badge">
  <img alt="GPU time" src="https://img.shields.io/badge/GPU%20time-~1%20ms%20%2F%20frame-8957e5?style=for-the-badge">
  <img alt="iDrive 7" src="https://img.shields.io/badge/BMW-iDrive%207%20MGU-e4002b?style=for-the-badge">
</p>

<p align="center"><img src="docs/media/redline.gif" alt="换挡转速：全屏转速条、换挡灯与挡位，60 fps 动画" width="100%"></p>

为插电混动车提供实际纯电续航、电池健康和充电记录，以及实时电池功率、电芯温度和空调功耗。运动仪表提供增压、燃油压力、点火正时、失火和轮胎数据。还包括换挡灯与全屏转速表、虚拟马力机、制动和加速计时器、G 值仪表、机油暖机指南、故障码扫描与清除、车辆保养项目，以及停车时玩的 Doom。应用运行于车辆原有应用平台，使用 HMI 原生按钮和设置菜单，读取实时车辆数据，重启后仍可使用；一条命令即可移除全部改动。

> **免责声明。** 这是一个非官方爱好项目，与 BMW AG 无关联，未获其认可或支持。修改主机的风险由使用者自行承担。请在停车或封闭赛道环境使用应用，驾驶时注意道路。故障检测能够清除全车控制单元的故障存储器，请先读取故障码。

---

<a id="not-a-png-slideshow-a-custom-render-engine"></a>
## 自定义渲染引擎：真正连续的画面

BMW 应用平台提供的自定义图形显示方式，是用 JavaScript 画图、压缩成 **PNG**，交给 HMI 解码并显示在图像框中。SDK 只有这条自绘通道，帧率通常只有每秒几帧：在主机的 Atom CPU 上，仅压缩一张 1600 × 520 PNG 就要约 60 ms，还不包含绘制和传送。

这些应用随附 **`mgu-renderd`**，一个使用 C 和 OpenGL ES 2 的渲染引擎。自 2.0 起，它使用 Robert Nisipeanu 和 IterioDev 开发的 [mgu-render](kit/renderd/README.md#the-engine-mgu-render)，该引擎从本项目最初的引擎发展而来。应用每帧发送几 KB 的**绘图指令**，由主机 Intel GPU 在独立合成层上绘制，并与显示刷新同步，实现**真正的 60 fps**，指针和条形动画连续平滑。

<p align="center"><img src="docs/media/compare.gif" alt="相同的换挡转速画面：10 fps PNG 与全帧率 GPU 对比" width="80%"><br><sub>上：将相同帧停留到 10 fps，模拟 PNG 通道的常见速率。下：引擎绘制的每一帧。</sub></p>

| | 原有 PNG 方式 | `mgu-renderd` |
|---|---|---|
| **应用发送内容** | 每帧一张压缩位图 | 每帧几 KB 绘图指令 |
| **绘制方** | CPU 上的 JavaScript，逐像素绘制 | Intel HD Graphics 505 GPU |
| **帧率** | 每秒几帧，仅 PNG 编码就约 60 ms | **60 fps**，由显示器节拍控制 |
| **运动效果** | 数值在帧之间跳变 | 每帧用弹簧平滑算法更新仪表 |
| **屏幕空间** | HMI 图像框、标题栏和 120 px 按钮栏 | 全屏，页头位于 HMI 标题条，按钮栏仅 48 px |

**实车测量**（主机应用日志，10 秒平均值）：

| 应用 | 帧率 | 每帧 GPU 时间 | 每帧应用 JavaScript 时间 |
|---|---|---|---|
| M Vitals | 60–61 fps | 1.0–1.3 ms，峰值 11 ms | 2–5 ms |
| eDrive | 60–61 fps | 1.0–1.2 ms | |
| G-Force | 56–61 fps | 1.3 ms | |

60 fps 下每帧有 16.7 ms，GPU 约用其中 1 ms，因此余量充足。卡片、表盘、刻度等静态部分只绘制一次并缓存在 GPU 上。未安装引擎时，同一套代码会自动回退到 PNG 通道，外观保持一致。

```
 app (Node.js)  ──  drawing commands  ──▶  mgu-renderd (C, OpenGL ES 2)  ──▶  own layer above the HMI
     │              Unix socket, per frame        Intel GPU, synced to vsync          (input still goes to the HMI)
     └── buttons, settings, tiles: BMW's own HMI widgets, so the iDrive controller and touch work as usual
```

图中每帧绘图指令经 Unix socket 发送到 GPU 引擎，独立图层位于 HMI 上方；输入仍交给 HMI。按钮、设置和磁贴采用 BMW 原生 HMI 控件，iDrive 控制器和触摸照常工作。

详见 [应用如何绘图](#44-how-apps-draw-remote-hmi-rhmi) 和 [`kit/renderd`](kit/renderd/README.md)。

---

<a id="gallery"></a>
## 画廊

<table>
<tr>
<td width="50%"><img src="docs/media/m_vitals.gif" alt="M 车辆仪表发动机页"><br><b>M Vitals</b>: 转速、增压、车速与挡位、功率、扭矩</td>
<td width="50%"><img src="docs/media/gforce.gif" alt="G-Force"><br><b>G-Force</b>: 摩擦圆与轨迹、附着力边界、峰值和记录</td>
</tr>
<tr>
<td><img src="docs/media/draggy.gif" alt="Drag Timer"><br><b>Drag Timer</b>: 实时车速曲线、分段、¼ 英里</td>
<td><img src="docs/media/brake_test.gif" alt="Brake Test"><br><b>Brake Test</b>: 100–0 距离、减速度曲线、制动衰退</td>
</tr>
<tr>
<td><img src="docs/media/m_vitals_chassis.gif" alt="M 车辆仪表底盘页"><br><b>M Vitals</b>: G 值、胎压与胎温、xDrive 分配</td>
<td><img src="docs/media/warmup.gif" alt="Warm-Up"><br><b>Warm-Up</b>: 达到工作温度的时间、安全转速上限</td>
</tr>
<tr>
<td><img src="docs/screens/m_vitals_fuel.png" alt="M 车辆仪表燃油与点火页"><br><b>M Vitals</b>: 进气、高低压燃油压力、点火正时、各缸失火</td>
<td><img src="docs/screens/edrive.png" alt="eDrive"><br><b>eDrive</b>: 实际纯电续航、电池健康、上次充电、12 V</td>
</tr>
<tr>
<td><img src="docs/screens/edrive_log.png" alt="eDrive 充电日志"><br><b>eDrive</b>: 充电日志、费用与总计</td>
<td><img src="docs/screens/dyno.png" alt="Virtual Dyno"><br><b>Virtual Dyno</b>: 一次加速的功率与扭矩曲线</td>
</tr>
<tr>
<td><img src="docs/screens/dtc_scanner.png" alt="Fault Scanner"><br><b>Fault Scanner</b>: 全控制单元故障码与说明</td>
<td><img src="docs/screens/redline.png" alt="Redline"><br><b>Redline</b>: G20 风格转速条、大号挡位、换挡评分</td>
</tr>
<tr>
<td><img src="docs/screens/service.png" alt="Service"><br><b>Service</b>: 保养需求、下次保养、项目详情</td>
<td><img src="docs/screens/doom.png" alt="Doom"><br><b>Doom</b>: 全分辨率全屏 Freedoom，iDrive 控制器操作，自动存档</td>
</tr>
<tr>
<td><img src="docs/screens/edrive2.png" alt="eDrive 电池页"><br><b>eDrive</b>: 高压电池实时功率、回收与驱动相对电池限制、本次行程总计</td>
<td><img src="docs/screens/edrive2_battery.png" alt="eDrive 电池页"><br><b>eDrive</b>: 电芯温度与电压、冷却液、电池允许功率</td>
</tr>
</table>

<sub>所有动画均使用应用内置的离线演示行程，经引擎自身绘图代码录制（`mgu-renderd --replay`，见 [6.3](#63-preview-build-deploy)），保留 HMI 返回箭头和状态图标，采用默认 M 三色主题。GIF 最高仅播放 50 fps，实车显示为 60 fps。每个应用另有 M 红、冰白和夜间琥珀主题；实车中的相同页面显示实时车辆数据。</sub>

## 目录

- [自定义渲染引擎](#not-a-png-slideshow-a-custom-render-engine) · [画廊](#gallery)
1. [应用](#1-the-apps)
2. [所需条件](#2-what-you-need)
3. [快速开始](#3-quick-start)
4. [主机工作原理](#4-how-the-head-unit-works)
5. [应用如何安装到主机](#5-how-the-apps-get-onto-the-unit)
6. [编写自己的应用](#6-writing-your-own-app)
7. [车辆信号参考](#7-vehicle-signals-reference)
8. [故障排查与注意事项](#8-troubleshooting-and-gotchas)
9. [已知限制](#9-known-limits)
10. [仓库结构](#10-repository-layout)

---

<a id="1-the-apps"></a>
## 1. 应用

每个应用都有采用 HMI 原生样式的设置页：四种配色（默认 M 三色、M 红、冰白、夜间琥珀）、单位、车速读数更新频率（像 BMW 仪表一样每秒 5 次，最高 60 次）和演示模式。成绩与记录保存于主机，重启后保留。

| 应用 | 功能 |
|---|---|
| **Redline（换挡转速）** | G20 Live Cockpit 风格转速显示：宽幅转速条在中央以倾斜分段从左向右填充，颜色从主题色过渡到换挡点的红色；上方为数字转速，下方为大号挡位，另有数字车速及 12 灯换挡指示。到达换挡点时，换挡灯、挡位和 SHIFT 提示变为纯红色；默认关闭的“闪烁与闪屏”可使其频闪并令全屏闪红。挡位来自变速箱或由转速/车速学习得到。每次升挡评分为过早、正好、过晚或触及限转，并记录换挡日志及准确度。始终提示冷机油；默认开启的冷机保护会在机油升温前降低换挡点。 |
| **Virtual Dyno（虚拟马力机）** | 在一个挡位内全油门加速，根据加速度、车重、空气阻力和滚阻计算功率与扭矩曲线。可设置车重、车身形状、传动损耗及 hp/PS/kW、Nm/lb-ft。保存测量记录，可固定一次为基准，使每次新测量显示正负差值；可选叠加发动机电脑自身的扭矩读数。 |
| **Brake Test（制动测试）** | 记录 100–0、200–0 km/h 或 60–0、100–0 mph 的距离、时间、峰值减速度和减速曲线。起始速度交点在采样间插值，结果不依赖采样率。制动衰退图比较最近几次停车，距离增长时提示。保存最佳成绩及完整历史。 |
| **Drag Timer（弹射模式）** | 记录 0–50、0–100、100–200、0–200 km/h 和 ¼ 英里（或对应英制项目），提供插值分段、可选一英尺起步预留（rollout）、实时速度曲线及最佳时间。 |
| **G-Force（G 值仪表）** | 摩擦圆带渐隐轨迹，随各方向实际使用的附着力扩展边界；显示横纵向实时条、各方向本次峰值、超过 0.5 g 的持续时间和历史记录。G 值数字按设置频率更新，默认每秒 10 次；圆点与轨迹以完整帧率移动。 |
| **Warm-Up（暖机助手）** | 机油和冷却液仪表，以及暖机计算器：根据实测升温速率计算达到工作温度所需分钟数和预计时刻，并投射在温度趋势图上；样本不足时使用典型速率，混动车纯电行驶时显示发动机关闭。提供随油温升高的安全转速上限，以及激烈驾驶后的涡轮冷却倒计时：高转或高功率后需温和驾驶 30 秒至 3 分钟，取决于此前激烈驾驶时长。 |
| **M Vitals（M 车辆仪表）** | 多页运动仪表及峰值：转速、增压、带 D/S/M 与数字挡位的车速、iDrive 运动显示提供的功率（百分比乘以车辆最大功率，适用于原厂及调校发动机；kW/hp/PS）、扭矩（Nm/lb-ft）、冷却液、机油温度及 G 值等。燃油与点火页显示进气温度 IAT、高压燃油 HPFP/油轨及低压燃油 LPFP 压力、点火正时、目标/实际增压和请求/实际空气充量（均附 5 分钟曲线；BMW DME DID 4AB0 / 580B / 480C / 5813，OBD PID 0x70 作为后备），以及本次驾驶循环各缸失火计数（OBD 服务 06）；通过 UDS/OBD 从 DME 读取，标准 OBD 标识可在 `app.json` 的 config.dme 调整，同时显示进气比车外高多少度。温度页另从变速箱单元 EGS 读取油温（config.dme.egs）。各项均可自动/显示/隐藏，未应答项让出空间。底盘页大字显示胎压（对照目标）和胎温，xDrive 卡片可设自动（车辆报告四驱后显示）、显示或隐藏，适用于后驱车；无原车扭矩分配信号时，读取分动箱 LMV 的前轴扭矩（UDS `22 DB32`，config.xdrive），结合发动机扭矩和挡位估算，卡片注明来源。增压、变速箱油温、轮胎卡片和胎温同样支持自动/显示/隐藏；自动模式收到真实数据后显示。255 °C 胎温等不合理值及始终为 0 °C 的变速箱油温等不变值视为无数据；原始值写入日志（`raw tyre temperature`、`raw gearbox oil`、`raw FES boost`），用于校准 config.scaling。增压优先来自运动显示，无可用值时从 DME 的 OBD 读取增压/歧管绝对压力减环境气压（config.dme.boost 中的候选项），也可用 Boost from 手动指定。接近红线或增压上限时，仪表由蓝转红。 |
| **Fault Scanner（故障检测）** | 经主机诊断网关通过 UDS 扫描全车控制单元，按模块显示故障码与状态，实时显示 Check Control 消息，支持两次按键确认清除。故障文本来自本车编码工具导出（`kit/tools/dtc_texts.py`）、少量手写文本，以及可选导入的全控制单元故障数据库（`--db`）；对有故障的单元读取 SGBD 索引（UDS 22 F1 50）以选择名称和文本。仅导入英文文本，混有德文的条目被跳过，相应故障无说明。CSV 故障码列表（`--codes`）为适用单元补齐仍缺失的说明；执行 `--db` 后用 `kit/tools/dtc_tables.py` 生成 `dtc_scanner_*.json`，按单元类型与地址补充文本。构建用 `pack_data.py` 将约 19 MB 文本压入约 3.7 MB 的 `dtc_db.pack`，应用只解压当前故障所需的几 KB。仓库已获许可随附故障文本表和 SGBD 索引的压缩包 `apps/dtc_scanner/dtc_db.pack`；自行导入的 `dtc_db/` 会替代它。导入数据库和车辆导出文件不进入 git。 |
| **eDrive（EDrive助手）** | 面向插电混动/电动车，按实际驾驶学习纯电续航：以发动机启动阈值以上的可用电量，结合每公里行驶能耗（最近约 60 km 纯电行驶）与空调、车载电器每小时功耗计算。冷天制热、热天制冷的功耗按外温区间，在发动机关闭且静止/缓行时学习；行驶能耗按低于 35、35–60、60–85、85–110、高于 110 km/h 分档，按当前速度估计续航，因此高速续航比市区少。行驶时也根据同速下相对空调关闭状态的额外能耗学习空调功耗；座椅和方向盘加热按挡位计入。能量页显示各速度档能耗、当前驱动/空调/座椅/方向盘/车载用电及各自消耗的公里数、车辆自身功率分配和高压电池温度（续航页也显示）。空调按小时耗电，拥堵时对里程影响更大，页面显示 kW 和损失里程。空调开关读取 ClimateMaster `statusClimateSystemOn`：关闭时仅扣除独立学习的车载用电（通常 0.3 kW），续航升高；开启时下降，显示 CLIMATE ON/OFF，A/C 按键开启时另有 A/C 标记。尚未学习时按外温估算：满电在 20 °C 约 50 km、10 °C 为 40–45、0 °C 为 30–38、−10 °C 为 20–30，按本车 20 °C 续航缩放，并显示高低范围、SOH（满充容量相对新电池的百分比与 kWh）及当前电量 kWh。新电池容量可设置，例如 330e/530e 为 12 kWh、X5 45e 为 24 kWh。还显示上次高压充电增加的百分比/kWh/里程（主机休眠期间充电会在下次启动显示）和 12 V 电压。充电日志记录日期、充入电量、增加里程和按电价计算的费用（默认 0.25 €/kWh），提供月度/累计总计和 14 天图表。无混动系统时检测到电池单元不应答，只显示 12 V，或将 Hybrid system 设为 No。电量和 SOH 通过 UDS 读取，诊断页展示原始应答，便于按车型修改 `app.json` 的 DID。 |
| **eDrive 实时页面** | `apps/edrive/live.js` 默认适配 24 kWh 的 X5 xDrive45e，可调整用于其他插混车型。**电池：**每秒读取电压和电流，相乘得到实时 kW，正值为驱动、负值为回收或充电；条形范围为电池当前允许的最大回收至最大驱动功率，附两分钟曲线、电芯与冷却液温度；逐个电芯电压条标出最高、最低及压差。本次行程统计耗电、回收、净耗电、驱动与空调份额及峰值；菜单 Reset drive totals 开始新行程。**能量页空调：**发动机关闭、未插电且静止时，电池只供应车内负载，因此总功耗减去空调关闭时学习的基线，即实际制热/制冷功耗；该行优先显示这个测量值或空调单元自身数据，替代估计值。经 SME 的 UDS 读取 `DD68` 电压、`DD69` 电流、`DDBF` 电芯电压、`DDC0` 电芯温度、`DD6C` 冷却液、`DD7D` 电流限值（采用 OVMS 在 i3 上解析的 BMW 标识）；诊断页显示应答，若电流方向相反可用 `powerSign` 翻转。**主页小组件**（`startWidget`）的大组件显示实时功率、状态、电压/电流、电量、功率条、电芯和本次行程，小组件以文本行显示相同信息；Battery unit 与 Scan 页面由 Diagnostics pages 设置控制。 |
| **Service（保养信息）** | 读取 BMW CBS 保养需求，与 iDrive“车辆状态 > 保养需求”一致：机油、制动器、制动液、车辆检查、年检等，每项使用车辆原有语言和单位显示距离、日期，以绿/黄/红区分，并给出下次保养摘要及详细提示。数据来自仪表 `KombiInterface_2`。只读：这些车辆没有提供供主机调用的保养复位，需要在仪表菜单或维修车间完成。 |
| **Doom** | Freedoom: Phase 1（四章免费游戏数据）以 WebAssembly 在主机运行。3D 视图使用全屏完整分辨率 1920 × 504，扩展 Doom 的视野以适应屏幕；状态栏、菜单及消息以 4:3 叠加，VM 上可达 35 fps。先进入 Play/Continue、New game 和设置主菜单，游戏中无页头或按钮栏，BACK 返回菜单。**旋转控制器瞄准，推杆行走和横移，按下开火与开门，双击切换下一武器。** 游戏中独占旋钮、按压与倾斜，向前推不再打开 HMI 下拉菜单，向左推不再离开游戏；BACK、MENU 和触摸始终有效。依赖安装器加载到 HMI 的控制器门控插件，见 [5.1](#51-what-deploy-carsh-install-does)。没有插件时仍读取控制器信号，但 HMI 也会响应。离开页面或被弹窗/来电遮挡时暂停并自动存档，下次从停止位置继续。主菜单可设置难度、章节、移动速度（默认慢走，可选步行/跑步）、瞄准速度与方向、渲染分辨率（全/中/低）。采用 GPL-2.0，见[许可证](#doom-and-renderer-licences)。默认仅停车运行，行驶时保存并等待；Parked only 可关闭。 |

VM 或无车辆数据的台架上，所有应用在 5 秒后进入内置演示行程，含起步、逐挡加速、急停、转弯和冷机升温。数据非来自车辆时显示 **DEMO** 标记。

> **本次中文故障库补充：**简体故障检测包为随包数据库的 86,735 条唯一文本提供对应，其中 86,716 条含中文，19 条纯内部标识保留。使用机器辅助翻译，尚未逐句人工审校；没有说明的故障码不编造含义。导入的新数据库仍可能含未翻译说明。详见 [覆盖范围与验证方法](docs/diagnostic-chinese.md)。

---

<a id="2-what-you-need"></a>
## 2. 所需条件

**车辆端**

- **搭载 MGU（iDrive 7 / ID7）的 BMW。** 开发与测试固件为 `P18_23w44.2`，其他 MGU 版本很可能可用；安装器的 `check` 会在修改前报告检查结果。
- **主机 root shell 访问权限**，通过 SSH 或串口控制台。本项目不提供此权限，也无法公开获取方法；可自行查找社区 MGU root 指南。后文假定已能以 `root` 登录。
- **从本车提取的 BMW 应用 SDK `oap-sdk`。** 它是 BMW 版权代码，不包含在仓库中；车机每个 BMW 应用内都有，`kit/tools/extract_sdk.js` 可很快从其中一个应用重建，见快速开始。

**电脑端**

支持 Windows、macOS、Linux，只需 **Python 和 Node.js**，无需 Linux 环境、编译器或 Docker。仓库含[预编译 GPU 渲染器](kit/renderd/prebuilt)，构建器会检查它与源码是否匹配。

| 工具 | 用途 | 是否必需 |
|---|---|---|
| **Python 3.6+** | `build.py` 打包应用，`make_kit.py` 打包车机套件 | 是 |
| **Node.js 14+** | 构建时生成图标、提取 SDK、预览 | 是 |
| **OpenSSH 的 ssh/scp** | 通过部署脚本安装到车机 | 是，Windows 10/11、macOS、Linux 自带 |
| **Docker** | 自行重新编译 `mgu-renderd` | 仅修改渲染器 C 代码时 |
| **ffmpeg、bash** | `make_gif.sh` 录制上面的动画 | 可选 |
| **Pillow**（`pip install pillow`） | `bake_fonts.py` 重新烘焙字库 | 可选 |

无需 npm 包，构建仅使用 Node 和 Python 标准库。Windows 从 [python.org](https://www.python.org/downloads/) 安装 Python 并勾选 Add python.exe to PATH，再从 [nodejs.org](https://nodejs.org/) 安装 Node.js LTS。macOS 可用 Homebrew 的 `brew install python node`，或相同网站的安装包。Ubuntu/WSL 可执行 `sudo apt install python3 nodejs openssh-client`；Node 必须至少 14，Ubuntu 24.04 自带 18，22.04 及更早版本的包太旧，应使用 nodejs.org 或 nvm。

在任意系统终端检查版本：

```sh
python3 --version     # Windows: python --version
node --version
```

**修改渲染器 `kit/renderd/src` 时**需要 Docker：Windows/macOS 使用 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，Linux 使用 [Docker Engine](https://docs.docker.com/engine/install/)。构建器在 Ubuntu 18.04 镜像内编译以匹配车机库，首次约下载 550 MB、耗时数分钟；包括 Apple Silicon 等 ARM 电脑也始终构建 x86-64。之后更新预编译副本供提交。源码变化而无法编译时，会明确提示，并在使用旧渲染器打包前询问。

---

<a id="3-quick-start"></a>
## 3. 快速开始

<a id="31-get-the-sdk-from-your-unit"></a>
### 3.1 从本机提取 SDK

将固件自带的 x_call 应用复制到电脑并提取 SDK：

```sh
scp root@<unit>:'/usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz' .
mkdir x_call && tar xzf x_call@*.tgz -C x_call
node kit/tools/extract_sdk.js x_call/javascript/app.js     # 输出 ./oap-sdk/
```

Windows PowerShell 也可执行这些命令，内置 scp 和 tar；请将 `x_call@*.tgz` 换成实际文件名。提取结果如下：

| 路径 | 内容 |
|---|---|
| `oap-sdk/index.js`、`package.json` | 构建时放入每个应用的运行时，供 `require('oap-sdk')` 使用 |
| `oap-sdk/source/` | 每个 SDK 模块按实际路径保存为可读文件，例如 `source/src/core/OnlineApp.js` |

固件中的 SDK 24.10.x 包含完整公开 API。车机后续下载的 x_call（`/var/opt/public/oap/oap_12204/source/javascript/app.js`）可能携带较新 SDK，但缺少 `telephony`、`appstart`、`map`、`poi`。本套件应用不依赖它们，因此也可用，提取工具会列出缺失项。`oap-sdk/` 已在 `.gitignore` 中，**切勿提交**。

<a id="32-build"></a>
### 3.2 构建

```sh
python3 kit/tools/build.py            # 全部应用 -> dist/<id>@<ver>.mgu
python3 kit/tools/build.py redline    # 仅一个应用
python3 kit/tools/build.py --language zh-CN   # 简体中文 -> dist/<id>@<ver>-zh.cn.2.mgu
node kit/tools/preview.js dist/redline preview wait=10   # 在电脑上预览 -> preview/*.png
```

Windows 将 `python3` 换成 `python`。默认构建英文；`--language zh-CN` 将所有应用构建为简体中文，语言在构建时固定，不受车机语言设置影响。安装另一语言包相当于更新同一应用，不会另装一套。

Translation by：小白151（[JackieZ123430](https://github.com/JackieZ123430)，[idrive7-apps-cn](https://github.com/JackieZ123430/idrive7-apps-cn)）。本中文指南即 [README.zh-CN.md](README.zh-CN.md)。示例中的版本后缀会随应用版本和语言修订变化。

`.mgu` 文件包含 BMW SDK，仅供自己的车机使用，请勿公开发布。

<a id="33-install-on-the-car"></a>
### 3.3 安装到车辆

车辆停稳、点火开启，最好连接电瓶充电器。先把应用、安装器和 GPU 渲染器打包为 `dist/mgu-custom-apps.tar.gz`：

```sh
deploy/make-car-kit.sh                 # macOS / Linux / WSL
deploy\make-car-kit.cmd                # Windows (cmd or PowerShell)
python3 kit/tools/make_kit.py redline  # 任意系统，仅部分应用
python3 kit/tools/make_kit.py --language zh-CN   # 中文套件 -> dist/mgu-custom-apps-zh-CN(.tar.gz)
```

中文套件的 shell 部署需指定 `KIT=dist/mgu-custom-apps-zh-CN`，PowerShell 部署指定 `-Kit dist\mgu-custom-apps-zh-CN.tar.gz`。

随后通过 SSH 推送。macOS/Linux/WSL：

```sh
HU=root@<unit-ip> PORT=22 KEY=~/.ssh/id_mgu deploy/push-to-car.sh check    # 只读检查主机，列出将修改内容
HU=root@<unit-ip> PORT=22 KEY=~/.ssh/id_mgu deploy/push-to-car.sh install  # 备份 -> 安装 -> 重启应用平台
HU=root@<unit-ip> PORT=22 KEY=~/.ssh/id_mgu deploy/push-to-car.sh restore  # 撤销，恢复备份
```

`check` 只读检查主机并列出将触及的内容；`install` 依次备份、安装、重启应用平台；`restore` 恢复备份。`KEY` 是主机 SSH 私钥，权限应为 `chmod 600`；每条命令都需提供，除非已在 `~/.ssh/config` 或 ssh-agent 中配置。

**Windows：**`deploy/push-to-car.ps1` 使用系统 OpenSSH 完成相同工作，可使用 [idrive7-8-ssh-root](https://github.com/cauliflowermossgrape/idrive7-8-ssh-root) 工具写出的密钥 `data\enrollments\<VIN>\id_rsa`；主机 IP 在旁边的 `connect.txt` 中。

```powershell
powershell -ExecutionPolicy Bypass -File deploy\push-to-car.ps1 check   -Key <path>\id_rsa -Ip <unit-ip>
powershell -ExecutionPolicy Bypass -File deploy\push-to-car.ps1 install -Key <path>\id_rsa -Ip <unit-ip>
```

默认读取 `dist\mgu-custom-apps.tar.gz`，可用 `-Kit <path>` 指定。无网络时，可把 `dist/mgu-custom-apps/` 复制到 U 盘，在主机先运行 `sh deploy-car.sh check`，再运行 `sh deploy-car.sh install`。

约 1–2 分钟后，应用磁贴出现在 **Apps** 中。主机 `/var/opt/mgu-custom-apps` 下还可执行：

```sh
sh deploy-car.sh status     # 已安装应用、运行和挂钩状态
sh deploy-car.sh backups    # 列出备份
sh deploy-car.sh restore    # 恢复原厂（要求输入 YES）
```

`status` 显示已安装应用、运行和挂钩状态，`backups` 列出备份，`restore` 恢复原厂并要求输入 YES。

<a id="34-doom-the-extra-steps"></a>
### 3.4 Doom 的额外步骤

Doom 像其他应用一样安装，除非构建时只列出其他应用，否则包含在套件中。四个区别：

1. **首次构建下载游戏数据。** git 不保存 WAD。第一次 `build.py`/`make-car-kit` 从 [Freedoom 发布页](https://github.com/freedoom/freedoom/releases/tag/v0.13.0) 下载 Freedoom: Phase 1 0.13.0 的 24 MB zip，核对 SHA-256，保存为 `apps/doom/freedoom1.wad`，以后复用。电脑无法联网时可在别处下载 `freedoom-0.13.0.zip` 并把其中的 `freedoom1.wad` 放到 `apps/doom/`。其他 WAD，包括 id 原版 `doom.wad`，无法通过校验。
2. **体积更大。** 引擎与游戏数据约 11 MB，推送稍慢，无需额外处理。
3. **全屏需要 GPU 渲染器。** 套件会安装 `mgu-renderd`；未运行时回退为普通应用区域内的较小画面。
4. **安装结束会为控制器门控插件重启一次主机。** `deploy-car.sh install` 将 `mgu-inputgate.so` 配置为随 HMI 加载，让游戏独占控制器，见 [5.1](#51-what-deploy-carsh-install-does)。它在主机启动时加载，因此安装后会黑屏约一分钟，随后自动恢复。若插件导致 HMI 无法正常启动，会自动排除插件。要稍后重启可用 `NO_REBOOT=1 sh deploy-car.sh install`，插件下次用车时加载；不需要插件可用 `NO_INPUTGATE=1 sh deploy-car.sh install`。此时 Doom 仍能运行，但 HMI 也会响应控制器，例如向前推会打开下拉菜单。

```sh
python3 kit/tools/build.py doom                       # -> dist/doom@<ver>.mgu (首次下载 WAD)
deploy/make-car-kit.sh doom                           # 仅打包 Doom，不带参数则打包全部应用
HU=root@<unit-ip> PORT=22 KEY=~/.ssh/id_mgu deploy/push-to-car.sh install
```

车机 **Apps → Doom** 打开主菜单（开始/继续、新游戏、设置）。首次启动需数秒编译引擎。存档在应用数据目录中，重装同一应用仍保留，执行 `restore` 则不保留。

<a id="35-back-to-stock"></a>
### 3.5 恢复原厂

`restore` 停止平台并移除所有自定义应用、挂钩及启动配置，再从**原厂备份**精确恢复所有触及文件。该备份是首次安装建立的备份，永不覆盖；每个文件都与备份校验。最后重启 HMI，使磁贴无需整机重启即可消失。

---

<a id="4-how-the-head-unit-works"></a>
## 4. 主机工作原理

以下是与应用有关的 MGU 内部结构，内容均来自运行中的主机。

<a id="41-hardware"></a>
### 4.1 硬件

| 部分 | 详情 |
|---|---|
| CPU | Intel Apollo Lake x86-64，Intel GPU，i915/Mesa，EGL + GLES2 |
| 系统 | Linux 4.14（`-apl`），systemd，BusyBox 用户空间 |
| 存储 | eMMC：只读根文件系统和可写 `/var/opt`，应用位于 `/var/opt/public`。另有 2.5 英寸硬盘，包含导航等只读分区，以及 `/var/opt/hdshare` 下约 90 GB 可写共享区。 |
| 视频输入 | Intel IPU4 摄像头采集模块，六个 CSI-2 端口；作者主机没有连接摄像头，摄像头视图经以太网输入，见 4.6。 |
| 网络 | `socnet0` 连接车辆，以 VLAN 划分不同车载域；`wlan0` 用于手机热点/CarPlay。 |

<a id="42-software-stack"></a>
### 4.2 软件栈

```
 ┌───────────────────────────── HMI (HmiMain3D, RAMSES 3D renderer) ─────────────────────────────┐
 │  BMW's screens and menus   +   "Remote HMI" (RHMI) screens that apps describe and fill with data │
 └───────────────▲──────────────────────────────────────────────────────────▲────────────────────┘
                 │ SOME/IP + joynr                                             │ SOME/IP
 ┌───────────────┴──────────────┐   ┌──────────────────────────────────────┴─────────────────────┐
 │  OAP app platform            │   │  Native services                                             │
 │  oapcontroller -> MainApp    │   │  media (mediaengine, mediaapp), cameras (dasvideo,           │
 │  (Node.js) -> one Node       │   │  icam2proxy), AVB streams, navigation, phone, diagnostics    │
 │  process per app             │   │  gateway (TASU), provisioning, connectivity (connman)        │
 └───────────────┬──────────────┘   └──────────────────────────────────────┬─────────────────────┘
                 │                     SOME/IP over Ethernet VLANs            │
 ┌───────────────┴────────────────────────────────────────────────────────────┴─────────────────┐
 │  The rest of the car: engine and chassis data, instrument cluster, cameras, telematics (TCB)   │
 └───────────────────────────────────────────────────────────────────────────────────────────────┘
```

图中上层为 HMI（HmiMain3D 与 RAMSES 3D），同时显示 BMW 界面与应用描述的 RHMI 页面；下层为 OAP 应用平台和原生服务，经 SOME/IP 与车辆其他部分相连。

- **SOME/IP（vsomeip）**是主要总线。主机与车内每项服务都记录在 `/etc/oap/someip/someip-interfaces.json` 中，包括接口、字段及其读取方法/变更通知、方法、事件、线缆协议 ID 和类型。转速、车速、温度、加速度以字段通知传入。
- **joynr** 是其上的高级 RPC 层；BMW 集群控制器监听 4242/4243，平台用它管理应用和 HMI 入口。
- **HMI** 是带 BMW 资源数据库的 RAMSES 3D 渲染器。应用通过 BMW 控件模板描述页面，再传入文字、图像和属性，见 4.4。

<a id="43-the-app-platform-oap"></a>
### 4.3 OAP 应用平台

BMW 称其为 **Online Apps Platform**，天气、新闻、M Laptimer、紧急呼叫、保养、电池等原厂应用都由此运行，本项目采用相同机制。

- `oapcontroller.service` 启动 `/usr/lib/oap-mainapp` 中的 **MainApp**，它是 uid 12201 的 Node.js 宿主，负责安装、启动、停止和监督应用。
- **每个应用是 npm 风格包**，含 `package.json`、`manifest.json`、`permissions.json`、`rhmiData/`、`javascript/app.js`，安装到 `/var/opt/public/oap/oap_<uid>/`，以 uid 12203 起的独立 Linux 用户运行。车机使用 Node.js 8 和 SOME/IP、证书、编码等原生扩展。
- **注册信息：**`oap_12201/security/uids.txt` 映射 uid 与应用；`oap_12201/data/apps/<app>.json` 保存版本、安装来源和状态。
- **安装来源：**BMW 后台应用商店或只读目录 `/usr/lib/oap-mainapp/preinstalled_apps/`。MainApp 根据应用 manifest 和服务目录生成 `someipInterfaces/*.json` 及 `acl.json`；应用只能访问所申请的服务与字段。
- **服务配置决定可见性。** BMW 后台推送的签名文件 `/var/opt/public/tm/tm_12000/data/prov/ProvSigned.xml` 列出车辆获准的应用与功能，未启用的被 MainApp 隐藏。签名文件不能直接编辑，套件采用 5.2 的后备机制。
- **崩溃处理严格。** 意外退出会触发 `CorruptAppsHandler` 清空应用数据，第二次会卸载应用。不要手动终止进程。需要重启时用 `systemctl restart oapcontroller`，由平台正常停止应用。
- 每个应用的 CPU、内存和磁盘限制来自 `package.json` 中的 `oapAppSettings`。

<a id="44-how-apps-draw-remote-hmi-rhmi"></a>
### 4.4 应用如何绘图：Remote HMI（RHMI）

HMI 不运行应用代码，应用随附页面**描述**：

- `rhmiData/application.json`：应用身份与 Apps 菜单入口的图标、标题和位置。
- `rhmiData/uiDescriptions/ID7/application.xml` 和 `uiDescription.json`：由标签、按钮、列表、勾选框、图像等组件组成的状态/页面，各自使用 `LT_State_*`、`LT_Label_*`、`LT_Button_*` 等 BMW 模板。
- 运行时推送文字、可见性、启用状态、列表行和图像。

套件用一个大型图像组件作为主页面，由应用自行绘制。两条显示路径自动选择：

- **GPU 引擎，60 fps。** `kit/runtime/record.js` 记录矩形、渐变、圆弧、线条、烘焙字体字形和缓存层，经 Unix socket 发给小型系统服务 `mgu-renderd`。它通过 OpenGL ES 2 在 HMI 上方的独立合成层绘制，合成器接收上一帧后再请求下一帧，使显示器决定节拍。卡片、表盘与刻度预绘成 GPU 纹理，仪表通过弹簧算法平滑。看门狗会隐藏停止送帧的应用，卡死的应用不会一直挡住 HMI。
- **原有 PNG 后备通道。** 无服务或设置 Renderer = Software 时，同一段记录交给纯 JavaScript 栅格化器 `kit/runtime/canvas.js`，编码成 PNG，以 4–15 fps 发送到 HMI 图像组件；代码与外观相同，保留 HMI 自身标题和按钮栏。

使用渲染器时，默认 Screen layout = Full screen：

```
 ┌──┬──────────────────────────────────────────────────────┬───────────────────────┐
 │H │ M Vitals  ENGINE  THERMALS  FUEL & IGN.  CHASSIS │ HMI status strip       │  header: app name + page tabs
 ├──┼──────────────────────────────────────────────────────┴───────────────────────┤
 │  │                                                                              │
 │ <│                       page content, scaled up to fill                        │
 │  │                                                                              │
 ├──┴──────────────────────────────────────────────────────────────────────────────┤
 │      NEXT PAGE          PREVIOUS PAGE          SETTINGS                          │  slim 48 px bar
 └─────────────────────────────────────────────────────────────────────────────────┘
```

- **页头**位于 HMI 黑色标题条，只覆盖应用名称、页签和 DEMO 等标记所需宽度；右侧透明，原车电台、手机信号、通知、音量、语音、个人资料和时钟照常显示与工作。
- **细按钮栏**为 48 px，替代 HMI 的 120 px，由套件绘制。文字与下方 HMI 按钮对齐，触摸和控制器按键继续由 HMI 接收；`Focusable=3` 报告焦点，使控制器选中的按钮像原厂控件一样高亮。
- 返回箭头与主页按钮保持可见，该列在按钮栏以上透明；下方遮住原厂按钮栏，左下不再重复显示。选项、警告、来电等弹窗出现时会隐藏渲染表面。
- Screen layout = Standard 保留 HMI 自身标题和 120 px 栏，渲染器只覆盖图像区域。

按钮和设置页使用正常 RHMI 控件，旋钮、触摸、返回操作与原厂一致。控件词汇、ID 和更新格式见 [`docs/rhmi-widgets.md`](docs/rhmi-widgets.md)。

<a id="45-diagnostics"></a>
### 4.5 诊断

主机充当诊断网关，SOME/IP 服务 `com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu` 可向任意控制单元发送 UDS 请求，或用功能地址 `0xDF` 发给所有单元，应答通过事件返回。车机原厂诊断任务表也使用相同请求：

- 读取故障：`0x19 02 <mask>`，按状态掩码 ReadDTCInformation。
- 清除故障：`0x14 FF FF FF`，ClearDiagnosticInformation。
- 读取数据：`0x22 <DID>`，例如 `F190` 为 VIN。

清除全部模块的故障可能令控制单元重启，主机自身也可能重启。

<a id="46-media-cameras-and-the-drive-recorder"></a>
### 4.6 媒体、摄像头与 Drive Recorder

- 主机与全车之间的音视频使用以太网 **AVB**。网卡专用驱动 `igb_avb` 绕过普通 Linux 网络栈，把流直接交给 BMW 流处理器。
- 倒车/环视图像通过 **AVB 上的 H.264** 输入，由 `dasvideo` 显示；仅在屏幕显示摄像头视图时推流。
- BMW 行车记录服务 `VideoBuffer`（由 `icam2proxy` 提供）需要同时开启编码标记和签名服务配置中的 `oap_drive_recorder`。只编码无效；缺少任一项都不会有供应用录制的服务。

<a id="47-connectivity"></a>
### 4.7 联网

主机没有独立互联网路由，只能通过内部 VLAN 上的远程通信单元 **TCB** 访问 BMW 服务器。若 TCB 无移动连接，例如美规车在欧洲无法使用其 eSIM，主机会离线，无法更新服务配置，BMW 在线应用也不可用。本项目自定义应用不依赖互联网。

---

<a id="5-how-the-apps-get-onto-the-unit"></a>
## 5. 应用如何安装到主机

<a id="51-what-deploy-carsh-install-does"></a>
### 5.1 `deploy-car.sh install` 做了什么

1. **检查**主机，并针对当前固件试构建 MainApp 补丁；遇到预期之外的情况，在改文件前停止。
2. **备份**所有待修改文件到脚本旁 `backups/<time>/` 和 `/var/opt/public/mgu_custom_backup/<time>/`，验证两份副本；首次备份作为原厂备份保留。
3. **启用服务配置挂钩**（5.2），通过 `oapcontroller.service` 的 systemd drop-in 使其重启后生效。
4. **安装每个 `.mgu`** 到 `/var/opt/public/oap/oap_<uid>/`，使用 12221 起的 uid，不触及原厂应用；加载主机固件自带 BMW 生成器生成 SOME/IP 配置和 ACL，注册为预装应用并修正所有权和权限。
5. **安装 GPU 渲染器 `mgu-renderd`**，作为随平台启动的 systemd 服务，以 root 身份、合成器组运行。其前台门控通过 SOME/IP 读取当前前台应用，独占触摸的应用使用 nft 路由触摸。它还从主机 HMI 创建页面内绘制模板，最多约 2 分钟；每次 HMI 启动前从 `/run` 挂载，带启动保护，不写入分区，`NO_EMBED=1` 可跳过。应用接入方式见 [`kit/renderd`](kit/renderd/README.md#using-it-in-an-app)。无法安装时应用仍可软件绘制。
6. **配置控制器门控 `mgu-inputgate.so`** 随 HMI 加载，使用 `hmi.service` 的 drop-in 并保留其他预加载项。全屏应用请求独占时（如 Doom 游戏中），HMI 看到旋钮、按压、倾斜均未触碰，应用通过渲染器接收真实事件；BACK、MENU 等按钮和触摸从不拦截。只有请求独占且屏幕可见的应用使渲染器持续刷新 `/run/mgu-renderd/inputgate` 标记时才生效；应用关闭、崩溃、弹窗覆盖或渲染器消失后，0.7 秒内恢复 HMI 控制。为此不会直接重启 HMI，因为其停止会使用 SIGABRT，主机对此会整机重启。插件通过 HMI 前运行的 `mgu-inputgate-guard.service` 在下次开机加载；`mgu-inputgate-check.service` 在启动 2 分钟后确认健康，连续两次不健康会自动排除插件，重新安装可重试。两服务永久保持活动，因为此主机任何服务停止都可能引发重启。`status` 显示已加载、已配置待下次启动或已被保护机制排除；`NO_INPUTGATE=1` 跳过。
7. **重启应用平台一次**，HMI 约 1–2 分钟刷新应用列表。若刚配置门控，改为在安装完成 10 秒后整机重启，以加载门控并重启其他服务。`NO_REBOOT=1` 可跳过，下次用车时加载。

涉及的文件如下，注释说明应用 ID 列表、注册表、新建挂钩及服务等：

```
/var/opt/public/oap/oap_12201/security/uids.txt          app id list
/var/opt/public/oap/oap_12201/data/apps/                 app registry
/var/opt/public/oap/oap_12201/data/custom_apps.json      (new) list of custom apps
/var/opt/public/oap/_mgu_custom/                         (new) patched main.js + boot script
/etc/systemd/system/oapcontroller.service.d/50-mgu-custom-apps.conf   (new)
/var/opt/public/oap/oap_12221 ... oap_12299/              (new) the apps
/var/opt/mgu-renderd/                                    (new) the GPU renderer
/etc/systemd/system/mgu-renderd.service                  (new) its service (+ oapcontroller.service.wants link)
/etc/systemd/system/mgu-renderd-hmi.service              (new) mounts the page template before the HMI (+ hmi.service.wants link)
/etc/systemd/system/display-bridge*.d/mgu-renderd.conf   (new) display-bridge stands down while the renderer is installed
/etc/systemd/system/hmi.service.d/zz-mgu-inputgate.conf  (new) loads the controller gate into the HMI
/etc/systemd/system/mgu-inputgate-guard.service          (new) decides at each start whether it loads
/etc/systemd/system/mgu-inputgate-check.service          (new) confirms the HMI is healthy with it
```

<a id="52-the-provisioning-hook"></a>
### 5.2 服务配置挂钩

MainApp 只显示 BMW 签名服务配置启用的应用，其中不会包含自定义应用。套件复制 MainApp 的 `main.js`，增加一个后备分支：“若服务配置无该应用条目，则使用 `custom_apps.json` 的条目”，并在平台启动时以 **bind mount** 覆盖原文件。只读系统分区不修改，BMW 原厂应用仍使用真实配置，不伪造或重新签名。

固件更新后，启动脚本发现 MainApp 改变便不会应用旧副本，主机按原厂方式运行，自定义应用只是被隐藏。再次执行 `sh deploy-car.sh install` 可为新固件重建挂钩。

---

<a id="6-writing-your-own-app"></a>
## 6. 编写自己的应用

在 `apps/<id>/` 中提供 `app.json`（应用定义）和 `main.js`（行为）即可。`build.py` 为其生成 BMW 包结构：RHMI 布局、入口、图标、33 种 HMI 语言的文本资源、manifest、权限与启动器。

<a id="61-appjson"></a>
### 6.1 `app.json`

以下保留可直接使用的原始配置，协议键与示例内部值不翻译：

```json
{
  "id": "boost",
  "title": "Boost",
  "description": "Big boost gauge",
  "version": "1.0.0",
  "vendor": "custom",
  "loggingId": "OAA1",
  "iconGlyph": "gauge",
  "signals": {
    "de.bmw.infotainment.vehicle.CDS": { "statusEngineSpeed2": "rs" },
    "de.bmw.infotainment.vehicle.Vehicle2": { "statusCarSpeed2": "rs" }
  },
  "screens": [
    { "name": "MAIN", "kind": "canvas", "title": "Boost",
      "buttons": [["BTN_RESET", "Reset peak"], ["BTN_SETTINGS", "Settings"]] }
  ],
  "settings": [
    { "key": "theme", "label": "Colour theme", "type": "choice", "default": "m_red",
      "options": [["m_red", "M Red"], ["ice", "Ice White"]] },
    { "key": "max", "label": "Gauge max", "type": "number", "unit": "bar", "default": 2.0, "steps": [1.5, 2.0, 2.5] },
    { "key": "peakHold", "label": "Hold peak", "type": "bool", "default": true }
  ]
}
```

| 键 | 含义 |
|---|---|
| `loggingId` | 4 字符日志标识，每个应用唯一。BMW 使用 `OA1x`，本项目使用 `OA93`–`OA9F`。 |
| `iconGlyph` | 无 `icon.png` 时由 `make_icon.js` 绘制磁贴图标，可用 `gauge`、`flag`、`engine`、`rpm`、`dyno`、`brake`、`temp`、`gforce`、`battery`、`wrench`、`doom` 或最多约 3 个字母。应用目录内 140 × 140 透明 `icon.png` 优先。随附图标源于 `kit/icons/<app>.svg`，用 `python3 kit/tools/render_icons.py` 渲染为透明背景，需 Pillow 和 Chromium/Chrome；`--sheet out.png` 生成预览，`--tile` 放到玻璃磁贴上。 |
| `signals` | `接口 → {字段: 标志}`。`r` 启动时读取一次，需 getter；`s` 订阅变更，需 notifier；`w` 通过 setter 与 `ctx.signals.set` 写入。可选 `_instances`、`_methods`、`_broadcasts`。`"_optional": "缺失时失去的功能"` 使缺少该接口的固件仍可安装，安装器和日志说明缺项；未设可选时拒绝安装，`deploy-car.sh` 跳过该应用。 |
| `screens` | `canvas` 页面含一张大图和最多 4 个按钮，`BTN_SETTINGS` 打开根据 `settings` 生成的设置页。`"bar": false` 不绘按钮栏，将全高留给游戏，但下方 HMI 按钮仍存在，用于焦点和点击；`"chrome": false` 移除页头、栏和面板，应用占整屏（`cv.place.full`）。`"kind": "menu"` 加 `"items"`（`["button", NAME, label]` 或 `["text", NAME, label]`）创建 HMI 列表页，`"settings": true` 把所有设置放进去，不另建设置页。 |
| `assets` | 构建下载并按 SHA-256 校验的资源，格式 `[{ "file", "sha256", "url" }]`；zip 可另设 `zipSha256`、`zipMember`，例如 Doom 数据。应用目录里的 `.wasm`、`.wad`、`LICENSE`、`NOTICE` 原样打包。 |
| `settings` | `choice`、按 `steps` 切换的 `number`、`bool`，保存在 `data/settings.json`。先显示应用设置，再显示主题、更新率、布局、渲染器、演示等屏幕设置。`"markDefault": true` 在默认行附加“默认”；`"reset": n` 的 n 改变时，让每辆车一次性恢复该项新默认值。 |
| `startWidget` | 可选主页小组件，按 Drive Recorder/Weather 方式生成 `rhmiDataStartWidget/`。`name` 为列表名，`layout` 为 HMI 模板（如 `LT_Table_OnlineApps_DriveRecorderWidget`），`image` 为图像目标单元（如 `BackgroundImage1`），`size` 为图片宽高（HMI 缩放到大组件并居中裁剪，G05 适合 384 × 256），`cells` 为每次放置组件时写入一次的 `{cell: [value, type]}`。用 `ctx.widget.loop(fps, (inst) => canvas)` 绘制，用 `ctx.widget.set(spawnId, cell, value, type)` 更新其他单元；点击打开应用，见 `apps/edrive/live.js`。 |

**对照服务目录检查标志。** 无 getter 的字段不能使用 `r`，getter ID 为 0 也视为缺失，安装器会拒绝。把主机目录复制为 `reference/someip-interfaces.json` 后执行：

```sh
python3 kit/tools/check_signals.py      # 对照目录检查所有 app.json
python3 kit/tools/sigdoc.py de.bmw.infotainment.vehicle.CDS2   # 字段、读取与通知接口、数据类型
```

第一条核对所有 `app.json`，第二条列出接口字段、getter/notifier 和类型。

<a id="62-mainjs"></a>
### 6.2 `main.js`

```js
'use strict';
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');

mgu.run({
    async start(ctx) {
        const car = new Car(ctx, ['rpm', 'speed']);     // 缩放后的信号与自动演示回退
        let peak = 0;
        car.onSample((d) => { if (G.isNum(d.rpm)) peak = Math.max(peak, d.rpm); }, () => { peak = 0; });
        ctx.ui.onClick('BTN_RESET', () => { peak = 0; });

        // 页面可见时，GPU 模式按显示刷新绘制（60 fps），
        // 否则 10 fps
        ctx.loop('MAIN', 10, () => {
            const t = ctx.theme(), d = car.data();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            G.frame(cv, t, ['Boost'], 0, [d.demo && { text: 'DEMO' }]);   // 页签（页头）
            G.radial(cv, t, 800, 290, 210, { value: d.rpm, min: 0, max: 8000, label: 'RPM', ticks: 8 });
            cv.text('PEAK ' + peak, 800, 500, 32, t.dim, { align: 'center', font: 'bold' });
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
```

示例创建带缩放与自动演示回退的转速/车速信号对象，记录峰值并提供重置按钮；页面可见时 GPU 模式每次刷新绘制，否则每秒 10 次。`G.frame` 绘制页签，`G.radial` 绘制转速仪表。

**`ctx` 提供：**

| API | 用途 |
|---|---|
| `ctx.ui` | `image(name, canvas)`、`text(name, str)`、`visible(name, on)`、`checked(name, on)`、`rows(name, n)`、`onClick(name, fn)`。 |
| `ctx.settings` | `get(key)`、`onChange(fn)`。 |
| `ctx.canvas(w, h)` | 可复用的单帧画布，交给 `ui.image`。使用 1600 × 520，页签由 `G.frame` 绘制，内容位于 `G.TOP`（44）与 `G.BOTTOM`（512）之间。 |
| `ctx.loop(screen, fps, fn)` | 仅在页面显示时运行；GPU 模式每次刷新一帧，否则每秒 fps 次，返回 `{stop()}`。 |
| `ctx.theme()` | 当前主题，含 `bg`、`text`、`dim`、`accent`、`warn`、`crit`、`cold` 等。 |
| `ctx.signals` | 原始 SOME/IP 访问：`watch(iface, instance, handlers)`、`proxy`、`call`、`set(proxy, field, value)`，写入需 `w`。 |
| `require('./kit/parked')` | `watch(ctx, log)` 返回 `{ moving(), speed() }`，判断车速是否超过 3 km/h，供游戏等仅停车运行功能使用。信号暂时安静时保留上次状态，无任何车速（VM/台架）视为停车。需 `Vehicle2.statusCarSpeed2` 的 `rs`。每个游戏都有默认开启的布尔设置 `parkedOnly`，`moving()` 时暂停。 |
| `ctx.controller` | `grab(on)` 仅在本应用显示时独占旋钮、按压和倾斜，HMI 不再响应这些操作，BACK/MENU/触摸仍有效。`onInput(fn)` 接收 `frontRotaryEncoderOperation`、`frontRotaryEncoderPushButton`、`frontRotaryEncoderDeflection`，数值与 FrontCCU 相同；需要 GPU 渲染器及 5.1 门控插件。 |
| `ctx.log` | `info/warn/error` 写入系统日志及 `data/<id>.log`。 |
| `ctx.dataDir` | 持久保存的可写应用目录。 |

**绘图**（`ctx.canvas()`）：`fillRect`、`gradientRect`、`roundRect`、`strokeRoundRect`、`arc(cx, cy, r0, r1, a0, a1, color, {round, ramp})`、`circle`、`line`、`polyline`、`quad`、`fillUnder`、`rampRect`、`clip`/`noclip`、`alpha`；`text(str, x, baselineY, size, color, {font, align, spacing})` 返回宽度，另有 `textWidth`、`blit(layer, x, y)`。`image(id, x, y, w, h)` 绘制游戏帧等像素图像，通过 `kit/record` 的 `setImage(id, w, h, rgba)` 设置，仅变化时重新上传 GPU。`xf(1, 0, 0)` 到 `xf()` 之间按屏幕像素绘制，`cv.place` 给出帧位置。不支持读像素；静态内容用 `G.layer(key, w, h, (c) => ...)` 绘制一次，每帧 blit，缓存在 GPU。

**模板**（`kit/runtime/gauges.js`，均接受主题 t）：`panel`、`radial`、`needle`、`ring`、`bar`、`segBar`、`stat`、`readout`、`shiftLights`、`gear`、`chart`、`table`、`pill`、`tyres`、`gmeter`、`frame`（全屏时页签在页头，否则为细页签栏）、`header`、`menuBar`（`slim`/`standard`）。仪表、条形和 G 值自动平滑过渡；自己的绘图可用 `G.smooth(key, value)`。字体有 `label`、`bold`、`num`、`light`、`gear`；大字号仅含数字与少量字母，需要更多可用 `kit/tools/bake_fonts.py` 重新烘焙 Ubuntu 字体族。

**`Car`**（`kit/runtime/car.js`）提供 `rpm`、`speed`、`temps`、`accel`、`gear`、`torque` 分组，`car.data()` 返回真实单位的 `{ rpm, speed, gLong, gLat, coolant, oil, gear, torque, demo }`，过滤无效原始值。演示模式遵循应用 `demo` 设置，`auto` 在 5 秒没有车辆数据后切换模拟行程。

<a id="63-preview-build-deploy"></a>
### 6.3 预览、构建、部署

```sh
python3 kit/tools/build.py boost
node kit/tools/preview.js dist/boost out wait=8 BTN_RESET render --set theme=ice
deploy/make-car-kit.sh boost && HU=root@<unit> KEY=~/.ssh/id_mgu deploy/push-to-car.sh install
```

`preview.js` 在电脑上以模拟主机和演示数据运行已构建应用，把软件通道推送的每帧保存为 PNG。查看全屏 GPU 布局时，录制渲染器接收的内容并用 `mgu-renderd` 回放，见[无车测试](kit/renderd/README.md#test-without-a-car)：

```sh
node kit/tools/preview.js dist/boost out wait=8 render --gpu out/stream.bin
```

录制文首动画时，`frames=<n>` 以每秒 60 帧实时绘制 n 帧，`mgu-renderd --replay ... --raw` 写出每帧。`make_gif.sh` 完成整个流程并编码 GIF，需 Docker 和 ffmpeg：

```sh
kit/tools/make_gif.sh docs/media/redline.gif redline 6 6 --set coldGuard=false   # 演示行程 6 秒后，录制 6 秒
```

示例在演示行程开始 6 秒后录制 6 秒。

---

<a id="7-vehicle-signals-reference"></a>
## 7. 车辆信号参考

应用使用的信号与 `car.js` 缩放公式为：原始值 × 系数 + 偏移。

| 数值 | 接口 · 字段 | 缩放/含义 |
|---|---|---|
| 发动机转速 | `vehicle.CDS` · `statusEngineSpeed2` | × 0.25 rpm |
| 车速 | `vehicle.Vehicle2` · `statusCarSpeed2` | × 0.015625 km/h |
| 冷却液/机油温度 | `vehicle.CDS` · `statusEngineTemperature`（`temperatureEngineDrive`、`temperatureEngineOilDrive`） | × 1 − 48 °C |
| 纵向/横向加速度 | `vehicle.CDS2` · `statusLongitudinalAccelerationMassCenter` / `statusLateralAccelerationMassCenter` | × 0.002 − 65 m/s² |
| 挡位 | `vehicle.VehicleInformation` · `statusGearboxDrive.statusActualGearDrive` | 枚举 R=1、N/P=2、1 挡=3 … 10 挡=12，仅事件 |
| 发动机扭矩 | `vehicle.FES` · `statusActualValueTorque2.actualValueTorqueCrankshaft` | 原始 4095 无效 |
| iDrive 控制器 | `controlelements.FrontCCU` · `statusRotaryEncoderState` | `frontRotaryEncoderOperation` 为 16 位循环旋钮计数；`frontRotaryEncoderPushButton` 为按压（`DREHGEBER_KURZ/LANG_GEDRUECKT`）；`frontRotaryEncoderDeflection` 为上下左右推杆（`NORD_KURZ_GEDRUECKT` 等），`MITTELSTELLUNG` 为居中。枚举按名称传入，全为 `SIGNAL_UNGUELTIG` 表示无控制器（VM）。HMI 也会响应。 |
| 控制器按钮 | `controlelements.FrontCCU` · `statusPushButtonsState` | `frontOperationButton1..8` 的短按、长按、触摸；HMI 自身用于 MENU/BACK 等。 |
| 保养项目 | `KombiInterface_2` · `cbsDataServiceList` | 仪表列表：ID、名称、颜色及文本形式的距离和日期。 |

目录中还有增压、转向角、横摆角速度、轮速、踏板位置、电池、外温和仪表接口等，使用 `sigdoc.py` 探索。

---

<a id="8-troubleshooting-and-gotchas"></a>
## 8. 故障排查与注意事项

- **磁贴一直显示 Loading app。** 应用进程没有连接 HMI。查看 `/var/opt/public/oap/oap_<uid>/data/<id>.log` 中的启动步骤和致命错误，以及 `sh deploy-car.sh status`。
- **崩溃后应用消失。** 这是 MainApp 的崩溃处理，见 4.3；修复崩溃后重新 `install`。
- **不要 `kill` 应用进程。** 用 `systemctl restart oapcontroller` 重启平台，HMI 会刷新列表。
- **移除后仍有磁贴。** HMI 有缓存，`restore` 会依次重启 `hmi.service` 与平台处理，整机重启也有效。
- **安装时报 `interface generation failed ... no getter available`。** 无 getter 的字段设了 `r`；运行 `check_signals.py` 并改成 `s`。
- **实车全是 DEMO。** 对应信号组 5 秒未收到数据，查看日志并确认点火已开；只有主机唤醒时不会发送许多车辆信号。
- **固件更新后应用消失。** 应用仍已安装但被隐藏，因为挂钩拒绝修改未知 MainApp；重新运行 `sh deploy-car.sh install`。

---

<a id="9-known-limits"></a>
## 9. 已知限制

- **不能当行车记录仪。** 摄像头录制需要获得 BMW 服务配置授权的 Drive Recorder 服务，见 4.6。应用不能截取原始摄像头流，而且仅显示摄像头时才推流。
- **离线车仍会离线。** 这些应用不需要互联网，但不能修复 TCB 连接或解锁 BMW 在线服务。
- **物理按钮。** 应用能接收部分方向盘按钮（滚轮按压、语音、音量）与 iDrive 旋钮/按压/推杆，但 HMI 也会响应；BACK、MENU、OPTION 仍会退出或遮挡应用。
- 马力、制动距离等计算值的精度取决于车速和加速度传感器，应与已知数据比较并在平路测量。

---

<a id="10-repository-layout"></a>
## 10. 仓库结构

```
apps/<id>/            app.json + main.js (+ helpers) per app
apps/doom/            Doom: doom-core.js (WebAssembly runner, files over Node fs), controls.js
                      (controller -> keys), doom.wasm (built from third_party/doomgeneric), GPL-2.0
kit/runtime/          app runtime: mgu.js (platform glue), record.js + display.js + renderd.js
                      (GPU path), canvas.js (software path), gauges.js, themes.js,
                      car.js (signals + demo), sim.js (demo drive), signals.js (SOME/IP),
                      diag.js (UDS over TASU), fonts/
kit/renderd/          mgu-renderd: the GPU renderer service (mgu-render: C, GLES2, Wayland/ivi),
                      GPL-3.0-or-later; prebuilt/ = the ready binary + the source fingerprint it
                      was built from; inputgate/ = the controller gate
kit/platform/         permissions template used by build.py
kit/tools/            build.py, make_kit.py, preview.js, make_gif.sh, make_icon.js, render_icons.py,
                      bake_fonts.py, extract_sdk.js, check_signals.py, sigdoc.py, oapgen/gen.js
kit/icons/            the apps' tile icons as SVG (render_icons.py -> apps/<app>/icon.png)
deploy/               make-car-kit.sh/.cmd, push-to-car.sh/.ps1, mgu-app-install.sh, mainapp-patch.js
deploy/car/           deploy-car.sh (runs on the unit) + its README
docs/                 RHMI widget reference, screenshots (docs/screens), animations (docs/media)
third_party/doomgeneric/  Doom's engine source (GPL-2.0) with the changes for the app (mgu.patch,
                      MGU.md) and build.sh, which builds apps/doom/doom.wasm
```

`apps/<id>/` 保存各应用定义、主程序与辅助文件；`apps/doom/` 含 WebAssembly 运行器、控制器映射及 Doom 引擎；`kit/runtime/` 为平台衔接、GPU/软件绘图、仪表主题、车辆信号、演示和诊断运行时。`kit/renderd/` 是基于 mgu-render 的 C/GLES2/Wayland/ivi GPU 服务，采用 GPL-3.0-or-later，`prebuilt/` 为二进制与源码指纹，`inputgate/` 为控制器门控。`kit/platform/` 为权限模板，`kit/tools/` 为构建、预览、图标字体、SDK 提取、信号与接口生成工具，`kit/icons/` 为 SVG 图标。`deploy/` 为电脑端部署工具，`deploy/car/` 为主机脚本与说明，`docs/` 为 RHMI 文档和媒体。`third_party/doomgeneric/` 为 GPL-2.0 Doom 引擎源码、`mgu.patch`、`MGU.md` 和生成 `apps/doom/doom.wasm` 的 `build.sh`。

以下内容有意不放入仓库：

- `oap-sdk/`：BMW SDK，请从本机提取，见 3.1。
- `reference/someip-interfaces.json`：从本机复制的服务目录。
- `dist/`：构建输出，每个 `.mgu` 都包含 BMW SDK。
- VIN、密钥、服务配置文件等能标识车辆的内容。

安装时所需的 BMW 接口生成器，同样由 `kit/tools/oapgen/gen.js` 从主机自身固件加载，因此仓库不分发 BMW 代码。

<a id="doom-and-renderer-licences"></a>
### Doom 与渲染器许可证

仓库采用 MIT，但有两部分例外。GPU 渲染器 `kit/renderd` 是 Robert Nisipeanu 和 IterioDev 的 [mgu-render](https://github.com/robertnisipeanu/mgu-store)，采用 GPL-3.0-or-later（`kit/renderd/LICENSE`）；来自本仓库最初渲染器的部分仍同时保留 MIT（`kit/renderd/LICENSE.mgu-renderd`），`kit/renderd/inputgate` 门控采用 MIT。渲染器作为独立程序运行，因此经 socket 与它通信的应用仍采用 MIT。

另一部分是 Doom：`apps/doom/doom.wasm` 是以 WebAssembly 编译的 [doomgeneric](https://github.com/ozkl/doomgeneric) 引擎（GPL-2.0），所以 Doom 应用整体按 GPL-2.0 分发，见 `apps/doom/LICENSE` 和 `NOTICE`。完整源码及适配修改在 `third_party/doomgeneric`，使用 zig 0.13 和 binaryen 119 执行其 `build.sh` 可逐字节重建 `doom.wasm`。游戏数据 [Freedoom: Phase 1](https://freedoom.github.io) 0.13.0 采用 BSD，声明在 NOTICE 中；数据不放入仓库，由构建脚本下载并核对 SHA-256。Doom 是 id Software 的商标，Freedoom 与本应用均不隶属于 id Software。

---

**Translation by：抖音 小白科技杂物社 · BiliBili 小白151 · GitHub [JackieZ123430](https://github.com/JackieZ123430)。**
