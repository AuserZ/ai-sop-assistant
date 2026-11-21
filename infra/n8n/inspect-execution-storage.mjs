import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const project = process.env.SOP_WORKFLOW_TEST_PROJECT;
if (!project || !/^ai-sop-(?:assistant|s03-[a-z0-9-]+)$/.test(project)) {
  throw new Error("An explicitly named synthetic S03 Compose project is required.");
}
const docker = process.env.SOP_TEST_DOCKER ?? (process.platform === "win32" ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe" : "docker");
const jwtPattern = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

function command(arguments_, input) {
  const result = spawnSync(docker, arguments_, { input, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || result.error) {
    throw new Error(`Count-only storage inspection failed (exit ${result.status}); raw output withheld.`);
  }
  return result.stdout;
}
const normalize = path => resolve(path).replaceAll("\\", "/").toLowerCase();
const containers = {};
const pausedServices = new Set();
for (const service of ["postgres", "redis", "n8n-main", "n8n-worker"]) {
  const id = command(["compose", "-p", project, "ps", "--all", "--quiet", service]).trim();
  assert.match(id, /^[a-f0-9]{12,64}$/);
  const [container] = JSON.parse(command(["inspect", id]));
  assert.equal(container.Config.Labels["com.docker.compose.project"], project);
  assert.equal(normalize(container.Config.Labels["com.docker.compose.project.working_dir"]), normalize(process.cwd()));
  containers[service] = id;
  if (container.State.Paused) pausedServices.add(service);
}

const sql = `BEGIN READ ONLY;
SELECT json_build_object(
  'status', e.status, 'executionRows', count(*),
  'dataRows', count(d."executionId"),
  'dataRowsWithJwt', count(*) FILTER (WHERE d.data ~ 'eyJ[A-Za-z0-9_-]*[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+'),
  'jwtOccurrences', coalesce(sum((SELECT count(*) FROM regexp_matches(coalesce(d.data,''), 'eyJ[A-Za-z0-9_-]*[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+', 'g'))),0),
  'dataRowsWithAuthorization', count(*) FILTER (WHERE lower(d.data) LIKE '%authorization%'),
  'dataRowsWithPrivateKeyMarker', count(*) FILTER (WHERE d.data LIKE '%PRIVATE KEY%'),
  'softDeletedRows', count(*) FILTER (WHERE e."deletedAt" IS NOT NULL),
  'oldestCreatedAgeSeconds', round(extract(epoch FROM clock_timestamp()-min(e."createdAt"))),
  'oldestStartedAgeSeconds', round(extract(epoch FROM clock_timestamp()-min(e."startedAt")))
) FROM execution_entity e LEFT JOIN execution_data d ON d."executionId"=e.id
WHERE e."workflowId"='sop-s03-probe-v1' GROUP BY e.status ORDER BY e.status;
COMMIT;`;
const executionCounts = command(["exec", "-i", containers.postgres, "psql", "-X", "-q", "-A", "-t", "-U", "sop_bootstrap", "-d", "sop_n8n", "-v", "ON_ERROR_STOP=1"], sql)
  .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const payloadSql = `BEGIN READ ONLY;
SELECT json_build_object(
  'payloadRows', count(*),
  'payloadRowsWithJwt', count(*) FILTER (WHERE d.data ~ 'eyJ[A-Za-z0-9_-]*[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+'),
  'payloadRowsWithPrivateKeyMarker', count(*) FILTER (WHERE d.data LIKE '%PRIVATE KEY%'),
  'orphanPayloadRows', count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM execution_entity e WHERE e.id=d."executionId"))
) FROM execution_data d WHERE d."workflowData"->>'id'='sop-s03-probe-v1';
COMMIT;`;
const payloadCounts = JSON.parse(command(["exec", "-i", containers.postgres, "psql", "-X", "-q", "-A", "-t", "-U", "sop_bootstrap", "-d", "sop_n8n", "-v", "ON_ERROR_STOP=1"], payloadSql));

function redis(arguments_) {
  return command(["exec", containers.redis, "sh", "-c", 'export REDISCLI_AUTH="$(cat /run/secrets/redis-password)"; exec redis-cli --raw "$@"', "redis-counts", ...arguments_]);
}
const queueCounts = { keys: 0, hashRows: 0, hashRowsWithJwt: 0, jwtOccurrences: 0, hashRowsWithAuthorization: 0, listItems: 0, sortedSetItems: 0 };
const keys = redis(["--scan", "--pattern", "bull:*"]).trim().split("\n").filter(Boolean);
queueCounts.keys = keys.length;
for (const key of keys) {
  const type = redis(["TYPE", key]).trim();
  if (type === "hash") {
    const value = redis(["HGETALL", key]);
    const matches = value.match(jwtPattern) ?? [];
    queueCounts.hashRows++;
    queueCounts.hashRowsWithJwt += Number(matches.length > 0);
    queueCounts.jwtOccurrences += matches.length;
    queueCounts.hashRowsWithAuthorization += Number(/authorization/i.test(value));
  } else if (type === "list") {
    queueCounts.listItems += Number(redis(["LLEN", key]).trim());
  } else if (type === "zset") {
    queueCounts.sortedSetItems += Number(redis(["ZCARD", key]).trim());
  }
}
const logCounts = [];
for (const service of ["n8n-main", "n8n-worker"]) {
  const result = spawnSync(docker, ["logs", containers[service]], { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error("Count-only log inspection failed; raw output withheld.");
  const logs = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  logCounts.push({ service, source: "docker", jwtOccurrences: (logs.match(jwtPattern) ?? []).length, bearerOccurrences: (logs.match(/Bearer\s+[A-Za-z0-9_.-]+/gi) ?? []).length, privateKeyMarkers: (logs.match(/BEGIN (?:RSA )?PRIVATE KEY/g) ?? []).length });
  if (pausedServices.has(service)) {
    logCounts.push({ service, source: "native-event-files", status: "DEFERRED_PAUSED" });
    continue;
  }
  const eventLogCounts = command(["exec", containers[service], "node", "-e", String.raw`
    const fs=require('node:fs');
    const directory='/home/node/.n8n';
    const counts=fs.readdirSync(directory).filter(name=>/^n8nEventLog.*\.log$/.test(name)).map(name=>{
      const path=directory+'/'+name;
      if(!fs.lstatSync(path).isFile())throw Error('Unexpected event-log file type');
      const text=fs.readFileSync(path,'utf8');
      return{source:name,jwtOccurrences:(text.match(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g)??[]).length,bearerOccurrences:(text.match(/Bearer\s+[A-Za-z0-9_.-]+/gi)??[]).length,privateKeyMarkers:(text.match(/BEGIN (?:RSA )?PRIVATE KEY/g)??[]).length};
    });
    console.log(JSON.stringify(counts));
  `]);
  logCounts.push(...JSON.parse(eventLogCounts).map(counts => ({ service, ...counts })));
}
console.log(JSON.stringify({ observedAt: new Date().toISOString(), project, workflow: "sop-s03-probe-v1", executionCounts, payloadCounts, queueCounts, logCounts }));
assert.ok(executionCounts.every(counts => counts.dataRowsWithPrivateKeyMarker === 0), "Execution payload contains a private-key marker.");
assert.equal(payloadCounts.payloadRowsWithPrivateKeyMarker, 0, "Execution payload contains a private-key marker.");
assert.ok(logCounts.every(counts => counts.status === "DEFERRED_PAUSED" || (counts.jwtOccurrences === 0 && counts.bearerOccurrences === 0 && counts.privateKeyMarkers === 0)), "n8n logs contain a JWT, bearer or private-key marker.");
