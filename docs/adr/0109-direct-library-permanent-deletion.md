# ADR 0109: Direct permanent deletion from the library

Status: accepted

## Decision

Library card menus and batch selection offer **Delete Permanently**
for images, videos, and GIFs, alongside the existing **Move to Trash** action.
Trash retains Restore and Delete Permanently.

Permanent deletion always opens the existing destructive confirmation window,
with an explicit irreversible-action warning and the selected count for batches.
Cancel or Escape leaves the captures untouched. Delete controls use the existing
red danger palette with a red background; moving to recoverable Trash stays a
separate, explicitly named action.

## Consequences

The existing single and atomic batch deletion commands remove assets directly;
no intermediate Trash operation is needed. Their persistence-before-cleanup,
project cleanup, thumbnail invalidation, and library change events are preserved.
No new command, storage format, or network behavior is introduced.

Batch controls retain the current selection toolbar above the grid, including
Export Selected, and wrap within the library width. Existing measured card-menu
placement remains unchanged. Validation uses isolated fixtures, never deletes user captures,
and does not empty the user's Trash.
