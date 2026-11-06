export type VideoExportFailureStage = "request" | "source" | "snapshot" | "render" | "save" | "worker" | "progress" | "annotations" | "open" | "unknown";
export type VideoExportFailure = {stage: VideoExportFailureStage; code: string};

const nativeStages = new Set(["request", "source", "snapshot", "render", "save", "worker"]);
const ioKinds = new Set([
  "not_found", "permission_denied", "connection_refused", "connection_reset", "host_unreachable",
  "network_unreachable", "connection_aborted", "not_connected", "addr_in_use", "addr_not_available",
  "network_down", "broken_pipe", "already_exists", "would_block", "not_a_directory", "is_a_directory",
  "directory_not_empty", "read_only_filesystem", "filesystem_loop", "stale_network_file_handle",
  "invalid_input", "invalid_data", "timed_out", "write_zero", "storage_full", "not_seekable",
  "quota_exceeded", "file_too_large", "resource_busy", "executable_file_busy", "deadlock",
  "crosses_devices", "too_many_links", "invalid_filename", "argument_list_too_long", "interrupted",
  "unsupported", "unexpected_eof", "out_of_memory", "in_progress", "other", "uncategorized",
]);

/** Accept only the native command's bounded, non-sensitive diagnostic protocol. */
export function parseVideoExportFailure(reason: unknown): VideoExportFailure {
  if (typeof reason !== "string") return {stage: "unknown", code: "unknown"};
  const match = /^VIDEO_EXPORT_FAILED:([a-z]+):([a-z0-9_A-F]+)$/.exec(reason);
  if (!match || !nativeStages.has(match[1])) return {stage: "unknown", code: "unknown"};
  const code = match[2];
  if (code !== "native" && code !== "unknown" && !/^(?:hresult|transcode)_[0-9A-F]{8}$/.test(code)
      && !(code.startsWith("io_") && ioKinds.has(code.slice(3)))) {
    return {stage: "unknown", code: "unknown"};
  }
  return {stage: match[1] as VideoExportFailureStage, code};
}

export function videoExportFailureMessage(failure: VideoExportFailure): string {
  switch (failure.stage) {
    case "source": return "Couldn't read the original video. Check that it is still available, then retry.";
    case "snapshot": return "Couldn't prepare the video. Check temporary-folder access and free space, then retry.";
    case "render": return "Couldn't render the video. Your edit is still here. Retry or report this error code.";
    case "save": return "Couldn't save the copy to the library. Check library access and free space, then retry.";
    case "request": return "Couldn't start the export. Reopen the video and retry.";
    case "progress": return "Couldn't start the export. Retry the export.";
    case "annotations": return "Couldn't prepare the annotations for export. Reduce their size or number, then retry.";
    case "open": return "The copy was saved to the library, but couldn't be opened. Try Open again.";
    default: return "Couldn't export the video. Your edit is still here. Retry or report this error code.";
  }
}

export function videoExportFailureCode(failure: VideoExportFailure): string {
  return `${failure.stage}/${failure.code}`;
}
