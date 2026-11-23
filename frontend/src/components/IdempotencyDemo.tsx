import { useState } from "react";
import { ArrowRight, CheckCheck, Fingerprint, KeyRound, RefreshCw, ShieldCheck, X } from "lucide-react";
import { submitWebhookEvent } from "../api";
import type { WebhookEventInput } from "../types";

interface IdempotencyDemoProps {
  event: WebhookEventInput | null;
}

interface DemoReply {
  status: number;
  jobId?: string;
  error?: string;
}

function newKey(): string {
  return `demo-${crypto.randomUUID()}`;
}

export function IdempotencyDemo({ event }: IdempotencyDemoProps) {
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [first, setFirst] = useState<DemoReply | null>(null);
  const [second, setSecond] = useState<DemoReply | null>(null);
  const [conflict, setConflict] = useState<DemoReply | null>(null);
  const [error, setError] = useState<string | null>(null);

  function resetForKey(value: string) {
    setKey(value);
    setFirst(null);
    setSecond(null);
    setConflict(null);
    setError(null);
  }

  async function send(input: WebhookEventInput): Promise<DemoReply> {
    const response = await submitWebhookEvent(input, key);
    return {
      status: response.status,
      jobId: response.data.jobId,
      error: response.data.error,
    };
  }

  async function runDuplicatePair() {
    if (!event) return;
    setBusy(true);
    setError(null);
    setFirst(null);
    setSecond(null);
    setConflict(null);
    try {
      const firstReply = await send(event);
      setFirst(firstReply);
      const secondReply = await send(event);
      setSecond(secondReply);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reach the HookFlow API.");
    } finally {
      setBusy(false);
    }
  }

  async function runConflict() {
    if (!event) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      let original = first;
      if (!original?.jobId) {
        original = await send(event);
        setFirst(original);
      }
      if (original.status === 409) {
        setConflict({ status: 409, error: "This key already belongs to a different event." });
        return;
      }
      const changedPayload = {
        ...event.payload,
        [`dashboardConflictProbe_${crypto.randomUUID()}`]: true,
      };
      setConflict(await send({ ...event, payload: changedPayload }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reach the HookFlow API.");
    } finally {
      setBusy(false);
    }
  }

  const sameJob = Boolean(first?.jobId && second?.jobId && first.jobId === second.jobId);

  return (
    <section className="panel idempotency-panel" id="idempotency">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">DUPLICATE PROTECTION</div>
          <h2>Idempotency lab</h2>
        </div>
        <span className="panel-icon panel-icon-violet"><Fingerprint size={18} /></span>
      </div>

      <p className="panel-description">Replay the same event with one key and inspect the API’s real responses.</p>

      <label className="field-label" htmlFor="demo-key">Idempotency key</label>
      <div className="input-with-icon demo-key-input">
        <KeyRound size={15} />
        <input id="demo-key" className="text-input" value={key} onChange={(event) => resetForKey(event.target.value)} />
        <button className="key-refresh" type="button" onClick={() => resetForKey(newKey())} aria-label="Generate a fresh key">
          <RefreshCw size={14} />
        </button>
      </div>
      {!event && <p className="demo-hint">Set a valid event type and JSON object in the composer to enable the demo.</p>}

      <div className="demo-actions">
        <button className="secondary-button" type="button" disabled={!event || busy} onClick={runDuplicatePair}>
          {busy ? <span className="button-spinner" /> : <CheckCheck size={15} />}
          Submit identical pair
          {!busy && <ArrowRight size={14} />}
        </button>
        <button className="text-action" type="button" disabled={!event || busy} onClick={runConflict}>
          <X size={14} /> Try a changed payload
        </button>
      </div>

      {error && <div className="inline-error demo-error" role="alert">{error}</div>}

      {(first || second || conflict) && (
        <div className="idempotency-results" aria-live="polite">
          {first && <ResultRow label="Request 01" result={first} />}
          {second && <ResultRow label="Replay 02" result={second} />}
          {conflict && <ResultRow label="Changed event" result={conflict} />}
          {sameJob && <div className="same-job-confirm"><ShieldCheck size={15} /> Same job ID returned for both requests</div>}
          {conflict?.status === 409 && <div className="conflict-note">409 Conflict · this key is bound to the original event for 24 hours.</div>}
        </div>
      )}

      <div className="idempotency-explainer">
        <ShieldCheck size={15} />
        <span>Same key + same fingerprint reuses a job. Changing event type, payload, or scenario returns <code>409</code>.</span>
      </div>
    </section>
  );
}

function ResultRow({ label, result }: { label: string; result: DemoReply }) {
  return (
    <div className={`demo-result-row ${result.status === 409 ? "demo-result-conflict" : ""}`}>
      <span>{label}</span>
      <strong>{result.status}</strong>
      <code title={result.jobId || result.error}>{result.jobId || result.error || (result.status === 202 ? "Accepted" : "Request failed")}</code>
    </div>
  );
}
