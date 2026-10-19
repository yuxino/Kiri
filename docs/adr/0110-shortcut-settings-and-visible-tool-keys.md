# ADR 0110: Shortcut settings and visible tool keys

- Status: Accepted
- Date: 2026-10-19
- Extends: ADR 0046

## Context

Issue #156 asks for shortcuts to show the main window, capture, record, and
recognize text. A single capture binding buried in General does not explain
the available actions. Annotation tools also need visible key hints and a
consistent, readable property panel. Shortcut editing must keep a stable list
layout; measured bounds and passing interaction cases alone do not establish
clear visual hierarchy or acceptable visual design.

## Decision

Settings has General, Shortcuts, Text Recognition, and About pages. Shortcuts
contains four independently editable Launch actions and two While recording
actions, followed by grouped, read-only in-app key references. Every reference
group and its key list are visible by default, without an expand/collapse step.
Launch actions remain registered while Kiri runs. On macOS, Windows, and X11, the two recording
actions are registered only once recording starts, remain available while paused
and during pause/resume transitions, and are released when stopping enters
finalization or recording fails. Region selection and countdown do not reserve
their keys. Inactive recording bindings remain configurable in Settings.
The settings navigation stays visible while the panel scrolls. Global actions
form one vertical list at every width, with Launch actions followed by While
recording under their respective headings. The page title and list share their
reading width; available space adjusts the row's label and shortcut field without
splitting the scopes into parallel columns.

Each row has one editable shortcut field. Clear removes the key binding; it does
not turn off the action itself, so it is not presented as a feature switch.
Customized or unbound rows expose Restore Default directly. There is no ellipsis
menu or expanded editing card.

Editing retains the current key combination and a visible caret inside the same
field, with Escape-to-cancel guidance beside it. The shared instruction above the
list changes in place for editing without changing row positions or scroll
position. Entering, cancelling, or switching the edited field must not make the
page jump. Only actual errors appear below the affected row; routine editing
instructions do not add a row-level feedback block. Shared scope guidance replaces
repetitive action descriptions, with priority details available from a nearby
focusable help control.

Keep Shift+Command+A on macOS and Shift+Control+A on Windows/X11 for capture.
New Record, OCR, and main-window defaults add Alt/Option and use R, O, and L.
Pause/Resume Recording uses Shift+Alt/Option+primary+P; Stop and Save Recording
uses Shift+Alt/Option+primary+S. This avoids the common browser Shift+primary+R
command and reserves recording controls only when needed. Native registration
still cannot detect every foreground application's local shortcuts. A recording
binding conflict reports a visible error without aborting recording; control
buttons, tray actions, and commands remain available.

Record and OCR carry their initial mode in the capture session, so overlay
startup cannot lose the requested mode. They retain region selection, countdown,
and explicit remote-OCR consent. The main-window action preserves the current
page, matching tray activation.

The recording control panel appears without taking keyboard focus. It has no
window-level bare Space or Escape listener. Deliberately focused native buttons
retain standard Space/Enter activation. Escape continues to cancel capture and
the countdown; it does not stop an ongoing recording. Recording stop always
finalizes and saves the result.

Persist all action bindings in one versioned, atomically replaced file. Preserve
the legacy capture choice and give it priority over new defaults. Each action
can be disabled, reset, or retried. Reject internal duplicates before registering;
register a replacement before releasing the old combination and roll back on
failure. One occupied startup binding does not prevent registering the others.

While a focused shortcut field records, all registered action keys report their
combination instead of executing. Native focus loss and window dismissal clear
recording independently of React. Held native keys remain suppressed until
release, including after a settings mutation. Native callbacks never acquire
the settings mutex or re-enter the shortcut registration manager.

Wayland retains desktop ownership and the existing optional Portal scope.
Command fallbacks cover `--capture`, `--record`, `--ocr`, `--library`,
`--toggle-recording-pause`, and `--stop-recording`. Recording commands affect only
an ongoing recording. The desktop may keep command or Portal keys reserved while
Kiri is idle; native recording-scope release guarantees do not apply to Wayland.
Kiri never writes desktop bindings or claims command-based keys are registered.

Annotation tools keep their implemented single-letter keys at the lower right
of their icons. Action combinations such as Undo, Redo, and Escape appear with
the full action name on hover/focus instead of creating a second row beneath
every button. Completion and save show a checkmark with the Return symbol,
without a visible text label; hover/focus exposes the full action description.
Selected tools use a restrained medium-gray surface; only completion uses a
light surface.
Shared annotation properties use aligned controls, distinct color choices, and
quieter secondary actions. Shared surfaces drop the warm tint in favor of pure
white content areas and neutral light-gray navigation and controls; dark-mode
text colors also use neutral equal-RGB grays. Annotation colors, live editing, undo
gestures, and IME behavior remain the source of truth.

Keep capture controls compact: small tool-key hints are secondary to the icons,
and recording setup places format, start, and cancel in one row above labeled
switches. Reducing visual size must preserve usable pointer targets and visible
state. Review at actual display scale, including Chinese text and long localized
labels; an enlarged screenshot alone is not a density check.

Automatically anchor the main annotation toolbar using only its own dimensions.
Opening or switching tool properties must not flip that toolbar to the other
side of the selection. The main toolbar has a small accessible drag handle;
the property panel integrates its own handle and Hide tool options button into
its existing heading, without adding a title row. A focused handle supports
2-pixel arrow-key adjustments, or 10 pixels with Shift.

The two manual positions are independent and last for the current capture.
Selection geometry, selected annotations, tools, and property changes do not
reset a manual main-toolbar position; a new capture restores automatic placement.
The main toolbar stays within screen bounds and avoids the mode selector.
Property placement stays reachable, avoids the toolbar and mode selector, and
makes room if the main toolbar is dragged over it. Automatic property placement
also avoids the selected or edited annotation. The panel scrolls when space is
constrained. Selection changes move the main toolbar only while it remains in
automatic placement.

Hiding properties persists through annotation and property changes until the
main toolbar's Tool options button reopens the panel.
Property-panel placement stays fixed during pointer adjustments and numeric-field
editing, then resumes automatic avoidance when the interaction ends.
Escape leaves a property field's edit or ends the current toolbar/panel drag
without cancelling the screenshot.

## Verification

Render the actual SettingsView with its real styles and dictionaries for browser
regression. Check measured geometry and overflow across narrow/default/wide
content widths, all seven languages, long key combinations, and editing/error
states. Compare row positions and scroll offset before, during, and after editing;
entering edit mode must not shift the list. Screenshots alone do not establish
these constraints, and geometry or interaction passes do not establish aesthetic
acceptance. Review actual-scale hierarchy, density, alignment, and clarity of the
editable field and its actions separately. Changes to the interaction require
fresh evidence for that revision. The renderer matrix and native entry points are
listed in the
[shortcut settings QA guide](../qa/shortcut-settings.md).

Use injected native-registration transactions for failure and migration tests;
exercise recorder lifetime and keyboard behavior in frontend tests. Cover recording
binding registration and release across start, pause/resume, stop, and failure;
confirm idle keys stay available to other apps and an unavailable binding does not
abort recording. Inspect the packaged app for actual native dispatch, settings
persistence, overlay modes, recording-panel focus, and visible toolbar/property
layouts. Browser runs verify rendered geometry and DOM interaction; simulated
platform labels, user agents, and CSS zoom do not establish native DPI, focus,
or global-hotkey registration/dispatch. Windows and Linux native acceptance
remain separate from macOS results, and configured CI is not a passing result.
