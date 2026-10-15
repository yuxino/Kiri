# ADR 0108: Open existing support folders from About

- Status: Accepted
- Date: 2026-10-15

## Decision

Settings → About adds an Open Folder menu beside Copy Info and a GitHub project
link. Keep the existing settings layout and concise README; detailed controls
belong in the translated usage guides.

The menu opens the existing settings and logs directories. Windows also offers
its separate error-log directory and system temporary directory, where older
updater folders may be found. Folder commands accept a fixed enum, require the
library window, and do not accept renderer-supplied paths. They may create a
missing destination on an explicit open action, but never delete or relocate
files. Installed and portable data-storage policies remain unchanged.

GitHub opens the fixed Kiri repository URL in the system browser only after an
explicit click. Both actions are single-flight and report retryable errors.
The menu stays within the window, supports arrow/Home/End navigation, returns
focus on Escape, and advances focus on Tab.

## Verification

Handler tests cover destinations, focus, failures and duplicate actions. Real
Windows installed-app checks assert the resulting Explorer location for every
folder. Renderer checks cover narrow windows and keyboard navigation separately
from native command acceptance.
