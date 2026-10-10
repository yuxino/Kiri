# Recheck native packages without rebuilding

Use an independent temporary QA ref for each active platform replay. The build
workflow cancels an older run on the same ref, even when the requested profiles
differ. Keep application, assets, dependencies, configuration and packaging
sources identical to the original candidate; apply only QA/workflow repairs and
Markdown documentation changes.

## Windows

```sh
gh workflow run build.yml --repo yuxino/Kiri --ref <qa-ref> \
  -f profile=recheck-windows -f windows_native_candidate_run_id=<original-run>
```

The candidate must be a completed official `workflow_dispatch` build with one
unambiguous first attempt. Rust tests, NSIS creation, portable packaging and
bundle upload must have passed. Known native acceptance gates may have failed
or been skipped, but all original gates are replayed: countdown, shortcut,
installed/portable smoke, and confirmation/color checks when present. An
unknown native gate or missing driver blocks the replay.

The verifier authenticates artifact origin and archive digests, the actual
checkout SHA from the original job log, and the application/packaging source
comparison. It extracts the original NSIS payload and requires the installed
executable's SHA-256 to equal that payload. Tauri CLI 2.11.4 replaces exactly one
`__TAURI_BUNDLE_TYPE_VAR_UNK` marker with `__TAURI_BUNDLE_TYPE_VAR_NSS` while
packaging NSIS, then restores the compiled output. The verifier independently
requires this exact byte substitution to reproduce the payload hash; any other
change fails. Compiled/portable and NSIS identities are recorded and checked
separately before each gate. The mechanism is documented in the
[locked CLI's bundler source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs).
It waits for
the complete installer process tree and retains installed-file/hash diagnostics
on failure. A failed checksum is never waived.

New package runs retain `kiri-windows` (NSIS and portable ZIP) and
`windows-native-candidate` (compiled executable), including after native QA
failure. Legacy failed runs can use `countdown-debug-build`; if their original
portable ZIP was not retained, the unchanged packaging script recreates it from
the exact candidate executable. The provenance report explicitly distinguishes
that replay from reuse of the original ZIP. This is not a release promotion.

Each native gate uses fresh Kiri-only directories on a disposable GitHub-hosted
Windows runner and restores prior CI data afterward. No OS Known Folder
redirection or global WebView process kill is used. Failed gates do not suppress
later independent gates, and all gates must pass for the job/quality gate to
succeed. Evidence is retained in `windows-native-recheck-review`.

## Linux X11

```sh
gh workflow run build.yml --repo yuxino/Kiri --ref <qa-ref> \
  -f profile=recheck-linux-x11 -f linux_candidate_run_id=<original-run>
```

The existing package-provenance verifier authenticates the original `.deb`,
build/install steps and unchanged application sources before replaying the
installed application in an isolated Xvfb/Openbox session. It also replays the
installed system-audio/pause checks. A failed candidate is eligible only when
its original X11 acceptance step was the sole failed build-job step.

Pin-window gestures wait for painted image/controls and use continuous native
mouse positions. Corner resizing deliberately uses unequal normalized pointer
deltas, then checks the resulting native aspect ratio. Do not replace these
checks with proportional pointer inputs. Ordinary foreground stacking uses a
managed window, records its fullscreen-to-windowed transition, and never raises
or repins the reference to pass. Focused fullscreen windows can occupy a layer
above ordinary always-on-top windows; retain that result separately.

Xvfb establishes only the recorded X11 session and scale. It does not establish
GNOME Wayland, hardware, multiple-monitor or fractional-scale acceptance.

After the replay and evidence handoff, remove temporary refs/checkouts and
duplicate downloads. Preserve reports, necessary generated screenshots, active
application/cache state and source changes.
