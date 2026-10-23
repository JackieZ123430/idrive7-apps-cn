# MGU / ID7 RHMI widget vocabulary (design reference)

What an OAP app can put on the head unit screen, and how it addresses it. This is
the **RHMI** (Remote HMI) model: an app ships a UI *description* (`application.xml`
+ `uiDescription.json` in `rhmiData/`) and then drives it at runtime by pushing
*data-model* and *property* updates over joynr to the car's HMI, which does the
actual drawing with BMW's skin.

> Sources (all on this unit / in our SDK dump, not invented):
> - `/usr/lib/oap-mainapp/rhmiData/uiDescriptions/ID7/{application.xml,uiDescription.json}` — BMW's own app, the only **verified** widget-template usage we have.
> - `oap-sdk/.../rhmi/RhmiApplication.js` — the component-type table + the update wire format.
> - `oap-sdk/.../RhmiConstants.js` — every numeric id/enum below (PropertyIds, ParameterMapKeys, ParameterMapValueTypes, notification enums).
> - `oap-sdk/.../components/*.js` + `rhmiBehaviorMixin.js` — which cells/rows/properties each component exposes.

---

## 1. The two layers

**(a) Static layout** — `rhmiData/uiDescriptions/<HMI>/application.xml`. Declares a
tree of *containers* → *layoutGroups* → *components*, each with an id, a `type`, and
a HMI `widget` template name. `uiDescription.json` carries the same ids with names,
default text (StringIds) and default properties. Component ids are app-local; state
ids are global (registered via `rhmiData/application.json` entry points).

```xml
<container id="1" type="state" widget="LT_State_List" stateId="20992">
  <property id="4" value="2"/>
  <layoutGroup id="78" name="Titlebar">
    <component id="1" type="title"/>
  </layoutGroup>
  <layoutGroup id="77" name="List">
    <component id="10" type="label"  widget="LT_Label_1Row_CallScreen_Headline" focusId="29852"/>
    <component id="90" type="button" widget="LT_Button_1Row_1IconLeft"          focusId="29864"/>
  </layoutGroup>
</container>
```

**(b) Runtime data** — the app calls `component.setValue(row, cell, value, valueType)`
(and `setProperty`, `setRowCount`). The SDK packs these into joynr update packages
(`DataModelUpdate` / `PropertyUpdate` / `PropertyModelUpdate` / `DefaultValueUpdate`).
A component is a **grid of rows × named cells**; you address one cell at a time.

---

## 2. Component types

The HMI type string for each component (from `RhmiApplication.js`'s dispatch table —
these are all the app side can instantiate):

| type | what it is | cells / notes |
|---|---|---|
| `state` | a full screen you open/close (top-level container) | has child components; `stateFocus`/`stateVisible` events |
| `overlay` | transient overlay on top of a state | e.g. loading overlay |
| `popUp` | modal pop-up (title + body + buttons) | priority/flags/timeout properties |
| `icPopUp` / `hudPopUp` / `hudMidPopUp` | instrument-cluster / head-up pop-ups | same shape as popUp |
| `player` | media player surface | — |
| `preview` / `previewMap` | tile preview (incl. map preview) | shown on the app tile |
| `title` | screen title text | cell `Text`; rows |
| `label` | static/dynamic text line(s) | cell `Text`; multiple rows |
| `button` | clickable | cell `Text`; `action` event |
| `checkBox` / `radioButton` | toggles | cell `Text` + `selected`; `action` |
| `image` | graphic | cell `graphic` (Asset); rows |
| `valueList` | multi-row list with per-row cells | `action`/`focus`; **the real "table"** |
| `slider` / `progressBar` | bar widgets | `action`/`focus` |
| `dropDownMenu` | spinner/drop-down | — |
| `timeRoll` / `dateRoll` / `editRoll` | roll pickers | — |
| `separator` | divider line | no data cells |
| `bookmark` | bookmark anchor | — |
| `startWidget` | home-screen widget surface | — |
| `toolBar` + `toolBarButton` / `toolBarCheckBox` | toolbar + items | — |
| `selectionBar` + `selectionBarButton` / `selectionBarCheckBox` | selection bar + items | — |

## 3. Container types (the `type` on `<container>`)

`logical` (non-visual root), `state`, `overlay`, `popUp`, and the pop-up variants
`icPopUp` / `hudPopUp` / `hudMidPopUp`, plus `player`, `preview`, `previewMap`,
`toolBar`, `selectionBar`. A `state` is what an entry point opens.

---

## 4. Properties (`<property id=.. value=..>` and `setProperty`)

`PropertyIds` enum — the `id` used in `application.xml` and in runtime property updates:

| id | name | id | name |
|---:|---|---:|---|
| 1 | Enabled | 12 | PopupFlags |
| 2 | Visible | 13 | Timeout |
| 3 | Focusable | 14 | ResultList |
| 4 | Preview | 15 | FocusWraparound |
| 5 | Bookmark | 16 | OptionComponents |
| 6 | Speedlockable | 17 | QuickListComponent |
| 7 | UUID | 18 | DefaultFocusComponent |
| 8 | ShowWaitingAnimation | 19 | AutoScrollFocus |
| 9 | ParentState | 20 | icPriority |
| 10 | ChildState | 21 | Decorator |
| 11 | PopupPriority | 255 | Invalid |

`Focusable` values seen in practice: `0` = not focusable (static label), `1` =
focusable, `3` = focusable + clickable (buttons). `Speedlockable` = may be blocked
while driving.

Focus events: the HMI sends a component's `focus` event (`{ value: true }` when the iDrive
controller lands on it, `{ value: false }` when it leaves, plus `{ row }` events) only for
`Focusable=3`. With `1` or `2` the controller still moves over the buttons, but the app hears
nothing. The kit builds its bar buttons with `3`, so its own slim bar can light the focused one.

---

## 5. The data-model update (`setValue` and friends)

`component.setValue(row, cell, value, valueType)` is the core call. Under it:

**ParameterMapKeys** (map keys in each update entry): `Value=0`, `ValueType=1`,
`Row=2`, `Cell=3`, `RowCount=4`, `AssetCell=5`.

**ParameterMapValueTypes** (what kind of value a cell holds):

| id | type | id | type |
|---:|---|---:|---|
| 0 | Text (UTF-8 string) | 8 | Alignment |
| 1 | Asset (image id) | 9 | CuttingStyle (truncation) |
| 2 | UInt | 10 | Color (string or packed uint) |
| 3 | SInt | 11 | TextFormat |
| 4 | Float | 12 | FontStyle |
| 5 | Bool | 13 | Clear |
| 6 | Enum | 14 | Reset |
| 7 | TextAlignment | 255 | Invalid |

So a single cell can carry not just text but its **alignment, colour, font style and
format** — e.g. you can right-align or recolour a value cell by writing that cell with
`TextAlignment` / `Color` / `FontStyle` value types.

**Convenience methods** the components mix in (`rhmiBehaviorMixin.js`):
- `label` / `button` / `title` / `checkBox`: `setText(text,row=0)` → `setValue(row,'Text',text,'Text')`
- `image`: `setGraphic(...)` → cell `graphic` (Asset)
- all visual: `setVisible(bool)`, `setEnabled(bool)`, `setFocusable(bool)`, and per-row `setRow<Prop>(row,bool)`
- lists: `setRowCount(n)`, then `setValue(row, cell, …)` per row/cell
- read-back: `getValue(row,cell)`, `getProperty(name)`

**Events coming back** (`NotificationParameterMapActionSubTypes`): `Click=0`,
`Increase=4`, `Decrease=5`, `ToggleEdit=6`, `SetValue=7`, `CurrentValue=8`,
`Confirm=9`, `Abort=10`. Lists can also ask the app for data lazily
(`DATA_REQUEST`, keys `RequestStart=6`/`RequestSize=7`) — that's how big scrolling
lists page their rows.

---

## 6. Widget template names

The `widget="…"` attribute names a **template in BMW's HMI skin**. The skin is **not
in this firmware image** (grep of the whole guest finds these names only in our own
apps) — so the authoritative template catalog has to come from an HMI resource dump.
What we do have:

### Verified (BMW's own MainApp `application.xml`)
| widget | used on | shape implied by the name |
|---|---|---|
| `LT_State_Overlay` | overlay container | overlay state |
| `LT_State_Wide` | pop-up container | wide pop-up state |
| `LT_Table_Overlay_4Row_1TextDyn` | label in an overlay | table, **4 rows**, **1 dynamic text cell** per row |
| `LT_ScrollLabel_CCM_Details` | label | scrollable long-text label |
| `LT_Button_3Row_1TextDyn` | button | **3 rows**, 1 dynamic text cell |

**Naming convention** (readable from the above): `LT_<Kind>[_<context>]_<N>Row_<M>TextDyn`
— `<N>Row` = how many rows the template lays out, `<M>TextDyn` = how many dynamic
text cells each row has. A `…_2TextDyn` template is therefore the real way to get a
genuine **left + right (key/value) two-column row**; set cell 0 and cell 1 on the same
row. (We can't confirm the exact cell names of a 2-cell template without the skin, so
anything beyond `Text` should be validated on the car before shipping.)

### Used by our custom apps — chosen by us, NOT yet verified against the skin
`LT_State_List`, `LT_Label_1Row_CallScreen_Headline`, `LT_Button_1Row_1IconLeft`.
They render in our bring-up, but a different skin/variant may name them differently;
treat them as "known-to-work-here", not canonical.

---

## 7. Minimal recipe

1. **Declare** a `state` container (global `stateId`) with a `Titlebar` group (a
   `title`) and a `List` group of `label`/`button` components; give each a `focusId`.
2. Register the state as an **entry point** in `rhmiData/application.json`
   (`textId`, `icon`, `insertionStateId`, `private:false` to show a tile).
3. At runtime: `rhmi.setText(id, "…")` for text, `rhmi.onAction(id, cb)` for buttons,
   `setVisible/setEnabled` for state, `setRowCount`+`setValue(row,cell,…)` for lists.
4. For a two-column row, prefer a `…_2TextDyn` label/table template and write both
   cells; absent a verified template, format one `Text` cell as two space-separated
   columns (alignment is then at the mercy of the skin's proportional font).

_Everything here is from the unit's own files and the OAP SDK; widget-template names
are BMW's. See `someip-access-map.txt` for the data side (signals/DTCs)._
