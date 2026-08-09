// Bringing a CSV in.
//
// The engine has streamed CSV imports since the first phase — encoding detection, delimiter
// detection, batched inserts, header de-duplication, ragged-row reporting — and for one turn this
// screen exposed exactly none of its choices: every import created every column, named whatever the
// file said, with no way to skip a column, rename one, aim one at a column the sheet already has,
// or drop duplicate rows. All of that was already in ImportOptions; the screen just never sent it.
//
// The shape is a mapping table, one row per CSV column: where does this land? Into a column the
// sheet already has, into a new one (renameable before it exists), or nowhere. The default is not
// neutral — a CSV header that matches an existing column is pre-aimed at it, because importing
// "Email" into a sheet that has an Email column and getting "Email (2)" is never what anyone meant.

import { useEffect, useRef, useState } from "react";
import { IconPlus } from "../ui/Icon.tsx";
import { Select } from "../ui/Select.tsx";
import { api } from "../api.ts";
import type { Column } from "../api.ts";
import "./CsvImport.css";

/** How much of the file's head the browser sends for the instant preview. The engine reads at most
 *  ~64KB for a preview; 128KB is a comfortable margin that still posts in a blink. */
const HEAD_BYTES = 128 * 1024;

interface Preview {
  headers: string[];
  sampleRows: string[][];
  inferredTypes: string[];
  delimiter: string;
  encoding: string;
  raggedCount: number;
  /** The file had a quote that never closed, so it was read with quoting off — quotes are literal. */
  quotesDisabled: boolean;
}

/** Mirrors `ImportResult` in src/csv.ts, plus the row count the route appends. */
interface Result {
  rowsInserted: number;
  duplicatesSkipped: number;
  /** Rows the TABLE's own duplicate rule removed after the import, when it is set to run itself. */
  dedupedAfter: number;
  /** Rows whose field count differed from the header. They are PADDED or truncated and imported —
   *  this was `raggedSkipped` back when they were discarded, and reading the old name here meant
   *  the number rendered as nothing at all. */
  raggedFixed: number;
  /** Headers the file repeated. Each repeat became its own suffixed column rather than overwriting
   *  the first one, so the user has two columns where the file said one name. */
  duplicateHeaders: string[];
  /** What the file was finally decoded as, after any mid-stream correction away from UTF-8. */
  encoding: "utf8" | "latin1";
  /** A quote that never closed forced quoting off, so every quote was kept as a literal character. */
  quotesDisabled: boolean;
  columnsCreated: number;
  ms: number;
  rowCount: number;
}

/** One CSV column's fate. Mirrors the engine's ImportMapping. */
interface Mapping {
  /** "new" | "skip" | an existing column id. */
  target: string;
  /** The name a NEW column gets. Editable before it exists — after is a rename plus a regret. */
  name: string;
}

interface Props {
  sheetId: string;
  /** The sheet's existing columns — half of what a CSV column can land in. */
  columns: Column[];
  onImported: () => void;
}

const DELIMITER_NAME: Record<string, string> = {
  ",": "commas",
  ";": "semicolons",
  "\t": "tabs",
  "|": "bars",
};

/** Same normalization the engine keys columns by, so the auto-aim agrees with what import would do. */
const keyOf = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** A byte count in the largest unit that keeps it short — GB for the files this progress is FOR. */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * POST the file to the upload route, reporting how much of it has been SENT.
 *
 * `fetch` cannot report upload progress; only XHR's `upload.onprogress` can. The route streams the
 * body to disk, so progress here tracks the real slow operation — the bytes crossing to the engine
 * and landing on disk — rather than a spinner that says nothing while a gigabyte transfers. The
 * response shape is the upload route's JSON, unchanged.
 */
function uploadCsv(
  f: File,
  onProgress: (fraction: number) => void,
  register?: (xhr: XMLHttpRequest) => void,
): Promise<{ path?: string; bytes?: number; preview?: Preview; error?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register?.(xhr);
    xhr.open("POST", "/api/csv/upload");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      try { resolve(JSON.parse(xhr.responseText)); }
      catch { reject(new Error("The engine's answer could not be read.")); }
    };
    xhr.onerror = () => reject(new Error("The upload could not reach the engine."));
    // Choosing a different file (or closing) aborts the in-flight stage; that is not a failure.
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    xhr.send(f);
  });
}

export function CsvImport({ sheetId, columns, onImported }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  /** The in-flight import's aborter, so the Cancel button can stop it. null when not importing. */
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<{ name: string; path: string; bytes: number } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  /** CSV column index whose repeated values mean "same row, skip it". -1 is off. */
  const [dedupeOn, setDedupeOn] = useState(-1);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"upload" | "import" | null>(null);
  /** Rows written so far during an import, streamed from the engine. null when not importing. */
  const [progress, setProgress] = useState<number | null>(null);
  /** Fraction (0–1) of the file's bytes sent to the engine during the upload, and the total to send. */
  const [uploadFrac, setUploadFrac] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The file the user picked, known immediately from the head preview — before the full upload
   *  has finished staging it to disk. `file` (with a staged path) arrives only when staging is done. */
  const [picked, setPicked] = useState<{ name: string; bytes: number } | null>(null);
  /** True while the whole file uploads in the background, after the mapping screen is already shown. */
  const [staging, setStaging] = useState(false);
  /** The user pressed Import before the background upload finished; fire it the moment it lands. */
  const [queuedImport, setQueuedImport] = useState(false);
  /** The in-flight background upload, so choosing a different file can abort it. */
  const stageXhrRef = useRef<XMLHttpRequest | null>(null);

  /** Stage the WHOLE file to disk in the background while the user maps columns. The import needs the
   *  complete file on disk, but the mapping screen only ever needed the head — so this runs behind it
   *  instead of in front of it. Sets `file` (with the staged path) when it lands. */
  const stageFull = async (f: File) => {
    setStaging(true);
    setUploadFrac(0);
    setUploadTotal(f.size);
    try {
      const res = await uploadCsv(f, setUploadFrac, (xhr) => { stageXhrRef.current = xhr; });
      if (res.error || !res.path) { setError(res.error ?? "The file could not be uploaded."); return; }
      setFile({ name: f.name, path: res.path, bytes: res.bytes ?? f.size });
    } catch (e) {
      // An abort (the user picked a different file, or closed) is silent; a real failure is shown.
      if (!(e instanceof DOMException && e.name === "AbortError")) setError("The file could not be uploaded.");
    } finally {
      stageXhrRef.current = null;
      setStaging(false);
    }
  };

  const take = async (f: File) => {
    if (!f) return;
    // A new pick abandons any upload still staging from the last one.
    stageXhrRef.current?.abort();
    stageXhrRef.current = null;
    setStaging(false);
    setError(null);
    setResult(null);
    setFile(null);
    setPreview(null);
    setMappings([]);
    setProgress(null);
    setQueuedImport(false);
    setPicked({ name: f.name, bytes: f.size });

    // 1. Show the mapping screen at once, from the file's head alone — no waiting for the whole
    //    file to cross to the engine. This is the change that makes "select file → see columns"
    //    feel instant on a file of any size.
    setBusy("upload");
    let preview: Preview;
    try {
      preview = await api.previewHead(f.slice(0, HEAD_BYTES));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
      setPicked(null);
      setBusy(null);
      return;
    }
    setPreview(preview);
    // Pre-aim each CSV column at an existing column when the names match. The engine would do the
    // same quietly for "new" targets, but a default the screen SHOWS is one the user can veto.
    const byKey = new Map(columns.map((c) => [keyOf(c.name), String(c.id)]));
    setMappings(preview.headers.map((h) => ({ target: byKey.get(keyOf(h)) ?? "new", name: h })));
    // An email-ish column is the natural dedupe key; suggested, never forced.
    setDedupeOn(preview.headers.findIndex((h) => /email/i.test(h)));
    setBusy(null);

    // 2. Stage the rest of the file in the background so it is on disk by the time Import is pressed.
    void stageFull(f);
  };

  // If Import was pressed while the file was still staging, fire it the instant staging completes.
  useEffect(() => {
    if (queuedImport && file?.path && !staging) {
      setQueuedImport(false);
      void doImport(file.path);
    }
    // doImport is intentionally omitted: the effect runs after render, so it closes over the current
    // preview/mappings/dedupe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedImport, file, staging]);

  const doImport = async (stagedPath?: string) => {
    const path = stagedPath ?? file?.path;
    if (!path || !preview) return;
    setBusy("import");
    setError(null);
    setProgress(0);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/sheets/${sheetId}/import`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          mappings: mappings.map((m) =>
            m.target === "new"
              ? { target: "new", name: m.name.trim() || undefined }
              : { target: m.target },
          ),
          dedupeOnIndex: dedupeOn >= 0 && mappings[dedupeOn]?.target !== "skip" ? dedupeOn : undefined,
        }),
      });

      // A pre-stream rejection ("File not found") is a plain JSON error with a 4xx; only a started
      // import streams. Read the body either way.
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        setError(j?.error ?? "Could not reach the engine.");
        return;
      }

      // Newline-delimited JSON: `progress` lines while it runs, then one `done` or `error` line. The
      // row count is read off the progress lines so the footer can count up as rows land.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let done: Result | null = null;
      let streamError: string | null = null;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          const ev = JSON.parse(raw) as
            | { type: "progress"; rows: number }
            | { type: "done"; result: Result }
            | { type: "cancelled" }
            | { type: "error"; error: string };
          if (ev.type === "progress") setProgress(ev.rows);
          else if (ev.type === "done") done = ev.result;
          else if (ev.type === "error") streamError = ev.error;
          // "cancelled" needs no handling — the abort path below already reset the screen.
        }
      }

      if (streamError) { setError(streamError); return; }
      if (done) { setResult(done); onImported(); }
    } catch (e) {
      // The Cancel button aborts the fetch, which lands here. It is not an error: the engine rolled
      // the rows back, so the screen goes back to the mapping with a plain note and the grid refreshes.
      if (e instanceof DOMException && e.name === "AbortError") {
        setError("Import cancelled — nothing was added to the table.");
        onImported();
      } else {
        setError("Could not reach the engine.");
      }
    } finally {
      abortRef.current = null;
      setBusy(null);
      setProgress(null);
    }
  };

  /** Cancel a running import: abort the request, which the engine sees and rolls back. */
  const cancelImport = () => abortRef.current?.abort();

  if (result) {
    return (
      <div className="cc-csv__done">
        <div className="cc-modal__stat"><span className="cc-modal__stat-label">Rows added</span><span className="cc-modal__stat-value mono">{result.rowsInserted.toLocaleString()}</span></div>
        <div className="cc-modal__stat"><span className="cc-modal__stat-label">Columns created</span><span className="cc-modal__stat-value mono">{result.columnsCreated.toLocaleString()}</span></div>
        {result.duplicatesSkipped > 0 && (
          <div className="cc-modal__stat"><span className="cc-modal__stat-label">Duplicates skipped</span><span className="cc-modal__stat-value mono">{result.duplicatesSkipped.toLocaleString()}</span></div>
        )}
        {/* The table's OWN rule, which runs itself when it is set to. The engine has always
            reported this and the screen never showed it — so an import into a sheet with automatic
            deduplication on could remove rows and the summary said only how many arrived. Rows
            leaving is the half nobody expects. */}
        {(result.dedupedAfter ?? 0) > 0 && (
          <div className="cc-modal__stat">
            <span className="cc-modal__stat-label">Removed by this table's duplicate rule</span>
            <span className="cc-modal__stat-value mono">{result.dedupedAfter.toLocaleString()}</span>
          </div>
        )}
        {/* Reported rather than buried. These rows DID arrive — short ones were padded and long
            ones lost only their extras — but a value landing in the wrong column is the failure
            this number is the only warning of. */}
        {(result.raggedFixed ?? 0) > 0 && (
          <div className="cc-modal__stat"><span className="cc-modal__stat-label">Rows padded to fit the header</span><span className="cc-modal__stat-value mono">{result.raggedFixed.toLocaleString()}</span></div>
        )}
        {/* A column the user did not ask for. The engine suffixes a repeated header to "Email (2)"
            rather than letting the second one overwrite the first, which is the right answer — but
            unsaid it looks like the import invented a column. */}
        {(result.duplicateHeaders?.length ?? 0) > 0 && (
          <div
            className="cc-modal__stat"
            title="The file used the same heading more than once. Each repeat became its own column rather than overwriting the first, so nothing was lost — the arrow shows where the repeat ended up."
          >
            <span className="cc-modal__stat-label">Repeated headers</span>
            {/* Truncated, not wrapped: the row is a fixed 26px and a file with eight repeats would
                otherwise grow it and shuffle everything below. */}
            <span className="cc-modal__stat-value truncate">{result.duplicateHeaders.join(", ")}</span>
          </div>
        )}
        {/* Only when it is NOT plain UTF-8. The preview says what it expects to read the file as;
            this says what it actually did, because the engine retries in Windows-1252 mid-stream and
            an accent that survived is the only other evidence that happened. */}
        {result.encoding === "latin1" && (
          <div className="cc-modal__stat">
            <span className="cc-modal__stat-label">Read as</span>
            <span className="cc-modal__stat-value">Windows-1252</span>
          </div>
        )}
        {result.quotesDisabled && (
          <div className="cc-csv__warn" role="status">
            This file had a quote that was never closed, so it was read with quoting off — every{" "}
            <span className="mono">&quot;</span> was kept as part of the text. If a field used quotes to
            hold a comma, that field split into more than one column; check those before you rely on them.
          </div>
        )}
        <p className="cc-csv__note">
          The sheet now has {result.rowCount.toLocaleString()} rows. Took {(result.ms / 1000).toFixed(1)}s.
        </p>
        <button
          className="cc-btn cc-btn--xs"
          onClick={() => { setResult(null); setFile(null); setPreview(null); setPicked(null); setStaging(false); setQueuedImport(false); }}
        >
          Import another file
        </button>
      </div>
    );
  }

  const landing = mappings.filter((m) => m.target !== "skip").length;

  return (
    <div className="cc-csv">
      <div
        className={`cc-csv__drop${dragging ? " cc-csv__drop--over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void take(f);
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.txt,text/csv"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void take(f); }}
        />
        <p className="cc-csv__droptext">
          {busy === "upload"
            ? "Reading the file…"
            : staging
              ? `Uploading ${fmtSize(uploadTotal * uploadFrac)} of ${fmtSize(uploadTotal)} · ${Math.round(uploadFrac * 100)}%`
              : picked ? picked.name : "Drop a CSV here, or"}
        </p>
        {/* The bar tracks the FULL file crossing to the engine in the background — the mapping table
            below is already usable while it climbs. */}
        {staging && (
          <div
            className="cc-csv__bar"
            role="progressbar"
            aria-valuenow={Math.round(uploadFrac * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="cc-csv__bar-fill" style={{ width: `${Math.round(uploadFrac * 100)}%` }} />
          </div>
        )}
        {busy !== "upload" && (
          <button className="cc-btn" onClick={() => fileRef.current?.click()}>
            <IconPlus /> <span>{picked ? "Choose a different file" : "Choose a file"}</span>
          </button>
        )}
      </div>

      {error && <div className="cc-csv__error" role="alert">{error}</div>}

      {preview && (
        <>
          {/* Encoding and delimiter first, because both are silent failures. A cp1252 file read as
              UTF-8 does not error — it just turns every é into a pair of wrong characters, in every
              row, and nothing later in the pipeline notices. */}
          <div className="cc-csv__facts">
            <span className="cc-csv__fact">
              Separated by <strong>{DELIMITER_NAME[preview.delimiter] ?? `"${preview.delimiter}"`}</strong>
            </span>
            <span className="cc-csv__fact">
              Read as <strong>{preview.encoding === "latin1" ? "Windows-1252" : "UTF-8"}</strong>
            </span>
            <span className="cc-csv__fact">
              <strong>{landing}</strong> of <strong>{preview.headers.length}</strong> columns coming in
            </span>
          </div>

          {/* They are not dropped, so this must not say "skipped": the engine pads them. The warning
              is still worth making, for the opposite reason: they all arrive, and a value shifted one
              column left arrives looking
              perfectly valid. */}
          {preview.raggedCount > 0 && (
            <div className="cc-csv__warn" role="status">
              {preview.raggedCount} of the first rows have a different number of fields than the
              header. They still come in — short rows are padded, long ones lose the extras — but a
              value can land in the wrong column. Usually it means a value contains the separator and
              is not quoted.
            </div>
          )}

          {preview.quotesDisabled && (
            <div className="cc-csv__warn" role="status">
              This file has a quote that is never closed, so it is read with quoting off — every{" "}
              <span className="mono">&quot;</span> is kept as part of the text. It still imports, but a
              field that used quotes to hold a comma will split into more than one column.
            </div>
          )}

          {/* One row per CSV column: what it holds, and where it lands. */}
          <div className="cc-csv__map">
            {preview.headers.map((h, i) => {
              const m = mappings[i] ?? { target: "new", name: h };
              const sample = preview.sampleRows.find((r) => r[i])?.[i] ?? "";
              return (
                <div key={i} className={`cc-csv__maprow${m.target === "skip" ? " cc-csv__maprow--skip" : ""}`}>
                  <span className="cc-csv__csvcol">
                    <span className="truncate" title={h}>{h}</span>
                    <span className="cc-csv__sample truncate" title={sample}>
                      {sample || "—"} · {preview.inferredTypes[i]}
                    </span>
                  </span>
                  <span className="cc-csv__arrow" aria-hidden>→</span>
                  <Select
                    label={`Where ${h} lands`}
                    value={m.target}
                    size="sm"
                    showLabel={false}
                    options={[
                      { value: "new", label: "New column" },
                      { value: "skip", label: "Leave it out" },
                      ...columns.map((c) => ({ value: String(c.id), label: c.name })),
                    ]}
                    onChange={(v) => setMappings((prev) => prev.map((x, j) => (j === i ? { ...x, target: v } : x)))}
                  />
                  {/* Named before it exists. Fixing the header's ALL_CAPS_SNAKE here beats renaming
                      the column after it has already spread into references. */}
                  {m.target === "new" ? (
                    <input
                      className="cc-input cc-csv__name"
                      value={m.name}
                      aria-label={`Name for the new ${h} column`}
                      onChange={(e) => setMappings((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                  ) : (
                    /* Reserved, so switching between "new" and an existing column cannot resize the
                       row and shuffle everything below the pointer. */
                    <span className="cc-csv__name cc-csv__name--void" aria-hidden />
                  )}
                </div>
              );
            })}
          </div>

          <div className="cc-field cc-field--tight">
            <span className="cc-field__label">
              Skip rows that repeat a value
              <span className="cc-field__sub">so importing the same file twice cannot double the table</span>
            </span>
            <Select
              label="Dedupe on"
              value={String(dedupeOn)}
              size="sm"
              showLabel={false}
              options={[
                { value: "-1", label: "Keep every row" },
                ...preview.headers.map((h, i) => ({ value: String(i), label: `Same ${h} means same row` })),
              ]}
              onChange={(v) => setDedupeOn(Number(v))}
            />
          </div>

          <div className="cc-csv__tablewrap">
            <table className="cc-csv__table">
              <thead>
                <tr>
                  {preview.headers.map((h, i) => (
                    <th key={i} className={mappings[i]?.target === "skip" ? "cc-csv__th--skip" : undefined}>
                      <span className="truncate">{h}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sampleRows.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} className={mappings[j]?.target === "skip" ? "cc-csv__td--skip" : undefined}>
                        <span className="truncate">{v}</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="cc-csv__foot">
            <span className={`cc-csv__meta mono${busy === "import" ? " cc-csv__meta--live" : ""}`}>
              {busy === "import"
                ? `${(progress ?? 0).toLocaleString()} rows imported…`
                : staging
                  ? `Uploading ${Math.round(uploadFrac * 100)}% of ${fmtSize(uploadTotal)}…`
                  : `${(((file?.bytes ?? picked?.bytes) ?? 0) / 1024 / 1024).toFixed(1)} MB · showing ${Math.min(5, preview.sampleRows.length)} rows`}
            </span>
            {busy === "import" ? (
              <button className="cc-btn cc-btn--danger" onClick={cancelImport}>
                Cancel
              </button>
            ) : (
              <button
                className="cc-btn cc-btn--primary"
                // If the background upload has already landed, import now; if not, queue it and the
                // effect fires it the moment the file is fully staged — so the user never waits on the
                // upload before pressing the button, only after.
                onClick={() => { if (file?.path && !staging) void doImport(); else setQueuedImport(true); }}
                disabled={landing === 0 || queuedImport}
                title={landing === 0 ? "Every column is being left out — nothing would arrive." : undefined}
              >
                {queuedImport ? `Finishing upload… ${Math.round(uploadFrac * 100)}%` : "Import into this table"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
