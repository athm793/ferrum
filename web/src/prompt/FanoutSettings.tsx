// Fan-out on an ai/agent column: run the prompt once per item of a list column's value, in place.
//
// The list comes from a column whose value IS a list — a JSON or array column. A plain text column
// is offered nowhere here because the executor refuses it: splitting prose on a guessed separator
// is salvage, and salvage is the author's explicit choice in a rule column, not the executor's to
// invent.
//
// Cost, said plainly where the setting is made: a fan-out row costs items × the per-row figure. The
// run dialog's forecast samples the list column and prices that distribution; this screen's live
// figure is per item.

import { Select } from "../ui/Select.tsx";
import type { Column } from "../api.ts";

export interface FanoutValue {
  on: boolean;
  sourceId: string | null;
  cap: number | null;
}

interface Props {
  value: FanoutValue;
  /** The table's columns — the candidates are the ones whose value is a list. */
  columns: Column[];
  onChange: (next: FanoutValue) => void;
  busy: boolean;
}

const LIST_TYPES = new Set(["json", "array"]);

export function FanoutSettings({ value, columns, onChange, busy }: Props) {
  const candidates = columns.filter((c) => LIST_TYPES.has(c.valueType));
  const on = value.on && value.sourceId != null && candidates.some((c) => c.id === value.sourceId);
  const cap = value.cap ?? 50;

  const sourceOptions = [
    { value: "off", label: "Off — run once per row" },
    ...candidates.map((c) => ({ value: c.id, label: `Each item of ${c.name}` })),
  ];

  return (
    <div className="cc-field">
      <span className="cc-field__label">Once per item of a list</span>
      <Select
        label="Run the prompt"
        value={on ? String(value.sourceId) : "off"}
        options={sourceOptions}
        onChange={(v) => onChange(v === "off" ? { on: false, sourceId: null, cap: value.cap } : { on: true, sourceId: v, cap: value.cap })}
        disabled={busy || candidates.length === 0}
        disabledReason={candidates.length === 0 ? "No column in this table holds a list yet — a JSON or array column is the list a fan-out reads." : undefined}
      />
      {on && (
        <>
          <span className="cc-field__label">
            Most items one row may run
            <span className="cc-field__sub">the rest are skipped and counted</span>
          </span>
          <input
            className="cc-input cc-input--num"
            type="number"
            min={1}
            step={1}
            size={6}
            value={cap}
            disabled={busy}
            aria-label="The most items one row may run"
            onChange={(e) => onChange({ ...value, cap: e.target.value === "" ? null : Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
            onBlur={() => onChange({ ...value, cap })}
          />
        </>
      )}
      <span className="cc-field__hint">
        {on && value.sourceId != null ? (
          <>
            The prompt runs once per item, and the answers fold back into the cell as a list. A row
            whose list is missing or not a list is skipped free. Rows cost items × the per-row figure,
            and the run dialog prices that distribution.
          </>
        ) : candidates.length === 0 ? (
          <>
            Point this at a column that holds a list and the prompt runs once per item instead of once
            per row. No column in this table holds a list yet — a JSON or array column is what a
            fan-out reads.
          </>
        ) : (
          <>
            Point this at a column that holds a list and the prompt runs once per item instead of once
            per row, with the answers folding back as a list.
          </>
        )}
      </span>
    </div>
  );
}
