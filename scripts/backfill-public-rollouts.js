#!/usr/bin/env node

import fs from "node:fs";

function usage() {
  console.log(`Usage:
  WORKER_URL=https://your-worker.example.workers.dev \\
  PUBLIC_ROLLOUT_ADMIN_SECRET=your-secret \\
  node workers/backfill-public-rollouts.js workers/backfill-public-rollouts.sample.json

Options:
  --dry-run  Print request body without sending it.
`);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const filePath = args.find((arg) => !arg.startsWith("--"));

if (!filePath) {
  usage();
  process.exit(1);
}

const workerUrl = process.env.WORKER_URL;
const adminSecret = process.env.PUBLIC_ROLLOUT_ADMIN_SECRET;

if (!dryRun && (!workerUrl || !adminSecret)) {
  console.error("Missing WORKER_URL or PUBLIC_ROLLOUT_ADMIN_SECRET.");
  usage();
  process.exit(1);
}

const raw = fs.readFileSync(filePath, "utf8");
const body = JSON.parse(raw);
const endpoint = `${workerUrl?.replace(/\/+$/, "")}/admin/public-rollouts/backfill`;

if (dryRun) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

(async () => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-public-rollout-admin-secret": adminSecret
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  console.log(text);

  if (!response.ok) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
