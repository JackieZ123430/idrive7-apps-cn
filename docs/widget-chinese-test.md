# eDrive 小组件：简体与繁体中文测试

本页是测试步骤，不会自动执行任何命令。请在主机上的其他测试结束、确认可以中断应用平台后再操作。
当前验证范围为电脑上的构建、离线渲染及模拟 RHMI 事件，尚未证明实机 HMI 的布局、字体和所有固件兼容性。

## 准备

- 保留目前可用版本的安装包、应用数据及主机安装器备份。记录原有设置和主页布局。
- 首次验证建议只构建/安装 `edrive`，不要同时更新其余应用：

  ```powershell
  python kit/tools/make_kit.py --language zh-CN edrive
  ```

  繁体版使用 `--language zh-TW`，英文使用 `--language en`。
- 三种包更新同一个 `edrive` 应用。安装哪种语言就使用哪种语言，不需要在车机里切换系统语言。
- 保持供电稳定，车辆停车或使用测试台架。本项目不需要再次刷调试镜像。

## 安装（等主机可以测试时再执行）

将仅含 eDrive 的载荷与 `deploy/push-to-car.ps1` 放在同一目录，载荷命名为 `mgu-custom-apps.tar.gz`，或者显式用 `-Kit` 指定。

```powershell
$key = "C:\自己的密钥目录\id_rsa"
$mguIp = "实际MGU-IP"
powershell -ExecutionPolicy Bypass -File .\push-to-car.ps1 check -Key $key -Ip $mguIp
```

`check` 会先上传并校验工具载荷，写入主机暂存目录，不是完全只读。通过后才能安装：

```powershell
powershell -ExecutionPolicy Bypass -File .\push-to-car.ps1 install -Key $key -Ip $mguIp
```

安装会重新加载应用平台，可能中断其他正在运行的应用，因此不要在其他重要测试期间操作。
仅 eDrive 的包不应安装其他自定义应用，但共享的部署平台组件仍由安装器检查/维护。

## 观察项目

1. 应用列表、设置和小组件选择列表显示 `eDrive助手`，不能出现 `EDrive助手` 或 `eDrive助手助手`。英文包显示 `eDrive`。
2. 在 eDrive 设置里临时启用演示数据，以便缺少电池控制单元的台架也能显示内容。记录并在结束后恢复原设置。
3. 在主页添加一个小尺寸 eDrive 小组件。检查标题、电芯、行程、行驶/充电/能量回收等状态；原生文字不能乱码、消失或出现方框。数字和单位仍须正常。
4. 将其切换为大尺寸，观察中文图片、字号、裁切、数值和单位。图片预览无法证明小尺寸的原生文字格一定正确。
5. 同时添加两个实例，反复切换大小、进入其他页面再返回，确认两个实例没有串文字或留下旧状态。
6. 删除并重新添加小组件，重复多次，确认不会逐渐丢字或出现资源池耗尽。点击小组件应仍能打开完整 eDrive。
7. 分别安装简体包和繁体包验证，重点对比“设置/設定”“电芯/電芯”“读取中/讀取中”“行驶/行駛”。繁体为台湾用语，不是粤语翻译。
8. 确认当前其他测试都已结束后，再安排一次完整主机重启，检查应用和小组件能否恢复。

## 故障记录与回退

- 记录安装语言、eDrive 版本、固件版本、大小组件各一张照片，以及发生问题的操作顺序。
- 查看应用数据目录下 `edrive.log`，留意 `widget`、`StringBundle`、`INVALID_VALUE`、`pool exhausted` 等错误。不要清除日志或故障记录来掩盖问题。
- 本地包使用设备所有者提取的 SDK；不同固件需要另行核查。未收录的故障数据库译文仍保留英文。
- 首选重新安装此前确认可用的同应用版本，并核对保存的数据；如果需要恢复原厂应用配置，按安装器原有 `restore` 流程操作。该恢复可能影响整组自定义应用，不等于只撤回小组件汉化，必须先核对备份范围。

## 离线验证

```powershell
python kit/tools/test_zh.py
node kit/tools/test_widget_text.js
node kit/tools/test_zh.js
```

分别构建三种语言后，还应对各包实际携带的 `source/javascript/kit` 运行 `test_zh.js`，以检查对应字形、署名、字符串与显存预算。

汉化：抖音 小白科技杂物社 · BiliBili 小白151 · GitHub JackieZ123430。
