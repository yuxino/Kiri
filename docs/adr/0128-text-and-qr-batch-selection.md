# 0128 — Batch selection for Text History and QR Favorites

Status: accepted

Both record destinations expose Select records, checkboxes, Select All and
Deselect All. Normal row clicks continue to read a single record. Selection is
limited to the current search results; changing the query clears selection and
hides stale results. Library refreshes prune missing IDs. Escape exits selection;
Command/Ctrl+A selects visible results only in selection mode and outside text inputs.

A shared selection controller submits the existing atomic batch_move_to_trash
command. The explicit Move to Trash action includes the selected count. Records
and their source images remain recoverable through Trash, matching single-record
removal. No new permanent-delete path or additional confirmation is introduced.
Failed mutations retain selection for retry; pending mutations block repeated
submission, selection changes and search changes. Batch mode disables single-record
actions, and OCR editing/saving blocks entering selection mode.

Verification uses isolated component tests and the real-component browser harness;
no user library data is modified. The Rust persistence boundary is unchanged.

## Validation

Checked against base `c97a521` plus this change: the final layout passed 116
focused frontend interaction tests. The v1.6.37 release check then passed the
complete frontend/release suite (964 passed, 3 already skipped), production
build, seven-language key/placeholder parity and Rust checks (535 tests passed,
5 already ignored, plus `cargo check`). Isolated real-component browser checks covered text and QR batch
removal, failure retaining selection, overflow-menu dismissal, and Chinese,
English, Japanese and German controls at 800- and 960-pixel widths. Reading and
selection kept the same content origin, with no horizontal page overflow.

The local arm64 app was bundled with updater artifacts disabled for this local
build, passed deep/strict signature checks with the installed app's designated
requirement, and replaced the canonical installation. Installed macOS WebKit
checks verified both complete pages, retained detail/date during selection,
Command+A and Escape on both lists, and opening/Escape-closing the overflow
menu. Native checks selected and cancelled only; mutation success/failure was
verified with isolated fixtures, without changing user records. Windows/Linux
native behavior remains outside this local acceptance.

## Record workspace layout

The text and QR pages use a compact title without a repeated explanatory
subtitle, followed by a shared search/selection toolbar across the workspace.
Selection count, select/deselect all, recoverable removal and cancellation
stay together in that toolbar. Below 850 pixels, selection temporarily replaces
the search field so long localized actions do not move the list downward.
The list and current reading preview remain
mounted during selection; single-record actions are disabled until selection
ends. Failures remain attached to the batch action and keep selection retryable.

The navigation rail is 180 pixels; record lists use 240–300 pixels according
to available space. List previews use whitespace and a restrained selection
fill instead of row dividers plus a heavy selection stripe. Dates omit seconds
and expose the complete local timestamp in the title. The detail header keeps
its short date with compact actions and wraps only when its contents require it.
Copy uses a quiet neutral fill, secondary actions use ghost buttons, and
low-frequency removal/restoration live in the same accessible overflow menu.
Native capture QR results preserve their existing action hierarchy.

Review the whole page at normal and minimum widths, not just cropped buttons.
Compare reading and selection with the same sample, checking content position,
scroll offset, long localized labels, action feedback and preview preservation.
Browser geometry checks complement visual review and do not replace native
WebKit acceptance for desktop keyboard/focus behavior.

Installed macOS verification found that clicking selection buttons in WebKit
can leave keyboard focus on the document, outside the record section. Batch
shortcuts also listen at window scope while selection is active, with text-input,
IME and busy guards. Regression tests cover document-focus Select All and Escape
on both record pages.
