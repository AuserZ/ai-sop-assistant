import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import { createStorageGateway } from "./gateway.mjs";

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function fixture(t, respond, options = {}) {
  const received = [];
  const upstream = createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", chunk => chunks.push(chunk));
    incoming.on("end", () => { received.push({ url: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks).toString() }); respond(outgoing); });
  });
  const upstreamOrigin = await listen(upstream);
  const gateway = createStorageGateway({ upstreamOrigin, bucket: "synthetic", ...options });
  const origin = await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstream); });
  return { origin, received, target: origin + "/cdn-cgi/local/r2/s3/synthetic/staging/object" };
}

test("only the bounded S3 surface is reachable", async t => {
  const f = await fixture(t, response => response.end("ok"));
  for (const path of ["/cdn-cgi/local/r2/public/synthetic/key", "/cdn-cgi/local/explorer", "/", "/cdn-cgi/local/r2/s3/other/key", "/cdn-cgi/local/r2/s3/synthetic/../other/key"]) assert.equal((await fetch(f.origin + path)).status, 404);
  for (const method of ["POST", "DELETE"]) assert.equal((await fetch(f.target, { method })).status, 404);
  assert.equal((await fetch(f.target + "?uploadId=unsupported", { method: "PUT" })).status, 404);
  assert.equal(f.received.length, 0);
});

test("browser credentials and foreign origins never reach storage", async t => {
  const f = await fixture(t, response => response.end("ok"));
  for (const headers of [{ Cookie: "session=synthetic" }, { Authorization: "Bearer synthetic" }, { "Proxy-Authorization": "Basic synthetic" }, { Origin: "https://untrusted.invalid" }]) assert.equal((await fetch(f.target, { method: "PUT", headers })).status, 403, Object.keys(headers).join(","));
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const client = request(f.target, { method: "PUT", headers: { Host: "untrusted.invalid" } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    client.on("error", reject);
    client.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal(f.received.length, 0);
});

test("signed host, raw query and upload headers survive the transport hop", async t => {
  const f = await fixture(t, response => { response.writeHead(200, { ETag: '"synthetic"', "access-control-allow-origin": "http://127.0.0.1:3000" }); response.end(); });
  const query = "?X-Amz-Signature=synthetic&X-Amz-Credential=local%2Fscope&x-id=PutObject";
  const response = await fetch(f.target + query, { method: "PUT", headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/pdf", "If-None-Match": "*", "amz-sdk-invocation-id": "synthetic-invocation", "amz-sdk-request": "attempt=1; max=1", "x-amz-meta-write-id": "synthetic", "X-Unrelated": "must-not-forward" }, body: "data" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"synthetic"');
  assert.equal(f.received[0].url, "/cdn-cgi/local/r2/s3/synthetic/staging/object" + query);
  assert.equal(f.received[0].headers.host, new URL(f.origin).host);
  assert.equal(f.received[0].headers["content-length"], "4");
  assert.equal(f.received[0].headers["content-type"], "application/pdf");
  assert.equal(f.received[0].headers["if-none-match"], "*");
  assert.equal(f.received[0].headers["amz-sdk-invocation-id"], "synthetic-invocation");
  assert.equal(f.received[0].headers["amz-sdk-request"], "attempt=1; max=1");
  assert.equal(f.received[0].headers["x-unrelated"], undefined);
  assert.equal(f.received[0].body, "data");
});

test("diagnostic errors and redirects expose no signed request details", async t => {
  const f = await fixture(t, response => { response.writeHead(403, { "content-type": "application/xml" }); response.end("<Error><Code>SignatureDoesNotMatch</Code><CanonicalRequest>synthetic-secret-query</CanonicalRequest><SignatureProvided>synthetic-signature</SignatureProvided></Error>"); });
  const response = await fetch(f.target);
  assert.equal(response.status, 403);
  const text = await response.text();
  assert.match(text, /SignatureDoesNotMatch/);
  assert.doesNotMatch(text, /CanonicalRequest|synthetic-secret-query|synthetic-signature/);
  const redirect = await fixture(t, result => { result.writeHead(307, { Location: "https://untrusted.invalid" }); result.end(); });
  const denied = await fetch(redirect.target, { redirect: "manual" });
  assert.equal(denied.status, 502);
  assert.equal(denied.headers.get("location"), null);
});

test("oversized input and stalled upstream requests terminate safely", async t => {
  const f = await fixture(t, () => {}, { maximumBodyBytes: 4, requestTimeoutMilliseconds: 50 });
  assert.equal((await fetch(f.target, { method: "PUT", body: "oversize" })).status, 413);
  assert.equal(f.received.length, 0);
  assert.equal((await fetch(f.target)).status, 504);
});

test("100-continue is terminated before the native workerd transport", async t => {
  const f = await fixture(t, response => response.end("ok"));
  const status = await new Promise((resolve, reject) => {
    const upload = request(f.target, { method: "PUT", headers: { Expect: "100-continue", "Content-Length": "4" } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    upload.on("continue", () => upload.end("data"));
    upload.on("error", reject);
    upload.flushHeaders();
  });
  assert.equal(status, 200);
  assert.equal(f.received[0].headers.expect, undefined);
  assert.equal(f.received[0].body, "data");
});
