import { Channel, invoke, Resource } from "@tauri-apps/api/core";
import { check as checkOfficial, type Update as OfficialUpdate } from "@tauri-apps/plugin-updater";

export type DownloadEvent =
  | { event: "Started"; data: { downloaded: number; contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export class Update {
  private downloadedBytes?: Resource;
  constructor(private readonly update: OfficialUpdate) {}
  get version() { return this.update.version; }
  get currentVersion() { return this.update.currentVersion; }
  get body() { return this.update.body; }

  async download(onEvent: (event: DownloadEvent) => void) {
    const channel = new Channel<DownloadEvent>();
    channel.onmessage = onEvent;
    const rid = await invoke<number>("download_app_update", { rid: this.update.rid, onEvent: channel });
    this.downloadedBytes = new Resource(rid);
  }

  async install() {
    if (!this.downloadedBytes) throw new Error("Download and verify the update first.");
    await invoke("install_app_update", { updateRid: this.update.rid, bytesRid: this.downloadedBytes.rid });
    this.downloadedBytes = undefined;
  }

  async close() {
    try { await this.downloadedBytes?.close(); }
    finally { await this.update.close(); }
  }
}

export async function check(options: { timeout: number }) {
  const update = await checkOfficial(options);
  return update ? new Update(update) : null;
}
