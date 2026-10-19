# ADR 0111: Supported shortcut keys and explicit confirmation

- Status: Accepted
- Date: 2026-10-20
- Supersedes: ADR 0046 key restrictions and ADR 0110 recorder presentation

## Context

The letter/digit and modifier requirement excludes useful function, navigation,
media, and keypad keys. Allowing typing keys globally also changes their behavior
in other applications, so the choice needs an explicit confirmation rather than
another hidden key whitelist.

## Decision

Pass the physical `KeyboardEvent.code` and actual modifiers to the native shortcut
parser. Do not limit the frontend to letters and digits. The native library decides
which key codes it supports; operating-system registration decides availability.
Keep canonical key codes for persistence and readable labels for presentation,
including a distinct Num prefix for keypad keys.

Support remains platform-specific. Windows `RegisterHotKey` cannot distinguish
keypad Enter from ordinary Enter and has no separate media-pause key mapping;
reject those two candidates instead of registering Enter or Pause/Break under a
different label. Ordinary Enter, Pause/Break, and media Play/Pause remain supported.

Ignore modifier-only events, IME composition, and repeats. Bare Escape cancels;
Tab and Shift+Tab retain focus navigation and cancel ordinary recording. With a
pending candidate, Tab can reach its confirmation button. Escape or Tab with
Control, Alt, or Meta remains a recordable combination.

F1–F24, media keys, and combinations containing Control, Alt, or Meta save
immediately. Other bare keys and Shift-only combinations remain a candidate for
that action until Use this key is activated. Explain that the key will affect
other applications; for recording-scoped actions, limit that explanation to
while recording. Until confirmation succeeds, the saved binding stays unchanged.
Browser input and native `shortcut-recorded` events use the same candidate policy.

The active recording field shows Press shortcut… rather than retaining the old
key under an imitation text caret. A pending candidate shows its key and belongs
only to that row, alongside its confirmation and cancellation controls. Ordinary
entry does not shift the list; routine instructions remain shared above it.
Cancelling, leaving the page, or losing window focus discards the candidate without
changing the binding. Unsupported keys, internal duplicates, and failed native
registration or persistence preserve the prior binding and report an error.

On macOS, ordinary keys continue to use native registration without Input
Monitoring permission. Playback media keys use an intercepting event tap and require
existing Accessibility authorization; volume keys use ordinary registration.
Without the required authorization, registration reports an error
and preserves the old binding; it does not prompt for authorization or change
permissions. The ordinary-key permission contract must not be generalized to
media keys.

Default bindings, recording-only registration scope, and Wayland desktop
ownership remain as in ADR 0046, ADR 0075, and ADR 0110.

## Verification

Cover physical key identity, direct-save and pending-confirmation paths, native
and browser event parity, ignored IME/repeat/modifier events, Escape/Tab behavior,
row ownership, and cancellation without mutation. Check failure preservation and
keypad/number-row distinction. Browser rendering and unit checks do not establish
native registration or cross-platform acceptance; record Windows, Linux, and
packaged macOS results separately when those checks have actually run.
