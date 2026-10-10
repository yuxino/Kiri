import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AnnotationDocumentV1, AppearanceSettings } from "../annotation/model";
import type { CropPixels } from "../annotation/crop.js";
import { kiriResourceUrl, videoResourceUrl } from "./kiri-resource-url.js";
import type {VideoProject,VideoProjectSnapshot} from "../windows/video-project";

// ---------------------------------------------------------------------------
// Shared DTO types (mirror src-tauri/src/commands.rs)
// ---------------------------------------------------------------------------

interface RectDto {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureContextDto {
  displayWidth: number;
  displayHeight: number;
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
  windowRects: RectDto[];
  sourceApplication: string | null;
}

export interface OcrRecognitionDto {
  text: string;
  saved: boolean;
  asset: AssetDto | null;
}

export interface AssetDto {
  id: string;
  kind: "image" | "video" | "gif";
  createdAt: number;
  filename: string;
  title: string | null;
  ocrText: string | null;
  ocrOriginalText: string | null;
  qrText: string | null;
  tags: string[];
  pixelWidth: number;
  pixelHeight: number;
  duration: number | null;
  fileSize: number | null;
  sourceApplication: string | null;
  isFavorite: boolean;
  trashedAt: number | null;
  gifEligible: boolean;
}

export interface BatchExportResultDto { exported: number; failed: string[]; }

export type LibraryAvailability = "ready" | "unavailable" | "migrating";

export interface LibraryStatusDto {
  availability: LibraryAvailability;
  locationLabel: string;
  isDefault: boolean;
}

export interface DockVisibilityDto {
  supported: boolean;
  visible: boolean;
}

export type AssetAvailability = "ready" | "missing" | "unreadable" | "libraryUnavailable";

export interface AssetAvailabilityDto {
  status: AssetAvailability;
}

export interface PendingRecordingDto {
  id: string;
  createdAt: number;
}

/** Background finalization status; transient and not a saved library asset. */
export interface RecordingSaveJob {
  id: string;
  kind: "video" | "gif";
  createdAt: string;
  duration: number | null;
  pixelWidth: number;
  pixelHeight: number;
}

export type RecordingOutputFormat = "mp4" | "gif";

export interface RecordingOptions {
  outputFormat: RecordingOutputFormat;
  usesCountdown: boolean;
  capturesSystemAudio: boolean;
  capturesMicrophone: boolean;
  showsCursor: boolean;
  highlightsClicks: boolean;
}

export const DEFAULT_RECORDING_OPTIONS: RecordingOptions = {
  outputFormat: "mp4",
  usesCountdown: true,
  capturesSystemAudio: false,
  capturesMicrophone: false,
  showsCursor: true,
  highlightsClicks: false,
};

export interface RecordingState {
  isStarting: boolean;
  isRecording: boolean;
  isPaused: boolean;
  isTransitioning: boolean;
  isFinalizing: boolean;
  elapsed: number;
  elapsedLabel: string;
}

export interface NoticeDto {
  id: string;
  title: string;
  symbol: string;
}

export interface GifConversionStateDto {
  id: string;
  isConverting: boolean;
  phase: "preparing" | "checking" | "encoding" | "finalizing" | "saving" | "cancelling" | "cancelled" | "complete" | "failed";
  progress: number | null;
  error: string | null;
}

export interface ErrorDto {
  message: string;
  recovery: string | null;
}

export interface ShortcutStatusDto {
  label: string;
  status: "enabled" | "occupied" | "systemManaged";
}

export interface PortalShortcutsDto {
  revision: number;
  status: "unsupported" | "checking" | "unavailable" | "ready" | "connecting" | "active" | "declined" | "failed" | "closed";
  available: boolean;
  canConfigure: boolean;
  appId: string;
  bindings: Array<{ id: string; description: string; command: string; trigger: string | null }>;
}

export interface PlatformCapabilitiesDto {
  recording: boolean;
  localOcr: boolean;
  systemAudio: boolean;
  microphone: boolean;
  clickHighlights: boolean;
  videoEditing: boolean;
  videoSpeedEditing: boolean;
  videoEffectsEditing: boolean;
  videoAnnotationsEditing: boolean;
  videoExportPresets: boolean;
  manualUpdates: boolean;
}

export type OcrProviderPreset = "aliyunBailian" | "openAi" | "customOpenAi";

type OcrProtocol = "openAiChatCompletions";

export type OcrEngineRef =
  | { kind: "local" }
  | { kind: "profile"; profileId: string };

export interface OcrProviderProfileDto {
  id: string;
  revision: number;
  name: string;
  provider: OcrProviderPreset;
  protocol: OcrProtocol;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export interface OcrProviderSettingsDto {
  schemaVersion: number;
  activeEngine: OcrEngineRef;
  profiles: OcrProviderProfileDto[];
  warning?: string | null;
}

export interface SaveOcrProviderProfileRequest {
  id?: string;
  revision?: number;
  name: string;
  provider: OcrProviderPreset;
  protocol: OcrProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

interface PreparedOcrProfileDto {
  id: string;
  revision: number;
  name: string;
  provider: OcrProviderPreset;
  origin: string;
  model: string;
  hasApiKey: boolean;
}

export interface PreparedOcrRequestDto {
  requestId: string;
  engine: OcrEngineRef;
  imageWidth: number;
  imageHeight: number;
  byteLength: number;
  profile?: PreparedOcrProfileDto | null;
}

export interface AnnotationProjectDto {
  revisionSha256: string;
  state: "none" | "valid" | "invalid";
  documentJson: string | null;
  readOnly: boolean;
}

export interface EditorUpdateDto {
  revisionSha256: string;
  actionSucceeded: boolean;
}

const EDITOR_REVISION_MISMATCH_ERROR = "The screenshot changed after the editor opened.";

export function isEditorRevisionMismatch(error: unknown): boolean {
  return String(error) === EDITOR_REVISION_MISMATCH_ERROR;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface QrCodeDto { index: number; corners: [number, number][]; text: string | null; url: string | null; host: string | null; suspicious: boolean; }
export interface QrScanDto { requestId: string; imageUrl: string; width: number; height: number; codes: QrCodeDto[]; }

export const api = {
  scanQr: (requestId: string, selection: RectDto | null, assetId: string | null, expectedRevisionSha256?: string) => invoke<QrScanDto>("scan_qr", { requestId, selection, assetId, expectedRevisionSha256 }),
  cancelQr: (requestId: string) => invoke<void>("cancel_qr", { requestId }),
  qrAction: (requestId: string, index: number, action: string) => invoke<AssetDto | null>("qr_action", { requestId, index, action }),
  listQrFavorites: (query: string) => invoke<AssetDto[]>("list_qr_favorites", { query }),
  qrFavoriteAction: (id: string, action: string) => invoke<void>("qr_favorite_action", { id, action }),
  listOcrRecords: (query: string) => invoke<AssetDto[]>("list_ocr_records", { query }),
  updateOcrHistoryText: (id: string, expectedText: string, replacement: string | null) =>
    invoke<AssetDto>("update_ocr_history_text", { id, expectedText, replacement }),
  recognizeAssetLocal: (id: string) => invoke<OcrRecognitionDto>("recognize_asset_local", { id }),
  copyHistoryText: (text: string) => invoke<void>("copy_history_text", { text }),
  listAssets: (query: string, showingTrash: boolean) =>
    invoke<AssetDto[]>("list_assets", { query, showingTrash }),
  getAsset: (id: string) => invoke<AssetDto>("get_asset", { id }),
  getLibraryStatus: () => invoke<LibraryStatusDto>("get_library_status"),
  getDockVisibility: () => invoke<DockVisibilityDto>("get_dock_visibility"),
  setDockVisibility: (visible: boolean) => invoke<void>("set_dock_visibility", { visible }),
  chooseLibraryLocation: () => invoke<LibraryStatusDto>("choose_library_location"),
  locateLibrary: () => invoke<LibraryStatusDto>("locate_library"),
  restoreDefaultLibrary: () => invoke<LibraryStatusDto>("restore_default_library"),
  retryLibrary: () => invoke<LibraryStatusDto>("retry_library"),
  revealLibrary: () => invoke<void>("reveal_library"),
  getAssetAvailability: (id: string) =>
    invoke<AssetAvailabilityDto>("get_asset_availability", { id }),
  restoreMissingAsset: (id: string) =>
    invoke<boolean>("restore_missing_asset", { id }),
  removeMissingAsset: (id: string) =>
    invoke<void>("remove_missing_asset", { id }),
  listPendingRecordings: () =>
    invoke<PendingRecordingDto[]>("list_pending_recordings"),
  getRecordingSaveJobs: () => invoke<RecordingSaveJob[]>("get_recording_save_jobs"),
  retryPendingRecordings: () => invoke<number>("retry_pending_recordings"),
  setFavorite: (id: string, favorite: boolean) =>
    invoke<void>("set_favorite", { id, favorite }),
  renameAsset: (id: string, title: string) =>
    invoke<void>("rename_asset", { id, title }),
  setTags: (id: string, tags: string[]) =>
    invoke<void>("set_tags", { id, tags }),
  moveToTrash: (id: string) => invoke<void>("move_to_trash", { id }),
  restoreAsset: (id: string) => invoke<void>("restore_asset", { id }),
  permanentlyDelete: (id: string) => invoke<void>("permanently_delete", { id }),
  emptyTrash: () => invoke<void>("empty_trash"),
  batchMoveToTrash: (ids: string[]) => invoke<void>("batch_move_to_trash", { ids }),
  batchRestore: (ids: string[]) => invoke<void>("batch_restore", { ids }),
  batchPermanentlyDelete: (ids: string[]) => invoke<void>("batch_permanently_delete", { ids }),
  batchSetFavorite: (ids: string[], favorite: boolean) =>
    invoke<void>("batch_set_favorite", { ids, favorite }),
  exportSelectedAssets: (ids: string[]) =>
    invoke<BatchExportResultDto | null>("export_selected_assets", { ids }),
  showConfirmDialog: (
    kind: string,
    title: string,
    message: string,
    confirmLabel: string,
    ids?: string[],
    localize = false,
  ) => invoke<void>("show_confirm_dialog", { kind, title, message, confirmLabel, ids, localize }),
  setLanguage: (language: string) => invoke<void>("set_language", { language }),
  copyAsset: (id: string) => invoke<void>("copy_asset", { id }),
  openAsset: (id: string) => invoke<void>("open_asset", { id }),
  pinAsset: (id: string) => invoke<void>("pin_asset", { id }),
  openEditor: (id: string, recognizeQr = false) => invoke<void>("open_editor", { id, recognizeQr }),
  takeEditorQrRequest: () => invoke<boolean>("take_editor_qr_request"),
  revealAsset: (id: string) => invoke<void>("reveal_asset", { id }),
  loadVideoProject: (id:string) => invoke<VideoProjectSnapshot>("load_video_project",{id}),
  saveVideoProject: (id:string,revision:string,project:VideoProject) => invoke<VideoProjectSnapshot>("save_video_project",{id,revision,project}),
  exportVideoCopy: (id: string, segments: {start: number; end: number;speed?:number}[], effects: import("../windows/video-effects").VideoEffect[], annotations: import("../windows/video-annotation-render").RasterizedVideoAnnotation[], preset: "original" | "share" | "small",requestId?:string) =>
    invoke<string>("export_video_copy", { id, segments, effects: effects.map(({id: _id, ...effect}) => effect), annotations, preset,requestId }),
  cancelVideoExport: (requestId:string) => invoke<boolean>("cancel_video_export",{requestId}),
  getGifConversionStates: () => invoke<GifConversionStateDto[]>("get_gif_conversion_states"),
  cancelGifConversion: (id: string) => invoke<boolean>("cancel_gif_conversion", { id }),
  convertToGif: (id: string) => invoke<void>("convert_to_gif", { id }),

  startCapture: () => invoke<CaptureContextDto>("start_capture"),
  cancelCapture: () => invoke<void>("cancel_capture"),
  confirmCapture: async (
    png: Uint8Array,
    annotation: {
      selection: { x: number; y: number; width: number; height: number };
      document: AnnotationDocumentV1;
    },
    pinOnTop = false,
  ) => {
    const token = await invoke<string>("prepare_capture_annotation", {
      request: {
        selection: annotation.selection,
        documentJson: JSON.stringify(annotation.document),
      },
    });
    return invoke<void>("confirm_capture", png, {
      headers: {
        "x-kiri-annotation-token": token,
        "x-kiri-pin-on-top": String(pinOnTop),
      },
    });
  },
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  copyCaptureColor: (hex: string) => invoke<void>("copy_capture_color", { hex }),
  getOcrProviderSettings: () =>
    invoke<OcrProviderSettingsDto>("get_ocr_provider_settings"),
  saveOcrProviderProfile: (request: SaveOcrProviderProfileRequest) =>
    invoke<OcrProviderSettingsDto>("save_ocr_provider_profile", { request }),
  deleteOcrProviderProfile: (profileId: string, profileRevision: number) =>
    invoke<OcrProviderSettingsDto>("delete_ocr_provider_profile", {
      profileId,
      profileRevision,
    }),
  setActiveOcrEngine: (engine: OcrEngineRef) =>
    invoke<OcrProviderSettingsDto>("set_active_ocr_engine", { engine }),
  prepareOcrRequest: (selection: RectDto) =>
    invoke<PreparedOcrRequestDto>("prepare_ocr_request", { selection }),
  recognizePreparedOcrLocal: (requestId: string) =>
    invoke<OcrRecognitionDto>("recognize_prepared_ocr_local", { requestId }),
  recognizePreparedOcrRemote: (
    requestId: string,
    profileId: string,
    profileRevision: number,
  ) =>
    invoke<OcrRecognitionDto>("recognize_prepared_ocr_remote", {
      requestId,
      profileId,
      profileRevision,
    }),
  cancelPreparedOcr: (requestId: string) =>
    invoke<void>("cancel_prepared_ocr", { requestId }),

  startRecordingFlow: (region: RectDto, options: RecordingOptions) =>
    invoke<void>("start_recording_flow", { request: { region, options } }),
  recordingCountdownReady: (sessionId: string) => invoke<void>("recording_countdown_ready", { sessionId }),
  cancelRecordingFlow: (sessionId: string) => invoke<void>("cancel_recording_flow", { sessionId }),
  beginRecording: (sessionId: string) => invoke<void>("begin_recording", { sessionId }),
  getRecordingState: () => invoke<RecordingState>("get_recording_state"),
  pauseRecording: () => invoke<void>("pause_recording"),
  resumeRecording: () => invoke<void>("resume_recording"),
  stopRecording: () => invoke<void>("stop_recording"),

  micSupported: () => invoke<boolean>("mic_supported"),
  platformCapabilities: () => invoke<PlatformCapabilitiesDto>("platform_capabilities"),
  getPortalShortcuts: () => invoke<PortalShortcutsDto>("get_portal_shortcuts"),
  updatePortalShortcuts: (operation: "setup" | "configure" | "refresh" | "disconnect") => invoke<PortalShortcutsDto>("update_portal_shortcuts", { operation }),
  cancelPortalShortcutSetup: () => invoke<void>("cancel_portal_shortcut_setup"),
  getShortcutStatus: () => invoke<ShortcutStatusDto>("get_shortcut_status"),
  setCaptureShortcut: (shortcut: string | null) => invoke<ShortcutStatusDto>("set_capture_shortcut", { shortcut }),
  setCaptureShortcutEditing: (editing: boolean) => invoke<void>("set_capture_shortcut_editing", { editing }),
  retryShortcut: () => invoke<ShortcutStatusDto>("retry_shortcut"),
  openReleasePage: () => invoke<void>("open_release_page"),
  isPortableBuild: () => invoke<boolean>("is_portable_build"),
  openSettings: (action: string) => invoke<void>("open_settings", { action }),
  authorizeScreenshot: () => invoke<void>("authorize_screenshot"),
  quitApp: () => invoke<void>("quit_app"),
  getRecordingOptions: () => invoke<RecordingOptions>("get_recording_options"),
  setRecordingOptions: (options: RecordingOptions) =>
    invoke<void>("set_recording_options", { options }),
  importMedia: (paths?:string[]) => invoke<{ids:string[];failed:number}>("import_media",{paths:paths??null}),
  pasteClipboardImage: () => invoke<AssetDto>("paste_clipboard_image"),
  getAnnotationAppearance: () =>
    invoke<AppearanceSettings>("get_annotation_appearance"),
  setAnnotationAppearance: (appearance: Partial<AppearanceSettings>) =>
    invoke<AppearanceSettings>("set_annotation_appearance", { appearance }),

  saveFileDialog: (defaultName: string) =>
    invoke<string | null>("save_file_dialog", { defaultName }),
  getAssetAnnotationProject: (id: string) =>
    invoke<AnnotationProjectDto>("get_asset_annotation_project", { id }),
  updateAsset: (
    id: string,
    png: Uint8Array,
    document: AnnotationDocumentV1,
    options: {
      action: "save" | "saveAs";
      cropPixels: CropPixels | null;
      saveToken: string | null;
      revisionSha256: string;
    },
  ) => {
    return invoke<string>("prepare_asset_annotation", {
      id,
      documentJson: JSON.stringify(document),
      cropPixels: options.cropPixels,
      revisionSha256: options.revisionSha256,
    }).then((annotationToken) => invoke<EditorUpdateDto>("update_asset", png, {
      headers: {
        "x-kiri-asset-id": id,
        "x-kiri-annotation-token": annotationToken,
        "x-kiri-editor-action": options.action === "saveAs" ? "save-as" : "save",
        ...(options.saveToken
          ? { "x-kiri-save-token": options.saveToken }
          : {}),
      },
    }));
  },
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function onNotice(handler: (notice: NoticeDto) => void): Promise<UnlistenFn> {
  return listen<NoticeDto>("notice", (event) => handler(event.payload));
}

export function onGifConversionState(
  handler: (state: GifConversionStateDto) => void,
): Promise<UnlistenFn> {
  return listen<GifConversionStateDto>("gif-conversion-state", (event) =>
    handler(event.payload),
  );
}

export function onError(handler: (error: ErrorDto) => void): Promise<UnlistenFn> {
  return listen<ErrorDto>("error", (event) => handler(event.payload));
}

export function onLibraryChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("library-changed", handler);
}

export function onCaptureShortcutConfirmed(handler: () => void): Promise<UnlistenFn> {
  return listen("capture-shortcut-confirmed", handler);
}

export function onAssetContentChanged(handler: (assetId: string) => void): Promise<UnlistenFn> {
  return listen<string>("asset-content-changed", (event) => handler(event.payload));
}

export function onAnnotationAppearanceChanged(handler: (appearance: AppearanceSettings) => void): Promise<UnlistenFn> {
  return listen<AppearanceSettings>("annotation-appearance-changed", event => handler(event.payload));
}

export function onPinOnTop(handler: () => void): Promise<UnlistenFn> {
  return listen("pin-on-top", handler);
}

export function onEditorRecognizeQr(handler: () => void): Promise<UnlistenFn> {
  return listen("editor-recognize-qr", handler);
}

export function onRecordingState(
  handler: (state: RecordingState) => void,
): Promise<UnlistenFn> {
  return listen<RecordingState>("recording-state", (event) => handler(event.payload));
}

export function onRecordingSaveJobs(
  handler: (jobs: RecordingSaveJob[]) => void,
): Promise<UnlistenFn> {
  return listen<RecordingSaveJob[]>("recording-save-jobs", (event) => handler(event.payload));
}

export function mediaUrl(id: string, video = false): string {
  return video ? videoResourceUrl(id) : kiriResourceUrl("media", [id]);
}

export function onPortalShortcutsChanged(handler: (status: PortalShortcutsDto) => void): Promise<UnlistenFn> {
  return listen<PortalShortcutsDto>("portal-shortcuts-changed", (event) => handler(event.payload));
}
