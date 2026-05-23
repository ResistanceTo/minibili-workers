#!/usr/bin/env node

import crypto from "node:crypto";

const ASC_API_BASE = "https://api.appstoreconnect.apple.com";

function usage() {
  console.log(`Usage:
  ASC_ISSUER_ID=xxx \\
  ASC_KEY_ID=xxx \\
  ASC_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----' \\
  ASC_APP_ID=6753876871 \\
  WORKER_URL=https://your-worker.example.workers.dev \\
  PUBLIC_ROLLOUT_ADMIN_SECRET=your-secret \\
  node workers/sync-asc-public-rollouts.js --since-days=45

Options:
  --since-days=45          Sync builds uploaded in the last N days. Default: 45.
  --delay-days=30          Used only for dry-run display. Worker still uses ASC_DELAY_DAYS.
  --shareholder-name=股东  Exclude this group in display. Worker also excludes it later.
  --dry-run                Print fetched builds/groups/backfill body without sending to Worker.
`);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const sinceDays = numberOption("since-days", 45);
const displayDelayDays = numberOption("delay-days", 30);
const shareholderName = stringOption("shareholder-name", "股东");

if (args.includes("--help")) {
  usage();
  process.exit(0);
}

const env = process.env;
const required = ["ASC_ISSUER_ID", "ASC_KEY_ID", "ASC_PRIVATE_KEY", "ASC_APP_ID"];
if (!dryRun) {
  required.push("WORKER_URL", "PUBLIC_ROLLOUT_ADMIN_SECRET");
}

const missing = required.filter((key) => !env[key]);
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(", ")}`);
  usage();
  process.exit(1);
}

function numberOption(name, fallback) {
  const prefix = `--${name}=`;
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function stringOption(name, fallback) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function createAscToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({
    alg: "ES256",
    kid: env.ASC_KEY_ID,
    typ: "JWT"
  }));
  const payload = base64Url(JSON.stringify({
    iss: env.ASC_ISSUER_ID,
    iat: now,
    exp: now + 20 * 60,
    aud: "appstoreconnect-v1"
  }));
  const signingInput = `${header}.${payload}`;
  const privateKey = env.ASC_PRIVATE_KEY.replace(/\\n/g, "\n");
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363"
  });

  return `${signingInput}.${base64Url(signature)}`;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function fetchAscJSON(path, token) {
  const response = await fetch(`${ASC_API_BASE}${path}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ASC ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }

  return response.json();
}

async function fetchAllAsc(path, token) {
  const items = [];
  let next = path;
  while (next) {
    const json = await fetchAscJSON(next, token);
    items.push(...(json.data ?? []));
    next = nextPath(json.links?.next);
  }
  return items;
}

function nextPath(nextUrl) {
  if (!nextUrl) return "";
  const url = new URL(nextUrl);
  return `${url.pathname}${url.search}`;
}

async function fetchRecentBuilds(token) {
  const params = new URLSearchParams({
    "filter[app]": env.ASC_APP_ID,
    "sort": "-uploadedDate",
    "limit": "200",
    "fields[builds]": "version,uploadedDate,processingState,expired"
  });
  const allBuilds = await fetchAllAsc(`/v1/builds?${params.toString()}`, token);
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  return allBuilds.filter((build) => {
    const uploadedDate = new Date(build.attributes?.uploadedDate ?? "");
    return !Number.isNaN(uploadedDate.getTime()) && uploadedDate >= since;
  });
}

async function fetchExternalGroups(token) {
  const params = new URLSearchParams({
    "filter[app]": env.ASC_APP_ID,
    "filter[isInternalGroup]": "false",
    "limit": "200",
    "fields[betaGroups]": "name,isInternalGroup"
  });
  return fetchAllAsc(`/v1/betaGroups?${params.toString()}`, token);
}

function buildBackfillBody(builds) {
  return {
    items: builds.map((build) => {
      const uploadedDate = build.attributes?.uploadedDate;
      const buildNumber = build.attributes?.version;
      return {
        id: `asc-${build.id}`,
        appId: env.ASC_APP_ID,
        ascBuildId: build.id,
        buildNumber,
        workflowName: "asc-history-backfill",
        tagName: "",
        appName: env.APP_NAME ?? "MiniBili",
        releaseAt: uploadedDate,
        notes: env.BACKFILL_NOTES ?? "修复了一些已知问题，提升整体流畅度。"
      };
    })
  };
}

function printPlan(builds, groups, body) {
  const targetGroups = groups.filter((group) => group.attributes?.name !== shareholderName);
  console.log(`Fetched builds: ${builds.length}`);
  for (const build of builds) {
    const uploadedDate = build.attributes?.uploadedDate;
    const dueAt = new Date(new Date(uploadedDate).getTime() + displayDelayDays * 24 * 60 * 60 * 1000).toISOString();
    console.log(`- build=${build.attributes?.version} ascBuildId=${build.id} uploaded=${uploadedDate} due~=${dueAt}`);
  }
  console.log(`External groups: ${groups.length}`);
  console.log(`Target groups after excluding ${shareholderName}: ${targetGroups.map((group) => group.attributes?.name ?? group.id).join(", ") || "none"}`);
  console.log(JSON.stringify(body, null, 2));
}

async function sendBackfill(body) {
  const endpoint = `${env.WORKER_URL.replace(/\/+$/, "")}/admin/public-rollouts/backfill`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-public-rollout-admin-secret": env.PUBLIC_ROLLOUT_ADMIN_SECRET
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  console.log(text);
  if (!response.ok) {
    process.exit(1);
  }
}

(async () => {
  const token = createAscToken();
  const [builds, groups] = await Promise.all([
    fetchRecentBuilds(token),
    fetchExternalGroups(token)
  ]);
  const body = buildBackfillBody(builds);
  printPlan(builds, groups, body);

  if (!dryRun) {
    await sendBackfill(body);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
