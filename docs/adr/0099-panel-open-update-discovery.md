# ADR 0099: Discover updates when opening the main panel

- Status: Proposed
- Date: 2026-10-12
- Supersedes: ADR 0025 only for manual update discovery

## Decision

For macOS and installed Windows builds, check the existing fixed, signed-updater
manifest when the main panel is visible at startup or is activated. Cache
successful checks for six hours in the running app. Failed checks can retry on
a later activation after five minutes. Do not add a periodic background timer,
download automatically, or change the signature/installation trust boundary.

A small neutral dot beside Settings indicates an available version. The
accessible label also announces that availability. Failure or an up-to-date
result never creates a dot. Settings shows the version and notes using the
existing update actions. Linux and Windows portable packages retain their
manual Releases route and never query an unsupported installer target.

The main window owns the updater resource and operation state. Navigating away
from Settings preserves available updates, download progress and verified
installation readiness. Only one operation can run at a time; a late check
finishing after window teardown closes its native resource. Check, download,
signature failure and explicit restart behavior have isolated regressions.

## Consequences

Opening the panel now makes a metadata request. Privacy documentation records
this change. No captures, credentials or library data accompany that request.
The owner requested this discovery behavior while reviewing the sidebar; the
larger workspace redesign still needs review before merge.
