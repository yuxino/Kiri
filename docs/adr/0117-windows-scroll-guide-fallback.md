# 0117 — Hide an incompatible Windows scrolling guide

Status: accepted for implementation; Windows 10 native acceptance pending.

## Context

Issue #152 reports Windows 10 build 19045 failing to exclude the scrolling
region guide before capture starts. The native error is `0x80070008`; the code
alone does not establish physical memory exhaustion. The guide is a transparent,
mouse-passthrough window, separate from the interactive control panel.

## Decision

If Windows cannot apply capture exclusion to the guide, keep that guide hidden
for the session and confirm its native hidden state before continuing. All
subsequent show paths, including a repeated capture shortcut, must honor that
choice. Keep the hidden window under the usual session ownership and teardown.

The panel must still pass mandatory capture exclusion. Failure to confirm the
guide hidden or to exclude the panel cancels startup. Never use `WDA_MONITOR`,
ignore a visible control's exclusion error, or change alpha/compositing as a
speculative workaround. Preserve the native failure in diagnostic logs.

## Consequences and acceptance

Affected Windows sessions lose only the selected-area border and surrounding
dimming. Selection coordinates, capture, preview, controls, save, Escape and
cleanup retain their existing contracts. Other platforms keep their guides.

Test the visible and hidden-guide paths, repeated shortcuts, cancellation and
restart. Windows 10 build 19045 must additionally prove the actual WGC image is
free of black rectangles and Kiri controls, including an in-selection panel.
Server 2025 CI or macOS unit checks alone cannot close the reported issue.

## Follow-up: restore focus after queued Windows shows

The first Windows Server 2025 candidate run reached scrolling capture with
both guide and panel excluded, but cancellation left the restored library in
front of the source after both scrolling windows were destroyed. This is a
separate lifecycle failure from the Windows 10 affinity report.

Windows scrolling cleanup runs on a worker because WebView2 construction must
stay off the event loop. Tauri's `show()` only enqueues a request there, while
native source activation runs immediately. In the shared capture-origin
restoration path, follow each Windows show with `is_visible()`: its response
acknowledges the show on the same UI queue before restoring focus. Keep Tao's
visibility state, existing activation policy and other platforms unchanged;
do not move all scrolling UI work onto the main thread or add focus retries.

The installed-app gate must still prove source foreground after cancellation
and completion, with the library restored and no scrolling windows remaining.
The failed run demonstrates the symptom and source inspection establishes the
ordering defect. The corrected candidate passed native Server 2025 checks;
the Windows 10 fallback remains pending reporter confirmation. See the
[acceptance record](../qa/scrolling-capture.md#verified-candidate-before-v1629).
