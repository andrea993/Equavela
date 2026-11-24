// The contextual tabs of the numeric choices of a math region: Solver (a region with a solving
// call: algorithm, derivative method, stopping rules) and Differentiation (a region with numeric
// derivatives: the derivative method and its tolerance). Every change is one undo step.

import { useState, type ReactNode } from "react";
import { S } from "../strings";
import { Group, ToolButton } from "./Chrome";
import { algorithmsOf, NUMERIC_DEFAULTS, validNumeric, withNumeric, type NumericOptions, type SolvingFunction } from "../workbench/numeric";

type Change = (options: NumericOptions | null) => void;

function Field({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <label className="ribbon-field" title={title ?? label}>
      <span className="ribbon-field-label">{label}</span>
      {children}
    </label>
  );
}

/** A number field committed on Enter or blur; an invalid entry is kept red and not sent. */
function NumberField({ label, title, field, options, onChange, placeholder }: {
  label: string;
  title?: string;
  field: string;
  options: NumericOptions;
  onChange: Change;
  placeholder?: string;
}) {
  const stored = options[field] ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? stored;
  const valid = validNumeric(field, text);
  const commit = () => {
    if (draft === null) return;
    if (validNumeric(field, draft)) {
      if (draft.trim() !== stored) onChange(withNumeric(options, field, draft));
      setDraft(null);
    }
  };
  return (
    <Field label={label} title={title}>
      <input
        aria-label={label}
        aria-invalid={!valid}
        className={`numeric-field${valid ? "" : " invalid"}`}
        type="text"
        inputMode="decimal"
        size={7}
        value={text}
        placeholder={placeholder ?? NUMERIC_DEFAULTS[field] ?? ""}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            setDraft(null);
          }
        }}
      />
    </Field>
  );
}

function DerivativeFields({ options, onChange }: { options: NumericOptions; onChange: Change }) {
  const N = S.numeric;
  const method = options.derivatives ?? "auto";
  return (
    <>
      <Field label={N.derivatives} title={N.derivativeHint}>
        <select aria-label={N.derivatives} value={method} onChange={(event) => onChange(withNumeric(options, "derivatives", event.target.value))}>
          {Object.entries(N.derivativeMethods).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      {method === "finite-differences" && (
        <NumberField label={N.tolerance} title={N.toleranceHint} field="derivative-tolerance" options={options} onChange={onChange} placeholder="TOL" />
      )}
    </>
  );
}

export function SolverTab({ fn, options, onChange }: { fn: SolvingFunction; options: NumericOptions; onChange: Change }) {
  const N = S.numeric;
  const algorithm = options.algorithm ?? "auto";
  const optimizes = fn === "minimize" || fn === "maximize";
  return (
    <>
      <Group title={N.algorithm}>
        <Field label={N.algorithm} title={N.descriptions[algorithm]}>
          <select aria-label={N.algorithm} value={algorithm} onChange={(event) => onChange(withNumeric(options, "algorithm", event.target.value))}>
            {algorithmsOf(fn).map((value) => <option key={value} value={value} title={N.descriptions[value]}>{N.algorithms[value]}</option>)}
          </select>
        </Field>
        <span className="ribbon-hint numeric-description">{N.descriptions[algorithm]}</span>
      </Group>
      <Group title={N.derivatives}>
        <DerivativeFields options={options} onChange={onChange} />
      </Group>
      <Group title={N.stopping}>
        <div className="ribbon-fields ribbon-fields-inline">
          <NumberField label={N.maxEvaluations} field="max-evaluations" options={options} onChange={onChange} />
          <NumberField label={N.maxTime} field="max-time" options={options} onChange={onChange} placeholder="—" />
          <NumberField label={N.xTolerance} field="x-tolerance" options={options} onChange={onChange} />
          {optimizes && <NumberField label={N.fTolerance} field="f-tolerance" options={options} onChange={onChange} />}
        </div>
      </Group>
      <Group title={N.method}>
        <ToolButton label={N.reset} icon={<span className="glyph">↺</span>} disabled={Object.keys(options).length === 0} onClick={() => onChange(null)} />
      </Group>
    </>
  );
}

export function DerivativeTab({ options, onChange }: { options: NumericOptions; onChange: Change }) {
  const N = S.numeric;
  return (
    <>
      <Group title={N.derivatives}>
        <DerivativeFields options={options} onChange={onChange} />
      </Group>
      <Group title={N.method}>
        <ToolButton label={N.reset} icon={<span className="glyph">↺</span>} disabled={Object.keys(options).length === 0} onClick={() => onChange(null)} />
      </Group>
    </>
  );
}
