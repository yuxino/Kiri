"""Shared assertions for the installed library's recoverable Trash flow."""

from uuid import UUID


def expected_restored_index(before, current, selected):
    trashed = {item["id"]: item for item in current if item.get("trashedAt") is not None}
    if trashed.keys() != selected:
        return None

    restored = []
    for item in before:
        asset_id = item["id"]
        if asset_id not in selected or item["kind"] != "image":
            restored.append(item)
            continue

        # Keep the fresh revision through restore so a pending OCR job from
        # before the move cannot write back to this image.
        revision = trashed[asset_id].get("ocrRevision")
        if not revision or UUID(revision).version != 4 or revision == item.get("ocrRevision"):
            raise RuntimeError(f"Moving image {asset_id} to Trash must invalidate its OCR revision")
        restored.append({**item, "ocrRevision": revision})
    return restored
