# ADR 0100: Confirm Empty Trash inside the main window

- Status: Accepted
- Date: 2026-10-13

## Decision

The main-panel Empty Trash button shares the toolbar control height and text
size, with a persistent danger border and background. It opens an HTML modal
dialog in the library WebView. Its backdrop covers only the Kiri content area;
it does not create a desktop-wide confirmation window.

Cancel receives focus. Escape cancels while idle, and Return does not confirm
permanent deletion. The modal keeps focus inside, isolates main-panel shortcuts,
and restores the opener on close. Deletion remains explicit, single-flight and
uses the existing async `empty_trash` command. While pending, both actions are
disabled. A failure stays visible for retry or cancellation. Success refreshes
the capture list and clears stale batch selection.

## Consequences

The native dialog top layer makes the underlying main panel inert. Existing
confirmation windows for other actions and the library persistence, worker and
thumbnail-generation barriers are unchanged. Destructive positive-path tests
use isolated fixtures; installed-app acceptance opens and cancels without
clearing the user's Trash. This ships with the owner-approved workspace redesign.
