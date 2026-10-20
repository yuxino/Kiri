import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Info, RotateCcw, X } from "lucide-react";
import { KiriIcon, type IconName } from "../components/KiriIcons";
import { api, onShortcutRecorded, onShortcutSettingsChanged, type ShortcutAction, type ShortcutSettingDto } from "../lib/ipc";
import { fmt, t } from "../i18n";
import { PortalShortcutsCard } from "./PortalShortcutsCard";

// Native interception changes must remain ordered even if the page is left and
// remounted while an IPC response is pending.
let editorQueue: Promise<void> = Promise.resolve();
function setEditingInterception(editing: boolean): Promise<void> {
  const operation = editorQueue.catch(() => {}).then(() => api.setCaptureShortcutEditing(editing));
  editorQueue = operation;
  return operation;
}

const ACTIONS: Array<{ action: ShortcutAction; title: string; description: string; icon: IconName; command: string }> = [
  { action: "capture", title: "Screenshot", description: "Choose a window or region to capture.", icon: "camera.viewfinder", command: "kiri --capture" },
  { action: "record", title: "Record", description: "Choose a region for a new recording.", icon: "record.circle.fill", command: "kiri --record" },
  { action: "ocr", title: "Recognize Text", description: "Choose a region to recognize text.", icon: "text.viewfinder", command: "kiri --ocr" },
  { action: "library", title: "Show main window", description: "Bring Kiri to the front.", icon: "photo.on.rectangle", command: "kiri --library" },
  { action: "recordingPauseResume", title: "Pause/Resume Recording", description: "Pause/Resume Recording", icon: "pause.circle.fill", command: "kiri --toggle-recording-pause" },
  { action: "recordingStop", title: "Stop and Save Recording", description: "Stop and Save Recording", icon: "stop.fill", command: "kiri --stop-recording" },
];

// Native hotkeys can reach the recorder without a DOM keydown. Both paths must
// use the same deliberate opt-in for keys used to type or navigate other apps.
function needsSingleKeyConfirmation(shortcut: string) {
  const parts = shortcut.split("+");
  const code = parts.pop() ?? "";
  return !parts.some((part) => /^(control|ctrl|alt|super|meta|command)$/i.test(part))
    && !/^(F([1-9]|1\d|2[0-4])|AudioVolume\w+|Media\w+)$/i.test(code);
}

function candidateLabel(shortcut: string) {
  const mac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  const parts = shortcut.split("+");
  const code = parts.pop() ?? "";
  const names: Record<string, string> = {
    Space: "Space", Enter: mac ? "↩" : "Enter", Tab: mac ? "⇥" : "Tab", Escape: "Esc",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    Backspace: mac ? "⌫" : "Backspace", Delete: mac ? "⌦" : "Delete",
    PageUp: "Page Up", PageDown: "Page Down", CapsLock: "Caps Lock", NumLock: "Num Lock",
    ScrollLock: "Scroll Lock", PrintScreen: "Print Screen", Backquote: "`", Minus: "-", Equal: "=",
    BracketLeft: "[", BracketRight: "]", Backslash: "\\", IntlBackslash: "\\", Semicolon: ";",
    Quote: "'", Comma: ",", Period: ".", Slash: "/", NumpadAdd: "Num +", NumpadSubtract: "Num -",
    NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadDecimal: "Num .", NumpadEnter: "Num Enter", NumpadEqual: "Num =",
  };
  const key = names[code] ?? code.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ");
  const modifiers: Record<string, string> = mac
    ? { control: "⌃", ctrl: "⌃", alt: "⌥", shift: "⇧", super: "⌘", meta: "⌘", command: "⌘" }
    : { control: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Win", meta: "Win", command: "Win" };
  return [...parts.map((part) => modifiers[part.toLowerCase()] ?? part), key].join(mac ? "" : "+");
}

/** Display native labels as individual keys without changing their order. */
export function ShortcutKeys({ label, keys }: { label?: string; keys?: string[] }) {
  const parts = keys ?? (label?.includes("+") ? label.split("+") : Array.from(label ?? ""));
  return <span className="kiri-shortcut-keys" aria-hidden="true">
    {parts.map((key, index) => key === "/" ? <span className="kiri-shortcut-key-or" key={index}>/</span> : <kbd key={`${index}-${key}`}>{key}</kbd>)}
  </span>;
}

export function ShortcutsSettings() {
  const [settings, setSettings] = useState<ShortcutSettingDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<ShortcutAction | null>(null);
  const [busy, setBusy] = useState<ShortcutAction | null>(null);
  const [error, setError] = useState<{ action: ShortcutAction; message: string } | null>(null);
  const [candidate, setCandidate] = useState<{ action: ShortcutAction; shortcut: string; label: string } | null>(null);
  const candidateRef = useRef<typeof candidate>(null);
  const alive = useRef(false);
  const busyRef = useRef(false);
  const editingRef = useRef<ShortcutAction | null>(null);
  const editorGeneration = useRef(0);
  const subscription = useRef<Promise<() => void> | null>(null);
  const settingsVersion = useRef(0);
  const stopEditing = useCallback(() => {
    ++editorGeneration.current;
    if (editingRef.current) setError(null);
    editingRef.current = null;
    setEditing(null);
    candidateRef.current = null;
    setCandidate(null);
    return setEditingInterception(false).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    const version = settingsVersion.current;
    setLoadError(false);
    try {
      const next = await api.getShortcutSettings();
      if (alive.current && version === settingsVersion.current) setSettings(next);
    } catch {
      if (alive.current && version === settingsVersion.current) setLoadError(true);
    }
  }, []);

  const perform = useCallback(async (action: ShortcutAction, operation: () => Promise<ShortcutSettingDto[]>) => {
    if (busyRef.current || !alive.current) return;
    busyRef.current = true;
    const released = stopEditing();
    setBusy(action);
    setError(null);
    try {
      await released;
      if (!alive.current) return;
      const version = settingsVersion.current;
      const next = await operation();
      if (alive.current && version === settingsVersion.current) setSettings(next);
    } catch (failure) {
      if (alive.current) setError({ action, message: String(failure) });
      // Registration and persistence can fail separately. Read the native state
      // again rather than implying a failed candidate replaced the prior key.
      const version = settingsVersion.current;
      const current = await api.getShortcutSettings().catch(() => null);
      if (alive.current && current && version === settingsVersion.current) setSettings(current);
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(null);
    }
  }, [stopEditing]);

  const acceptRecordedShortcut = useCallback((action: ShortcutAction, shortcut: string) => {
    if (editingRef.current !== action || busyRef.current || !alive.current) return;
    setError(null);
    if (needsSingleKeyConfirmation(shortcut)) {
      const next = { action, shortcut, label: candidateLabel(shortcut) };
      candidateRef.current = next;
      setCandidate(next);
    } else {
      void perform(action, () => api.setActionShortcut(action, shortcut));
    }
  }, [perform]);

  useEffect(() => {
    alive.current = true;
    void setEditingInterception(false).catch(() => {});
    subscription.current = onShortcutRecorded(({ shortcut }) => {
      const action = editingRef.current;
      if (action) acceptRecordedShortcut(action, shortcut);
    });
    void subscription.current.catch(() => {});
    const settingsSubscription = onShortcutSettingsChanged((next) => {
      if (!alive.current) return;
      ++settingsVersion.current;
      setLoadError(false);
      setSettings(next);
    });
    void settingsSubscription.catch(() => {});
    void load();
    window.addEventListener("blur", stopEditing);
    return () => {
      alive.current = false;
      stopEditing();
      window.removeEventListener("blur", stopEditing);
      void subscription.current?.then((dispose) => dispose()).catch(() => {});
      void settingsSubscription.then((dispose) => dispose()).catch(() => {});
    };
  }, [load, acceptRecordedShortcut, stopEditing]);

  const beginEditing = async (action: ShortcutAction, button: HTMLButtonElement) => {
    if (busyRef.current) return;
    if (editingRef.current === action) { stopEditing(); return; }
    button.focus();
    const generation = ++editorGeneration.current;
    setError(null);
    candidateRef.current = null;
    setCandidate(null);
    try {
      await subscription.current;
      if (!alive.current || generation !== editorGeneration.current || document.activeElement !== button) return;
      await setEditingInterception(true);
      if (alive.current && generation === editorGeneration.current && document.activeElement === button) {
        editingRef.current = action;
        setEditing(action);
      }
    } catch {
      if (alive.current && generation === editorGeneration.current) {
        setError({ action, message: "Could not change the shortcut." });
      }
    }
  };

  const recordKey = (event: KeyboardEvent<HTMLButtonElement>, action: ShortcutAction) => {
    if (editingRef.current !== action) return;
    if (event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key === "Process"
      || /^(Control|Shift|Alt|Meta|AltGraph|Fn)$/.test(event.key) || /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(event.code)) return;
    const modified = event.ctrlKey || event.altKey || event.metaKey;
    if (event.key === "Tab" && !modified) {
      if (!candidateRef.current) void stopEditing();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !modified && !event.shiftKey) { void stopEditing(); return; }
    if (!event.code || event.code === "Unidentified") {
      setError({ action, message: "This key is not supported as a shortcut." });
      return;
    }
    const modifiers = [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super"].filter(Boolean);
    const shortcut = [...modifiers, event.code].join("+");
    acceptRecordedShortcut(action, shortcut);
  };

  const systemManaged = settings?.some((setting) => setting.status === "systemManaged");
  const compactKeys = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  // Keep every field in one column, including while a saved long binding is
  // being edited. Native media key names need room beyond the usual modifiers.
  const longestLabel = Math.max(candidate?.label.length ?? 0, ...(settings ?? []).map((setting) => setting.label?.length ?? 0));
  const longKeys = longestLabel > (compactKeys ? 8 : 24);
  return <div className="kiri-shortcuts-page" data-compact-keys={compactKeys || undefined} data-long-keys={longKeys || undefined}>
    <section className="kiri-settings-section kiri-shortcut-section" aria-labelledby="global-shortcuts-title">
      <div className="kiri-settings-section__heading kiri-shortcuts-heading">
        <div>
          <div className="kiri-shortcuts-title"><h2 id="global-shortcuts-title">{t("Global Shortcuts")}</h2>
            {!systemManaged && <span className="kiri-shortcuts-help">
              <button type="button" className="kiri-shortcuts-help-button" aria-label={t("Global shortcuts take priority over the same keys in other apps. Change or disable any you already use.")}
                aria-describedby="shortcut-priority-help"><Info size={14} aria-hidden="true" /></button>
              <span id="shortcut-priority-help" role="tooltip">{t("Global shortcuts take priority over the same keys in other apps. Change or disable any you already use.")}</span>
            </span>}
          </div>
          {systemManaged ? <p>{t("Your desktop manages global shortcuts on Wayland.")}</p> :
            <div className="kiri-shortcut-instruction" data-editing={editing !== null || undefined}>
              <p className="kiri-shortcut-instruction__idle" aria-hidden={editing !== null}>{t("Use these shortcuts while Kiri is running, even in another app.")} {t("Click a shortcut to change it.")}</p>
              <p className="kiri-shortcut-instruction__recording" id="shortcut-recording-instruction" role="status" aria-hidden={editing === null}>{t("Press a key or combination. Esc cancels.")}</p>
            </div>}
        </div>
      </div>
      {!settings ? <div className="kiri-settings-card kiri-settings-empty-state" role={loadError ? "alert" : "status"}>
        <span>{t(loadError ? "Couldn't load shortcuts." : "Loading shortcuts…")}</span>
        {loadError && <button className="kiri-button kiri-button--secondary" type="button" onClick={() => void load()}>{t("Retry")}</button>}
      </div> : <div className="kiri-shortcut-action-groups">
        {(["global", "recording"] as const).map((scope) => {
          const actions = ACTIONS.filter(({ action }) => settings.some((setting) => setting.action === action && setting.scope === scope));
          if (!actions.length) return null;
          const groupSystemManaged = actions.every(({ action }) => settings.find((setting) => setting.action === action)?.status === "systemManaged");
          return <div className="kiri-shortcut-action-group" role="group" aria-labelledby={`shortcut-scope-${scope}`} data-shortcut-scope={scope} key={scope}>
            <div className={`kiri-shortcut-action-group__heading${scope === "global" ? " kiri-visually-hidden" : ""}`}>
              <h3 id={`shortcut-scope-${scope}`} title={scope === "recording" ? t(groupSystemManaged ? "Your desktop manages global shortcuts on Wayland." : "Only active while recording.") : undefined}>{t(scope === "recording" ? "While recording" : "Launch actions")}</h3>
            </div>
            <div className="kiri-settings-group kiri-global-shortcuts">
              {actions.map(({ action, title, description, icon, command }) => {
                const setting = settings.find((item) => item.action === action);
                if (!setting) return null;
                const isEditing = editing === action;
                const rowError = error?.action === action ? error.message : null;
                const pending = candidate?.action === action ? candidate : null;
                const canReset = !setting.isDefault || setting.status === "disabled";
                const descriptionId = `shortcut-description-${action}`;
                return <div className="kiri-global-shortcut" key={action} data-action={action} data-editing={isEditing || undefined}>
                  <div className="kiri-global-shortcut__identity">
                    <span className="kiri-global-shortcut__icon" aria-hidden="true"><KiriIcon name={icon} size={action === "capture" ? 18 : 19} /></span>
                    <div className="kiri-global-shortcut__copy">
                      <strong id={`shortcut-title-${action}`} title={t(description)}>{t(title)}</strong>
                      <span id={descriptionId} className="kiri-visually-hidden">{t(description)}</span>
                    </div>
                  </div>
                  {setting.status === "systemManaged" ? <code className="kiri-shortcut-command">{command}</code> : <>
                    <div className="kiri-global-shortcut__controls"
                      onBlur={(event) => {
                        if (editingRef.current === action && !event.currentTarget.contains(event.relatedTarget)) void stopEditing();
                      }}
                      onKeyDown={(event) => {
                        if (event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                        if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && editingRef.current === action) {
                          event.preventDefault(); event.stopPropagation(); void stopEditing();
                        }
                      }}>
                      <span className="kiri-shortcut-reset-slot">
                        {canReset && <button type="button" tabIndex={0} className="kiri-shortcut-reset" disabled={busy !== null || isEditing}
                          aria-label={fmt("Restore default shortcut for %@", t(title))} title={`${t("Restore Default")} · ${setting.defaultLabel}`}
                          onClick={() => void perform(action, () => api.resetActionShortcut(action))}><RotateCcw size={14} aria-hidden="true" /></button>}
                      </span>
                      <div className="kiri-shortcut-field" data-editing={isEditing || undefined} data-unset={!setting.label || undefined} aria-busy={busy === action}>
                        <button type="button" tabIndex={0} className="kiri-shortcut-recorder" disabled={busy !== null} title={t("Click a shortcut to change it.")}
                          aria-label={fmt("Edit shortcut for %@: %@", t(title), pending?.label ?? setting.label ?? t("Not set"))}
                          aria-describedby={`${descriptionId}${isEditing ? " shortcut-recording-instruction" : ""}${rowError || pending || setting.status === "occupied" ? ` shortcut-feedback-${action}` : ""}`}
                          aria-pressed={isEditing} onClick={(event) => void beginEditing(action, event.currentTarget)}
                          onKeyDown={(event) => recordKey(event, action)}>
                          <span className="kiri-shortcut-value">
                            {pending ? <span className="kiri-shortcut-chord">{pending.label}</span> : isEditing
                              ? <span className="kiri-shortcut-listening">{t("Press shortcut…")}</span>
                              : setting.label ? <span className="kiri-shortcut-chord" aria-hidden="true">{setting.label}</span> : <span className="kiri-shortcut-unset">{t("Set shortcut")}</span>}
                          </span>
                        </button>
                        {isEditing ? <button key="cancel" type="button" tabIndex={0} className="kiri-shortcut-cancel" aria-label={t("Cancel")} title={t("Cancel")}
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() => void stopEditing()}>Esc</button> : setting.label ?
                          <button key="clear" type="button" tabIndex={0} className="kiri-shortcut-clear" disabled={busy !== null}
                            aria-label={fmt("Clear shortcut for %@", t(title))} title={fmt("Clear shortcut for %@", t(title))}
                            onClick={() => void perform(action, () => api.setActionShortcut(action, null))}><X size={12} aria-hidden="true" /></button> :
                          <span className="kiri-shortcut-clear-placeholder" aria-hidden="true" />}
                      </div>
                      {(rowError || pending || setting.status === "occupied") && <div className="kiri-shortcut-feedback" id={`shortcut-feedback-${action}`}>
                        {rowError || (!pending && setting.status === "occupied") ? <>
                          <p className="kiri-shortcut-status--error" role="alert">{t(rowError ?? "This shortcut is in use by another app.")}</p>
                          {setting.status === "occupied" && <button type="button" tabIndex={0} className="kiri-shortcut-retry" disabled={busy !== null}
                            onClick={() => void perform(action, () => api.retryActionShortcut(action))}>{t("Retry")}</button>}
                        </> : pending && <>
                          <p role="status">{t(scope === "recording" ? "While recording, this key will also trigger in other apps." : "This key will also trigger while typing or navigating in other apps.")}</p>
                          <button type="button" tabIndex={0} className="kiri-shortcut-apply" onPointerDown={(event) => event.preventDefault()}
                            onClick={() => void perform(action, () => api.setActionShortcut(action, pending.shortcut))}>{t("Use this key")}</button>
                        </>}
                      </div>}
                    </div>
                    {busy === action && <span className="kiri-visually-hidden" role="status">{t("Saving…")}</span>}
                  </>}
                </div>;
              })}
            </div>
          </div>;
        })}
      </div>}
      {systemManaged && <PortalShortcutsCard />}
    </section>
    <ShortcutReference />
  </div>;
}

type ReferenceRow = [label: string, keys: string[]];
function ShortcutReference() {
  const mac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  const linux = /Linux/i.test(navigator.userAgent);
  const mod = mac ? "⌘" : "Ctrl";
  const shift = mac ? "⇧" : "Shift";
  const alt = mac ? "⌥" : "Alt";
  const groups: Array<{ title: string; rows: ReferenceRow[] }> = [
    { title: "Capture and image editing", rows: [
      ["Select", ["V"]], ["Pen", ["P"]], ["Rectangle", ["R"]], ["Line", ["L"]], ["Arrow", ["A"]], ["Text", ["T"]],
      ["Label bubble", ["B"]], ["Numbered callout", ["N"]], ["Mosaic", ["M"]], ["Watermark", ["W"]],
      ["Crop saved image", ["C"]], ["Finish screenshot / save image", ["Enter"]],
      ["Undo", [mod, "Z"]], ["Redo", [shift, mod, "Z"]], ["Delete selected annotation", ["Delete", "/", "⌫"]],
      ["Copy screenshot while annotating", [mod, "C"]], ["Copy color before annotating", [mod, "C"]],
      ["Cancel capture / close image editor", ["Esc"]], ["Cancel countdown", ["Esc"]],
    ] },
    { title: "Editing text", rows: [
      ["Finish text", ["Enter"]], ["New line", [shift, "Enter"]], ["Finish callout text", [mod, "Enter"]], ["Cancel text edit", ["Esc"]],
    ] },
    { title: "Library and previews", rows: [
      ["Search", [mod, "F"]], ["Select all in selection mode", [mod, "A"]], ["Paste image into library", [mod, "V"]],
      ["Copy focused capture or preview", [mod, "C"]], ["Open focused capture", ["Enter", "/", "Space"]],
      ["Clear selection / close menu", ["Esc"]], ["Close preview or pinned image", ["Esc", "/", mod, "W"]],
    ] },
    { title: "Video playback and editing", rows: [
      ["Play / pause video", ["Space"]], ["Seek 5 seconds in playback", ["←", "/", "→"]], ["Split clip", ["S"]],
      ["Delete selected clip or effect", ["Delete", "/", "⌫"]], ["Undo", [mod, "Z"]], ["Redo", [shift, mod, "Z"]],
      ["Save video project", [mod, "S"]], ["Close video", [mod, "W"]], ["Reorder focused clip", [alt, "←", "/", "→"]],
      ["Trim focused edge by 0.1 seconds", ["←", "/", "→"]], ["Trim focused edge by 1 second", [shift, "←", "/", "→"]],
      ...(!linux ? [["Reorder selected effect layer", [alt, "↑", "/", "↓"]] as ReferenceRow] : []),
    ] },
  ];
  return <section className="kiri-settings-section kiri-shortcut-reference" aria-labelledby="shortcut-reference-title">
    <div className="kiri-settings-section__heading"><div>
      <h2 id="shortcut-reference-title">{t("In-app Shortcuts")}</h2>
      <p>{t("These shortcuts apply within Kiri and cannot be changed here.")}</p>
    </div></div>
    <div className="kiri-shortcut-reference__groups">
      {groups.map((group, index) => <section key={group.title} className="kiri-shortcut-reference__group" aria-labelledby={`shortcut-reference-group-${index}`}>
        <h3 id={`shortcut-reference-group-${index}`}>{t(group.title)}</h3>
        <dl>{group.rows.map(([label, keys]) => <div key={label}>
          <dt>{t(label)}</dt><dd aria-label={keys.join(" ")}><ShortcutKeys keys={keys} /></dd>
        </div>)}</dl>
      </section>)}
    </div>
  </section>;
}
