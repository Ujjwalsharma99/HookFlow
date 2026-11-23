export const DEMO_QUEUE_NAME = "hookflow-demo";

export interface DemoJobData {
  message: string;
}

export interface DemoJobResult {
  status: "success";
  message: string;
}
