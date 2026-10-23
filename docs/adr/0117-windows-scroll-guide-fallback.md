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
