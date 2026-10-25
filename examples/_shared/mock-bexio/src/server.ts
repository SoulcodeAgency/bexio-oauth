// Runs the mock as a standalone process: `node src/server.ts` (Node 24 strips the types).
import { startMockBexio } from "./index.ts";

const port = Number(process.env.MOCK_BEXIO_PORT ?? 9400);
const mock = await startMockBexio({
  port,
  clientId: process.env.MOCK_BEXIO_CLIENT_ID ?? "example-client",
  clientSecret: process.env.MOCK_BEXIO_CLIENT_SECRET ?? "example-secret",
});
console.log(`mock-bexio listening on ${mock.url} (issuer ${mock.issuer})`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void mock.close().then(() => process.exit(0)));
}
