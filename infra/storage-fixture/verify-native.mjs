import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

if (process.env.SOP_STORAGE_FIXTURE_VERIFY !== "1") throw new Error("Explicit synthetic storage verification is required.");
const docker = process.env.SOP_TEST_DOCKER ?? (process.platform === "win32" ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe" : "docker");
const image = process.env.SOP_STORAGE_FIXTURE_IMAGE ?? "ai-sop-s04-storage-fixture:verify";
const project = "ai-sop-s04-fixture-proof";
const name = `${project}-${randomUUID()}`;
const workspace = resolve(".").replaceAll("\\", "/").toLowerCase();
const directory = resolve(".local-secrets/storage-fixtures");
const bucket = "s04-synthetic-uploads";
const endpoint = "http://127.0.0.1:8787/cdn-cgi/local/r2/s3";
let created = false;

function command(arguments_, input) {
  const result = spawnSync(docker, arguments_, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error(`Scoped fixture command failed (exit ${result.status}); raw details withheld.`);
  return result.stdout;
}
function inspect() {
  const [container] = JSON.parse(command(["inspect", name]));
  assert.equal(container.Config.Labels["com.docker.compose.project"], project);
  assert.equal(container.Config.Labels["ai-sop.workspace"], workspace);
  assert.equal(container.Config.Labels["ai-sop.proof"], "s04-storage");
  return container;
}

const driver = String.raw`
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
async function run(test){
  let status,text,headers;
  const body=test.body?Buffer.from(test.body,'base64'):undefined;
  if(test.hostHeader){
    const result=await new Promise((resolve,reject)=>{const request=http.request(test.url,{method:test.method,headers:{...test.headers,Host:test.hostHeader}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,text:Buffer.concat(chunks).toString('utf8'),headers:response.headers}));});request.on('error',reject);request.setTimeout(10000,()=>request.destroy(Error('Transport deadline')));request.end(body);});
    status=result.status;text=result.text;headers=result.headers;
  }else{
    const response=await fetch(test.url,{method:test.method,headers:test.headers,body,redirect:'manual',signal:AbortSignal.timeout(10000)});
    status=response.status;text=await response.text();headers=Object.fromEntries(response.headers);
  }
  return{check:test.check,status,code:new RegExp('<Code>([A-Za-z0-9]+)</Code>').exec(text)?.[1],length:Number(headers['content-length']??0),bodyMatches:test.expectedHash?crypto.createHash('sha256').update(text).digest('hex')===test.expectedHash:undefined,diagnosticMarkers:/CanonicalRequest|StringToSign|SignatureProvided|X-Amz-Credential|X-Amz-Signature/.test(text),locationPresent:Boolean(headers.location),allowOrigin:headers['access-control-allow-origin']};
}
(async()=>{const results=input.parallel?await Promise.all(input.cases.map(run)):[];if(!input.parallel)for(const test of input.cases)results.push(await run(test));console.log(JSON.stringify(results));})().catch(()=>{console.error('Synthetic HTTP driver failed; request details withheld.');process.exitCode=1;});
`;

const sdkTransport = String.raw`
const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));
(async()=>{const response=await fetch(input.url,{method:input.method,headers:input.headers,body:input.body?Buffer.from(input.body,'base64'):undefined,redirect:'manual',signal:AbortSignal.timeout(10000)});const body=Buffer.from(await response.arrayBuffer());console.log(JSON.stringify({statusCode:response.status,headers:Object.fromEntries(response.headers),body:body.toString('base64')}));})().catch(()=>{console.error('Synthetic SDK transport failed; request details withheld.');process.exitCode=1;});
`;

async function main() {
  const directoryStat = await lstat(directory);
  assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());
  const files = ["access-key-id", "secret-access-key"].map(file => resolve(directory, file));
  for (const file of files) { const stat = await lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink()); }
  const accessKeyId = (await readFile(files[0], "utf8")).trim();
  const secretAccessKey = (await readFile(files[1], "utf8")).trim();
  assert.match(accessKeyId, /^s04-fixture-access-[a-f0-9]{32}$/);
  assert.match(secretAccessKey, /^s04-fixture-secret-[a-f0-9]{64}$/);
  const [metadata] = JSON.parse(command(["image", "inspect", image]));
  assert.equal(metadata.Config.User, "node");
  const client = new S3Client({ endpoint, region: "auto", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey }, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  const bytes = Buffer.from("%PDF-1.7\nS04 synthetic native storage proof\n%%EOF\n");
  const headers = { "content-type": "application/pdf", "content-length": String(bytes.length), "if-none-match": "*" };
  const body = bytes.toString("base64");
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  const signedPut = async (key, options = {}, signer = client) => {
    const url = await getSignedUrl(signer, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "application/pdf", ContentLength: bytes.length, IfNoneMatch: "*" }), { expiresIn: 120, signableHeaders: new Set(["content-type", "content-length", "if-none-match"]), ...options });
    assert.equal(new URL(url).searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host;if-none-match");
    return url;
  };
  function run(cases, parallel = false) { return JSON.parse(command(["exec", "-i", name, "node", "-e", driver], JSON.stringify({ cases, parallel }))); }
  function check(result, expectedStatus, expectedCode) {
    assert.equal(result.status, expectedStatus, `Unexpected status for ${result.check}`);
    if (expectedCode) assert.equal(result.code, expectedCode, `Unexpected error code for ${result.check}`);
    assert.equal(result.diagnosticMarkers, false);
    assert.equal(result.locationPresent, false);
    console.log(JSON.stringify(result));
  }
  try {
    command(["run", "--detach", "--pull", "never", "--name", name, "--label", `com.docker.compose.project=${project}`, "--label", `ai-sop.workspace=${workspace}`, "--label", "ai-sop.proof=s04-storage", "--network", "none", "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--tmpfs", "/tmp:uid=1000,gid=1000,mode=0700,size=256m", "--mount", `type=bind,src=${files[0]},dst=/run/secrets/storage-fixture-access-key-id,readonly`, "--mount", `type=bind,src=${files[1]},dst=/run/secrets/storage-fixture-secret-access-key,readonly`, "--env", "SOP_LOCAL_STORAGE_FIXTURE_ENABLED=1", image]);
    created = true;
    const container = inspect();
    assert.equal(container.HostConfig.NetworkMode, "none");
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.equal(container.HostConfig.Memory, 512 * 1024 * 1024);
    assert.equal(container.HostConfig.NanoCpus, 1_000_000_000);
    assert.equal(container.HostConfig.PidsLimit, 128);
    assert.ok(container.HostConfig.CapDrop.includes("ALL"));
    assert.ok(container.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
    assert.ok(!container.HostConfig.PortBindings || Object.keys(container.HostConfig.PortBindings).length === 0);
    assert.equal(container.Config.User, "1000:1000");
    assert.equal(container.Mounts.filter(mount => mount.Type === "bind").length, 2);
    assert.ok(container.Mounts.filter(mount => mount.Type === "bind").every(mount => !mount.RW && mount.Source.replaceAll("\\", "/").includes("/.local-secrets/storage-fixtures/")));
    console.log(JSON.stringify({ phase: "isolated-container", image: metadata.Id, network: "none", readOnly: true, user: "1000:1000", syntheticReadOnlyMounts: 2, publishedPorts: 0 }));
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline) {
      const current = inspect();
      if (!current.State.Running) throw new Error("Synthetic runtime exited before readiness.");
      const result = spawnSync(docker, ["exec", name, "node", "-e", "fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { encoding: "utf8", timeout: 5000 });
      if (result.status === 0) { ready = true; break; }
      await delay(1000);
    }
    assert.ok(ready, "Synthetic storage did not become ready.");
    const key = `staging/${randomUUID()}`;
    const putUrl = await signedPut(key);
    const preflight = run([{ check: "native loopback preflight", url: putUrl, method: "OPTIONS", headers: { origin: "http://127.0.0.1:3000", "access-control-request-method": "PUT", "access-control-request-headers": "content-type,if-none-match" } }])[0];
    check(preflight, 204);
    assert.equal(preflight.allowOrigin, "*");
    check(run([{ check: "native signed PUT", url: putUrl, method: "PUT", headers: { ...headers, origin: "http://127.0.0.1:3000" }, body }])[0], 200);
    const headUrl = await getSignedUrl(client, new HeadObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 120 });
    const getUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 120 });
    const head = run([{ check: "native signed HEAD", url: headUrl, method: "HEAD" }])[0]; check(head, 200); assert.equal(head.length, bytes.length);
    const get = run([{ check: "native signed GET", url: getUrl, method: "GET", expectedHash }])[0]; check(get, 200); assert.equal(get.bodyMatches, true);
    const sdkHeaderSets = [];
    const authorizationClient = new S3Client({ endpoint, region: "auto", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", requestHandler: {
      async handle(request) {
        const authorization = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? "";
        const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1].split(";") ?? [];
        assert.ok(signedHeaders.includes("amz-sdk-invocation-id") && signedHeaders.includes("amz-sdk-request"));
        sdkHeaderSets.push(signedHeaders);
        const target = new URL(`${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}${request.path}`);
        for (const [key, values] of Object.entries(request.query ?? {})) for (const value of Array.isArray(values) ? values : [values]) target.searchParams.append(key, String(value));
        const response = JSON.parse(command(["exec", "-i", name, "node", "-e", sdkTransport], JSON.stringify({ url: target.href, method: request.method, headers: request.headers, body: request.body ? Buffer.from(request.body).toString("base64") : undefined })));
        return { response: { statusCode: response.statusCode, headers: response.headers, body: Readable.from(Buffer.from(response.body, "base64")) } };
      },
    } });
    try {
      const sdkKey = `final/${randomUUID()}`;
      const input = { Bucket: bucket, Key: sdkKey, Body: bytes, ContentLength: bytes.length, ContentType: "application/pdf", IfNoneMatch: "*" };
      const written = await authorizationClient.send(new PutObjectCommand(input));
      assert.equal(written.$metadata.httpStatusCode, 200);
      const received = await authorizationClient.send(new GetObjectCommand({ Bucket: bucket, Key: sdkKey }));
      assert.equal(received.$metadata.httpStatusCode, 200);
      assert.deepEqual(Buffer.from(await received.Body.transformToByteArray()), bytes);
      await assert.rejects(authorizationClient.send(new PutObjectCommand(input)), error => error.name === "PreconditionFailed" && error.$metadata.httpStatusCode === 412);
      console.log(JSON.stringify({ check: "native Authorization-signed SDK.send", put: 200, get: 200, bodyMatches: true, replay: 412, signedHeaderNames: sdkHeaderSets }));
    } finally { authorizationClient.destroy(); }
    const unsigned = run([{ check: "native unsigned object denial", url: `${endpoint}/${bucket}/${key}`, method: "GET" }])[0];
    assert.ok([400, 401, 403].includes(unsigned.status));
    check(unsigned, unsigned.status);
    check(run([{ check: "native create-only replay", url: putUrl, method: "PUT", headers, body }])[0], 412, "PreconditionFailed");
    const raceUrl = await signedPut(`final/${randomUUID()}`);
    const race = run([0, 1].map(index => ({ check: `native conditional race ${index + 1}`, url: raceUrl, method: "PUT", headers, body })), true);
    assert.deepEqual(race.map(result => result.status).sort(), [200, 412]);
    for (const result of race) check(result, result.status, result.status === 412 ? "PreconditionFailed" : undefined);
    const fresh = await signedPut(`staging/${randomUUID()}`);
    const badSignature = new URL(fresh); const signature = badSignature.searchParams.get("X-Amz-Signature"); badSignature.searchParams.set("X-Amz-Signature", (signature[0] === "0" ? "1" : "0") + signature.slice(1));
    const badPath = new URL(fresh); badPath.pathname += "-tampered";
    const expired = await signedPut(`staging/${randomUUID()}`, { expiresIn: 1, signingDate: new Date(Date.now() - 120_000) });
    const unknownIdentity = new S3Client({ endpoint, region: "auto", forcePathStyle: true, credentials: { accessKeyId: `s04-fixture-access-${randomUUID().replaceAll("-", "")}`, secretAccessKey }, requestChecksumCalculation: "WHEN_REQUIRED" });
    const wrongSecret = new S3Client({ endpoint, region: "auto", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey: "s04-fixture-secret-incorrect" }, requestChecksumCalculation: "WHEN_REQUIRED" });
    const unknownIdentityUrl = await signedPut(`staging/${randomUUID()}`, {}, unknownIdentity);
    const wrongSecretUrl = await signedPut(`staging/${randomUUID()}`, {}, wrongSecret);
    unknownIdentity.destroy();
    wrongSecret.destroy();
    const alteredBody = Buffer.concat([bytes, Buffer.from("!")]).toString("base64");
    const denied = run([
      { check: "native bad signature", url: badSignature.href, method: "PUT", headers, body },
      { check: "native path tamper", url: badPath.href, method: "PUT", headers, body },
      { check: "native type tamper", url: fresh, method: "PUT", headers: { ...headers, "content-type": "application/octet-stream" }, body },
      { check: "native length tamper", url: fresh, method: "PUT", headers: { ...headers, "content-length": String(bytes.length + 1) }, body: alteredBody },
      { check: "native create-only header tamper", url: fresh, method: "PUT", headers: { ...headers, "if-none-match": '"changed"' }, body },
      { check: "native host tamper", url: fresh, method: "PUT", headers, body, hostHeader: "localhost:8787" },
      { check: "native expired URL", url: expired, method: "PUT", headers, body },
      { check: "native unknown credential identity", url: unknownIdentityUrl, method: "PUT", headers, body },
      { check: "native wrong signing secret", url: wrongSecretUrl, method: "PUT", headers, body },
    ]);
    for (const result of denied) check(result, result.check === "native unknown credential identity" ? 401 : 403, result.check === "native expired URL" ? "ExpiredRequest" : result.check === "native unknown credential identity" ? "Unauthorized" : "SignatureDoesNotMatch");
    const wrapperDenied = run([
      { check: "gateway cookie denial", url: fresh, method: "PUT", headers: { ...headers, cookie: "session=synthetic" }, body },
      { check: "gateway bearer denial", url: fresh, method: "PUT", headers: { ...headers, authorization: "Bearer synthetic" }, body },
      { check: "gateway foreign Origin denial", url: fresh, method: "PUT", headers: { ...headers, origin: "https://example.invalid" }, body },
      { check: "gateway unsigned public route denial", url: `http://127.0.0.1:8787/cdn-cgi/local/r2/public/${bucket}/${key}`, method: "GET" },
      { check: "gateway explorer denial", url: "http://127.0.0.1:8787/cdn-cgi/local/explorer", method: "GET" },
    ]);
    for (const result of wrapperDenied) check(result, /public|explorer/.test(result.check) ? 404 : 403);
    const logs = command(["logs", name]);
    assert.doesNotMatch(logs, /X-Amz-Signature|X-Amz-Credential|AWS4-HMAC-SHA256 Credential=|s04-fixture-(?:access|secret)-/i);
    const logFiles = JSON.parse(command(["exec", name, "node", "-e", String.raw`
      const fs=require('node:fs');const counts={regularLogFiles:0,discardedLogLinks:0,credentialMarkers:0};
      function scan(path){for(const name of fs.readdirSync(path)){const file=path+'/'+name,stat=fs.lstatSync(file);if(stat.isDirectory())scan(file);else if(name.endsWith('.log')){if(stat.isSymbolicLink()){if(fs.readlinkSync(file)!=='/dev/null')throw Error('Unexpected log link');counts.discardedLogLinks++;}else if(stat.isFile()){counts.regularLogFiles++;counts.credentialMarkers+=(fs.readFileSync(file,'utf8').match(/X-Amz-Signature|X-Amz-Credential|AWS4-HMAC-SHA256 Credential=|s04-fixture-(?:access|secret)-/gi)??[]).length;}}}}
      for(const name of fs.readdirSync('/tmp').filter(name=>name.startsWith('s04-storage-')))scan('/tmp/'+name);
      console.log(JSON.stringify(counts));
    `]));
    assert.ok(logFiles.discardedLogLinks >= 1);
    assert.equal(logFiles.credentialMarkers, 0);
    console.log(JSON.stringify({ result: "PASS", nativeCryptographicDenials: denied.length, conditionalRace: { accepted: 1, rejected: 1 }, gatewayDenials: wrapperDenied.length, dockerLogCredentialMarkers: 0, nativeLogFiles: logFiles, providerCompatibilityClaimed: false }));
  } finally {
    client.destroy();
    if (created) { inspect(); command(["rm", "--force", name]); assert.equal(command(["ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]).trim(), ""); console.log(JSON.stringify({ cleanup: "PASS", ownedContainerRemoved: true, persistentVolumesCreated: 0 })); }
  }
}

await main().catch(error => { console.error(`Native fixture verification failed: ${error.message.split("\n")[0].replace(/https?:\S+/g, "[URL withheld]")}`); process.exitCode = 1; });
