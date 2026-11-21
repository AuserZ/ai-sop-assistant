import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const project = process.env.SOP_WORKFLOW_TEST_PROJECT;
if (!project || !/^ai-sop-(?:assistant|s03-[a-z0-9-]+)$/.test(project)) {
  throw new Error("An explicitly named synthetic S03 Compose project is required.");
}
const docker = process.env.SOP_TEST_DOCKER ?? (process.platform === "win32" ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe" : "docker");
const fixtureName = `${project}-redirect-control`;
const workflowId = "sop-s03-http-control";
const workflowFile = "/tmp/sop-s03-http-control.json";
const nodeImage = "node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54";

function command(arguments_, input) {
  const result = spawnSync(docker, arguments_, { input, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error) {
    const details = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .replace(/-----BEGIN[^-]*KEY-----[\s\S]*?-----END[^-]*KEY-----/g, "[REDACTED_KEY]")
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
      .replace(/\b[a-f0-9]{64}\b/gi, "[REDACTED]")
      .split("\n").filter(line => /error|fail|unable|not found/i.test(line)).slice(0, 4).join("\n");
    throw new Error(`Scoped redirect proof command failed (exit ${result.status}): ${details}`);
  }
  return result.stdout;
}
const mainId = command(["compose", "-p", project, "ps", "--quiet", "n8n-main"]).trim();
assert.match(mainId, /^[a-f0-9]{12,64}$/);
const [main] = JSON.parse(command(["inspect", mainId]));
const normalize = path => resolve(path).replaceAll("\\", "/").toLowerCase();
assert.equal(main.Config.Labels["com.docker.compose.project"], project);
assert.equal(normalize(main.Config.Labels["com.docker.compose.project.working_dir"]), normalize(process.cwd()));

const server = `const http=require('node:http');let counts={source301:0,source307:0,destination:0,forwardedCanary:0};http.createServer((request,response)=>{response.setHeader('content-type','application/json');if(request.url==='/reset'){counts={source301:0,source307:0,destination:0,forwardedCanary:0};response.end('{}');}else if(request.url==='/counts'){response.end(JSON.stringify(counts));}else if(request.url==='/301'||request.url==='/307'){const status=Number(request.url.slice(1));counts['source'+status]++;response.writeHead(status,{location:'http://sop-s03-redirect-destination:8080/destination'});response.end('{}');}else if(request.url==='/destination'){counts.destination++;if(request.headers.authorization==='Bearer synthetic-redirect-canary')counts.forwardedCanary++;response.end('{}');}else{response.writeHead(404);response.end('{}');}}).listen(8080,'0.0.0.0');`;
let fixtureStarted = false;
try {
  command(["run", "--detach", "--rm", "--pull", "missing", "--name", fixtureName,
    "--label", `com.docker.compose.project=${project}`, "--network", `${project}_workflow`,
    "--network-alias", "sop-s03-redirect-fixture", "--network-alias", "sop-s03-redirect-destination",
    "--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--memory", "64m", "--cpus", "0.25", "--pids-limit", "32", "--entrypoint", "node", nodeImage, "-e", server]);
  fixtureStarted = true;
  await delay(500);
  function fixtureRequest(path) {
    const script = `fetch('http://sop-s03-redirect-fixture:8080/${path}').then(async response=>{if(!response.ok)throw Error('Fixture HTTP failure');console.log(await response.text());});`;
    return JSON.parse(command(["exec", mainId, "node", "-e", script]));
  }
  for (const noFollow of [false, true]) {
    fixtureRequest("reset");
    const requestNode = status => ({
      id: `redirect-${status}`, name: `Redirect ${status}`, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2,
      position: [status, 0], parameters: {
        method: "POST", url: `http://sop-s03-redirect-fixture:8080/${status}`, authentication: "none",
        sendHeaders: true, headerParameters: { parameters: [{ name: "Authorization", value: "Bearer synthetic-redirect-canary" }] },
        sendBody: true, specifyBody: "json", jsonBody: "{}",
        options: {
          timeout: 5000, response: { response: { fullResponse: true, neverError: true, responseFormat: "json" } },
          ...(noFollow ? { redirect: { redirect: { followRedirects: false } } } : {}),
        },
      },
    });
    const workflow = {
      id: workflowId, name: "S03 inactive native HTTP redirect control", active: false,
      nodes: [{ id: "manual", name: "Manual", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} }, requestNode(301), requestNode(307)],
      connections: { Manual: { main: [[{ node: "Redirect 301", type: "main", index: 0 }]] }, "Redirect 301": { main: [[{ node: "Redirect 307", type: "main", index: 0 }]] } },
      settings: { executionOrder: "v1", saveDataErrorExecution: "none", saveDataSuccessExecution: "none", saveManualExecutions: false, saveExecutionProgress: false, executionTimeout: 20 },
    };
    command(["exec", "-i", mainId, "node", "-e", `require('node:fs').writeFileSync('${workflowFile}',require('node:fs').readFileSync(0),{mode:0o600});`], JSON.stringify(workflow));
    command(["exec", mainId, "n8n", "import:workflow", `--input=${workflowFile}`]);
    command(["exec", mainId, "n8n", "execute", `--id=${workflowId}`, "--rawOutput"]);
    const counts = fixtureRequest("counts");
    assert.equal(counts.source301, 1);
    assert.equal(counts.source307, 1);
    assert.equal(counts.destination, noFollow ? 0 : 2);
    if (noFollow) assert.equal(counts.forwardedCanary, 0);
    console.log(JSON.stringify({ mode: "native-cli-http-node", followRedirects: noFollow ? false : "default", ...counts }));
  }
  console.log(`PASS: native 301/307 no-follow controls; retained inactive synthetic workflow ${workflowId}. This is separate from Queue Mode proof.`);
} finally {
  try {
    command(["exec", mainId, "node", "-e", `require('node:fs').rmSync('${workflowFile}',{force:true});`]);
  } finally {
    if (fixtureStarted) {
      const [fixture] = JSON.parse(command(["inspect", fixtureName]));
      assert.equal(fixture.Config.Labels["com.docker.compose.project"], project);
      command(["stop", "--time", "5", fixtureName]);
    }
  }
}
