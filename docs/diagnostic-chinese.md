# Simplified Chinese diagnostic descriptions

The `zh-CN` Fault Scanner build adds an independent lookup catalog for the fault
texts in the bundled `apps/dtc_scanner/dtc_db.pack`. It does not change that database,
diagnostic requests, clear behavior, app IDs, app.json files or startup handling.
The English build keeps its package name and contains no diagnostic translation
pack or expanded atlas. Other Chinese apps keep the original UI atlas.

## Coverage and review status

- Bundled database SHA-256: `206da522f83c48539eb9ac0ee02d7c859a7080b0b1c50cf76df05451a3930c55`.
- 86,735 unique database texts: 86,716 have Chinese prose; 19 contain only internal
  identifiers and are retained verbatim. This is coverage of this database version,
  not a claim to cover every BMW fault or every imported database.
- Previously shipped complete-sentence translations and manually corrected scan
  descriptions take precedence over the generated catalog.
- Machine-assisted translation uses the committed diagnostic glossaries,
  contextual disambiguation, offline M2M100 translation of remaining prose spans,
  and manual overrides. Model provenance is in
  `kit/localization/diagnostic-full-manifest.json`; model weights are not shipped
  and normal builds do not need a model, network access or extra Python packages.
- The entire catalog has **not** received individual human review. Structural
  checks and representative review do not establish semantic accuracy. The
  translations may still contain terminology errors or awkward wording.
- Unknown descriptions fall back to their complete original text. Missing source
  descriptions stay missing; no explanation is invented from a fault code alone.
  Internal control-unit abbreviations, numeric literals and hex message IDs are
  preserved. Generic UI word substitutions are bypassed for diagnostic prose,
  including width measurement and truncation in both software and GPU rendering.

## Build and reproduce checks

With the SDK extracted from your own unit as described in README.md:

```sh
python kit/tools/build_diagnostic_zh.py --report work/diagnostic-report
python kit/tools/build.py --language zh-CN dtc_scanner
node kit/tools/test_diagnostic_zh.js
node kit/tools/test_zh.js dist/dtc_scanner/source/javascript/kit
python kit/tools/build.py --language en dtc_scanner
node kit/tools/test_diagnostic_zh.js
node kit/tools/test_zh.js dist/dtc_scanner/source/javascript/kit
python kit/tools/test_zh.py
```

The coverage audit extracts the committed pack and checks every text, normalized
display aliases, numeric literals and hex IDs, writing a reviewable UTF-8 CSV and
coverage JSON. The runtime check exercises catalog lookups, unknown fallback,
known terminology regressions, literal rendering and glyph coverage. English
checks assert that every source description remains unchanged and no translation
pack is shipped. These are offline checks, not a new physical vehicle test.

The earlier 2.6.3-zh.cn.7 prototype was installed on a P18_23w44.2-1-3 bench; a
saved scan and the catalog were checked there. This rebased version and the new
upstream renderer have not been installed or visually verified on that bench.

To correct wording, edit `kit/localization/diagnostic-overrides.zh-CN.json`, rerun
the audit and rebuild. It overrides both generated and older UI translations.
For additional glyphs, install Pillow and regenerate the dedicated atlas:

```sh
python kit/tools/bake_cjk.py --diagnostic /path/to/NotoSansSC.ttf
```

Without `--diagnostic`, `bake_cjk.py` retains its original job of regenerating the
ordinary UI atlas. The diagnostic atlas is checked against the reserved GPU
budget and is copied only into the Simplified Chinese Fault Scanner package.

## Credits

Translation by: 抖音 小白科技杂物社 / BiliBili 小白151 /
GitHub [JackieZ123430](https://github.com/JackieZ123430).
The translation credit ships in Chinese (zh-CN) builds only: the settings rows, the
header corner and the entry file's comment, all from `kit/localization/credit.zh-CN.json`.
English builds carry no translation credit.
The Noto Sans SC atlas retains the repository's existing OFL notice and license.
