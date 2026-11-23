import { useState, type FormEvent } from "react";
import { Braces, ChevronDown, CircleAlert, KeyRound, Send, WandSparkles } from "lucide-react";
import type { Scenario, WebhookEventInput } from "../types";

interface DeliveryFormProps {
  eventType: string;
  payloadText: string;
  scenario: Scenario;
  idempotencyKey: string;
  submitting: boolean;
  error: string | null;
  onEventTypeChange: (value: string) => void;
  onPayloadChange: (value: string) => void;
  onScenarioChange: (value: Scenario) => void;
  onIdempotencyKeyChange: (value: string) => void;
  onSubmit: (event: WebhookEventInput, idempotencyKey?: string) => void;
}

const scenarios: Array<{ value: Scenario; label: string; description: string }> = [
  { value: "success", label: "Success", description: "Receiver returns 200" },
  { value: "transient", label: "Transient", description: "Two 500s, then 200" },
  { value: "failure", label: "Failure", description: "Retryable 500 response" },
  { value: "permanent", label: "Permanent", description: "Non-retryable 400 response" },
];

function parsePayload(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Payload must be a JSON object.");
  }
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > 8 * 1024) {
    throw new Error("Payload must be 8 KB or smaller.");
  }
  return parsed as Record<string, unknown>;
}

export function DeliveryForm(props: DeliveryFormProps) {
  const [validationError, setValidationError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (!props.eventType.trim() || props.eventType.length > 100) {
        throw new Error("Event type is required and must be 100 characters or less.");
      }
      if (props.idempotencyKey && !/^[A-Za-z0-9._~-]{1,128}$/.test(props.idempotencyKey)) {
        throw new Error("Use 1–128 letters, numbers, dots, underscores, tildes, or hyphens for the key.");
      }
      const payload = parsePayload(props.payloadText);
      setValidationError(null);
      props.onSubmit(
        { eventType: props.eventType.trim(), payload, scenario: props.scenario },
        props.idempotencyKey.trim() || undefined,
      );
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Check the event fields and try again.");
    }
  }

  return (
    <section className="panel composer-panel" id="compose">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">OUTBOUND EVENT</div>
          <h2>Compose delivery</h2>
        </div>
        <span className="panel-icon"><WandSparkles size={17} /></span>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <label className="field-label" htmlFor="event-type">Event type</label>
        <input
          id="event-type"
          className="text-input"
          value={props.eventType}
          onChange={(event) => props.onEventTypeChange(event.target.value)}
          placeholder="invoice.paid"
          maxLength={100}
          autoComplete="off"
        />

        <div className="field-label-row">
          <label className="field-label" htmlFor="payload">JSON payload</label>
          <span className="field-hint"><Braces size={13} /> object · 8 KB max</span>
        </div>
        <textarea
          id="payload"
          className="code-input"
          value={props.payloadText}
          onChange={(event) => props.onPayloadChange(event.target.value)}
          spellCheck={false}
          rows={7}
          aria-describedby={validationError ? "form-error" : undefined}
        />

        <div className="field-label-row scenario-label-row">
          <span className="field-label">Receiver scenario</span>
          <span className="field-hint">Choose a response path</span>
        </div>
        <div className="scenario-grid" role="radiogroup" aria-label="Receiver scenario">
          {scenarios.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={props.scenario === option.value}
              className={`scenario-option ${props.scenario === option.value ? "selected" : ""} scenario-${option.value}`}
              onClick={() => props.onScenarioChange(option.value)}
            >
              <span className="scenario-dot" />
              <span className="scenario-option-copy">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {props.scenario === option.value && <span className="scenario-selected-mark" />}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="idempotency-key">Idempotency key <span className="optional">optional</span></label>
        <div className="input-with-icon">
          <KeyRound size={15} />
          <input
            id="idempotency-key"
            className="text-input"
            value={props.idempotencyKey}
            onChange={(event) => props.onIdempotencyKeyChange(event.target.value)}
            placeholder="order_8f12a"
            maxLength={128}
            autoComplete="off"
          />
        </div>
        <p className="field-footnote">Same key + same event returns the original job. Keys are retained for 24 hours.</p>

        {(validationError || props.error) && (
          <div className="inline-error" id="form-error" role="alert">
            <CircleAlert size={16} />
            <span>{validationError || props.error}</span>
          </div>
        )}

        <button className="primary-button submit-button" type="submit" disabled={props.submitting}>
          {props.submitting ? <span className="button-spinner" /> : <Send size={16} />}
          {props.submitting ? "Submitting event…" : "Submit event"}
          {!props.submitting && <ChevronDown className="submit-chevron" size={15} />}
        </button>
      </form>
    </section>
  );
}
