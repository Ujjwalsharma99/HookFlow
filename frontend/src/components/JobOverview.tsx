import { CircleAlert, Copy, ExternalLink, Fingerprint, Radio, RotateCw } from "lucide-react";
import { useState } from "react";
import type { WebhookJobStatus } from "../types";
import { StatePill } from "./StatePill";

interface JobOverviewProps {
  job: WebhookJobStatus | null;
  polling: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function JobOverview({ job, polling, error, onRefresh }: JobOverviewProps) {
  const [copied, setCopied] = useState(false);

  async function copyJobId() {
    if (!job) return;
    try {
      await navigator.clipboard.writeText(job.jobId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="panel job-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">LIVE JOB</div>
          <h2>Delivery status</h2>
        </div>
        {job && (
          <button className="icon-button" type="button" onClick={onRefresh} aria-label="Refresh job status">
            <RotateCw size={16} className={polling ? "spin" : undefined} />
          </button>
        )}
      </div>

      {error && !job && (
        <div className="job-error-state" role="alert">
          <CircleAlert size={21} />
          <strong>Could not load job</strong>
          <p>{error}</p>
          <button className="quiet-button" onClick={onRefresh} type="button">Try again</button>
        </div>
      )}

      {!job && !error && (
        <div className="empty-job-state">
          <div className="empty-orbit"><Radio size={24} /></div>
          <strong>No active delivery</strong>
          <p>Submit an event to see its real BullMQ state, retries, and delivery result here.</p>
          <span className="empty-state-note"><ExternalLink size={13} /> Connected to your local HookFlow API</span>
        </div>
      )}

      {job && (
        <div className="job-content">
          <div className="job-state-row">
            <StatePill state={job.state} />
            {polling && <span className="polling-label"><span className="live-dot" /> polling</span>}
          </div>
          <div className="job-id-block">
            <span className="field-label">JOB ID</span>
            <div className="job-id-value">
              <code>{job.jobId}</code>
              <button className="copy-button" type="button" onClick={copyJobId} aria-label="Copy job ID">
                <Copy size={14} /> {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="job-stats-row">
            <div className="job-stat">
              <span>Delivery attempts</span>
              <strong>{job.deliveryAttemptsMade}<small> / {job.maximumAttempts}</small></strong>
            </div>
            <div className="job-stat">
              <span>BullMQ attempts made</span>
              <strong>{job.attemptsMade}</strong>
            </div>
            <div className="job-stat">
              <span>Retry state</span>
              <strong className={job.retryScheduled ? "retry-active" : "retry-idle"}>
                {job.retryScheduled ? "Scheduled" : job.state === "completed" ? "Not needed" : "—"}
              </strong>
            </div>
          </div>

          {job.result && (
            <div className="result-box result-success">
              <span className="result-caption"><Fingerprint size={14} /> DELIVERY RESULT</span>
              <code>HTTP {job.result.statusCode} · delivered</code>
            </div>
          )}
          {job.failureReason && (
            <div className="result-box result-failure" role="status">
              <span className="result-caption"><CircleAlert size={14} /> FINAL FAILURE</span>
              <code>{job.failureReason}</code>
            </div>
          )}
          {error && <div className="poll-error" role="status">{error}. {error === "Webhook event not found" ? "Polling stopped." : "Retrying…"}</div>}
        </div>
      )}
    </section>
  );
}
