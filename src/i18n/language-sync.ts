/** Subscribe before reading preferences, and never let a stale startup read
 * overwrite a language change received while the window is opening. */
export async function initializeLanguage(options: {
  subscribe: (change: (language: string) => void) => Promise<unknown>;
  getSaved: () => Promise<string>;
  getLocale: () => Promise<string>;
  accept: (language: string) => boolean;
}): Promise<void> {
  let changed = false;
  await options.subscribe((language) => {
    if (options.accept(language)) changed = true;
  }).catch(() => {});
  const saved = await options.getSaved().catch(() => "");
  if (changed) return;
  if (options.accept(saved)) return;
  const locale = await options.getLocale().catch(() => "");
  if (!changed) options.accept(locale);
}
