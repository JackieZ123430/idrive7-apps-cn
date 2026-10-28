[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文**

# MGU Custom Apps 繁體中文安裝包

**漢化：抖音 小白科技杂物社 / BiliBili 小白151 / GitHub [JackieZ123430](https://github.com/JackieZ123430)**

[本倉庫](https://github.com/JackieZ123430/idrive7-apps-cn) · [上游專案](https://github.com/cauliflowermossgrape/idrive7-apps) · [署名與來源](NOTICE.zh-CN.md)

英文、簡體中文和繁體中文分別構建、分別安裝。**安裝中文包就是中文，安裝英文包就是英文，應用設定中沒有語言切換選項。** 三種包更新同一組應用，不是重複安裝兩套應用。

## 功能與漢化範圍

包含 M 車輛儀表、換擋轉速、虛擬馬力機、制動測試、彈射模式、G 值儀表、暖機助手、eDrive助手、故障檢測、保養資訊和 Doom 共 11 個應用。

“彈射模式”對應原 Drag Timer，用於記錄起步、加速分段和成績。

中文包包含選單、按鈕、設定、儀表標題及內建提示的簡體或繁體中文譯文，並附帶繪製這些文字所需的開源中文字形。中文畫面右上角使用 12 px、約 25% 不透明度的小字署名：

**抖音：小白科技杂物社 · BiliBili：小白151 · GitHub：JackieZ123430**

英文包保留英文顯示，不顯示中文角落署名。原始版權及漢化貢獻署名保留在文件、設定頁和原始碼中。

- Doom 啟動選單和設定已漢化，遊戲內部貼圖和關卡文字保留原文。
- 故障狀態、診斷拒絕原因和已補錄的常見故障說明顯示中文；尚未收錄的原廠資料庫說明保留原文。故障碼、控制單元縮寫和診斷指令保持原樣。
- 自繪中文字型檔覆蓋本版內建譯文；車輛返回的任意中文長文字可能需要額外字形。原生 HMI 字串使用車機自己的字型。
- 臺架缺少對應控制單元時，可在應用設定中啟用演示資料。
- 單個 HMI 字串資源包按實機驗證的 1024 條預算檢查，本版預留 256 條動態資源，避免資源申請失敗導致 Loading app。

## 顯示預覽

以下為離線演示資料預覽，實際車機控制元件的字距、焦點和位置仍需實機驗證。

英文包：

![英文介面](docs/screens/bilingual-english-preview.png)

中文包：

![中文介面](docs/screens/chinese-warmup-preview.png)

故障頁面中文示例（離線演示資料）：

![故障狀態與說明中文示例](docs/screens/chinese-fault-preview.png)

## 構建英文、簡體中文和繁體中文安裝包

需要 Python 3、Node.js 14 以上，以及從自己車機提取的 BMW oap-sdk。已提交預生成字型檔和 GPU 渲染器，正常構建無需字型工具或 Docker。

原廠 SDK 不隨公開倉庫分發，也不要將含 SDK 的安裝包公開上傳。

1. 從自己的原廠 OAP 應用中獲取 `source/javascript/app.js`，儲存為 `own-app.js`。各車機應用 UID 不同，也可從 `/usr/lib/oap-mainapp/preinstalled_apps/` 下原廠應用 tgz 中解出這個檔案。詳細路徑和說明見英文 README。

   ```powershell
   node kit/tools/extract_sdk.js own-app.js oap-sdk
   ```

2. 構建英文包（預設）：

   ```powershell
   python kit/tools/make_kit.py --language en
   ```

   輸出：`dist/mgu-custom-apps.tar.gz`。

3. 構建中文包：

   ```powershell
   python kit/tools/make_kit.py --language zh-CN
   ```

   輸出：`dist/mgu-custom-apps-zh-CN.tar.gz`。

   只構建一個應用可在命令末尾加應用 ID，例如 `python kit/tools/make_kit.py --language zh-CN warmup`。

英文構建輸出 `dist/mgu-custom-apps.tar.gz`（與原有指令碼相容），中文構建輸出 `dist/mgu-custom-apps-zh-CN.tar.gz`。兩個語言安裝包分別儲存在不同檔案中，可以先後構建，不會互相覆蓋。

### 繁體中文包

```powershell
python kit/tools/make_kit.py --language zh-TW
```

輸出 `dist/mgu-custom-apps-zh-TW.tar.gz`，使用獨立的繁體中文詞庫和 Noto Sans TC 字型檔。安裝繁體包時，將 `-Kit` 後的檔案替換為該路徑。英文預設行為保持不變。

## Windows 安裝

適用於已具有 root SSH 的 iDrive 7 MGU。本專案部署應用，不刷寫 MGU 韌體。上游測試韌體為 `P18_23w44.2`；本臺架的 `P18_23w44.2-1-3` 已驗證安裝及保養應用啟動，其他功能和版本需按實際裝置測試。

指定要安裝的語言包、自己的 SSH 私鑰和車機 IP，先執行檢查：

```powershell
powershell -ExecutionPolicy Bypass -File deploy/push-to-car.ps1 check -Kit dist/mgu-custom-apps-zh-CN.tar.gz -Key "C:\你的目錄\id_rsa" -Ip "車機IP"
```

檢查透過後安裝：

```powershell
powershell -ExecutionPolicy Bypass -File deploy/push-to-car.ps1 install -Kit dist/mgu-custom-apps-zh-CN.tar.gz -Key "C:\你的目錄\id_rsa" -Ip "車機IP"
```

要安裝英文版，將 `-Kit` 後的檔案換成 `dist/mgu-custom-apps.tar.gz`。安裝器會備份配置並重啟應用平臺，首次設定 Doom 控制器外掛可能重啟車機。恢復使用同一指令碼的 `restore` 命令；更多細節見 [英文原文件](README.md)。

## 主畫面小工具的中文

`eDrive` 的中文名稱統一為 **eDrive助手**。小元件選擇列表、原生文字格及自繪圖片使用所安裝包的語言。
小元件擁有獨立字串包，預留 64 個 `SID_WIDGET_DYNAMIC_*` 槽位；主應用繼續使用自己的 256 個槽位。多個小元件例項的文字互相隔離，刪除後可複用槽位。

小元件的布林值、數值、佈局模板名、圖片和診斷識別符號不參與翻譯。小元件圖片使用同一個語言包的中文字型檔；原生文字使用車機 HMI 字型。

離線測試驗證了資源生成、例項隔離、槽位預算、更新順序和生命週期，**不能代替車機上的大小布局、裁切和字型驗證**。實機測試方法見 [小元件中文測試](docs/widget-chinese-test.md)。

## 新增其他語言

不需要複製一套應用程式碼或新增車機語言選單。每種語言是構建時選擇的譯文檔案：

1. 在 `kit/runtime/locales/` 新增 UTF-8 JSON，例如 `fr.json`：

   ```json
   {
     "Settings": "Paramètres",
     "Next page": "Page suivante",
     "Oil": "Huile"
   }
   ```

2. 構建工具會自動發現新檔案：`python kit/tools/make_kit.py --language fr`，生成 `dist/mgu-custom-apps-fr.tar.gz`。沒有譯文的文字保留英文。
3. 檢查該語言所需字形。含現有字型檔未覆蓋的字元時需補充字型檔；右向左文字等還需相應排版支援，不能只放入譯文就假定顯示正確。
4. 驗證原生選單、儀表排版、動態提示和資源總量。訊號名、設定內部取值、故障碼及協議欄位保持原樣。

簡體和繁體譯文分別維護在 `kit/runtime/locales/zh-CN.tsv` 和 `zh-TW.tsv`：

```powershell
python kit/tools/sync_zh.py --language zh-CN
python kit/tools/sync_zh.py --language zh-TW
python kit/tools/bake_cjk.py --language zh-CN
python kit/tools/bake_cjk.py --language zh-TW
```

字型重建需要 Pillow；正常構建直接使用已提交的字型檔，無需 OpenCC 或字型生成工具。繁體使用臺灣用語，不等同於粵語翻譯。每個安裝包僅攜帶一份選定的 CJK 字型檔，保留對應 OFL 許可。

## 檢查與預覽

```powershell
python kit/tools/test_zh.py
node kit/tools/test_zh.js
node kit/tools/test_widget_text.js
node kit/tools/test_zh.js dist/warmup/source/javascript/kit
node kit/tools/preview.js dist/warmup preview
```

第三條檢查當前已構建應用的固定語言和字形；第四條預覽當前語言的應用。安裝包包含的語言由構建引數決定，不讀取舊版的語言設定。
