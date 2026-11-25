// Runs the API the way Vercel does: one request handler, no background worker loop.
// Used by the e2e tests when E2E_SERVERLESS=1.
import http from "node:http";

process.env.VERCEL = "1";
const { default: handler } = await import("../src/app.js");
const port = Number(process.env.PORT || 10000);
http
  .createServer(handler)
  .listen(port, "127.0.0.1", () =>
    console.log(`serverless host listening on ${port}`),
  );
