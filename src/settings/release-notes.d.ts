export interface ReleaseNotesLanguage { id: string; label: string }
export interface ReleaseNotesPart { language: string | null; text: string }
export interface ReleaseNotesInline { type: "text" | "strong" | "code" | "link"; text: string; destination?: string }
export type ReleaseNotesBlock =
  | { type: "paragraph" | "heading" | "code"; text: string }
  | { type: "list"; ordered: boolean; items: string[] };
export function splitReleaseNotes(notes: string): { parts: ReleaseNotesPart[]; languages: ReleaseNotesLanguage[] };
export function preferredReleaseNotesLanguage(languages: ReleaseNotesLanguage[], locale: string): string | null;
export function releaseNotesInline(text: string): ReleaseNotesInline[];
export function releaseNotesBlocks(text: string): ReleaseNotesBlock[];
