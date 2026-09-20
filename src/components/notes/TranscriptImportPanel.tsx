import React, { useRef, useState } from "react";
import { FileText, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
  MAX_TRANSCRIPT_IMPORT_BYTES,
  TranscriptImportError,
  findImportedTranscriptNote,
  parseTranscriptImport,
  serializeImportedTranscript,
  transcriptImportFingerprint,
  transcriptImportSource,
} from "../../services/transcriptImport";
import { uploadTitleFallback } from "../../services/uploadNotes";

interface TranscriptImportPanelProps {
  folderId: number | null;
  onNoteCreated?: (noteId: number, folderId: number | null) => void;
}

type ImportResult = { noteId: number; duplicate: boolean } | null;
type PendingImportResult = NonNullable<ImportResult>;

// A file picker can fire twice before React disables the button. Keep the
// dedupe decision atomic within the renderer so a stale getNotes() snapshot
// cannot create two notes from the same selected content.
const pendingImports = new Map<string, Promise<PendingImportResult>>();

export default function TranscriptImportPanel({
  folderId,
  onNoteCreated,
}: TranscriptImportPanelProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult>(null);

  const openFilePicker = () => inputRef.current?.click();

  const handleFile = async (file: File | undefined) => {
    if (!file || isImporting) return;
    setError(null);
    setResult(null);
    if (file.size > MAX_TRANSCRIPT_IMPORT_BYTES) {
      setError(t("notes.upload.importTooLarge"));
      return;
    }

    setIsImporting(true);
    try {
      const source = await file.text();
      const parsed = parseTranscriptImport(file.name, source);
      const fingerprint = await transcriptImportFingerprint(source);
      const prior = pendingImports.get(fingerprint);
      if (prior) {
        const completed = await prior;
        setResult({ noteId: completed.noteId, duplicate: true });
        return;
      }

      const persist = (async (): Promise<PendingImportResult> => {
        const existing = findImportedTranscriptNote(
          await window.electronAPI.getNotes("upload", 100000, null),
          fingerprint
        );
        if (existing) return { noteId: existing.id, duplicate: true };

        const title = parsed.title || uploadTitleFallback(parsed.text, file.name);
        const saved = await window.electronAPI.saveNote(
          title,
          parsed.text,
          "upload",
          transcriptImportSource(file.name, fingerprint),
          null,
          folderId
        );
        if (!saved.success || !saved.note) throw new Error("saveFailed");

        const updated = await window.electronAPI.updateNote(saved.note.id, {
          transcript: serializeImportedTranscript(parsed.segments),
        });
        if (!updated.success) {
          // A note without its imported transcript is not a successful import
          // and would otherwise reserve this fingerprint on a later retry.
          await window.electronAPI.deleteNote(saved.note.id).catch(() => {});
          throw new Error("saveFailed");
        }
        return { noteId: saved.note.id, duplicate: false };
      })();
      pendingImports.set(fingerprint, persist);
      try {
        setResult(await persist);
      } finally {
        if (pendingImports.get(fingerprint) === persist) pendingImports.delete(fingerprint);
      }
    } catch (cause) {
      if (cause instanceof TranscriptImportError) {
        setError(t(`notes.upload.import${cause.code[0].toUpperCase()}${cause.code.slice(1)}`));
      } else {
        setError(t("notes.upload.importFailed"));
      }
    } finally {
      setIsImporting(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <section className="mt-5 border-t border-foreground/6 pt-4 text-center">
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.md,.srt,.vtt,.json,text/plain,text/markdown,application/json"
        className="sr-only"
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />
      <div className="flex items-center justify-center gap-2 text-xs font-medium text-foreground/75">
        <FileText size={14} aria-hidden="true" />
        {t("notes.upload.importTranscript")}
      </div>
      <p className="mt-1 text-[11px] text-foreground/45">{t("notes.upload.importDescription")}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3 h-8 text-xs"
        onClick={openFilePicker}
        disabled={isImporting}
      >
        <Upload size={13} className="mr-1.5" aria-hidden="true" />
        {isImporting ? t("notes.upload.importing") : t("notes.upload.importChooseFile")}
      </Button>
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      {result && (
        <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-foreground/55">
          <span>
            {t(result.duplicate ? "notes.upload.importDuplicate" : "notes.upload.importComplete")}
          </span>
          {onNoteCreated && (
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => onNoteCreated(result.noteId, folderId)}
            >
              {t("notes.upload.openNote")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
