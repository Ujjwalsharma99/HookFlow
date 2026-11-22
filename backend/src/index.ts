import express from "express";

const app = express();
const port = Number(process.env.PORT) || 3000;

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "hookflow" });
});

app.listen(port, () => {
  console.log(`HookFlow API listening on port ${port}`);
});
