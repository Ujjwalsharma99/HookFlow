import { Check, CircleAlert, Clock3, LoaderCircle, RotateCw } from "lucide-react";
import type { JobState } from "../types";

const stateLabels: Record<JobState, string> = {
  waiting: "Queued",
  active: "Delivering",
  delayed: "Retry scheduled",
  completed: "Delivered",
  failed: "Failed",
  unknown: "Unknown",
};

export function StatePill({ state }: { state: JobState }) {
  const Icon = state === "completed"
    ? Check
    : state === "failed" || state === "unknown"
      ? CircleAlert
      : state === "delayed"
        ? RotateCw
        : state === "active"
          ? LoaderCircle
          : Clock3;

  return (
    <span className={`state-pill state-${state}`}>
      <Icon size={14} className={state === "active" ? "spin" : undefined} />
      {stateLabels[state]}
    </span>
  );
}
