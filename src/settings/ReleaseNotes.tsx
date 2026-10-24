import { useMemo, useState, useSyncExternalStore } from "react";
import { getLanguage, onLanguageChange, t } from "../i18n";
import { preferredReleaseNotesLanguage, releaseNotesBlocks, releaseNotesInline, splitReleaseNotes } from "./release-notes.js";

function inline(text: string) {
  return releaseNotesInline(text).map((token, index) => {
    if (token.type === "strong") return <strong key={index}>{token.text}</strong>;
    if (token.type === "code") return <code key={index}>{token.text}</code>;
    if (token.type === "link") return <span key={index} className="kiri-release-notes__link" title={token.destination}>{token.text}</span>;
    return token.text;
  });
}

export function ReleaseNotes({ notes }: { notes: string }) {
  const locale = useSyncExternalStore(onLanguageChange, getLanguage, getLanguage);
  const parsed = useMemo(() => splitReleaseNotes(notes), [notes]);
  const [choice, setChoice] = useState<{ notes: string; locale: string; language: string } | null>(null);
  const language = choice?.notes === notes && choice.locale === locale
    ? choice.language : preferredReleaseNotesLanguage(parsed.languages, locale);
  const parts = parsed.parts.filter((part) => part.language === null || part.language === language);

  return (
    <section className="kiri-release-notes" aria-label={t("Release notes")}>
      <div className="kiri-release-notes__heading">
        <h3>{t("What's new")}</h3>
        {parsed.languages.length > 1 && (
          <div className="kiri-release-notes__languages" role="group" aria-label={t("Release notes")}>
            {parsed.languages.map((entry) => (
              <button key={entry.id} type="button" className="kiri-release-notes__language"
                aria-pressed={language === entry.id} lang={entry.id}
                onClick={() => setChoice({ notes, locale, language: entry.id })}>
                {entry.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="kiri-release-notes__content">
        {parts.map((part, index) => (
          <div key={index} className={part.language === null ? "kiri-release-notes__common" : undefined} lang={part.language ?? undefined}>
            {releaseNotesBlocks(part.text).map((block, blockIndex) => {
              if (block.type === "heading") return <h4 key={blockIndex} className="kiri-release-notes__block-heading">{inline(block.text)}</h4>;
              if (block.type === "code") return <pre key={blockIndex} className="kiri-release-notes__code"><code>{block.text}</code></pre>;
              if (block.type === "list") {
                const List = block.ordered ? "ol" : "ul";
                return <List key={blockIndex} className="kiri-release-notes__list">{block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</List>;
              }
              return <p key={blockIndex}>{inline(block.text)}</p>;
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
