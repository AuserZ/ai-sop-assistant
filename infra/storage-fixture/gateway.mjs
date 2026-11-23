import { createServer, request as upstreamRequest } from "node:http";

const allowedMethods = new Set(["PUT", "GET", "HEAD", "OPTIONS", "DELETE"]);
const allowedHeaders = new Set(["host", "origin", "content-type", "content-length", "content-md5", "authorization", "amz-sdk-invocation-id", "amz-sdk-request", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "access-control-request-method", "access-control-request-headers"]);
const allowedErrorCodes = new Set(["SignatureDoesNotMatch", "ExpiredRequest", "Unauthorized", "InvalidArgument", "InvalidRequest", "NoSuchKey", "NoSuchBucket", "PreconditionFailed", "BadDigest", "XAmzContentSHA256Mismatch", "RequestTimeTooSkewed", "NotImplemented"]);
const maximumErrorBytes = 65_536;

function reject(response, status, code = "InvalidRequest") {
  response.writeHead(status, { "content-type": "application/xml", "cache-control": "no-store" });
  response.end(`<Error><Code>${code}</Code><Message>Storage fixture request rejected.</Message></Error>`);
}

export function createStorageGateway({ upstreamOrigin, bucket, browserOrigin = "http://127.0.0.1:3000", maximumBodyBytes = 21_000_000, requestTimeoutMilliseconds = 15_000 }) {
  const upstream = new URL(upstreamOrigin);
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || upstream.pathname !== "/") throw new Error("The fixture upstream must be loopback HTTP.");
  const prefix = `/cdn-cgi/local/r2/s3/${bucket}/`;
  return createServer((incoming, outgoing) => {
    const host = incoming.headers.host ?? "";
    let hostname;
    try { hostname = new URL(`http://${host}`).hostname; } catch { reject(outgoing, 403); return; }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) { reject(outgoing, 403); return; }
    if (incoming.url === "/healthz" && incoming.method === "GET") { outgoing.writeHead(200, { "cache-control": "no-store" }); outgoing.end("ok"); return; }
    if (!incoming.url?.startsWith(prefix) || !allowedMethods.has(incoming.method)) { reject(outgoing, 404); return; }
    const url = new URL(incoming.url, `http://${host}`);
    if (!url.pathname.startsWith(prefix) || url.pathname.length === prefix.length || url.searchParams.has("uploadId") || url.searchParams.has("uploads") || url.searchParams.has("partNumber")) { reject(outgoing, 404); return; }
    if (incoming.headers.cookie || incoming.headers["proxy-authorization"] || (incoming.headers.authorization && !incoming.headers.authorization.startsWith("AWS4-HMAC-SHA256 "))) { reject(outgoing, 403); return; }
    if (incoming.method === "DELETE" && (incoming.headers.origin !== undefined || !incoming.headers.authorization?.startsWith("AWS4-HMAC-SHA256 "))) { reject(outgoing, 403); return; }
    if (incoming.headers.origin && incoming.headers.origin !== browserOrigin) { reject(outgoing, 403); return; }
    if (incoming.headers["x-amz-copy-source"]) { reject(outgoing, 400); return; }
    const length = incoming.headers["content-length"];
    if (length && (!/^\d+$/.test(length) || Number(length) > maximumBodyBytes)) { reject(outgoing, 413); return; }
    const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => allowedHeaders.has(name) || name.startsWith("x-amz-")));
    // Preserve the signed Host and raw path/query while changing only the transport destination.
    const target = upstreamRequest({ hostname: upstream.hostname, port: upstream.port, path: incoming.url, method: incoming.method, headers }, (received) => {
      if (outgoing.destroyed || outgoing.writableEnded) { received.destroy(); return; }
      if (received.statusCode >= 300 && received.statusCode < 400) { received.resume(); reject(outgoing, 502); return; }
      const responseHeaders = Object.fromEntries(Object.entries(received.headers).filter(([name]) => ["content-type", "content-length", "etag", "last-modified", "vary"].includes(name) || name.startsWith("access-control-") || name.startsWith("x-amz-meta-") || name.startsWith("x-amz-checksum-")));
      if (received.statusCode >= 400) {
        let bytes = 0;
        const chunks = [];
        received.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > maximumErrorBytes) { received.destroy(); reject(outgoing, 502); return; }
          chunks.push(chunk);
        });
        received.on("end", () => {
          if (outgoing.writableEnded) return;
          const code = /<Code>([A-Za-z0-9]+)<\/Code>/.exec(Buffer.concat(chunks).toString("utf8"))?.[1];
          for (const [name, value] of Object.entries(responseHeaders)) if (name.startsWith("access-control-")) outgoing.setHeader(name, value);
          reject(outgoing, received.statusCode, allowedErrorCodes.has(code) ? code : "InvalidRequest");
        });
      } else {
        outgoing.writeHead(received.statusCode, responseHeaders);
        received.pipe(outgoing);
      }
      received.on("error", () => { if (!outgoing.headersSent) reject(outgoing, 502); else outgoing.destroy(); });
    });
    let receivedBytes = 0;
    incoming.on("data", chunk => {
      receivedBytes += chunk.length;
      if (receivedBytes > maximumBodyBytes) { incoming.unpipe(target); target.destroy(); if (!outgoing.headersSent) reject(outgoing, 413); }
    });
    const deadline = setTimeout(() => { target.destroy(); if (!outgoing.headersSent) reject(outgoing, 504); else outgoing.destroy(); }, requestTimeoutMilliseconds);
    outgoing.on("close", () => { clearTimeout(deadline); target.destroy(); });
    target.on("error", () => { if (!outgoing.headersSent) reject(outgoing, 502); });
    incoming.on("aborted", () => target.destroy());
    incoming.pipe(target);
  });
}
