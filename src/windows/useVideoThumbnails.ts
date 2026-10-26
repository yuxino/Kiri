import { useEffect, useState } from "react";

/** One decoder and twelve small frames, independent of recording length. */
export function useVideoThumbnails(src: string, duration: number, enabled: boolean, revision = 0) {
  const [frames, setFrames] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || !Number.isFinite(duration) || duration <= 0) return;
    let cancelled = false;
    const decoder = document.createElement("video");
    decoder.crossOrigin = "anonymous";
    decoder.muted = true;
    decoder.preload = "auto";
    decoder.playsInline = true;
    const pending = new Set<() => void>();
    const wait = (event: string) => new Promise<void>((resolve, reject) => {
      const dispose = () => {
        clearTimeout(timeout); decoder.removeEventListener(event, done);
        decoder.removeEventListener("error", error); pending.delete(abort);
      };
      const done = () => { dispose(); resolve(); };
      const error = () => { dispose(); reject(new Error("thumbnail decode failed")); };
      const abort = () => { dispose(); reject(new Error("thumbnail decode cancelled")); };
      const timeout = window.setTimeout(error, 8000);
      pending.add(abort);
      decoder.addEventListener(event, done, {once:true});
      decoder.addEventListener("error", error, {once:true});
    });
    setFrames([]); setFailed(false);
    void (async () => {
      const ready = wait("loadeddata");
      decoder.src = src;
      await ready;
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = Math.max(1, Math.round(160 * decoder.videoHeight / decoder.videoWidth));
      // Bound memory even for extremely tall videos.
      if (canvas.height > 160) { canvas.width = Math.max(1, Math.round(160*decoder.videoWidth/decoder.videoHeight)); canvas.height=160; }
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("thumbnail canvas unavailable");
      const result: string[]=[];
      for (let index=0;index<12;index++) {
        if(cancelled) return;
        const time = Math.min(duration - Math.min(0.001,duration/2), duration*(index+0.5)/12);
        if (Math.abs(decoder.currentTime-time)>0.0001) {
          const sought=wait("seeked"); decoder.currentTime=time; await sought;
        }
        if(cancelled) return;
        ctx.drawImage(decoder,0,0,canvas.width,canvas.height);
        result.push(canvas.toDataURL("image/jpeg",0.65));
        setFrames([...result]);
      }
    })().catch(() => { if(!cancelled) setFailed(true); });
    return () => {
      cancelled=true; pending.forEach(abort=>abort()); decoder.pause();
      decoder.removeAttribute("src"); decoder.load();
    };
  },[src,duration,enabled,revision]);
  return {frames,failed};
}
