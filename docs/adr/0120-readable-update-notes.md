# ADR 0120: Readable update notes

- Status: Accepted
- Date: 2026-10-24
- Extends: ADRs 0025, 0099 and 0110

## Context

About displayed bilingual release Markdown as raw text in a small, separately
scrolling gray box. The install action aligned with the entire notes block,
and a downloaded update did not clearly show its target version.

## Decision

Keep the current and target versions, update status and primary action together
at the top of one neutral card. Place support tools below that card. Release
notes use the card's reading width and the settings panel's existing scroll
area instead of a nested fixed-height viewport.

Settings stays in the sidebar footer with the same row height as the other
destinations. Keep New update as quieter trailing text on that single row,
without an extra box or subtitle, and retain the accessible update label.

Render a limited Markdown subset as React text elements: headings, paragraphs,
lists, strong text and code. HTML remains literal text. Links and image syntax
retain their label with an inert destination tooltip; they never navigate,
execute code or load media. The inert-content boundary of ADR 0025 remains.

When notes include explicit English and Chinese headings, Chinese UI languages
initially show the Chinese section; other UI languages prefer English, then the
first available section. Visible language buttons allow switching. Shared
introductions and same-or-higher-level nonlanguage sections remain visible.
Unsectioned notes stay readable without language controls. The preference is
re-evaluated when the UI language or release notes change.

Download, signature verification, installation, restart, error recovery, and
manual Linux/Windows portable updates keep their existing actions and state.
No updater endpoint, package, dependency or native integration changes.

## Verification

Exercise parser and component language selection, shared content, inert markup,
and existing updater action regressions. Review real settings styles in the
isolated browser harness at narrow, default and wide widths, including long
translations and all update states. Browser previews do not establish native
installer, signing or cross-platform desktop acceptance.
