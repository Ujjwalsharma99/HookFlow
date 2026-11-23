import { Activity, Clock3, Globe2, Info } from "lucide-react";
import type { WebhookJobStatus } from "../types";

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

interface AttemptTimelineProps {
  job: WebhookJobStatus | null;
}

export function AttemptTimeline({ job }: AttemptTimelineProps) {
  const attempts = job?.deliveryAttempts ?? [];

  return (
    <section className="panel attempts-panel">
      <div className="panel-heading attempts-heading">
        <div>
          <div className="eyebrow">TRANSPORT HISTORY</div>
          <h2>Delivery attempts</h2>
        </div>
        {job && <span className="attempt-count">{attempts.length} recorded</span>}
      </div>

      {attempts.length === 0 ? (
        <div className="empty-attempts">
          <Activity size={19} />
          <span>{job ? "Waiting for the first delivery attempt…" : "Attempt history appears when a job is submitted."}</span>
        </div>
      ) : (
        <div className="attempt-table-wrap">
          <table className="attempt-table">
            <thead>
              <tr>
                <th>Attempt</th>
                <th>Timestamp</th>
                <th>HTTP / error</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => (
                <tr key={`${attempt.attemptNumber}-${attempt.timestamp}`}>
                  <td><span className="attempt-number">{String(attempt.attemptNumber).padStart(2, "0")}</span></td>
                  <td className="timestamp-cell"><Clock3 size={13} /> {formatTimestamp(attempt.timestamp)}</td>
                  <td>
                    {attempt.httpStatus ? (
                      <span className={`http-code ${attempt.httpStatus >= 200 && attempt.httpStatus < 300 ? "http-ok" : "http-bad"}`}>
                        <Globe2 size={12} /> {attempt.httpStatus}
                      </span>
                    ) : (
                      <span className="error-category">{attempt.errorCategory || "unknown error"}</span>
                    )}
                  </td>
                  <td>
                    <span className={`outcome-pill outcome-${attempt.outcome}`}>
                      <span />
                      {attempt.outcome.replaceAll("_", " ")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {job?.retryScheduled && (
        <div className="retry-banner"><Info size={14} /> BullMQ is waiting for the next exponential backoff interval.</div>
      )}
    </section>
  );
}
