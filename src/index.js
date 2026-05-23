/**
 * Cloudflare Worker: Xcode Cloud webhook -> Telegram announcement.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";
const ASC_API_BASE = "https://api.appstoreconnect.apple.com";
const XCODE_CLOUD_SECRET_HEADER = "x-xcode-webhook-secret";
const PUBLIC_ROLLOUT_ADMIN_SECRET_HEADER = "x-public-rollout-admin-secret";
const PUBLIC_ROLLOUT_TABLE = "testflight_public_rollouts";
const DEFAULT_PUBLIC_ROLLOUT_LIMIT = 10;
const DEFAULT_ASC_SYNC_BUILD_LIMIT = 5;
const ASC_SYNC_CRON = "0 23 * * *";
const PUBLIC_ROLLOUT_CRON = "0 0 * * *";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, message: "Method Not Allowed" }, 405);
    }

    const rawBody = await request.text();
    const url = new URL(request.url);

    if (url.pathname === "/admin/public-rollouts/backfill") {
      return handlePublicRolloutBackfill(request, rawBody, env);
    }

    if (url.pathname === "/admin/public-rollouts/sync-now") {
      return handleAdminTask(request, env, "sync-now", () => syncLatestAscBuildsToD1(env));
    }

    if (url.pathname === "/admin/public-rollouts/publish-due") {
      return handleAdminTask(request, env, "publish-due", () => publishDuePublicRollouts(env));
    }

    if (env.XCODE_CLOUD_WEBHOOK_SECRET) {
      const receivedSecret = request.headers.get(XCODE_CLOUD_SECRET_HEADER) ?? "";
      // 安全升级：用 Web Crypto API 对比哈希，彻底杜绝时序攻击风险
      const isVerified = await safeCompare(receivedSecret, env.XCODE_CLOUD_WEBHOOK_SECRET);
      if (!isVerified) {
        return jsonResponse({ ok: false, message: "Unauthorized" }, 401);
      }
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ ok: false, message: "Invalid JSON" }, 400);
    }

    logWebhookPayload(payload, env);

    if (!isBuildFinished(payload)) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "Xcode Cloud build is not finished yet"
      });
    }

    const summary = await buildSummary(payload, env);
    logBuildSummary(summary);
    const publicRollout = await safeCreatePublicRolloutJob(payload, summary, env);

    if (env.ANNOUNCE_ONLY_SUCCESS === "true" && summary.status !== "SUCCEEDED") {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: `Build finished with ${summary.status}`,
        publicRollout
      });
    }

    if (shouldSkipEmptyTaggedSuccess(summary, env)) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: `No release notes found for ${summary.tagName}; skipped default success notification`,
        publicRollout
      });
    }

    const message = formatTelegramMessage(summary);

    if (env.DEBUG_DRY_RUN === "true") {
      return jsonResponse({ ok: true, dryRun: true, message, summary, publicRollout });
    }

    const telegramResult = await sendTelegramMessage(env, message);

    return jsonResponse({
      ok: true,
      sent: true,
      status: summary.status,
      telegramMessageId: telegramResult?.result?.message_id,
      publicRollout
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledAutomation(event, env));
  }
};

async function runScheduledAutomation(event, env) {
  const cron = event?.cron ?? "";
  console.log(`[Cron] Triggered | cron=${cron || "manual"}`);

  if (cron === ASC_SYNC_CRON) {
    await syncLatestAscBuildsToD1(env);
    return;
  }

  if (cron === PUBLIC_ROLLOUT_CRON) {
    await publishDuePublicRollouts(env);
    return;
  }

  await syncLatestAscBuildsToD1(env);
  await publishDuePublicRollouts(env);
}

async function syncLatestAscBuildsToD1(env) {
  if (!env.TESTFLIGHT_DB) {
    console.log("[ASCSync] Skipped: TESTFLIGHT_DB binding is missing.");
    return;
  }

  const appId = env.ASC_APP_ID;
  if (!appId) {
    console.log("[ASCSync] Skipped: ASC_APP_ID is missing.");
    return;
  }

  try {
    validatePublicRolloutConfig(env);
    const token = await createAppStoreConnectJWT(env);
    const buildLimit = positiveInt(env.ASC_SYNC_BUILD_LIMIT, DEFAULT_ASC_SYNC_BUILD_LIMIT);
    const builds = await fetchLatestAscBuilds({ token, appId, limit: buildLimit });
    const groups = await fetchExternalBetaGroups({ token, appId });
    const groupBuilds = await fetchBuildsForGroups({ token, groups });
    const membershipsByBuildId = indexGroupMemberships(groups, groupBuilds);

    console.log(`[ASCSync] Sync started | app=${appId} | builds=${builds.length} | groups=${groups.length} | buildLimit=${buildLimit}`);

    for (const build of builds) {
      await upsertPublicRolloutJobFromAscBuild({
        env,
        token,
        appId,
        build,
        memberships: membershipsByBuildId.get(build.id) ?? []
      });
    }

    console.log(`[ASCSync] Sync completed | app=${appId} | builds=${builds.length}`);
  } catch (error) {
    console.log(`[ASCSync] Failed | error=${error?.message ?? error}`);
  }
}

async function safeCreatePublicRolloutJob(payload, summary, env) {
  try {
    return await maybeCreatePublicRolloutJob(payload, summary, env);
  } catch (error) {
    const message = error?.message ?? String(error);
    console.log(`[PublicRollout] Failed to schedule | build=${summary.buildNumber} | workflow=${summary.workflowName} | error=${message}`);
    return { enabled: false, reason: "schedule_error", error: message };
  }
}

function isBuildFinished(payload) {
  const eventType = upper(payload?.metadata?.attributes?.eventType);
  return eventType === "BUILD_COMPLETED";
}

async function buildSummary(payload, env) {
  const buildRunAttr = payload?.ciBuildRun?.attributes ?? {};
  const gitReferenceAttr = payload?.scmGitReference?.attributes ?? {};
  const appName = shareholderAppName(env, payload?.ciProduct?.attributes?.name);
  const buildNumber = buildRunAttr.number ?? "未知";
  const status = normalizeStatus(buildRunAttr.completionStatus);
  const workflowName = payload?.ciWorkflow?.attributes?.name ?? "";

  const tagName = gitReferenceAttr.name;
  const appId = payload?.app?.id;

  console.log(
    `[ASC] Resolving notes | app=${appId ?? "missing"} | build=${buildNumber} | tag=${tagName ?? "missing"} | ascToken=${hasAppStoreConnectConfig(env) ? "available" : "missing"}`
  );

  const ascBuildInfo = status === "SUCCEEDED"
    ? await fetchAscBuildNotesInfo({ env, appId, buildNumber })
    : null;
  const commitMsg = normalizeReleaseNotes(buildRunAttr.sourceCommit?.message ?? "");
  const whatsNewLog = ascBuildInfo?.notes || commitMsg;

  const eventDate = payload?.metadata?.attributes?.createdDate ?? buildRunAttr.finishedDate;

  return {
    appName,
    buildNumber,
    status,
    workflowName,
    tagName,
    whatsNewLog,
    whatsNewSource: ascBuildInfo?.notes ? "asc_beta_build_localization" : commitMsg ? "source_commit" : "fallback",
    whatsNewLength: whatsNewLog.length,
    ascBuildId: ascBuildInfo?.buildId ?? null,
    eventDate
  };
}

async function maybeCreatePublicRolloutJob(payload, summary, env) {
  if (env.PUBLIC_ROLLOUT_SCHEDULE_FROM_WEBHOOK !== "true") {
    return {
      enabled: true,
      source: "asc_scheduled_sync",
      reason: "webhook_does_not_include_testflight_group_membership"
    };
  }

  if (summary.status !== "SUCCEEDED") {
    return { enabled: false, reason: "build_not_succeeded" };
  }

  if (!env.TESTFLIGHT_DB) {
    return { enabled: false, reason: "missing_d1_binding" };
  }

  const allowedWorkflows = parseList(env.PUBLIC_ROLLOUT_WORKFLOW_NAMES);
  if (allowedWorkflows.length === 0) {
    return { enabled: false, reason: "missing_public_rollout_workflows" };
  }

  if (!allowedWorkflows.includes(summary.workflowName)) {
    return { enabled: false, reason: "workflow_not_matched", workflowName: summary.workflowName };
  }

  if (env.DEBUG_DRY_RUN === "true") {
    return { enabled: true, dryRun: true, reason: "debug_dry_run" };
  }

  const buildRunId = payload?.ciBuildRun?.id;
  const appId = payload?.app?.id;
  if (!buildRunId || !appId || !summary.buildNumber) {
    return { enabled: false, reason: "missing_payload_identifiers" };
  }

  const result = await upsertPublicRolloutJob({
    env,
    id: buildRunId,
    appId,
    buildRunId,
    buildNumber: summary.buildNumber,
    workflowName: summary.workflowName,
    tagName: summary.tagName ?? "",
    appName: summary.appName,
    notes: summary.whatsNewLog,
    ascBuildId: summary.ascBuildId,
    releaseAtValue: payload?.ciBuildRun?.attributes?.finishedDate ?? summary.eventDate
  });

  console.log(`[PublicRollout] Scheduled | id=${buildRunId} | app=${appId} | build=${summary.buildNumber} | workflow=${summary.workflowName} | dueAt=${result.dueAt}`);
  return { enabled: true, id: buildRunId, status: "SCHEDULED", dueAt: result.dueAt };
}

async function handlePublicRolloutBackfill(request, rawBody, env) {
  const unauthorized = await verifyPublicRolloutAdmin(request, env);
  if (unauthorized) return unauthorized;

  if (!env.TESTFLIGHT_DB) {
    return jsonResponse({ ok: false, message: "TESTFLIGHT_DB binding is missing" }, 500);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ ok: false, message: "Invalid JSON" }, 400);
  }

  const entries = Array.isArray(body?.items) ? body.items : [body];
  const results = [];

  for (const entry of entries) {
    try {
      const normalized = await normalizeBackfillEntry(entry, env);
      const result = await upsertPublicRolloutJob({ env, ...normalized });
      results.push({ ok: true, id: normalized.id, status: normalized.status ?? "SCHEDULED", dueAt: result.dueAt });
      console.log(`[PublicRollout] Backfilled | id=${normalized.id} | build=${normalized.buildNumber} | status=${normalized.status ?? "SCHEDULED"} | dueAt=${result.dueAt}`);
    } catch (error) {
      const message = error?.message ?? String(error);
      results.push({ ok: false, error: message });
      console.log(`[PublicRollout] Backfill item failed | error=${message}`);
    }
  }

  const success = results.filter((item) => item.ok).length;
  return jsonResponse({ ok: success === results.length, total: results.length, success, results });
}

async function handleAdminTask(request, env, taskName, task) {
  const unauthorized = await verifyPublicRolloutAdmin(request, env);
  if (unauthorized) return unauthorized;

  await task();
  return jsonResponse({ ok: true, task: taskName });
}

async function verifyPublicRolloutAdmin(request, env) {
  if (!env.PUBLIC_ROLLOUT_ADMIN_SECRET) {
    return jsonResponse({ ok: false, message: "PUBLIC_ROLLOUT_ADMIN_SECRET is not configured" }, 500);
  }

  const receivedSecret = request.headers.get(PUBLIC_ROLLOUT_ADMIN_SECRET_HEADER) ?? "";
  if (!await safeCompare(receivedSecret, env.PUBLIC_ROLLOUT_ADMIN_SECRET)) {
    return jsonResponse({ ok: false, message: "Unauthorized" }, 401);
  }

  return null;
}

async function normalizeBackfillEntry(entry, env) {
  const payload = entry?.payload ?? (entry?.ciBuildRun ? entry : null);
  if (payload) {
    const summary = await buildSummary(payload, env);
    if (summary.status !== "SUCCEEDED") {
      throw new Error(`Backfill payload build status is ${summary.status}`);
    }

    const buildRunId = payload?.ciBuildRun?.id;
    const appId = payload?.app?.id;
    if (!buildRunId || !appId || !summary.buildNumber) {
      throw new Error("Backfill payload is missing ciBuildRun.id, app.id, or build number");
    }

    return {
      id: buildRunId,
      appId,
      buildRunId,
      buildNumber: summary.buildNumber,
      ascBuildId: summary.ascBuildId,
      workflowName: summary.workflowName,
      tagName: summary.tagName ?? "",
      appName: summary.appName,
      notes: summary.whatsNewLog,
      releaseAtValue: payload?.ciBuildRun?.attributes?.finishedDate ?? summary.eventDate,
      status: "SCHEDULED",
      lastError: null
    };
  }

  const id = entry?.id ?? entry?.buildRunId;
  const appId = entry?.appId;
  const buildNumber = entry?.buildNumber ?? entry?.ciBuildNumber;
  const ascBuildId = entry?.ascBuildId ?? entry?.buildId ?? null;
  const releaseAtValue = entry?.releaseAt ?? entry?.finishedDate;
  if (!id || !appId || !buildNumber || !releaseAtValue) {
    throw new Error("Backfill item requires id/buildRunId, appId, buildNumber, and releaseAt");
  }

  const buildState = classifyBackfillBuild(entry);

  return {
    id,
    appId,
    buildRunId: entry?.buildRunId ?? id,
    buildNumber,
    ascBuildId,
    workflowName: entry?.workflowName ?? "manual-backfill",
    tagName: entry?.tagName ?? "",
    appName: entry?.appName ?? env.APP_NAME ?? "应用",
    notes: normalizeReleaseNotes(entry?.notes ?? ""),
    releaseAtValue,
    status: entry?.status ?? buildState.status,
    lastError: entry?.lastError ?? entry?.last_error ?? buildState.lastError,
    shareholderGroupsJson: normalizeGroupsJson(entry?.shareholderGroupsJson ?? entry?.shareholder_groups_json ?? entry?.shareholderGroups),
    targetGroupsJson: normalizeTargetGroupsJson(entry?.targetGroupsJson ?? entry?.target_groups_json ?? entry?.targetGroups)
  };
}

function classifyBackfillBuild(entry) {
  const expired = entry?.expired === true || upper(entry?.expired) === "TRUE";
  if (expired) {
    return {
      status: "SKIPPED_EXPIRED",
      lastError: "Build is expired in App Store Connect"
    };
  }

  const processingState = upper(entry?.processingState);
  if (processingState && processingState !== "VALID") {
    return {
      status: "SKIPPED_PROCESSING_STATE",
      lastError: `Build processingState is ${processingState}`
    };
  }

  return { status: "SCHEDULED", lastError: null };
}

function normalizeTargetGroupsJson(value) {
  return normalizeGroupsJson(value);
}

function normalizeGroupsJson(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

async function upsertPublicRolloutJob({ env, id, appId, buildRunId, buildNumber, ascBuildId, workflowName, tagName, appName, notes, releaseAtValue, status = "SCHEDULED", lastError = null, shareholderGroupsJson = null, targetGroupsJson = null }) {
  const releaseAt = toIsoDate(releaseAtValue);
  const dueAt = addDays(releaseAt, rolloutDelayDays(env)).toISOString();
  const now = new Date().toISOString();
  const releaseNotes = normalizeReleaseNotes(notes);

  await env.TESTFLIGHT_DB.prepare(`
    INSERT INTO ${PUBLIC_ROLLOUT_TABLE} (
      id, app_id, build_run_id, ci_build_number, asc_build_id, workflow_name, tag_name,
      app_name, notes, release_at, due_at, status, shareholder_groups_json, target_groups_json, attempts,
      last_error, telegram_message_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      app_id = excluded.app_id,
      ci_build_number = excluded.ci_build_number,
      asc_build_id = COALESCE(excluded.asc_build_id, asc_build_id),
      workflow_name = excluded.workflow_name,
      tag_name = excluded.tag_name,
      app_name = excluded.app_name,
      notes = excluded.notes,
      release_at = excluded.release_at,
      due_at = excluded.due_at,
      status = CASE WHEN status = 'DONE' THEN status ELSE excluded.status END,
      shareholder_groups_json = COALESCE(excluded.shareholder_groups_json, shareholder_groups_json),
      target_groups_json = COALESCE(excluded.target_groups_json, target_groups_json),
      last_error = CASE WHEN status = 'DONE' THEN last_error ELSE excluded.last_error END,
      updated_at = excluded.updated_at
  `).bind(
    id,
    appId,
    buildRunId,
    String(buildNumber),
    ascBuildId || null,
    workflowName,
    tagName ?? "",
    appName,
    releaseNotes,
    releaseAt.toISOString(),
    dueAt,
    status,
    shareholderGroupsJson,
    targetGroupsJson,
    lastError,
    now,
    now
  ).run();

  return { dueAt };
}

function shouldSkipEmptyTaggedSuccess(summary, env) {
  return env.SKIP_EMPTY_TAGGED_SUCCESS === "true"
    && summary.status === "SUCCEEDED"
    && summary.tagName
    && summary.whatsNewSource === "fallback"
    && !summary.whatsNewLog;
}

async function publishDuePublicRollouts(env) {
  if (!env.TESTFLIGHT_DB) {
    console.log("[PublicRollout] Skipped cron: TESTFLIGHT_DB binding is missing.");
    return;
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const staleProcessingBefore = new Date(nowDate.getTime() - 15 * 60 * 1000).toISOString();
  const limit = positiveInt(env.PUBLIC_ROLLOUT_LIMIT, DEFAULT_PUBLIC_ROLLOUT_LIMIT);
  const jobs = await env.TESTFLIGHT_DB.prepare(`
    SELECT *
    FROM ${PUBLIC_ROLLOUT_TABLE}
    WHERE (status = 'SCHEDULED' AND due_at <= ?)
       OR (status = 'PROCESSING' AND updated_at <= ?)
    ORDER BY due_at ASC
    LIMIT ?
  `).bind(now, staleProcessingBefore, limit).all();

  const rows = jobs?.results ?? [];
  console.log(`[PublicRollout] Cron tick | due=${rows.length} | now=${now}`);

  for (const job of rows) {
    await processPublicRolloutJob(env, job);
  }
}

async function processPublicRolloutJob(env, job) {
  const startedAt = new Date().toISOString();
  console.log(`[PublicRollout] Processing | id=${job.id} | app=${job.app_id} | build=${job.ci_build_number} | dueAt=${job.due_at}`);

  const claimed = await claimPublicRolloutJob(env, job.id, job.updated_at, startedAt);
  if (!claimed) {
    console.log(`[PublicRollout] Skipped already claimed job | id=${job.id}`);
    return;
  }

  try {
    validatePublicRolloutConfig(env);

    const token = await createAppStoreConnectJWT(env);
    const build = job.asc_build_id
      ? await fetchAscBuildById({ token, buildId: job.asc_build_id })
      : await fetchAscBuildByVersion({ token, appId: job.app_id, buildNumber: job.ci_build_number });

    if (build?.attributes?.expired === true) {
      await updatePublicRolloutJob(env, job.id, {
        status: "SKIPPED_EXPIRED",
        asc_build_id: build.id,
        last_error: "Build is expired in App Store Connect",
        updated_at: new Date().toISOString()
      });
      console.log(`[PublicRollout] Skipped expired build | id=${job.id} | buildId=${build.id}`);
      return;
    }

    const notes = normalizeReleaseNotes(job.notes)
      || await fetchAscBuildNotes({ token, buildId: build.id });
    const betaGroups = await fetchExternalBetaGroups({ token, appId: job.app_id });
    const targetGroups = selectPublicTargetGroups(betaGroups, env);

    if (targetGroups.length === 0) {
      throw new Error("No external beta groups found after excluding shareholder groups.");
    }

    if (env.ASC_DRY_RUN === "true") {
      console.log(`[PublicRollout] Dry run | build=${build.id} | groups=${targetGroups.map((group) => group.attributes?.name ?? group.id).join(", ")}`);
    } else {
      await addBuildToBetaGroups({ token, buildId: build.id, groups: targetGroups });
    }

    const targetGroupsJson = JSON.stringify(targetGroups.map((group) => ({
      id: group.id,
      name: group.attributes?.name ?? ""
    })));

    let telegramMessageId = job.telegram_message_id ?? null;
    if (env.ASC_DRY_RUN !== "true") {
      const telegramResults = await sendPublicTelegramAnnouncements(env, formatPublicRolloutMessage({ ...job, notes }, targetGroups));
      telegramMessageId = telegramResults[0]?.result?.message_id ?? null;
    }

    await updatePublicRolloutJob(env, job.id, {
      status: env.ASC_DRY_RUN === "true" ? "SCHEDULED" : "DONE",
      asc_build_id: build.id,
      notes,
      target_groups_json: targetGroupsJson,
      last_error: null,
      telegram_message_id: telegramMessageId,
      updated_at: new Date().toISOString()
    });

    console.log(`[PublicRollout] ${env.ASC_DRY_RUN === "true" ? "Dry run completed" : "Done"} | id=${job.id} | buildId=${build.id} | groups=${targetGroups.length}`);
  } catch (error) {
    const nextAttempts = Number(job.attempts ?? 0) + 1;
    const maxAttempts = positiveInt(env.PUBLIC_ROLLOUT_MAX_ATTEMPTS, 10);
    const status = nextAttempts >= maxAttempts ? "FAILED" : "SCHEDULED";
    const message = error?.message ?? String(error);

    await updatePublicRolloutJob(env, job.id, {
      status,
      attempts: nextAttempts,
      last_error: message.slice(0, 1000),
      updated_at: new Date().toISOString()
    });

    console.log(`[PublicRollout] Failed | id=${job.id} | status=${status} | attempts=${nextAttempts} | error=${message}`);

    if (status === "FAILED" && env.PUBLIC_TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(env, formatPublicRolloutFailureMessage(job, message), {
        chatId: env.PUBLIC_TELEGRAM_CHAT_ID,
        threadId: env.PUBLIC_TELEGRAM_THREAD_ID
      }).catch((telegramError) => {
        console.log(`[PublicRollout] Failed to send failure notification | id=${job.id} | error=${telegramError?.message ?? telegramError}`);
      });
    }
  }
}

async function sendPublicTelegramAnnouncements(env, message) {
  const targets = publicTelegramTargets(env);
  const results = [];

  for (const target of targets) {
    const result = await sendTelegramMessage(env, message, target);
    results.push(result);
    console.log(`[Telegram] Public announcement sent | target=${target.name} | chatId=${target.chatId} | messageId=${result?.result?.message_id ?? "unknown"}`);
  }

  return results;
}

function publicTelegramTargets(env) {
  const targets = [];
  if (env.PUBLIC_TELEGRAM_CHAT_ID) {
    targets.push({
      name: "public_group",
      chatId: env.PUBLIC_TELEGRAM_CHAT_ID,
      threadId: env.PUBLIC_TELEGRAM_THREAD_ID,
      pin: env.PUBLIC_TELEGRAM_PIN_MESSAGE === "true",
      disablePinNotification: env.PUBLIC_TELEGRAM_PIN_DISABLE_NOTIFICATION !== "false"
    });
  }

  if (env.PUBLIC_TELEGRAM_CHANNEL_ID) {
    targets.push({
      name: "public_channel",
      chatId: env.PUBLIC_TELEGRAM_CHANNEL_ID,
      pin: env.PUBLIC_TELEGRAM_CHANNEL_PIN_MESSAGE === "true",
      disablePinNotification: env.PUBLIC_TELEGRAM_CHANNEL_PIN_DISABLE_NOTIFICATION !== "false"
    });
  }

  return targets;
}

async function updatePublicRolloutJob(env, id, fields) {
  const keys = Object.keys(fields).filter((key) => fields[key] !== undefined);
  if (keys.length === 0) return;

  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  const values = keys.map((key) => fields[key]);
  await env.TESTFLIGHT_DB.prepare(`
    UPDATE ${PUBLIC_ROLLOUT_TABLE}
    SET ${assignments}
    WHERE id = ?
  `).bind(...values, id).run();
}

async function claimPublicRolloutJob(env, id, previousUpdatedAt, claimedAt) {
  const result = await env.TESTFLIGHT_DB.prepare(`
    UPDATE ${PUBLIC_ROLLOUT_TABLE}
    SET status = 'PROCESSING', updated_at = ?
    WHERE id = ?
      AND status IN ('SCHEDULED', 'PROCESSING')
      AND updated_at = ?
  `).bind(claimedAt, id, previousUpdatedAt).run();

  return (result?.meta?.changes ?? 0) > 0;
}

function validatePublicRolloutConfig(env) {
  const missing = [];
  if (!env.ASC_ISSUER_ID) missing.push("ASC_ISSUER_ID");
  if (!env.ASC_KEY_ID) missing.push("ASC_KEY_ID");
  if (!env.ASC_PRIVATE_KEY) missing.push("ASC_PRIVATE_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing App Store Connect config: ${missing.join(", ")}`);
  }
}

function hasAppStoreConnectConfig(env) {
  return Boolean(env.ASC_ISSUER_ID && env.ASC_KEY_ID && env.ASC_PRIVATE_KEY);
}

async function fetchLatestAscBuilds({ token, appId, limit }) {
  let url = `/v1/builds?${new URLSearchParams({
    "filter[app]": appId,
    "sort": "-uploadedDate",
    "limit": String(limit),
    "fields[builds]": "version,uploadedDate,processingState,expired"
  }).toString()}`;
  const json = await fetchAscJSON(url, token);
  return json?.data ?? [];
}

async function fetchBuildsForGroups({ token, groups }) {
  const result = new Map();
  for (const group of groups) {
    const builds = [];
    let url = `/v1/betaGroups/${encodeURIComponent(group.id)}/builds?${new URLSearchParams({
      "limit": "200",
      "fields[builds]": "version,uploadedDate,processingState,expired"
    }).toString()}`;

    while (url) {
      const json = await fetchAscJSON(url, token);
      builds.push(...(json?.data ?? []));
      url = nextAscPath(json?.links?.next);
    }

    result.set(group.id, builds);
  }
  return result;
}

function indexGroupMemberships(groups, groupBuilds) {
  const memberships = new Map();
  const groupsById = new Map(groups.map((group) => [group.id, group]));

  for (const [groupId, builds] of groupBuilds.entries()) {
    const group = groupsById.get(groupId);
    for (const build of builds) {
      if (!build?.id) continue;
      const groupInfo = {
        id: groupId,
        name: group?.attributes?.name ?? ""
      };
      const current = memberships.get(build.id) ?? [];
      current.push(groupInfo);
      memberships.set(build.id, current);
    }
  }

  return memberships;
}

async function upsertPublicRolloutJobFromAscBuild({ env, token, appId, build, memberships }) {
  const attrs = build?.attributes ?? {};
  const buildNumber = attrs.version;
  const releaseAtValue = attrs.uploadedDate;
  if (!build?.id || !buildNumber || !releaseAtValue) {
    console.log(`[ASCSync] Skipped malformed build | buildId=${build?.id ?? "missing"}`);
    return;
  }

  const shareholderGroups = selectShareholderMemberships(memberships, env);
  const targetGroups = selectPublicMemberships(memberships, env);
  const state = classifyAscBuildForRollout(attrs, shareholderGroups, targetGroups);
  const notes = await fetchAscBuildNotes({ token, buildId: build.id });

  const result = await upsertPublicRolloutJob({
    env,
    id: `asc-${build.id}`,
    appId,
    buildRunId: `asc-${build.id}`,
    buildNumber,
    ascBuildId: build.id,
    workflowName: "asc-scheduled-sync",
    tagName: "",
    appName: publicAppName(env),
    notes,
    releaseAtValue,
    status: state.status,
    lastError: state.lastError,
    shareholderGroupsJson: normalizeGroupsJson(shareholderGroups),
    targetGroupsJson: normalizeGroupsJson(targetGroups)
  });

  console.log(`[ASCSync] Upserted | build=${buildNumber} | buildId=${build.id} | status=${state.status} | shareholderGroups=${shareholderGroups.length} | publicGroups=${targetGroups.length} | dueAt=${result.dueAt}`);
}

function classifyAscBuildForRollout(attrs, shareholderGroups, targetGroups) {
  if (attrs.expired === true) {
    return {
      status: "SKIPPED_EXPIRED",
      lastError: "Build is expired in App Store Connect"
    };
  }

  const processingState = upper(attrs.processingState);
  if (processingState && processingState !== "VALID") {
    return {
      status: "SKIPPED_PROCESSING_STATE",
      lastError: `Build processingState is ${processingState}`
    };
  }

  if (targetGroups.length > 0) {
    return { status: "DONE", lastError: null };
  }

  if (shareholderGroups.length === 0) {
    return {
      status: "SKIPPED_NOT_SHAREHOLDER",
      lastError: "Build is not assigned to shareholder group"
    };
  }

  return { status: "SCHEDULED", lastError: null };
}

function selectShareholderMemberships(memberships, env) {
  const shareholderName = env.ASC_SHAREHOLDER_GROUP_NAME ?? "股东";
  const shareholderIds = new Set(parseList(env.ASC_SHAREHOLDER_GROUP_ID));
  return memberships.filter((group) => group.name === shareholderName || shareholderIds.has(group.id));
}

function selectPublicMemberships(memberships, env) {
  const shareholderName = env.ASC_SHAREHOLDER_GROUP_NAME ?? "股东";
  const shareholderIds = new Set(parseList(env.ASC_SHAREHOLDER_GROUP_ID));
  return memberships.filter((group) => group.name !== shareholderName && !shareholderIds.has(group.id));
}

async function fetchAscBuildNotesInfo({ env, appId, buildNumber }) {
  if (!appId || !buildNumber) {
    console.log("[ASC] Notes skipped: missing app id or build number.");
    return null;
  }

  if (!hasAppStoreConnectConfig(env)) {
    console.log("[ASC] Notes skipped: App Store Connect config is incomplete.");
    return null;
  }

  try {
    const token = await createAppStoreConnectJWT(env);
    const build = await fetchAscBuildByVersion({ token, appId, buildNumber });
    const notes = await fetchAscBuildNotes({ token, buildId: build.id });
    return { buildId: build.id, notes };
  } catch (error) {
    console.log(`[ASC] Failed to resolve build notes | app=${appId} | build=${buildNumber} | error=${error?.message ?? error}`);
    return null;
  }
}

async function fetchAscBuildByVersion({ token, appId, buildNumber }) {
  const params = new URLSearchParams({
    "filter[app]": appId,
    "filter[version]": String(buildNumber),
    "sort": "-uploadedDate",
    "limit": "1",
    "fields[builds]": "version,uploadedDate,processingState,expired"
  });

  const json = await fetchAscJSON(`/v1/builds?${params.toString()}`, token);
  const build = json?.data?.[0];
  if (!build?.id) {
    throw new Error(`App Store Connect build not found for app=${appId}, version=${buildNumber}`);
  }

  console.log(`[ASC] Build resolved | app=${appId} | version=${buildNumber} | buildId=${build.id} | expired=${String(build.attributes?.expired ?? false)} | processing=${build.attributes?.processingState ?? "unknown"}`);
  return build;
}

async function fetchAscBuildById({ token, buildId }) {
  const params = new URLSearchParams({
    "fields[builds]": "version,uploadedDate,processingState,expired"
  });
  const json = await fetchAscJSON(`/v1/builds/${encodeURIComponent(buildId)}?${params.toString()}`, token);
  const build = json?.data;
  if (!build?.id) {
    throw new Error(`App Store Connect build not found for id=${buildId}`);
  }

  console.log(`[ASC] Build loaded | buildId=${build.id} | expired=${String(build.attributes?.expired ?? false)} | processing=${build.attributes?.processingState ?? "unknown"}`);
  return build;
}

async function fetchAscBuildNotes({ token, buildId }) {
  const params = new URLSearchParams({
    "limit": "200",
    "fields[betaBuildLocalizations]": "whatsNew,locale,build"
  });
  const json = await fetchAscJSON(`/v1/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations?${params.toString()}`, token);
  const notes = chooseLocalizedNotes(json?.data ?? []);
  console.log(`[ASC] Build notes loaded | buildId=${buildId} | localizations=${json?.data?.length ?? 0} | notesLength=${notes.length}`);
  return notes;
}

function chooseLocalizedNotes(localizations) {
  const notesByLocale = new Map();
  for (const item of localizations ?? []) {
    const locale = item?.attributes?.locale;
    const notes = normalizeReleaseNotes(item?.attributes?.whatsNew ?? "");
    if (locale && notes) {
      notesByLocale.set(locale, notes);
    }
  }

  for (const locale of ["zh-Hans", "zh-Hant", "zh", "en-US", "en"]) {
    const notes = notesByLocale.get(locale);
    if (notes) return notes;
  }

  return notesByLocale.values().next().value ?? "";
}

async function fetchExternalBetaGroups({ token, appId }) {
  const groups = [];
  let url = `/v1/betaGroups?${new URLSearchParams({
    "filter[app]": appId,
    "filter[isInternalGroup]": "false",
    "limit": "200"
  }).toString()}`;

  while (url) {
    const json = await fetchAscJSON(url, token);
    groups.push(...(json?.data ?? []));
    url = nextAscPath(json?.links?.next);
  }

  console.log(`[ASC] External beta groups loaded | app=${appId} | count=${groups.length}`);
  return groups;
}

function selectPublicTargetGroups(groups, env) {
  const shareholderName = env.ASC_SHAREHOLDER_GROUP_NAME ?? "股东";
  const shareholderIds = new Set(parseList(env.ASC_SHAREHOLDER_GROUP_ID));
  const targets = groups.filter((group) => {
    const name = group.attributes?.name ?? "";
    return name !== shareholderName && !shareholderIds.has(group.id);
  });

  console.log(`[ASC] Target groups selected | excludedName=${shareholderName} | excludedIds=${[...shareholderIds].join(",") || "none"} | count=${targets.length}`);
  return targets;
}

async function addBuildToBetaGroups({ token, buildId, groups }) {
  for (const group of groups) {
    const response = await fetch(`${ASC_API_BASE}/v1/builds/${encodeURIComponent(buildId)}/relationships/betaGroups`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: [{ id: group.id, type: "betaGroups" }]
      })
    });

    if (response.ok || response.status === 409) {
      console.log(`[ASC] Build access added | buildId=${buildId} | group=${group.attributes?.name ?? group.id} | status=${response.status}`);
      continue;
    }

    const body = await response.text().catch(() => "");
    throw new Error(`App Store Connect API ${response.status} ${response.statusText} for group ${group.attributes?.name ?? group.id}: ${body.slice(0, 500)}`);
  }
}

async function fetchAscJSON(path, token) {
  const response = await fetch(`${ASC_API_BASE}${path}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`App Store Connect API ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }

  return response.json();
}

async function createAppStoreConnectJWT(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "ES256",
    kid: env.ASC_KEY_ID,
    typ: "JWT"
  };
  const payload = {
    iss: env.ASC_ISSUER_ID,
    iat: now,
    exp: now + 20 * 60,
    aud: "appstoreconnect-v1"
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const privateKey = await importP8PrivateKey(env.ASC_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function importP8PrivateKey(value) {
  const pem = String(value ?? "").replace(/\\n/g, "\n");
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const bytes = base64ToBytes(base64);

  return crypto.subtle.importKey(
    "pkcs8",
    bytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

function normalizeReleaseNotes(value) {
  return String(value ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatTelegramMessage(summary) {
  const lines = [
    `📢 <b>${escapeHtml(summary.appName)} 已更新</b>`,
    "----------------------------------------",
    `<b>对应版本：</b> Build ${escapeHtml(String(summary.buildNumber))}`,
    `<b>发布时间：</b> ${escapeHtml(formatDate(summary.eventDate))}`,
    ""
  ];

  if (summary.whatsNewLog) {
    lines.push(`<b>💡 更新内容：</b>`);
    lines.push(`<i>${escapeHtml(summary.whatsNewLog)}</i>`);
  } else {
    lines.push(`<b>💡 更新内容：</b>`);
    lines.push(`<i>修复了一些已知问题，提升整体流畅度。</i>`);
  }

  return lines.join("\n");
}

async function sendTelegramMessage(env, text, options = {}) {
  const body = {
    chat_id: options.chatId ?? env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  const threadId = options.threadId ?? env.TELEGRAM_THREAD_ID;
  if (threadId) {
    body.message_thread_id = Number(threadId);
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok === false) {
    throw new Error(`Telegram API ${response.status} ${response.statusText}: ${JSON.stringify(result)}`);
  }

  if (options.pin === true && result?.result?.message_id) {
    await pinTelegramMessage(env, {
      chatId: body.chat_id,
      messageId: result.result.message_id,
      disableNotification: options.disablePinNotification !== false
    });
  }

  return result;
}

async function pinTelegramMessage(env, { chatId, messageId, disableNotification }) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/pinChatMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      disable_notification: disableNotification
    })
  });

  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok === false) {
    throw new Error(`Telegram pinChatMessage ${response.status} ${response.statusText}: ${JSON.stringify(result)}`);
  }

  return result;
}

function formatPublicRolloutMessage(job, targetGroups) {
  const lines = [
    `📢 <b>${escapeHtml(job.app_name)} 已同步</b>`,
    "----------------------------------------",
    `<b>对应版本：</b> Build ${escapeHtml(String(job.ci_build_number))}`,
    `<b>开放范围：</b> 全部测试员。`,
    ""
  ];

  if (job.notes) {
    lines.push("<b>💡 更新内容：</b>");
    lines.push(`<i>${escapeHtml(job.notes)}</i>`);
  }

  return lines.join("\n");
}

function formatPublicRolloutFailureMessage(job, error) {
  return [
    `⚠️ <b>${escapeHtml(job.app_name)} 同步失败</b>`,
    "----------------------------------------",
    `<b>对应版本：</b> Build ${escapeHtml(String(job.ci_build_number))}`,
    `<b>任务 ID：</b> ${escapeHtml(job.id)}`,
    `<b>错误：</b> ${escapeHtml(error)}`
  ].join("\n");
}

// 绝对防时序攻击的非对称哈希安全比对
async function safeCompare(a, b) {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  
  const hashA = await crypto.subtle.digest("SHA-256", aBytes);
  const hashB = await crypto.subtle.digest("SHA-256", bBytes);
  
  const viewA = new Uint8Array(hashA);
  const viewB = new Uint8Array(hashB);
  
  if (viewA.length !== viewB.length) return false;
  let c = 0;
  for (let i = 0; i < viewA.length; i++) {
    c |= viewA[i] ^ viewB[i];
  }
  return c === 0;
}

function logWebhookPayload(payload, env) {
  console.log(`[XcodeCloud] Event: ${payload?.metadata?.attributes?.eventType} | Status: ${payload?.ciBuildRun?.attributes?.completionStatus}`);
}

function logBuildSummary(summary) {
  console.log(`[XcodeCloud] App: ${summary.appName} | Build: ${summary.buildNumber} | Tag: ${summary.tagName ?? "none"} | Result: ${summary.status} | Notes: ${summary.whatsNewSource} | NotesLength: ${summary.whatsNewLength ?? 0}`);
}

function normalizeStatus(value) {
  const status = upper(value);
  if (status.includes("SUCCEEDED") || status.includes("SUCCESS")) return "SUCCEEDED";
  if (status.includes("FAILED") || status.includes("FAILURE")) return "FAILED";
  if (status.includes("ERROR")) return "ERRORED";
  if (status.includes("CANCEL")) return "CANCELED";
  return "FAILED";
}

function parseList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function shareholderAppName(env, fallback) {
  return env.SHAREHOLDER_APP_NAME ?? env.APP_NAME ?? fallback ?? "应用";
}

function publicAppName(env) {
  return env.PUBLIC_APP_NAME ?? env.APP_NAME ?? "应用";
}

function rolloutDelayDays(env) {
  return positiveInt(env.ASC_DELAY_DAYS, 30);
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function toIsoDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function nextAscPath(nextUrl) {
  if (!nextUrl) return "";
  try {
    const url = new URL(nextUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function upper(value) { return String(value ?? "").toUpperCase(); }
function escapeHtml(val) {
  return String(val).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function formatDate(value) {
  const date = new Date(value);
  // 如果苹果传过来的时间戳非法，原样返回字符串，防止脚本崩溃
  if (Number.isNaN(date.getTime())) return String(value);

  // 转化为最符合国内用户习惯的：2026年5月22日 21:15 格式
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
