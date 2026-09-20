import React, { useRef, useState } from "react";
import { FileText, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
  MAX_TRANSCRIPT_IMPORT_BYTES,
  TranscriptImportError,
  parseTranscriptImport,
  serializeImportedTranscript,
  transcriptImportFingerprint,
  transcriptImportSource,
} from "../../services/transcriptImport";
import { uploadTitleFallback } from "../../services/uploadNotes";

interface TranscriptImportPanelProps {
  folderId: number | null;
  onNoteCreated?: (noteId: number, folderId: number | null, spaceId?: number) => void;
}

type ImportResult = {
  noteId: number;
  folderId: number | null;
  spaceId: number;
  duplicate: boolean;
} | null;

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
      const title = parsed.title || uploadTitleFallback(parsed.text, file.name);
      // The main-process transaction checks the fingerprint and writes the
      // note plus transcript together, so concurrent picker events cannot
      // reserve an empty note or create duplicate imports.
      const saved = await window.electronAPI.saveTranscriptImportNote({
        title,
        content: parsed.text,
        sourceFile: transcriptImportSource(file.name, fingerprint),
        transcript: serializeImportedTranscript(parsed.segments),
        folderId,
      });
      if (!saved.success || !saved.note) throw new Error("saveFailed");
      setResult({
        noteId: saved.note.id,
        folderId: saved.note.folder_id ?? null,
        spaceId: saved.note.space_id,
        duplicate: saved.duplicate === true,
      });
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
              onClick={() => onNoteCreated(result.noteId, result.folderId, result.spaceId)}
            >
              {t("notes.upload.openNote")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
