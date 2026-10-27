[English](README.md) | **中文**

# MGU Custom Apps 中文安装包

**汉化：抖音 小白科技杂物社 / BiliBili 小白151 / GitHub [JackieZ123430](https://github.com/JackieZ123430)**

[本仓库](https://github.com/JackieZ123430/idrive7-apps-cn) · [上游项目](https://github.com/cauliflowermossgrape/idrive7-apps) · [署名与来源](NOTICE.zh-CN.md)

英文和中文分别构建、分别安装。**安装中文包就是中文，安装英文包就是英文，应用设置中没有语言切换选项。** 两种包更新同一组应用，不是重复安装两套应用。

## 功能与汉化范围

包含 M 车辆仪表、换挡转速、虚拟马力机、制动测试、加速计时、G 值仪表、暖机助手、电驱助手、故障扫描、保养信息和 Doom 共 11 个应用。

中文包包含菜单、按钮、设置、仪表标题及内置提示的简体中文译文，并附带绘制这些文字所需的开源中文字形。中文画面右上角使用 12 px、约 25% 不透明度的小字署名：

**抖音：小白科技杂物社 · BiliBili：小白151 · GitHub：JackieZ123430**

英文包保留英文显示，不显示中文角落署名。原始版权及汉化贡献署名保留在文档、设置页和源码中。

- Doom 启动菜单和设置已汉化，游戏内部贴图和关卡文字保留原文。
- 原厂故障码数据库、ECU 原始响应及车辆返回的说明保留原文；技术标识和诊断指令不翻译。
- 自绘中文字库覆盖本版内置译文；车辆返回的任意中文长文本可能需要额外字形。原生 HMI 字符串使用车机自己的字体。
- 台架缺少对应控制单元时，可在应用设置中启用演示数据。
- 单个 HMI 字符串资源包按实机验证的 1024 条预算检查，本版预留 256 条动态资源，避免资源申请失败导致 Loading app。

## 显示预览

以下为离线演示数据预览，实际车机控件的字距、焦点和位置仍需实机验证。

英文包：

![英文界面](docs/screens/bilingual-english-preview.png)

中文包：

![中文界面](docs/screens/chinese-warmup-preview.png)

## 构建两个安装包

需要 Python 3、Node.js 14 以上，以及从自己车机提取的 BMW oap-sdk。已提交预生成字库和 GPU 渲染器，正常构建无需字体工具或 Docker。

原厂 SDK 不随公开仓库分发，也不要将含 SDK 的安装包公开上传。

1. 从自己的原厂 OAP 应用中获取 `source/javascript/app.js`，保存为 `own-app.js`。各车机应用 UID 不同，也可从 `/usr/lib/oap-mainapp/preinstalled_apps/` 下原厂应用 tgz 中解出这个文件。详细路径和说明见英文 README。

   ```powershell
   node kit/tools/extract_sdk.js own-app.js oap-sdk
   ```

2. 构建英文包（默认）：

   ```powershell
   python kit/tools/make_kit.py --language en
   ```

   输出：`dist/mgu-custom-apps-en.tar.gz`。

3. 构建中文包：

   ```powershell
   python kit/tools/make_kit.py --language zh-CN
   ```

   输出：`dist/mgu-custom-apps-zh-CN.tar.gz`。

   只构建一个应用可在命令末尾加应用 ID，例如 `python kit/tools/make_kit.py --language zh-CN warmup`。

英文构建同时保留兼容上游脚本的 `dist/mgu-custom-apps.tar.gz`。两个语言安装包分别保存在不同文件中，可以先后构建，不会互相覆盖。

## Windows 安装

适用于已具有 root SSH 的 iDrive 7 MGU。本项目部署应用，不刷写 MGU 固件。上游测试固件为 `P18_23w44.2`；本台架的 `P18_23w44.2-1-3` 已验证安装及保养应用启动，其他功能和版本需按实际设备测试。

指定要安装的语言包、自己的 SSH 私钥和车机 IP，先执行检查：

```powershell
powershell -ExecutionPolicy Bypass -File deploy/push-to-car.ps1 check -Kit dist/mgu-custom-apps-zh-CN.tar.gz -Key "C:\你的目录\id_rsa" -Ip "车机IP"
```

检查通过后安装：

```powershell
powershell -ExecutionPolicy Bypass -File deploy/push-to-car.ps1 install -Kit dist/mgu-custom-apps-zh-CN.tar.gz -Key "C:\你的目录\id_rsa" -Ip "车机IP"
```

要安装英文版，将 `-Kit` 后的文件换成 `dist/mgu-custom-apps-en.tar.gz`。安装器会备份配置并重启应用平台，首次设置 Doom 控制器插件可能重启车机。恢复使用同一脚本的 `restore` 命令；更多细节见 [英文原文档](README.md)。

## 新增其他语言

不需要复制一套应用代码或新增车机语言菜单。每种语言是构建时选择的译文文件：

1. 在 `kit/runtime/locales/` 新增 UTF-8 JSON，例如 `fr.json`：

   ```json
   {
     "Settings": "Paramètres",
     "Next page": "Page suivante",
     "Oil": "Huile"
   }
   ```

2. 构建工具会自动发现新文件：`python kit/tools/make_kit.py --language fr`，生成 `dist/mgu-custom-apps-fr.tar.gz`。没有译文的文本保留英文。
3. 检查该语言所需字形。含现有字库未覆盖的字符时需补充字库；右向左文字等还需相应排版支持，不能只放入译文就假定显示正确。
4. 验证原生菜单、仪表排版、动态提示和资源总量。信号名、设置内部取值、故障码及协议字段保持原样。

中文译文维护在 `kit/runtime/locales/zh-CN.tsv`，执行 `python kit/tools/sync_zh.py` 生成 JSON。新增汉字后，用 Pillow 和 `python kit/tools/bake_cjk.py` 重建中文字库，并保留字体许可证。

## 检查与预览

```powershell
python kit/tools/test_zh.py
node kit/tools/test_zh.js
node kit/tools/test_zh.js dist/warmup/source/javascript/kit
node kit/tools/preview.js dist/warmup preview
```

第三条检查当前已构建应用的固定语言和字形；第四条预览当前语言的应用。安装包包含的语言由构建参数决定，不读取旧版的语言设置。
