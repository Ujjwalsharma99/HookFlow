import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

interface ManagedChild {
  name: "API" | "worker";
  process: ChildProcess;
  finished: boolean;
}

const children: ManagedChild[] = [
  {
    name: "API",
    process: spawn(process.execPath, [resolve(__dirname, "index.js")], { stdio: "inherit" }),
    finished: false,
  },
  {
    name: "worker",
    process: spawn(process.execPath, [resolve(__dirname, "worker.js")], { stdio: "inherit" }),
    finished: false,
  },
];

let shuttingDown = false;
let requestedExitCode = 0;
let forceStopTimer: NodeJS.Timeout | undefined;

function allChildrenExited(): boolean {
  return children.every(({ process: child, finished }) => finished || child.exitCode !== null || child.signalCode !== null);
}

function finishIfStopped(): void {
  if (!shuttingDown || !allChildrenExited()) return;
  if (forceStopTimer) clearTimeout(forceStopTimer);
  process.exitCode = requestedExitCode;
}

function stopAll(exitCode: number, signal: NodeJS.Signals): void {
  if (exitCode !== 0) requestedExitCode = exitCode;
  if (!shuttingDown) {
    shuttingDown = true;
    console.log(`HookFlow combined service stopping both processes with ${signal}`);
    forceStopTimer = setTimeout(() => {
      console.error("Combined shutdown grace period expired; force-stopping remaining processes");
      requestedExitCode = 1;
      for (const { process: child, finished } of children) {
        if (!finished && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      finishIfStopped();
    }, 35_000);
    forceStopTimer.unref();
  }

  for (const { process: child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  finishIfStopped();
}

for (const managed of children) {
  const { name, process: child } = managed;
  child.once("spawn", () => {
    if (shuttingDown) child.kill("SIGTERM");
  });
  child.once("error", () => {
    console.error(`HookFlow ${name} process could not be started`);
    stopAll(1, "SIGTERM");
  });
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`HookFlow ${name} process exited unexpectedly (code ${code ?? "none"}, signal ${signal ?? "none"})`);
      stopAll(1, "SIGTERM");
    }
  });
  child.once("close", () => {
    managed.finished = true;
    finishIfStopped();
  });
}

process.once("SIGINT", () => stopAll(0, "SIGTERM"));
process.once("SIGTERM", () => stopAll(0, "SIGTERM"));

console.log("HookFlow combined service started API and worker processes");
