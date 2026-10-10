// Some WebViews report isComposing=false on the IME's confirming keydown.
// Track the actual textarea lifecycle too, including window capture handlers.
const composingTargets = new WeakSet();

export function setTextComposition(target, active) {
  if (active) composingTargets.add(target);
  else composingTargets.delete(target);
}

export function isTextComposition(event) {
  const native = event.nativeEvent ?? event;
  const target = native.target ?? event.target;
  return native.isComposing === true || native.keyCode === 229 ||
    (target != null && composingTargets.has(target));
}

/** Use the focused browser editor's history, independently of GTK key bindings. */
export function handleTextEditorKey(event, actions, nativeUndo) {
  if (!isTextComposition(event)) {
    if (event.key === "Escape") {
      event.preventDefault();
      actions.cancel();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      if (nativeUndo) {
        // Standalone WebKitGTK does not bind Ctrl+Z like a full browser does.
        // A successful native command must suppress the platform default so
        // WebView2/WebKit on other platforms cannot undo twice. Empty or
        // unsupported history keeps the platform's default as a fallback.
        if (actions.nativeHistory?.(event.shiftKey ? "redo" : "undo")) {
          event.preventDefault();
        }
      } else {
        event.preventDefault();
        actions.commit();
        if (event.shiftKey) actions.redo();
        else actions.undo();
      }
    } else if (event.key === "Enter" && !event.shiftKey && (!actions.multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      actions.commit();
      actions.finish?.();
    }
  }
  event.stopPropagation();
}
