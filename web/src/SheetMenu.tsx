// The toolbar's overflow menu.
//
// It existed as an icon with no handler — a control that looks like it opens something and does
// nothing. The low-frequency sheet-level actions live here rather than as more buttons in the
// toolbar, per the two-tier toolbar rule.

import { useCallback, useRef, useState } from "react";
import { Popover } from "./ui/Popover.tsx";
import { Modal } from "./ui/Modal.tsx";
import { IconMore } from "./ui/Icon.tsx";
import { Select } from "./ui/Select.tsx";
import { api, type Sheet, type SheetKind } from "./api.ts";
import { isNarrowed, viewQuery, type GridView } from "./view.ts";
import "./SheetMenu.css";

interface Props {
  sheet: Sheet;
  /**
   * How the grid is currently narrowed, so the export can be the rows on screen.
   *
   * It used to export the whole table no matter what was filtered — the same headers, the same
   * shape, and a hundred times the rows. The failure is silent at the moment it happens and only
   * shows up wherever the file was sent next, so the menu now offers the filtered set BY NAME and
   * with its count, and keeps the whole-table export as a separate, separately-labelled item.
   */
  view: GridView;
  /** The count AFTER narrowing — the number the grid is showing. Put in the label so the user
   *  approves a row count rather than inferring one. */
  visibleRows: number;
  onRenamed: (name: string) => void;
  onTrashed: () => void | Promise<void>;
  /** The saved sheet comes back so the menu label and the engine agree on the current limit. */
  onBudgetSet?: (budgetUsd: number | null) => void;
  /** The whole sheet back, for settings that change more than one field of it. */
  onSheetChanged?: (sheet: Sheet) => void;
  /** Open the duplicate-rows screen. A table-level job, so it belongs on the table's own menu. */
  onDedupe?: () => void;
  /**
   * Open the cost report scoped to THIS table.
   *
   * Beside the spending limit deliberately: the limit is what you are allowed to spend and this is
   * what you have spent, and setting the first without being able to see the second is guesswork.
   */
  onUsage?: () => void;
  /** Open the scheduled-runs screen. A table-level rule, so it lives on the table menu. */
  onSchedules?: () => void;
  /**
   * Open the speed limits for this table.
   *
   * HERE, not in Settings. It first shipped in the workspace settings rail between Models and Keys —
   * which made it read as a workspace preference while listing columns from every table, so there
   * was no way to tell which of the two it was about. A limit belongs to a column, a column belongs
   * to a table, and this is the table's menu.
   */
  onLimits?: () => void;
  /**
   * Open the restore points — the values a run replaced.
   *
   * Beside the run-level actions rather than beside Undo, and named for what it does rather than
   * "Undo run": the values come back and the money does not, and a menu item saying "Undo" would
   * promise a refund that is not coming.
   */
  onRestorePoints?: () => void;
  /** Open the workspace-wide settings, so the levels read as a hierarchy rather than three places. */
  onWorkspaceSettings?: () => void;
  /**
   * Whether the grid's selection checkboxes are showing, and the switch for it.
   *
   * The row, column and select-all boxes are hidden until this is on — a hover-only control is one
   * nobody finds, which is exactly what happened. Turning it on from here is the discoverable way in.
   */
  selectMode?: boolean;
  onToggleSelectMode?: () => void;
}

export function SheetMenu({ sheet, view, visibleRows, onRenamed, onTrashed, onBudgetSet, onSheetChanged, onDedupe, onUsage, onSchedules, onRestorePoints, onLimits, onWorkspaceSettings, selectMode, onToggleSelectMode }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(sheet.name);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [budgeting, setBudgeting] = useState(false);
  const [budget, setBudget] = useState("");
  const [kinding, setKinding] = useState(false);
  const [kind, setKind] = useState<SheetKind>("generic");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const narrowed = isNarrowed(view);

  const show = useCallback(() => {
    if (!ref.current) return;
    setRect(ref.current.getBoundingClientRect());
    setOpen(true);
  }, []);

  const rename = async () => {
    const next = name.trim();
    if (!next || next === sheet.name) { setRenaming(false); return; }
    setBusy(true);
    setError(null);
    try {
      await api.renameSheet(sheet.id, next);
      onRenamed(next);
      setRenaming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** null removes the limit. The server validates; a rejection stays on screen rather than closing. */
  const saveBudget = async (value: number | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sheets/${sheet.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budgetUsd: value }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      onBudgetSet?.(res.sheet?.budgetUsd ?? null);
      setBudgeting(false);
    } catch {
      setError("Could not reach the engine to save the limit.");
    } finally {
      setBusy(false);
    }
  };

  /** What the rows are. A hint that improves defaults — it never changes a value already stored. */
  const saveKind = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.setSheetKind(sheet.id, kind);
      onSheetChanged?.(res.sheet);
      setKinding(false);
    } catch (e: any) {
      setError(String(e?.message ?? "Could not reach the engine to save that."));
    } finally {
      setBusy(false);
    }
  };

  const trash = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.trashSheet(sheet.id);
      setConfirmTrash(false);
      await onTrashed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={ref}
        className="hk-icon-btn"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={() => (open ? setOpen(false) : show())}
      >
        <IconMore />
      </button>

      <Popover open={open} anchor={rect ? { rect } : null} anchorEl={ref} onClose={() => setOpen(false)} width={220} role="menu" label="Table actions" placement="bottom-end">
        <div className="cc-menu2">
          {/*
            Whose settings these are, said before the first one.

            There are three scopes in this app — the workspace, a workbook, and a table — and until
            now nothing on screen distinguished them. This menu, the workbook's menu in the file
            browser and the Settings page all opened without saying what they governed, so "spending
            limit" here and "spending limit" there looked like the same control in two places rather
            than two limits at two levels. Each surface names its own scope now, in the same shape.
          */}
          <div className="cc-menu2__scope">
            <span className="cc-menu2__scope-kind">This table</span>
            <span className="cc-menu2__scope-name truncate" title={sheet.name}>{sheet.name}</span>
          </div>
          <button className="cc-menu2__item" onClick={() => { setOpen(false); setName(sheet.name); setRenaming(true); }}>
            Rename this table
          </button>
          {/* Turns the row / column / select-all checkboxes on. They are deliberately hidden until
              this is switched on, so this menu item is how anyone discovers they exist at all. */}
          {onToggleSelectMode && (
            <button className="cc-menu2__item" onClick={() => { setOpen(false); onToggleSelectMode(); }}>
              {selectMode ? "Done selecting — hide the checkboxes" : "Select rows & columns"}
            </button>
          )}
          {/* `viewQuery` is the grid's own serialiser, reused rather than rebuilt — the export and
              the grid have to name the same rows, and two builders of the same query string is
              exactly how they stop doing that. It starts with "&", so it is spliced after "?". */}
          {narrowed && (
            <a
              className="cc-menu2__item"
              href={`/api/sheets/${sheet.id}/export.csv?${viewQuery(view).slice(1)}`}
              download
              onClick={() => setOpen(false)}
            >
              Export {visibleRows.toLocaleString()} filtered {visibleRows === 1 ? "row" : "rows"} as CSV
            </a>
          )}
          <a className="cc-menu2__item" href={`/api/sheets/${sheet.id}/export.csv`} download onClick={() => setOpen(false)}>
            {narrowed ? "Export the whole table as CSV" : "Export as CSV"}
          </a>
          {onDedupe && (
            <button className="cc-menu2__item" onClick={() => { setOpen(false); onDedupe(); }}>
              Deduplication…
            </button>
          )}
          {/* The limit is in the label, not hidden behind the dialog. A cap you cannot see without
              opening a form is a cap you forget you set — and then spend an afternoon wondering why
              runs keep pausing. */}
          <button
            className="cc-menu2__item"
            onClick={() => { setOpen(false); setBudget(sheet.budgetUsd == null ? "" : String(sheet.budgetUsd)); setBudgeting(true); }}
          >
            Spending limit{sheet.budgetUsd != null ? ` · ${sheet.budgetUsd}` : ""}
          </button>
          {/* The current answer is in the label for the same reason the spending limit's is: a
              setting you cannot see without opening a form is one you forget you set. */}
          <button
            className="cc-menu2__item"
            onClick={() => { setOpen(false); setKind(sheet.kind); setKinding(true); }}
          >
            What these rows are{sheet.kind !== "generic" ? ` · ${sheet.kind}` : ""}
          </button>
          {onLimits && (
            <button className="cc-menu2__item" onClick={() => { setOpen(false); onLimits(); }}>
              Speed limits…
            </button>
          )}
          {onSchedules && (
            <button className="cc-menu2__item" onClick={() => { setOpen(false); onSchedules(); }}>
              Scheduled runs…
            </button>
          )}
          {onRestorePoints && (
            <button className="cc-menu2__item" onClick={() => { setOpen(false); onRestorePoints(); }}>
              Restore points…
            </button>
          )}
          {onUsage && (
            <button className="cc-menu2__item" onClick={() => { setOpen(false); onUsage(); }}>
              Usage and cost…
            </button>
          )}
          <div className="cc-menu2__sep" />
          {/* The way UP a level, so the three scopes read as a hierarchy rather than as three
              unrelated places. Without it, finding the workspace defaults from here meant knowing
              they existed and knowing the gear opened them. */}
          {onWorkspaceSettings && (
            <button
              className="cc-menu2__item cc-menu2__item--up"
              onClick={() => { setOpen(false); onWorkspaceSettings(); }}
              title="Models, keys and limits for every table in this workspace"
            >
              Workspace settings…
            </button>
          )}
          <div className="cc-menu2__sep" />
          <button className="cc-menu2__item cc-menu2__item--danger" onClick={() => { setOpen(false); setConfirmTrash(true); }}>
            Move this table to the trash
          </button>
        </div>
      </Popover>

      <Modal
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename this table"
        footNote={error ?? ""}
        footer={
          <>
            <button className="cc-btn" onClick={() => setRenaming(false)}>Cancel</button>
            <button className="cc-btn cc-btn--primary" onClick={() => void rename()} disabled={busy || !name.trim()}>Rename</button>
          </>
        }
      >
        <input
          className="cc-input"
          value={name}
          autoFocus
          aria-label="Table name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void rename(); } }}
        />
      </Modal>

      <Modal
        open={kinding}
        onClose={() => setKinding(false)}
        title="What these rows are"
        footNote={error ?? "A hint for the defaults. It never changes a value already in the table."}
        footer={
          <>
            <button className="cc-btn" onClick={() => setKinding(false)}>Cancel</button>
            <button className="cc-btn cc-btn--primary" onClick={() => void saveKind()} disabled={busy}>
              Save
            </button>
          </>
        }
      >
        <label className="cc-field">
          <span className="cc-field__label">Each row is</span>
          <Select<SheetKind>
            label="Rows are"
            value={kind}
            showLabel={false}
            size="md"
            onChange={setKind}
            options={[
              { value: "generic", label: "Neither — something else", hint: "the default" },
              { value: "people", label: "People", hint: "matched on email" },
              { value: "companies", label: "Companies", hint: "matched on domain" },
            ]}
          />
          <span className="cc-field__hint">
            Saying what a table holds lets the table assistant pick a sensible key to deduplicate on,
            and lets the column gallery say which saved columns suit this table. Both are
            <strong> suggestions you can change</strong> — nothing here runs anything or spends
            anything.
          </span>
        </label>
      </Modal>

      <Modal
        open={confirmTrash}
        onClose={() => setConfirmTrash(false)}
        title="Move this table to the trash?"
        footNote={error ?? "Recoverable — nothing is deleted."}
        footer={
          <>
            <button className="cc-btn" onClick={() => setConfirmTrash(false)}>Cancel</button>
            <button className="cc-btn cc-btn--danger" onClick={() => void trash()} disabled={busy}>Move to trash</button>
          </>
        }
      >
        <p className="cc-modal__summary">
          <strong>{sheet.name}</strong> and its {sheet.rowCount.toLocaleString()} rows will be hidden
          from the sheet list. The data stays on disk.
        </p>
      </Modal>

      <Modal
        open={budgeting}
        onClose={() => setBudgeting(false)}
        title="Spending limit for this table"
        footNote={error ?? "Counts every run ever made against this table."}
        footer={
          <>
            <button className="cc-btn" onClick={() => setBudgeting(false)}>Cancel</button>
            {/* Clearing is its own button rather than "save an empty box", because emptying a field
                and pressing Save reads as cancelling, not as removing the limit. */}
            <button className="cc-btn" onClick={() => void saveBudget(null)} disabled={busy || sheet.budgetUsd == null}>
              Remove limit
            </button>
            <button className="cc-btn cc-btn--primary" onClick={() => void saveBudget(Number(budget))} disabled={busy || !budget.trim()}>
              Save limit
            </button>
          </>
        }
      >
        <label className="cc-field">
          <span className="cc-field__label">
            Stop running after
            <span className="cc-field__sub">US dollars, estimated</span>
          </span>
          <input
            className="cc-input cc-input--num"
            type="number"
            min={0}
            step="0.5"
            size={8}
            value={budget}
            autoFocus
            placeholder="no limit"
            onChange={(e) => setBudget(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && budget.trim()) void saveBudget(Number(budget)); }}
          />
          <span className="cc-field__hint">
            A run that reaches this <strong>pauses</strong> rather than failing — the rows already
            done keep their values, and you can raise the limit and carry on. Script columns cost
            nothing and are never counted.
          </span>
        </label>
      </Modal>
    </>
  );
}
