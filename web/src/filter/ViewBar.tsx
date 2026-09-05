// Saved views.
//
// A view is a named filter + sort + search. The engine has stored them since Phase 1 with no way to
// make one, which mattered little while there was no filter builder — and matters a great deal now
// that there is, because a filter worth building twice is a filter worth saving.
//
// The design decision that shapes this: a view is APPLIED, not entered. Picking one writes its
// filter into the same `GridView` the toolbar edits, so there is exactly one description of what the
// grid is showing and a run keeps covering the rows on screen. A view that had its own parallel
// state would be a second way to narrow the grid, and the two would eventually disagree.
//
// The consequence, which the UI has to be honest about: once applied, the view can be edited like
// anything else, so "Sales prospects" can be showing something Sales prospects does not mean. That
// is signalled rather than prevented — blocking edits would make views a cage.

import { useCallback, useEffect, useRef, useState } from "react";
import { Popover } from "../ui/Popover.tsx";
import { Modal } from "../ui/Modal.tsx";
import { IconMore, IconPlus } from "../ui/Icon.tsx";
import { EMPTY_VIEW, savedViewToGrid, usableFilter, type GridView, type SavedView } from "../view.ts";
import "./ViewBar.css";

interface Props {
  sheetId: string;
  view: GridView;
  onChange: (v: GridView) => void;
  /** Bumped so the undo bar re-reads after a view is deleted. */
  onMutated: () => void;
  /** The view this table opens on, so the bar can show which one it is and change it. */
  defaultViewId?: string | null;
  onSetDefaultView?: (viewId: string | null) => void;
  /** The view applied on open, so the trigger names it instead of reading "Views" over a narrowed grid. */
  openedWith?: number | null;
}

/** Same shape on both sides of the comparison, so key order cannot make an identical view look edited.
 *  Hidden ids sort before comparing, because hiding is a SET — {3,7} and {7,3} are one state. */
const fingerprint = (v: GridView) =>
  JSON.stringify({
    filter: usableFilter(v.filter),
    sort: v.sort,
    search: v.search.trim(),
    hidden: [...v.hidden].sort((a, b) => a - b),
    groupBy: v.groupBy,
  });

export function ViewBar({ sheetId, view, onChange, onMutated, defaultViewId, onSetDefaultView, openedWith }: Props) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  // The trigger itself, so the menu follows it when something scrolls rather than closing on the user.
  const trigger = useRef<HTMLButtonElement>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * The last thing that went wrong, in the menu and in the naming box.
   *
   * There was nowhere at all for a refusal to appear: saving, updating and deleting each threw the
   * answer away, so a view the engine declined to save left the naming box open, unchanged and
   * silent — which reads as the Save button not being wired up.
   */
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sheets/${sheetId}/views`).then((r) => r.json());
      setViews(res.views ?? []);
    } catch { /* the bar degrades to "save this view" rather than blocking the toolbar */ }
  }, [sheetId]);

  // Reset to whatever the table was OPENED with, not to null. A table with a default view opens
  // narrowed, and a trigger reading "Views" over a narrowed grid is the drift this file's header
  // warns about — the name has to say what is on screen.
  useEffect(() => { void load(); setActiveId(openedWith ?? null); }, [load, openedWith]);

  const active = views.find((v) => v.id === activeId) ?? null;
  // Whether what is on screen still matches the view that was applied. Compared by value, because
  // the point is "does this still show what the name promises", not "was the object replaced".
  const drifted = active ? fingerprint(savedViewToGrid(active)) !== fingerprint(view) : false;

  const apply = (v: SavedView | null) => {
    setOpen(false);
    setActiveId(v?.id ?? null);
    onChange(v ? savedViewToGrid(v) : EMPTY_VIEW);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim() || "Untitled view",
        filter: usableFilter(view.filter) ?? { conj: "and", children: [] },
        sorts: view.sort ? [view.sort] : [],
        search: view.search.trim() || null,
        columns: { hidden: view.hidden },
        groupBy: view.groupBy,
      };
      const res = await fetch(`/api/sheets/${sheetId}/views`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      // The box stays open on a refusal, holding the name that was typed, rather than closing as
      // though the view had been kept.
      if (!res.view) { setError(String(res.error ?? "Could not save this view.")); return; }
      setActiveId(res.view.id);
      await load();
      setNaming(false);
      setName("");
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  /** Overwrite the applied view with what is on screen. Only offered when it has actually drifted. */
  const update = async () => {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/views/${active.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: active.name,
          filter: usableFilter(view.filter) ?? { conj: "and", children: [] },
          sorts: view.sort ? [view.sort] : [],
          search: view.search.trim() || null,
          columns: { hidden: view.hidden },
          groupBy: view.groupBy,
        }),
      });
      const body = await res.json().catch(() => null);
      // Said out loud, because the name in the trigger goes on being the applied view either way —
      // an overwrite that was refused is indistinguishable from one that worked.
      if (!res.ok || body?.error) {
        setError(String(body?.error ?? `Could not update “${active.name}”.`));
        return;
      }
      await load();
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const remove = async (v: SavedView) => {
    setOpen(false);
    setError(null);
    try {
      const res = await fetch(`/api/views/${v.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.error) {
        setError(String(body?.error ?? `Could not delete “${v.name}”.`));
        return;
      }
    } catch {
      setError("Could not reach the engine.");
      return;
    }
    // Deleting is undoable, so this is not a confirm-dialog moment — the undo bar is the safety net,
    // and a dialog in front of a reversible action is the speed bump people click through.
    if (activeId === v.id) setActiveId(null);
    await load();
    onMutated();
  };

  // "All rows" named the state, not the control, so the feature read as a row filter and saved
  // views looked like they did not exist. The trigger now says what it IS when nothing is applied,
  // and what is APPLIED when something is — which is the only time the state matters.
  const label = active ? active.name : "Views";

  return (
    <div className="cc-vb">
      <button
        ref={trigger}
        className="cc-vb__trigger"
        onClick={(e) => { setRect(e.currentTarget.getBoundingClientRect()); setOpen((o) => !o); }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={drifted ? `${label} — the grid no longer matches this view` : label}
      >
        <span className="cc-vb__name truncate">{label}</span>
        {/* A dot, not a word: the label is the thing being read, and "(edited)" inside it would make
            the trigger change width every time a filter is touched. */}
        {drifted && <span className="cc-vb__dot" aria-label="edited" />}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="m4 6.5 4 4 4-4" />
        </svg>
      </button>

      {/* Beside the trigger rather than inside the menu: updating and deleting both close the menu,
          so a message that only lived in there would be dismissed by the very action that wrote it.
          Truncated with the full text on hover, so a long refusal cannot widen the toolbar. */}
      {error && (
        <span
          role="alert"
          title={error}
          style={{
            marginLeft: "var(--s-2)", maxWidth: 220, fontSize: 12,
            color: "var(--status-error-solid)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {error}
        </span>
      )}

      <Popover open={open} anchor={rect ? { rect } : null} anchorEl={trigger} onClose={() => setOpen(false)} width={260} role="menu" label="Views">
        <div className="cc-vb__menu">
          <div className={`cc-vb__row${activeId === null ? " cc-vb__row--on" : ""}`}>
            <button className="cc-vb__item truncate" onClick={() => apply(null)}>
              All rows — no view
            </button>
            {onSetDefaultView && defaultViewId != null && (
              <button
                className="hk-icon-btn cc-vb__del"
                onClick={() => onSetDefaultView(null)}
                aria-label="Open this table on all rows"
                title="Open this table on all rows instead of a saved view"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.5 4.3 13.5l.8-4.2L2 6.4l4.2-.5z" />
                </svg>
              </button>
            )}
          </div>

          {views.map((v) => (
            <div key={v.id} className={`cc-vb__row${activeId === v.id ? " cc-vb__row--on" : ""}`}>
              <button className="cc-vb__item truncate" onClick={() => apply(v)}>{v.name}</button>
              {onSetDefaultView && (
                <button
                  className="hk-icon-btn cc-vb__del"
                  onClick={() => onSetDefaultView(String(v.id) === defaultViewId ? null : String(v.id))}
                  aria-label={
                    String(v.id) === defaultViewId
                      ? `Stop opening this table on ${v.name}`
                      : `Open this table on ${v.name}`
                  }
                  // Named rather than left to the icon: this is the one control here that changes
                  // what somebody else sees when they open the table, and a filtered landing state
                  // costs an index build on the first open after any data change.
                  title={
                    String(v.id) === defaultViewId
                      ? `This table opens on “${v.name}”. Click to open on all rows instead.`
                      : `Open this table on “${v.name}” every time`
                  }
                >
                  <svg
                    width="12" height="12" viewBox="0 0 16 16"
                    fill={String(v.id) === defaultViewId ? "currentColor" : "none"}
                    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <path d="M8 2l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.5 4.3 13.5l.8-4.2L2 6.4l4.2-.5z" />
                  </svg>
                </button>
              )}
              <button
                className="hk-icon-btn cc-vb__del"
                onClick={() => void remove(v)}
                aria-label={`Delete view ${v.name}`}
                title="Delete — undoable"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          ))}

          <div className="cc-vb__sep" role="separator" />

          {active && drifted && (
            <button className="cc-vb__item" onClick={() => void update()} disabled={busy}>
              Update “{active.name}” to match
            </button>
          )}
          <button
            className="cc-vb__item"
            onClick={() => { setOpen(false); setError(null); setNaming(true); }}
            disabled={!usableFilter(view.filter) && !view.sort && !view.search.trim()}
            // Disabled with a reason: saving the unnarrowed grid produces a view identical to
            // "All rows", which is a menu entry that does nothing.
            title={
              !usableFilter(view.filter) && !view.sort && !view.search.trim()
                ? "Filter, sort or search first — there is nothing to save yet."
                : undefined
            }
          >
            <IconPlus /> Save this as a view
          </button>
        </div>
      </Popover>

      <Modal
        open={naming}
        onClose={() => { setNaming(false); setError(null); }}
        title="Save this view"
        footNote="Filters, sort and search are saved. Column widths are not."
        footer={
          <>
            <button className="cc-btn" onClick={() => { setNaming(false); setError(null); }}>Cancel</button>
            <button className="cc-btn cc-btn--primary" onClick={() => void save()} disabled={busy || !name.trim()}>
              Save view
            </button>
          </>
        }
      >
        {/* The dialog is over the toolbar, so a refusal has to be repeated in here — the message
            beside the trigger is behind it and would not be read. */}
        {error && (
          <p role="alert" style={{ margin: "0 0 var(--s-3)", fontSize: 12.5, lineHeight: 1.55, color: "var(--status-error-solid)" }}>
            {error}
          </p>
        )}

        <label className="cc-field">
          <span className="cc-field__label">Name</span>
          <input
            className="cc-input"
            value={name}
            autoFocus
            placeholder="US companies over 500"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void save(); }}
          />
        </label>
      </Modal>
    </div>
  );
}
