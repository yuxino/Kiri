import type { GifConversionStateDto } from "../lib/ipc";
import { fmt, t } from "../i18n";

export function gifConversionLabel(job: GifConversionStateDto): string {
  if (job.phase === "finalizing") return t("Finishing GIF…");
  if (job.phase === "saving") return t("Saving GIF…");
  if (job.phase === "preparing") return t("Preparing GIF…");
  if (job.progress == null) return t("Creating GIF…");
  return fmt("Creating GIF… %d%", Math.floor(job.progress * 100));
}
