/**
 * local/ui — the field-by-field change list shared by the discard modals
 * and the review modal: "Query: old → new", one line per changed field.
 */
import type { FieldChange } from "../../view-model/rules-draft.js";

export function ChangeList({ changes }: { changes: readonly FieldChange[] }) {
  if (changes.length === 0) return null;
  return (
    <ul className="rt-changes">
      {changes.map((c) => (
        <li key={c.field} className="rt-changes__item">
          <span className="rt-changes__field">{c.label}</span>
          {c.from !== "" && (
            <>
              <del className="rt-changes__from">{c.from}</del>
              <span aria-hidden="true" className="rt-changes__arrow">
                →
              </span>
            </>
          )}
          <ins className="rt-changes__to">{c.to}</ins>
        </li>
      ))}
    </ul>
  );
}
