#!/usr/bin/env python3
"""
从 App Store Connect 拉取 MiniBili 最近的 TestFlight build 和外部测试群组，打印官方返回数据，
再通过 Worker 的回填接口同步到远端 D1。

依赖：
  pip install "PyJWT[crypto]" certifi

用法：
  python3 scripts/sync_asc_public_rollouts.py --dry-run
  python3 scripts/sync_asc_public_rollouts.py --since-days 45
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import certifi
except ImportError:  # pragma: no cover - optional local dependency
    certifi = None


BASE_URL = "https://api.appstoreconnect.apple.com/v1"
DEFAULT_VARS_FILE = Path(__file__).resolve().parent.parent / ".dev.vars"


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync App Store Connect builds into public rollout D1 jobs")
    parser.add_argument("--since-days", type=int, default=5, help="只同步最近 N 天上传的 build，默认 5；历史回填时显式传 45 或更大")
    parser.add_argument("--delay-days", type=int, default=30, help="只用于本地打印 dueAt，Worker 仍以 ASC_DELAY_DAYS 为准")
    parser.add_argument("--shareholder-name", default="股东", help="打印目标群组时排除的股东群组名")
    parser.add_argument("--shareholder-id", default="", help="打印目标群组时排除的股东群组 id，支持逗号分隔")
    parser.add_argument("--notes-locales", default="zh-Hans,zh-Hant,zh,en-US,en", help="多个 betaBuildLocalizations 同时存在时的 notes 语言优先级")
    parser.add_argument("--override-notes", default="", help="手工覆盖所有回填 build 的 notes，默认不覆盖")
    parser.add_argument("--print-raw-group-builds", action="store_true", help="打印 Apple 返回的每个群组完整 build 列表，默认只打印精简汇总")
    parser.add_argument("--dry-run", action="store_true", help="只打印 ASC 数据和即将发送给 Worker 的 body，不写入 D1")
    parser.add_argument("--vars-file", default=str(DEFAULT_VARS_FILE), help="读取 .dev.vars/.env 的路径")
    parser.add_argument("--app-id", help="App Store Connect app resource id，优先级高于环境变量")
    args = parser.parse_args()

    env = merged_env(Path(args.vars_file))
    key_id = required_value(env, "ASC_KEY_ID")
    issuer_id = required_value(env, "ASC_ISSUER_ID")
    private_key = normalize_private_key(required_value(env, "ASC_PRIVATE_KEY"))
    app_id = args.app_id or required_value(env, "ASC_APP_ID")

    if not args.dry_run:
        required_value(env, "WORKER_URL")
        required_value(env, "PUBLIC_ROLLOUT_ADMIN_SECRET")

    token = build_jwt(key_id=key_id, issuer_id=issuer_id, private_key=private_key)

    builds = fetch_recent_builds(token, app_id=app_id, since_days=args.since_days)
    beta_localizations = fetch_beta_build_localizations_for_builds(token, builds)
    groups = fetch_external_beta_groups(token, app_id=app_id)
    group_builds = fetch_builds_for_groups(token, groups)
    body = build_backfill_body(
        env=env,
        app_id=app_id,
        builds=builds,
        groups=groups,
        group_builds=group_builds,
        beta_localizations=beta_localizations,
        notes_locales=parse_csv(args.notes_locales),
        override_notes=normalize_notes(args.override_notes),
        shareholder_name=args.shareholder_name,
        shareholder_ids=parse_csv(args.shareholder_id or env.get("ASC_SHAREHOLDER_GROUP_ID", "")),
    )

    print_official_data(
        builds=builds,
        beta_localizations=beta_localizations,
        groups=groups,
        group_builds=group_builds,
        print_raw_group_builds=args.print_raw_group_builds,
    )
    print_plan(
        builds=builds,
        groups=groups,
        group_builds=group_builds,
        body=body,
        shareholder_name=args.shareholder_name,
        shareholder_ids=parse_csv(args.shareholder_id or env.get("ASC_SHAREHOLDER_GROUP_ID", "")),
        delay_days=args.delay_days,
    )

    if args.dry_run:
        return 0

    response = post_backfill(env=env, body=body)
    print("\n=== Worker Backfill Response ===")
    print(json.dumps(response, ensure_ascii=False, indent=2))
    return 0 if response.get("ok") else 1


def merged_env(vars_file: Path) -> dict[str, str]:
    values = dict(os.environ)
    if vars_file.exists():
        values.update(load_dotenv_file(vars_file))
    return values


def required_value(env: dict[str, str], name: str) -> str:
    value = env.get(name, "").strip()
    if not value:
        print(f"Missing required value: {name}", file=sys.stderr)
        sys.exit(1)
    return value


def load_dotenv_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    pending_key: str | None = None
    pending_quote: str | None = None
    pending_lines: list[str] = []

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if pending_key is not None and pending_quote is not None:
            if raw_line.rstrip().endswith(pending_quote):
                pending_lines.append(raw_line.rstrip()[:-1])
                env[pending_key] = "\n".join(pending_lines)
                pending_key = None
                pending_quote = None
                pending_lines = []
            else:
                pending_lines.append(raw_line)
            continue

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if value.startswith('"') and not value.endswith('"'):
            pending_key = key
            pending_quote = '"'
            pending_lines = [value[1:]]
            continue

        if value.startswith("'") and not value.endswith("'"):
            pending_key = key
            pending_quote = "'"
            pending_lines = [value[1:]]
            continue

        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]

        env[key] = value

    if pending_key is not None:
        print(f"Unterminated quoted value for key: {pending_key}", file=sys.stderr)
        sys.exit(1)

    return env


def normalize_private_key(value: str) -> str:
    normalized = value.replace("\\n", "\n").replace("\r\n", "\n").strip()
    if "-----BEGIN PRIVATE KEY-----" not in normalized:
        print("ASC_PRIVATE_KEY is missing BEGIN PRIVATE KEY header", file=sys.stderr)
        sys.exit(1)
    if "-----END PRIVATE KEY-----" not in normalized:
        print("ASC_PRIVATE_KEY is missing END PRIVATE KEY footer", file=sys.stderr)
        sys.exit(1)
    return normalized


def build_jwt(*, key_id: str, issuer_id: str, private_key: str) -> str:
    try:
        import jwt
    except ImportError:
        print('Missing dependency: PyJWT. Install with `pip3 install "PyJWT[crypto]" certifi`.', file=sys.stderr)
        sys.exit(1)

    now = int(time.time())
    payload = {
        "iss": issuer_id,
        "aud": "appstoreconnect-v1",
        "iat": now,
        "exp": now + 60 * 19,
    }
    headers = {
        "alg": "ES256",
        "kid": key_id,
        "typ": "JWT",
    }
    token = jwt.encode(payload, private_key, algorithm="ES256", headers=headers)
    if isinstance(token, bytes):
        return token.decode("utf-8")
    return token


def fetch_recent_builds(token: str, *, app_id: str, since_days: int) -> list[dict[str, Any]]:
    payload = api_get(
        token,
        "/builds",
        query={
            "filter[app]": app_id,
            "sort": "-uploadedDate",
            "limit": "200",
            "fields[builds]": "version,uploadedDate,processingState,expired",
        },
    )
    builds = payload.get("data", [])
    since = datetime.now(timezone.utc) - timedelta(days=since_days)

    filtered: list[dict[str, Any]] = []
    for build in builds:
        uploaded = parse_iso_datetime(build.get("attributes", {}).get("uploadedDate"))
        if uploaded is not None and uploaded >= since:
            filtered.append(build)
    return filtered


def fetch_external_beta_groups(token: str, *, app_id: str) -> list[dict[str, Any]]:
    payload = api_get(
        token,
        f"/apps/{app_id}/betaGroups",
        query={
            "limit": "200",
            "fields[betaGroups]": (
                "name,isInternalGroup,hasAccessToAllBuilds,publicLinkEnabled,"
                "publicLink,createdDate"
            ),
        },
    )
    groups = payload.get("data", [])
    return [group for group in groups if not group.get("attributes", {}).get("isInternalGroup")]


def fetch_beta_build_localizations_for_builds(
    token: str,
    builds: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for build in builds:
        build_id = str(build.get("id") or "")
        if not build_id:
            continue
        payload = api_get(
            token,
            f"/builds/{build_id}/betaBuildLocalizations",
            query={
                "limit": "200",
                "fields[betaBuildLocalizations]": "whatsNew,locale,build",
            },
        )
        result[build_id] = payload.get("data", [])
    return result


def fetch_builds_for_groups(
    token: str,
    groups: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for group in groups:
        group_id = str(group.get("id") or "")
        if not group_id:
            continue

        builds: list[dict[str, Any]] = []
        path = f"/betaGroups/{group_id}/builds"
        query = {
            "limit": "200",
            "fields[builds]": "version,uploadedDate,processingState,expired",
        }

        while path:
            payload = api_get(token, path, query=query)
            builds.extend(payload.get("data", []))
            next_url = payload.get("links", {}).get("next")
            path, query = split_next_url(next_url)

        result[group_id] = builds
    return result


def api_get(token: str, path: str, query: dict[str, str] | None = None) -> dict[str, Any]:
    url = f"{BASE_URL}{path}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"

    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(request, context=build_ssl_context()) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP {exc.code} {exc.reason}", file=sys.stderr)
        print(body, file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ssl.SSLCertVerificationError):
            print(
                "TLS certificate verification failed. Install certifi with `pip3 install certifi`.",
                file=sys.stderr,
            )
        raise


def build_ssl_context() -> ssl.SSLContext:
    if certifi is not None:
        return ssl.create_default_context(cafile=certifi.where())
    return ssl.create_default_context()


def build_backfill_body(
    *,
    env: dict[str, str],
    app_id: str,
    builds: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    group_builds: dict[str, list[dict[str, Any]]],
    beta_localizations: dict[str, list[dict[str, Any]]],
    notes_locales: list[str],
    override_notes: str,
    shareholder_name: str,
    shareholder_ids: list[str],
) -> dict[str, Any]:
    app_name = env.get("PUBLIC_APP_NAME") or env.get("APP_NAME") or "MiniBili"
    membership_by_build = build_membership_index(groups=groups, group_builds=group_builds)
    items = []

    for build in builds:
        attrs = build.get("attributes", {})
        build_id = str(build.get("id"))
        notes = override_notes or choose_beta_notes(
            beta_localizations.get(build_id, []),
            notes_locales=notes_locales,
        )
        memberships = membership_by_build.get(build_id, [])
        state = classify_build(
            attrs,
            memberships=memberships,
            shareholder_name=shareholder_name,
            shareholder_ids=shareholder_ids,
        )
        shareholder_groups = shareholder_groups_from_memberships(
            memberships,
            shareholder_name=shareholder_name,
            shareholder_ids=shareholder_ids,
        )
        target_groups = public_groups_from_memberships(
            memberships,
            shareholder_name=shareholder_name,
            shareholder_ids=shareholder_ids,
        )
        items.append(
            {
                "id": f"asc-{build_id}",
                "appId": app_id,
                "ascBuildId": build_id,
                "buildNumber": attrs.get("version"),
                "workflowName": "asc-history-backfill",
                "tagName": "",
                "appName": app_name,
                "releaseAt": attrs.get("uploadedDate"),
                "notes": notes,
                "expired": bool(attrs.get("expired")),
                "processingState": attrs.get("processingState"),
                "status": state["status"],
                "lastError": state["lastError"],
                "shareholderGroups": shareholder_groups,
                "targetGroups": target_groups,
            }
        )

    return {"items": items}


def choose_beta_notes(localizations: list[dict[str, Any]], *, notes_locales: list[str]) -> str:
    notes_by_locale: dict[str, str] = {}
    for item in localizations:
        attrs = item.get("attributes", {})
        locale = str(attrs.get("locale") or "")
        notes = normalize_notes(attrs.get("whatsNew"))
        if locale and notes:
            notes_by_locale[locale] = notes

    for locale in notes_locales:
        if locale in notes_by_locale:
            return notes_by_locale[locale]

    return next(iter(notes_by_locale.values()), "")


def classify_build(
    attrs: dict[str, Any],
    *,
    memberships: list[dict[str, str]] | None = None,
    shareholder_name: str = "股东",
    shareholder_ids: list[str] | None = None,
) -> dict[str, str | None]:
    if attrs.get("expired") is True:
        return {
            "status": "SKIPPED_EXPIRED",
            "lastError": "Build is expired in App Store Connect",
        }

    processing_state = str(attrs.get("processingState") or "").upper()
    if processing_state and processing_state != "VALID":
        return {
            "status": "SKIPPED_PROCESSING_STATE",
            "lastError": f"Build processingState is {processing_state}",
        }

    public_groups = public_groups_from_memberships(
        memberships or [],
        shareholder_name=shareholder_name,
        shareholder_ids=shareholder_ids or [],
    )
    if public_groups:
        return {
            "status": "DONE",
            "lastError": None,
        }

    shareholder_groups = shareholder_groups_from_memberships(
        memberships or [],
        shareholder_name=shareholder_name,
        shareholder_ids=shareholder_ids or [],
    )
    if not shareholder_groups:
        return {
            "status": "SKIPPED_NOT_SHAREHOLDER",
            "lastError": "Build is not assigned to shareholder group",
        }

    return {"status": "SCHEDULED", "lastError": None}


def build_membership_index(
    *,
    groups: list[dict[str, Any]],
    group_builds: dict[str, list[dict[str, Any]]],
) -> dict[str, list[dict[str, str]]]:
    groups_by_id = {str(group.get("id")): group for group in groups}
    memberships: dict[str, list[dict[str, str]]] = {}
    for group_id, builds in group_builds.items():
        group = groups_by_id.get(str(group_id), {})
        group_name = str(group.get("attributes", {}).get("name") or "")
        for build in builds:
            build_id = str(build.get("id") or "")
            if not build_id:
                continue
            memberships.setdefault(build_id, []).append(
                {
                    "id": str(group_id),
                    "name": group_name,
                }
            )
    return memberships


def public_groups_from_memberships(
    memberships: list[dict[str, str]],
    *,
    shareholder_name: str,
    shareholder_ids: list[str],
) -> list[dict[str, str]]:
    shareholder_id_set = set(shareholder_ids)
    return [
        group
        for group in memberships
        if group.get("name") != shareholder_name
        and group.get("id") not in shareholder_id_set
    ]


def shareholder_groups_from_memberships(
    memberships: list[dict[str, str]],
    *,
    shareholder_name: str,
    shareholder_ids: list[str],
) -> list[dict[str, str]]:
    shareholder_id_set = set(shareholder_ids)
    return [
        group
        for group in memberships
        if group.get("name") == shareholder_name
        or group.get("id") in shareholder_id_set
    ]


def post_backfill(*, env: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
    worker_url = required_value(env, "WORKER_URL").rstrip("/")
    secret = required_value(env, "PUBLIC_ROLLOUT_ADMIN_SECRET")
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")

    request = urllib.request.Request(
        f"{worker_url}/admin/public-rollouts/backfill",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "MiniBili-ASC-D1-Backfill/1.0",
            "x-public-rollout-admin-secret": secret,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, context=build_ssl_context()) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        print(f"Worker HTTP {exc.code} {exc.reason}", file=sys.stderr)
        print(body_text, file=sys.stderr)
        sys.exit(1)


def print_official_data(
    *,
    builds: list[dict[str, Any]],
    beta_localizations: dict[str, list[dict[str, Any]]],
    groups: list[dict[str, Any]],
    group_builds: dict[str, list[dict[str, Any]]],
    print_raw_group_builds: bool,
) -> None:
    print("\n=== Apple Official Builds ===")
    print(json.dumps(builds, ensure_ascii=False, indent=2))
    print("\n=== Apple Official Beta Build Localizations ===")
    print(json.dumps(beta_localizations, ensure_ascii=False, indent=2))
    print("\n=== Apple Official External Beta Groups ===")
    print(json.dumps(groups, ensure_ascii=False, indent=2))
    print("\n=== Apple Official Beta Group Builds Summary ===")
    print(json.dumps(summarize_group_builds(groups=groups, group_builds=group_builds), ensure_ascii=False, indent=2))

    if print_raw_group_builds:
        print("\n=== Apple Official Beta Group Builds Raw ===")
        print(json.dumps(group_builds, ensure_ascii=False, indent=2))


def print_plan(
    *,
    builds: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    group_builds: dict[str, list[dict[str, Any]]],
    body: dict[str, Any],
    shareholder_name: str,
    shareholder_ids: list[str],
    delay_days: int,
) -> None:
    shareholder_id_set = set(shareholder_ids)
    membership_by_build = build_membership_index(groups=groups, group_builds=group_builds)
    target_groups = [
        group
        for group in groups
        if group.get("attributes", {}).get("name") != shareholder_name
        and str(group.get("id") or "") not in shareholder_id_set
    ]

    print("\n=== Sync Plan ===")
    print(f"Fetched builds: {len(builds)}")
    for build in builds:
        attrs = build.get("attributes", {})
        build_id = str(build.get("id") or "")
        uploaded = attrs.get("uploadedDate")
        due_at = compute_due_at(uploaded, delay_days)
        memberships = membership_by_build.get(build_id, [])
        shareholder_groups = [
            group.get("name") or group.get("id")
            for group in shareholder_groups_from_memberships(
                memberships,
                shareholder_name=shareholder_name,
                shareholder_ids=shareholder_ids,
            )
        ]
        public_groups = [
            group.get("name") or group.get("id")
            for group in public_groups_from_memberships(
                memberships,
                shareholder_name=shareholder_name,
                shareholder_ids=shareholder_ids,
            )
        ]
        state = classify_build(
            attrs,
            memberships=memberships,
            shareholder_name=shareholder_name,
            shareholder_ids=shareholder_ids,
        )
        print(
            f"- build={attrs.get('version')} "
            f"ascBuildId={build_id} "
            f"uploaded={uploaded} "
            f"due~={due_at} "
            f"processing={attrs.get('processingState')} "
            f"expired={attrs.get('expired')} "
            f"shareholderGroups={','.join(shareholder_groups) or 'none'} "
            f"publicGroups={','.join(public_groups) or 'none'} "
            f"status={state['status']}"
        )

    print(f"External groups: {len(groups)}")
    print(
        f"Target groups after excluding {shareholder_name}/{','.join(shareholder_ids) or 'no-id'}: "
        f"{', '.join(group.get('attributes', {}).get('name') or str(group.get('id')) for group in target_groups) or 'none'}"
    )

    print("\n=== D1 Backfill Request Body ===")
    print(json.dumps(body, ensure_ascii=False, indent=2))


def summarize_group_builds(
    *,
    groups: list[dict[str, Any]],
    group_builds: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    groups_by_id = {str(group.get("id")): group for group in groups}
    summaries: list[dict[str, Any]] = []
    for group_id, builds in group_builds.items():
        group = groups_by_id.get(str(group_id), {})
        build_numbers = [
            str(build.get("attributes", {}).get("version") or "")
            for build in builds
            if build.get("attributes", {}).get("version")
        ]
        summaries.append(
            {
                "id": str(group_id),
                "name": group.get("attributes", {}).get("name") or "",
                "buildCount": len(builds),
                "buildNumbers": build_numbers,
            }
        )
    return summaries


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def compute_due_at(value: str | None, delay_days: int) -> str:
    uploaded = parse_iso_datetime(value)
    if uploaded is None:
        return "invalid-uploadedDate"
    return (uploaded + timedelta(days=delay_days)).isoformat().replace("+00:00", "Z")


def split_next_url(next_url: str | None) -> tuple[str, dict[str, str] | None]:
    if not next_url:
        return "", None
    parsed = urllib.parse.urlparse(next_url)
    query = {
        key: values[-1]
        for key, values in urllib.parse.parse_qs(parsed.query).items()
        if values
    }
    return parsed.path.replace("/v1", "", 1), query


def parse_csv(value: str | None) -> list[str]:
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


def normalize_notes(value: Any) -> str:
    return (
        "\n".join(
            line.strip()
            for line in str(value or "")
            .replace("\\n", "\n")
            .replace("\r\n", "\n")
            .replace("\r", "\n")
            .split("\n")
        )
        .replace("\n\n\n", "\n\n")
        .strip()
    )


if __name__ == "__main__":
    raise SystemExit(main())
