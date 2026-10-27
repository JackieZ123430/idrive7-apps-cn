# Proposed upstream contribution: optional Simplified Chinese

This document is a proposed PR description. No upstream pull request has been opened.

## Result

Apps and the main README default to English. Each app has a persisted **Language / 语言** setting for English and Simplified Chinese. The Chinese README is reachable from the language links at the top of either document.

## Implementation

- Keep canonical app metadata, IDs, settings values, signal interfaces and diagnostic requests in English/original form.
- Translate display strings at the software/GPU rendering and native HMI boundaries.
- Use stable StringIds and the SDK's Unicode StringBundle API for static menus and dynamic text. Switching languages updates both existing static resources and remembered dynamic rows.
- Preserve the language selection in each app's existing settings file. Gauge layer caches include the selected language, preventing stale labels after switching.
- Reuse a shared subsetted Noto Sans SC atlas within the prebuilt renderer's existing texture budget; no renderer binary or firmware changes are needed.
- English is the default even when the vehicle UI uses another language; users explicitly choose Chinese in each app.

## Attribution for discussion

Chinese contribution: **小白科技杂物社 / Bilibili 小白151 / GitHub JackieZ123430**.

The fork retains attribution in the README, NOTICE, source comments and settings. Its subtle corner attribution appears only in Chinese mode. Whether this corner text belongs upstream should be agreed with the maintainer; it is implemented in a separate `credits.js` module for easy adjustment.

## Resource limit

On the P18_23w44.2-1-3 bench, native `createStringBundle` accepts 1024 entries and rejects a 1052-entry bundle with `INVALID_VALUE`. Reserve 256 dynamic entries and fail the build if the total exceeds 1024. Startup SDK errors are retained in the app log; rejected startup exits rather than keeping the loading screen alive.

## Validation

- `node kit/tools/test_zh.js`: English defaults, persistence, two-way and rapid language changes, existing dynamic rows, English/Chinese credit visibility, glyph coverage, renderer measurements and texture budget.
- `python kit/tools/test_zh.py`: all 11 layouts, English/Chinese resource-key parity, valid StringId references and a default English selector.
- Build all 11 apps; preview English → Chinese → English without restarting the app.

Installed on a P18_23w44.2-1-3 bench; the Service app is confirmed to open after the string-resource fix. The remaining app functions, Chinese switching and physical HMI layout still require testing. Doom's in-game assets and the original fault-code database retain their original language. Extracted BMW SDK code and install packages are excluded from the public repository.
