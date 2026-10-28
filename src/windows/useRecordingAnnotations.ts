import {useEffect, useState} from "react";
import {api, onRecordingAnnotationsState, type RecordingAnnotationsState} from "../lib/ipc";

/** Subscribe before hydration; equal revisions can carry newer mode/readiness. */
export function useRecordingAnnotations(sessionId: string) {
  const [state, setState] = useState<RecordingAnnotationsState | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false, received = false;
    const subscription = onRecordingAnnotationsState(next => {
      if (disposed || next.sessionId !== sessionId) return;
      received = true;
      setFailed(false);
      setState(previous => previous && previous.revision > next.revision ? previous : next);
    });
    void subscription.then(() => api.getRecordingAnnotations(sessionId)).then(snapshot => {
      if (!disposed && !received) {setState(snapshot); setFailed(false);}
    }).catch(() => {if (!disposed) setFailed(true);});
    return () => {disposed = true; void subscription.then(stop => stop()).catch(() => {});};
  }, [sessionId]);
  return {state, failed};
}
