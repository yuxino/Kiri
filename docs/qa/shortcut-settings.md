# Shortcut settings regression

This is the current verification procedure, not a record of passing acceptance.
Results from an earlier interaction or layout revision do not validate a redesign.
The list layout contract is in [ADR 0110](../adr/0110-shortcut-settings-and-visible-tool-keys.md);
its recorder presentation and accepted-key policy are updated by
[ADR 0111](../adr/0111-supported-shortcut-keys-and-confirmation.md).

## Browser geometry and interaction

Run the real SettingsView, dictionaries, and styles through the isolated
[harness](../../scripts/qa/shortcut-settings-harness.tsx). Only native IPC and the
window shell are substituted; this is not a production application entry point.
With the repository dependencies and Python Playwright 1.55.0 installed, use:

```bash
python scripts/qa/shortcut-settings-ui.py --browser chromium
python scripts/qa/shortcut-settings-ui.py --browser webkit
```

The full matrix covers all seven languages with macOS, Windows, and Linux label/
user-agent fixtures at 700, 1000, and 1280-pixel window widths. Additional German
cases cover default/minimum geometry and 125% CSS zoom; Wayland cases exercise
read-only desktop commands. The script is the source of truth for exact sizes.
`--quick` narrows language coverage and is not a substitute for the full matrix.

Measure content width and element bounds, not just screenshots. Launch actions
and While recording stay in one vertical list at every width, and the page title
aligns with the list. No action label, long four-modifier key combination, field
action, or error may clip, overlap, or force horizontal scrolling. Keep the
rightmost keys clear of overlay scrollbars during actual scrolling;
`scrollbar-gutter` alone does not reserve space for every native scrollbar style.

Compare row positions and panel scroll offset in the normal state, while editing,
after Escape, and when switching the edited field. The active field says Press
shortcut… without an imitation text caret; Escape guidance stays beside it. The
shared instruction above the list changes without moving rows or scrolling the
page. There must be no expanded editing card or ellipsis menu. Pending-key preview,
confirmation, scope warning, and actual errors belong only to the affected row;
routine key-entry guidance remains shared above the list.

Verify F1–F24, media keys, punctuation, navigation, keypad keys, and combinations
containing Control/Alt/Meta using physical key identity. Direct-save choices must
save once; bare and Shift-only candidates must not mutate a binding before Use
this key. Check the global versus recording-only warning, cancel/blur/unmount
preservation, and native-recorded-event parity. Bare Escape cancels; bare/Shift Tab
navigates out or reaches a pending candidate's confirmation, while modified
Escape/Tab can be recorded. IME, repeat, and modifier-only events do not create a
candidate. Unsupported, duplicate, or unavailable choices must preserve the old
binding, and keypad labels must remain distinct from the number row.

Exercise editing/Escape, conflict feedback, custom keys, direct Restore Default,
clear, occupied retry, and tab-switch cancellation. Clear must remove the binding
rather than appear to switch the action itself off; customized or unbound rows
must offer Restore Default directly. All four reference groups and their key
lists must be visible without expansion; scroll to the final row while keeping
the tabs visible.

Separately review the actual-scale visual hierarchy, density, alignment, and
clarity of editing, clearing, and resetting. Passing geometry and interaction
checks does not establish aesthetic acceptance. Record evidence for the exact
revision under review instead of carrying earlier passing results forward.

[Renderer CI](../../.github/workflows/shortcut-layout.yml) configures Windows
Chromium, Ubuntu Chromium, and Ubuntu WebKit jobs. Each uploads
`shortcut-layout-<os>-<browser>` with `results.json`, screenshots, and `server.log`.
`KIRI_SHORTCUT_QA_OUT` selects the output directory; local runs default to
`output/playwright/shortcut-settings`. Record the actual host, browser/version,
fixture platform, viewport, CSS zoom, and run result when reporting evidence.

## Native shortcut checks

- Windows: [shortcut-native.py](../../scripts/qa/shortcut-native.py) runs only in
  its isolated hosted-CI profile. Verify the six settings rows, direct clear/reset
  actions, conflicts, persistence, launch actions, and idle P/S key availability.
  Evidence is `shortcut-native-review/report.json` and its screenshots. Idle key
  availability does not by itself verify active recording control or release.
- Ubuntu X11: [linux-native.sh](../../scripts/qa/linux-native.sh) runs the installed
  package in a disposable desktop. Its native main-window/OCR/Record and P/S
  recording actions retain the media assertions and evidence under
  `linux-native-review/`. See [Linux QA](../linux.md) for setup and limits.
- Wayland: [linux-wayland.py](../../scripts/qa/linux-wayland.py) retains desktop
  command controls. Do not report its results as native X11 hotkey coverage or
  claim that Kiri releases desktop-owned bindings while idle.

Browser user agents, shortcut labels, and CSS zoom simulate presentation; they
do not prove native WebView DPI/text scaling, focus restoration, global-hotkey
registration or dispatch, or physical mixed-scale displays. A macOS browser run
does not establish Windows/Linux native acceptance. Report configured, executed,
and passed checks separately; a workflow definition is not a passing run.
