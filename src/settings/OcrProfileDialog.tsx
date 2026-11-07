import { useEffect, useId, useState, type FormEvent, type MouseEvent } from "react";
import { t } from "../i18n";
import { isTextComposition, setTextComposition } from "../annotation/text-composition.js";
import type {
  OcrProviderPreset,
  OcrProviderProfileDto,
  SaveOcrProviderProfileRequest,
} from "../lib/ipc";
import { useDialogFocusTrap } from "./useDialogFocusTrap";

interface OcrProfileDialogProps {
  profile: OcrProviderProfileDto | null;
  busy: boolean;
  error: string | null;
  onCancel(): void;
  onSave(request: SaveOcrProviderProfileRequest): void;
}

const PROVIDER_DEFAULTS: Record<
  OcrProviderPreset,
  { name: string; baseUrl: string; model: string }
> = {
  aliyunBailian: {
    name: "Alibaba Cloud",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.5-ocr",
  },
  openAi: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-mini",
  },
  customOpenAi: {
    name: "Custom OCR",
    baseUrl: "",
    model: "",
  },
};

function defaultProfileName(provider: OcrProviderPreset): string {
  const name = PROVIDER_DEFAULTS[provider].name;
  return provider === "customOpenAi" ? t(name) : name;
}

function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function OcrProfileDialog({
  profile,
  busy,
  error,
  onCancel,
  onSave,
}: OcrProfileDialogProps) {
  const initialProvider = profile?.provider ?? "aliyunBailian";
  const defaults = PROVIDER_DEFAULTS[initialProvider];
  const [provider, setProvider] = useState<OcrProviderPreset>(initialProvider);
  const [name, setName] = useState(profile?.name ?? defaultProfileName(initialProvider));
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? defaults.baseUrl);
  const [model, setModel] = useState(profile?.model ?? defaults.model);
  const [apiKey, setApiKey] = useState("");
  const [baseUrlError, setBaseUrlError] = useState(false);
  const titleId = useId();
  const baseUrlErrorId = useId();
  const dialogRef = useDialogFocusTrap<HTMLDivElement>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy && !event.defaultPrevented && !isTextComposition(event)) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  const chooseProvider = (next: OcrProviderPreset) => {
    const nextDefaults = PROVIDER_DEFAULTS[next];
    setProvider(next);
    if (!name.trim() || name === defaultProfileName(provider)) {
      setName(defaultProfileName(next));
    }
    setBaseUrl(nextDefaults.baseUrl);
    setBaseUrlError(false);
    setModel(nextDefaults.model);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isValidBaseUrl(baseUrl)) {
      setBaseUrlError(true);
      return;
    }
    setBaseUrlError(false);
    const request: SaveOcrProviderProfileRequest = {
      name: name.trim(),
      provider,
      protocol: "openAiChatCompletions",
      baseUrl: baseUrl.trim(),
      model: model.trim(),
    };
    if (profile) {
      request.id = profile.id;
      request.revision = profile.revision;
    }
    // API keys are write-only. An empty field on edit deliberately omits the
    // property so the backend keeps the credential already in secure storage.
    if (apiKey.trim()) request.apiKey = apiKey.trim();
    onSave(request);
  };

  const dismissFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !busy) onCancel();
  };

  return (
    <div className="kiri-settings-dialog-backdrop" onMouseDown={dismissFromBackdrop}>
      <div
        ref={dialogRef}
        className="kiri-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onCompositionStartCapture={(event) => setTextComposition(event.target, true)}
        onCompositionEndCapture={(event) => setTextComposition(event.target, false)}
        onBlurCapture={(event) => setTextComposition(event.target, false)}
      >
        <form onSubmit={submit}>
          <div className="kiri-settings-dialog__header">
            <div>
              <h2 id={titleId}>{profile ? t("Edit OCR Profile") : t("Add OCR Profile")}</h2>
              <p>{t("Kiri stores the API key in your operating system's secure credential store.")}</p>
            </div>
          </div>

          <div className="kiri-settings-form-grid">
            <label className="kiri-settings-field">
              <span>{t("Profile Name")}</span>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={80}
                disabled={busy}
              />
            </label>

            <label className="kiri-settings-field">
              <span>{t("Provider")}</span>
              <select
                value={provider}
                onChange={(event) => chooseProvider(event.target.value as OcrProviderPreset)}
                disabled={busy}
              >
                <option value="aliyunBailian">{t("Alibaba Cloud Model Studio")}</option>
                <option value="openAi">OpenAI</option>
                <option value="customOpenAi">{t("Custom OpenAI-compatible")}</option>
              </select>
            </label>

            <label className="kiri-settings-field kiri-settings-field--wide">
              <span>{t("Base URL")}</span>
              <input
                type="text"
                inputMode="url"
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setBaseUrlError(false);
                }}
                placeholder={t("Enter the provider endpoint")}
                required
                spellCheck={false}
                disabled={busy}
                aria-invalid={baseUrlError}
                aria-describedby={baseUrlError ? baseUrlErrorId : undefined}
              />
              <small>{t("Kiri automatically appends /chat/completions.")}</small>
              {baseUrlError && (
                <small id={baseUrlErrorId} className="kiri-settings-field-error" role="alert">
                  {t("Enter a valid HTTP or HTTPS Base URL without credentials, query parameters, or fragments.")}
                </small>
              )}
            </label>

            <label className="kiri-settings-field">
              <span>{t("Model")}</span>
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={t("Enter a model name")}
                required
                spellCheck={false}
                disabled={busy}
              />
            </label>

            <label className="kiri-settings-field">
              <span>{t("API Key")}</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  profile?.hasApiKey
                    ? t("Leave blank to keep the saved key")
                    : t("Paste an API key")
                }
                autoComplete="new-password"
                spellCheck={false}
                disabled={busy}
              />
            </label>
          </div>

          {profile?.hasApiKey && (
            <p className="kiri-settings-key-note">
              {t("A key is already saved. Enter a new one only to replace it.")}
            </p>
          )}

          {error && (
            <div className="kiri-settings-form-error" role="alert">
              {error}
            </div>
          )}

          <div className="kiri-settings-dialog__actions">
            <button
              type="button"
              className="kiri-button kiri-button--secondary"
              onClick={onCancel}
              disabled={busy}
            >
              {t("Cancel")}
            </button>
            <button
              type="submit"
              className="kiri-button kiri-button--primary"
              disabled={busy}
            >
              {busy ? t("Saving…") : t("Save Profile")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
