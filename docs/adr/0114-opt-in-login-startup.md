# ADR 0114: Opt-in login startup

Status: accepted for implementation; native login-session acceptance remains separate.

## Decision

Kiri offers Start at login in Settings → General. The default is off for new installations and upgrades. Loading settings and starting the app never registers a startup item. Only an explicit user change registers or unregisters Kiri.

System startup state is authoritative. macOS uses SMAppService for the installed application; Windows uses the current user's Run entry and observes StartupApproved; Linux uses Kiri's own XDG autostart desktop entry and observes Hidden=true. A system-disabled item is not silently re-enabled. System approval requirements remain visible in Settings.

A login launch starts the tray, capture shortcuts and normal application services without opening or focusing the library. Manual app opens, tray actions and the library shortcut retain their existing behavior. Duplicate login launches do not open the library in an already-running instance. Dock visibility remains a separate preference.

## Verification boundaries

Unit and renderer tests cover default-off behavior, explicit changes, system-disabled status, stale asynchronous reads and launch arguments. They do not establish real logout/login behavior, Windows installation or GNOME session acceptance. Those require the installed application in each actual desktop session. Tests must not register startup items or alter the user's login settings merely by loading the app or its settings page.
