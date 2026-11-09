# ADR 0132: Russian as an eighth UI language

Status: Accepted

## Context

ADR 0079 established a Settings selector and a shared `language.json`
preference for seven languages. Russian is the most requested addition, and
the selector, persistence, broadcast, and native tray plumbing already scale
beyond seven choices.

## Decision

Add Russian (`ru`) as an eighth complete dictionary alongside English,
Simplified Chinese, Traditional Chinese, Japanese, German, Korean, and French.
The Settings selector shows it by its own name (Русский). The existing
`language.json` preference, `language-changed` broadcast, startup ordering, and
native tray/Portal labels apply unchanged; `ru` and `ru-*` OS locales resolve to
it.

All eight dictionaries keep the same English key set and ordered formatting
placeholders. Russian joins the native `PNG image` filter label, tray labels,
and Linux Portal shortcut descriptions. Documentation adds a Russian overview,
setup guide, and video-editing guide with the same platform limits as the other
languages.

## Verification

Dictionary and placeholder tests, locale resolution, tray labels, and the
native Portal label parity check cover all eight choices. Docs navigation and
the documentation index list Russian alongside the other languages.
