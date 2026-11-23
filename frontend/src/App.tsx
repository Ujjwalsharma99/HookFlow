import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  BookOpen,
  Braces,
  ChevronRight,
  CircleHelp,
  Fingerprint,
  GitBranch,
  Layers3,
  RadioTower,
  ShieldCheck,
  Webhook,
} from "lucide-react";
import { apiBaseUrl, ApiRequestError, getHealth, getWebhookJob, submitWebhookEvent } from "./api";
import { AttemptTimeline } from "./components/AttemptTimeline";
import { DeliveryForm } from "./components/DeliveryForm";
import { IdempotencyDemo } from "./components/IdempotencyDemo";
import { JobOverview } from "./components/JobOverview";
import type { Scenario, WebhookEventInput, WebhookJobStatus } from "./types";

const terminalStates = new Set(["completed", "failed"]);

function parseDraft(eventType: string, payloadText: string, scenario: Scenario): WebhookEventInput | null {
  if (!eventType.trim() || eventType.length > 100) return null;
  try {
    const payload: unknown = JSON.parse(payloadText);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 8 * 1024) return null;
    return { eventType: eventType.trim(), payload: payload as Record<string, unknown>, scenario };
  } catch {
    return null;
  }
}

export default function App() {
  const [eventType, setEventType] = useState("invoice.paid");
  const [payloadText, setPayloadText] = useState('{\n  "invoiceId": "inv_8042",\n  "amount": 128.5,\n  "currency": "USD"\n}');
  const [scenario, setScenario] = useState<Scenario>("success");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<WebhookJobStatus | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);

  const demoEvent = useMemo(
    () => parseDraft(eventType, payloadText, scenario),
    [eventType, payloadText, scenario],
  );

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const checkHealth = async () => {
      controller = new AbortController();
      try {
        await getHealth(controller.signal);
        if (active) setApiOnline(true);
      } catch {
        if (active) setApiOnline(false);
      }
      if (active) timer = window.setTimeout(checkHealth, 12_000);
    };

    void checkHealth();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    if (!jobId || (job && terminalStates.has(job.state))) return;

    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      controller = new AbortController();
      try {
        const latest = await getWebhookJob(jobId, controller.signal);
        if (!active) return;
        setJob(latest);
        setJobError(null);
        if (!terminalStates.has(latest.state)) timer = window.setTimeout(poll, 900);
      } catch (error) {
        if (!active) return;
        setJobError(error instanceof Error ? error.message : "Could not reach the HookFlow API.");
        if (!(error instanceof ApiRequestError && error.status === 404)) {
          timer = window.setTimeout(poll, 2_500);
        }
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [jobId, job?.state, refreshVersion]);

  async function handleSubmit(event: WebhookEventInput, key?: string) {
    setSubmitting(true);
    setSubmitError(null);
    setJob(null);
    setJobId(null);
    setJobError(null);
    try {
      const response = await submitWebhookEvent(event, key);
      if (response.status === 409) {
        setSubmitError(response.data.error || "This idempotency key belongs to a different event.");
        return;
      }
      if (response.status !== 202 || !response.data.jobId) {
        throw new Error(response.data.error || `Submission failed (${response.status}).`);
      }
      setJobId(response.data.jobId);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not reach the HookFlow API.");
    } finally {
      setSubmitting(false);
    }
  }

  const isTerminal = Boolean(job && terminalStates.has(job.state));
  const isPolling = Boolean(jobId && !isTerminal && jobError !== "Webhook event not found");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="HookFlow home">
          <span className="brand-mark"><Webhook size={20} strokeWidth={2.2} /></span>
          <span className="brand-word">hookflow<span>.</span></span>
        </a>

        <div className="workspace-switcher">
          <div className="workspace-avatar">HF</div>
          <div className="workspace-copy"><strong>HookFlow workspace</strong><span>{import.meta.env.DEV ? "Local development" : "Configured API"}</span></div>
        </div>

        <nav className="side-nav" aria-label="Main navigation">
          <span className="nav-section-label">WORKSPACE</span>
          <a className="nav-link active" href="#compose"><Layers3 size={16} /><span>Delivery lab</span><span className="nav-active-line" /></a>
          <a className="nav-link" href="#attempts"><Activity size={16} /><span>Attempt history</span></a>
          <a className="nav-link" href="#idempotency"><Fingerprint size={16} /><span>Idempotency</span></a>

          <span className="nav-section-label nav-section-spaced">DEVELOPMENT</span>
          <a className="nav-link" href="#compose"><Braces size={16} /><span>Event composer</span></a>
          <a className="nav-link" href="#attempts"><GitBranch size={16} /><span>Retry behavior</span></a>
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-status-card">
            <div className="sidebar-status-head"><span className={`status-led ${apiOnline ? "led-online" : apiOnline === false ? "led-offline" : "led-checking"}`} />
              <span>{apiOnline ? "API reachable" : apiOnline === false ? "API unavailable" : "Checking API"}</span>
            </div>
          <span className="sidebar-status-url">{apiBaseUrl.startsWith("http") ? apiBaseUrl : `${apiBaseUrl} via Vite proxy`}</span>
          </div>
          <a className="nav-link help-link" href="#idempotency"><CircleHelp size={16} /><span>Idempotency guide</span><ChevronRight size={13} /></a>
          <div className="profile-row" aria-label="HookFlow demo environment">
            <div className="profile-avatar"><ShieldCheck size={15} /></div>
            <div className="profile-copy"><strong>Demo environment</strong><span>Server-configured receivers</span></div>
          </div>
        </div>
      </aside>

      <main className="main-area" id="top">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={13} /><strong>Delivery lab</strong></div>
          <div className="topbar-actions">
            <span className="environment-tag"><span /> {import.meta.env.DEV ? "LOCAL DEV" : "PRODUCTION API"}</span>
            <div className="top-avatar" aria-hidden="true"><ShieldCheck size={16} /></div>
          </div>
        </header>

        <div className="content-wrap">
          <section className="page-intro">
            <div>
              <div className="eyebrow intro-eyebrow"><span className="intro-line" /> WEBHOOK OPERATIONS</div>
              <h1>Delivery lab</h1>
              <p>Compose events, inspect retries, and see your delivery pipeline in motion.</p>
            </div>
            <div className={`api-connection ${apiOnline ? "connected" : apiOnline === false ? "disconnected" : "checking"}`}>
              <span className="connection-icon"><RadioTower size={17} /></span>
              <span><strong>{apiOnline ? "Backend connected" : apiOnline === false ? "Backend offline" : "Connecting…"}</strong><small>{apiOnline ? "Health check is responding" : apiOnline === false ? `Check ${apiBaseUrl}` : "Checking configured API"}</small></span>
              <span className="connection-dot" />
            </div>
          </section>

          <div className="notice-strip">
            <div className="notice-icon"><ShieldCheck size={15} /></div>
            <p><strong>Controlled delivery demo</strong> · Scenarios select a server-configured receiver from the allowlist. Event data cannot choose a destination URL.</p>
            <span>SAFE SANDBOX</span>
          </div>

          <div className="primary-grid">
            <DeliveryForm
              eventType={eventType}
              payloadText={payloadText}
              scenario={scenario}
              idempotencyKey={idempotencyKey}
              submitting={submitting}
              error={submitError}
              onEventTypeChange={setEventType}
              onPayloadChange={setPayloadText}
              onScenarioChange={setScenario}
              onIdempotencyKeyChange={setIdempotencyKey}
              onSubmit={handleSubmit}
            />
            <JobOverview
              job={job}
              polling={isPolling}
              error={jobError}
              onRefresh={() => setRefreshVersion((value) => value + 1)}
            />
          </div>

          <div className="secondary-grid">
            <div id="attempts"><AttemptTimeline job={job} /></div>
            <IdempotencyDemo event={demoEvent} />
          </div>

          <footer className="page-footer">
            <span><span className={`footer-dot ${apiOnline ? "" : "footer-dot-muted"}`} /> HookFlow {import.meta.env.DEV ? "local" : "deployed"} instance</span>
            <span>Delivery state is read from the BullMQ status API <ArrowDownRight size={13} /></span>
            <a href="#idempotency"><BookOpen size={13} /> Idempotency guide</a>
          </footer>
        </div>
      </main>
    </div>
  );
}
