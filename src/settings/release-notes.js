const languageHeading = (label) => {
  if (/^english$/i.test(label)) return "en";
  if (/^(?:中文|简体中文|繁體中文|繁体中文|chinese)$/i.test(label)) return "zh";
  return null;
};

const headingLine = (line) => {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
  return match && { level: match[1].length, text: match[2].replace(/\s+#+$/, "") };
};

const closesFence = (line, marker, fence) => marker[0] === fence[0]
  && marker.length >= fence.length && line.trim() === marker;

/** Split only explicit language headings; all other sections remain readable. */
export function splitReleaseNotes(notes) {
  const parts = [];
  const languages = [];
  let language = null;
  let languageLevel = 0;
  let lines = [];
  let fence = null;
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) parts.push({ language, text });
    lines = [];
  };
  for (const line of notes.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (closesFence(line, marker[1], fence)) fence = null;
      lines.push(line);
      continue;
    }
    const heading = !fence && headingLine(line);
    const nextLanguage = heading && languageHeading(heading.text);
    if (nextLanguage) {
      flush();
      language = nextLanguage;
      languageLevel = heading.level;
      if (!languages.some((entry) => entry.id === language)) {
        languages.push({ id: language, label: heading.text });
      }
    } else {
      if (heading && language && heading.level <= languageLevel) {
        flush();
        language = null;
      }
      lines.push(line);
    }
  }
  flush();
  return { parts, languages };
}

export function preferredReleaseNotesLanguage(languages, locale) {
  const preferred = /^zh(?:-|_|$)/i.test(locale) ? "zh" : "en";
  return languages.find((entry) => entry.id === preferred)?.id
    ?? languages.find((entry) => entry.id === "en")?.id
    ?? languages[0]?.id
    ?? null;
}

/** A deliberately small Markdown subset. No HTML or executable URLs. */
export function releaseNotesInline(text) {
  const tokens = [];
  const expression = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|!?\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
  let end = 0;
  for (const match of text.matchAll(expression)) {
    if (match.index > end) tokens.push({ type: "text", text: text.slice(end, match.index) });
    if (match[1]) tokens.push({ type: "code", text: match[2] });
    else if (match[3]) tokens.push({ type: "strong", text: match[3] });
    else tokens.push({ type: "link", text: match[4], destination: match[5] });
    end = match.index + match[0].length;
  }
  if (end < text.length) tokens.push({ type: "text", text: text.slice(end) });
  return tokens;
}

export function releaseNotesBlocks(text) {
  const blocks = [];
  let paragraph = [];
  let list = null;
  let fence = null;
  let code = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    if (list) blocks.push(list);
    paragraph = [];
    list = null;
  };
  for (const line of text.split("\n")) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) { flush(); fence = marker[1]; }
      else if (closesFence(line, marker[1], fence)) {
        blocks.push({ type: "code", text: code.join("\n") });
        fence = null;
        code = [];
      } else code.push(line);
      continue;
    }
    if (fence) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    const heading = headingLine(line);
    if (heading) { flush(); blocks.push({ type: "heading", text: heading.text }); continue; }
    const item = line.match(/^\s{0,3}(?:([-*+])|\d+[.)])\s+(.+)$/);
    if (item) {
      const ordered = !item[1];
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { type: "list", ordered, items: [] };
      list.items.push(item[2]);
    } else if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  if (fence && code.length) blocks.push({ type: "code", text: code.join("\n") });
  return blocks;
}
