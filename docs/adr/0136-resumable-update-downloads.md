# ADR 0136: Resume interrupted signed update downloads

- Status: Accepted
- Amends: ADRs 0025 and 0031 (download transport only)
- Related: #206

## Decision

Keep the official Tauri updater for fixed-endpoint discovery and native
installation. Download its selected artifact through a bounded Rust transport
that retains one partial package in the application's cache. Retrying or
restarting the app can resume the same version, target, URL and signature with
HTTP Range and an available If-Range validator. Never persist redirected signed
URLs or let the frontend choose a URL, path, public key, or installer payload.

Use connection and read-idle timeouts, not a two-minute deadline for the entire
package. Downloads and retries remain explicit user actions. A server returning
the full body restarts at zero; a rejected range gets one full-request recovery.
Validate Content-Range and lengths before appending. Reject oversized packages,
and discard obsolete or invalid-signature content. Progress includes retained
bytes and an interrupted download offers Resume Download.

Verify the whole package before offering installation and again at the native
install boundary. Use the same minisign verifier already locked transitively by
the official plugin, now declared directly because the pinned plugin's public
install(bytes) method does not verify externally downloaded bytes. Keep the
existing embedded public key and Windows/macOS installation behavior.

## Alternatives and limits

Increasing the whole-download timeout alone does not preserve interrupted data.
Forking the updater plugin would duplicate platform installer maintenance. The
application therefore owns only caching and transport, with one 512 MiB package
limit, a native single-flight guard, and verified resources scoped to the library
webview. Linux and Windows portable builds retain manual updates.

Local HTTP regression servers exercise interruption and resume, process-lifetime
cache reopening, range rejection/ignoring, changed artifacts, truncated/invalid
responses and signature failures. UI tests cover byte progress, explicit retry,
duplicate operations and the install gate. These checks do not establish a
successful public update or Windows installer execution.
