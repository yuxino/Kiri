# ADR 0079: Seven languages and a shared language preference

Status: Accepted

## Context

Three adjacent language buttons do not scale to seven choices. Every Kiri
window has its own WebView, so changing only the Settings renderer leaves
already open previews, editors, and capture controls in the old language.

## Decision

Support English, Simplified Chinese, Traditional Chinese, Japanese, German,
Korean, and French. Show each language by its own name in a Settings selector.
The OS language applies until the user makes a choice; the existing backend
`language.json` stores supported codes and remains shared across windows.

Saving a choice broadcasts `language-changed` and updates native tray labels.
Renderers subscribe before reading the startup preference, and a new event wins
over a stale read. A failed preference save is visible and does not silently
pretend the choice will survive a restart.

All seven complete dictionaries share the same English key set and ordered
formatting placeholders. Document translations describe the same platform
limits; adding UI languages does not add Linux OCR language packs or imply
additional platform acceptance.

## Verification

Dictionary and formatting tests cover all seven choices. Locale tests cover
regional Chinese locales and OS fallback. Startup tests exercise language
changes during both saved-preference and OS-locale reads.
