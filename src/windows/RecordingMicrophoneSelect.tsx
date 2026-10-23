import { useEffect, useRef, useState } from "react";
import { ChoiceSelect } from "../components/ChoiceSelect";
import { t } from "../i18n";
import { api, type RecordingOptions } from "../lib/ipc";

export default function RecordingMicrophoneSelect({ options, disabled, onChange }: {
  options: RecordingOptions; disabled: boolean; onChange(options: RecordingOptions): void;
}) {
  const [devices, setDevices] = useState<{ id: string; name: string }[]>([]);
  const [status, setStatus] = useState<"unloaded" | "loading" | "ready" | "failed">("unloaded");
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const refresh = () => {
    const current = ++request.current;
    setStatus("loading");
    void api.listMicrophoneDevices().then(value => {
      if (current !== request.current) return;
      setDevices(value);
      setStatus("ready");
    }).catch(() => {
      if (current === request.current) setStatus("failed");
    });
  };
  const selectedUnavailable = status === "ready" && !!options.microphoneDeviceId && !devices.some(device => device.id === options.microphoneDeviceId);
  const missingValueLabel = status === "loading" ? t("Loading microphones…")
    : status === "failed" ? t("Unable to load microphones")
      : selectedUnavailable ? t("Selected microphone is unavailable") : t("Choose microphone");
  return <ChoiceSelect value={options.microphoneDeviceId ?? ""} disabled={disabled}
    missingValueLabel={missingValueLabel}
    label={t("Choose microphone")} menuHeader={t("Choose microphone")}
    className="kiri-record-options__microphone" menuClassName="kiri-record-device-menu" menuMinWidth={280}
    menuStatus={status === "loading" ? t("Loading microphones…") : status === "failed" ? t("Unable to load microphones")
      : selectedUnavailable ? t("Selected microphone is unavailable") : undefined}
    options={[{ value: "", label: t("System default microphone") }, ...devices.map(device => ({ value: device.id, label: device.name }))]}
    onOpen={refresh} onChange={id => onChange({ ...options, usesCountdown: true, capturesMicrophone: true, microphoneDeviceId: id || null })} />;
}
