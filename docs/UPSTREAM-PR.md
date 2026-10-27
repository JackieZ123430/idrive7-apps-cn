# Proposed upstream contribution: build-time language packs

The English README remains the upstream original, with only English / 中文 navigation added. English app metadata is canonical.

## Behavior

Build one installation package per language. There is no runtime language selector or language migration. An English package displays English; a Chinese package displays Simplified Chinese. Both retain the same app IDs and update the same applications.

- `python kit/tools/make_kit.py --language en`
- `python kit/tools/make_kit.py --language zh-CN`

The generated archives are named `mgu-custom-apps-en.tar.gz` and `mgu-custom-apps-zh-CN.tar.gz`. The default English build also keeps the original `mgu-custom-apps.tar.gz` filename for existing deployment scripts.

## Extension

Additional UTF-8 `kit/runtime/locales/<language>.json` catalogs are automatically discovered by the build tools. Static menu resources and the embedded runtime catalog use the selected language only. New scripts/characters require suitable licensed fonts and layout validation. No business-logic fork or extra native UI controls are needed.

## Native resource limit

The P18_23w44.2-1-3 bench accepts 1024 string resources and rejects a 1052-entry bundle. Reserve 256 dynamic resources and reject builds whose total exceeds 1024. Log SDK initialization errors and exit failed startup instead of leaving a live heartbeat behind the loading screen.

## Attribution

Chinese contribution: 抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430. The Chinese package retains a small, subtle corner credit; the English package does not show that corner credit. The upstream maintainer can review the attribution presentation separately from the catalog/build changes.

## Validation

- Python checks all 22 English/Chinese layouts, unchanged protocol/configuration data, valid StringIds, resource budgets, absent language selectors and automatic discovery of additional locale files.
- JavaScript checks fixed-language display behavior, generic catalogs, native Unicode handling, font coverage and corner-credit visibility.
- Both language kits are built and previewed independently.

The bench installation and Service startup are verified after the resource-limit correction; further functions and physical HMI layout still require testing. Extracted BMW SDK code and generated installation packages are excluded from the public repository.

## Translation coverage

Common DTC states, diagnostic rejection labels, demo faults and a curated set of diagnostic descriptions are translated. Full sentences are localized before truncation, and font atlas IDs include the atlas content revision so updates cannot reuse an outdated GPU glyph texture. The complete OEM fault database is not translated; unknown descriptions retain English. This should be presented as partial diagnostic-text coverage in a draft PR.
