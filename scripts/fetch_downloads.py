#!/usr/bin/env python3
"""Fetch daily traction metrics from PyPI, npm, and GitHub and append to CSV."""

import csv
import os
import sys
from collections import defaultdict
from datetime import date, timedelta
from typing import Dict, List

import requests
import yaml

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT_DIR, "config.yaml")
DATA_DIR = os.path.join(ROOT_DIR, "data")
CSV_PATH = os.path.join(DATA_DIR, "downloads.csv")

CSV_HEADERS = ["date", "package", "source", "downloads"]

# Re-fetch npm/pypi data for the last N days on every run. npm's analytics
# pipeline can update daily counts retroactively, so entries recorded with 0
# may later have real values.
RECENCY_DAYS = 7


def load_config():
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def load_existing_data():
    """Return a dict mapping (date, package, source) → downloads for all rows."""
    data = {}
    if not os.path.exists(CSV_PATH):
        return data
    with open(CSV_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            key = (row["date"], row["package"], row["source"])
            data[key] = int(row["downloads"])
    return data


def rewrite_csv_with_updates(updates: Dict[tuple, int]):
    """Overwrite specific rows in the CSV with new download counts.

    updates: mapping of (date, package, source) → new downloads value
    """
    if not updates or not os.path.exists(CSV_PATH):
        return
    rows = []
    with open(CSV_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            key = (row["date"], row["package"], row["source"])
            if key in updates:
                row["downloads"] = str(updates[key])
            rows.append(row)
    with open(CSV_PATH, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_HEADERS)
        writer.writeheader()
        writer.writerows(rows)


def fetch_pypi_downloads(package):
    """Fetch all available daily download counts from pypistats.org."""
    url = f"https://pypistats.org/api/packages/{package}/overall"
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"  [ERROR] PyPI fetch failed for {package}: {e}")
        return []

    results = []
    for entry in data.get("data", []):
        if entry.get("category") == "with_mirrors":
            results.append({"date": entry["date"], "downloads": entry["downloads"]})

    if not results:
        print(f"  [WARN] No download data found for PyPI package: {package}")
    return results


def fetch_npm_downloads(package):
    """Fetch the last 365 days of daily download counts from npm registry."""
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=364)
    url = f"https://api.npmjs.org/downloads/range/{start.isoformat()}:{end.isoformat()}/{package}"
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"  [ERROR] npm fetch failed for {package}: {e}")
        return []

    results = []
    for entry in data.get("downloads", []):
        results.append({"date": entry["day"], "downloads": entry["downloads"]})

    if not results:
        print(f"  [WARN] No download data found for npm package: {package}")
    return results


def parse_github_config(config):
    """Parse GitHub config supporting dict, list, or string formats."""
    github_cfg = config.get("github")
    owners: List[str] = []
    repos: List[str] = []

    if not github_cfg:
        return owners, repos

    if isinstance(github_cfg, dict):
        owners = github_cfg.get("owners", []) or []
        repos = github_cfg.get("repos", []) or []
    elif isinstance(github_cfg, list):
        for item in github_cfg:
            if isinstance(item, str):
                if "/" in item:
                    repos.append(item)
                else:
                    owners.append(item)
    elif isinstance(github_cfg, str):
        if "/" in github_cfg:
            repos.append(github_cfg)
        else:
            owners.append(github_cfg)

    return owners, repos


def github_headers():
    """Build GitHub API headers with optional token auth."""
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    headers = {
        "Accept": "application/vnd.github+json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def fetch_github_user_login(headers):
    """Return authenticated user login when a GitHub token is provided."""
    if "Authorization" not in headers:
        return None
    try:
        resp = requests.get("https://api.github.com/user", headers=headers, timeout=30)
        resp.raise_for_status()
        return resp.json().get("login")
    except Exception as e:
        print(f"  [WARN] Could not resolve authenticated GitHub user: {e}")
        return None


def fetch_github_paginated(endpoint, headers, params):
    """Fetch a paginated list endpoint from GitHub."""
    all_items = []
    page = 1
    while True:
        page_params = dict(params)
        page_params["page"] = page
        page_params["per_page"] = 100
        resp = requests.get(endpoint, headers=headers, params=page_params, timeout=30)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        batch = resp.json()
        if not isinstance(batch, list):
            break
        all_items.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return all_items


def fetch_repos_for_owner(owner, headers, viewer_login=None):
    """
    Fetch all repos for an owner (org or user).

    For authenticated requests where owner is the token owner, use /user/repos
    to include private repositories.
    """
    if viewer_login and viewer_login.lower() == owner.lower():
        endpoint = "https://api.github.com/user/repos"
        params = {"type": "owner", "sort": "full_name", "direction": "asc"}
        repos = fetch_github_paginated(endpoint, headers, params)
        if repos is not None:
            repos = [
                repo
                for repo in repos
                if repo.get("owner", {}).get("login", "").lower() == owner.lower()
            ]
            return repos

    org_endpoint = f"https://api.github.com/orgs/{owner}/repos"
    params = {"type": "all", "sort": "full_name", "direction": "asc"}
    repos = fetch_github_paginated(org_endpoint, headers, params)
    if repos is not None:
        return repos

    user_endpoint = f"https://api.github.com/users/{owner}/repos"
    repos = fetch_github_paginated(user_endpoint, headers, params)
    if repos is not None:
        return repos

    raise RuntimeError(f"Owner '{owner}' not found as a GitHub user or org")


def fetch_repo_by_full_name(full_name, headers):
    """Fetch a single repository by full name (owner/repo)."""
    url = f"https://api.github.com/repos/{full_name}"
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_github_repo_clones(full_name, headers):
    """
    Fetch the rolling 14-day daily clone counts for a single repo.

    Requires push access on the repo (the /traffic/clones endpoint is gated).
    Returns a list of {date, downloads} dicts where downloads = total clone count
    for that day. Days the API omits (no activity) are not filled — daily-cron
    appends will simply skip them.
    """
    url = f"https://api.github.com/repos/{full_name}/traffic/clones"
    try:
        resp = requests.get(url, headers=headers, timeout=30)
        if resp.status_code in (403, 404):
            print(f"  [WARN] /traffic/clones not accessible for {full_name} "
                  f"(status {resp.status_code}); token likely lacks push access")
            return []
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"  [ERROR] GitHub clones fetch failed for {full_name}: {e}")
        return []

    results = []
    for entry in data.get("clones", []):
        ts = entry.get("timestamp", "")
        day = ts[:10] if len(ts) >= 10 else ""
        if not day:
            continue
        results.append({"date": day, "downloads": int(entry.get("count", 0))})
    return results


def fetch_github_repo_stats(config):
    """
    Fetch GitHub repo traction metrics.

    Returns rows in the same schema as CSV_HEADERS with these source values:
    - github_stars
    - github_forks
    - github_open_issues
    - github_clones (rolling 14-day daily totals; only populated when the token
      has push access to the repo)
    """
    owners, explicit_repos = parse_github_config(config)
    if not owners and not explicit_repos:
        return []

    headers = github_headers()
    viewer_login = fetch_github_user_login(headers)
    today = date.today().isoformat()

    repos_by_name: Dict[str, dict] = {}

    for owner in owners:
        print(f"Fetching GitHub repos for owner: {owner}")
        try:
            repos = fetch_repos_for_owner(owner, headers, viewer_login)
        except Exception as e:
            print(f"  [ERROR] GitHub repo listing failed for owner {owner}: {e}")
            continue

        for repo in repos:
            full_name = repo.get("full_name")
            if full_name:
                repos_by_name[full_name] = repo
        print(f"  -> {len(repos)} repos discovered")

    for full_name in explicit_repos:
        if full_name in repos_by_name:
            continue
        print(f"Fetching GitHub repo: {full_name}")
        try:
            repo = fetch_repo_by_full_name(full_name, headers)
            repos_by_name[full_name] = repo
        except Exception as e:
            print(f"  [ERROR] GitHub fetch failed for repo {full_name}: {e}")

    rows = []
    for full_name, repo in sorted(repos_by_name.items()):
        stars = int(repo.get("stargazers_count", 0))
        forks = int(repo.get("forks_count", 0))
        open_issues = int(repo.get("open_issues_count", 0))
        rows.extend([
            {"date": today, "package": full_name, "source": "github_stars", "downloads": stars},
            {"date": today, "package": full_name, "source": "github_forks", "downloads": forks},
            {
                "date": today,
                "package": full_name,
                "source": "github_open_issues",
                "downloads": open_issues,
            },
        ])

        clone_entries = fetch_github_repo_clones(full_name, headers)
        for entry in clone_entries:
            rows.append({
                "date": entry["date"],
                "package": full_name,
                "source": "github_clones",
                "downloads": entry["downloads"],
            })
        if clone_entries:
            print(f"  -> {len(clone_entries)} day(s) of clone data for {full_name}")

    print(f"Collected GitHub stats for {len(repos_by_name)} repo(s)")
    return rows


DISCORD_EPOCH = 1420070400000


def discord_headers():
    """Build Discord Bot API headers."""
    token = os.environ.get("DISCORD_BOT_TOKEN")
    if not token:
        return None
    return {"Authorization": f"Bot {token}"}


def snowflake_from_datetime(dt):
    """Convert a datetime to a Discord snowflake ID."""
    import datetime as _dt
    if isinstance(dt, date) and not isinstance(dt, _dt.datetime):
        dt = _dt.datetime.combine(dt, _dt.time.min)
    ts_ms = int(dt.timestamp() * 1000)
    return (ts_ms - DISCORD_EPOCH) << 22


def date_from_snowflake(snowflake_id):
    """Extract a date from a Discord snowflake ID."""
    import datetime as _dt
    ts_ms = (int(snowflake_id) >> 22) + DISCORD_EPOCH
    return _dt.datetime.fromtimestamp(ts_ms / 1000).date()


def fetch_discord_stats(guild_id, existing_entries, backfill_days=90):
    """Fetch guild member count and daily message counts using Bot API.

    Backfills message counts for days not yet recorded, up to backfill_days.
    """
    headers = discord_headers()
    if not headers:
        print("  [WARN] DISCORD_BOT_TOKEN not set, skipping Discord")
        return None

    # Fetch guild info with approximate member count
    url = f"https://discord.com/api/v10/guilds/{guild_id}?with_counts=true"
    try:
        resp = requests.get(url, headers=headers, timeout=30)
        resp.raise_for_status()
        guild = resp.json()
    except Exception as e:
        print(f"  [ERROR] Discord guild fetch failed for {guild_id}: {e}")
        return None

    name = guild.get("name", str(guild_id))
    member_count = guild.get("approximate_member_count", 0)

    # Determine which days need message data
    today = date.today()
    start_date = today - timedelta(days=backfill_days)
    days_needed = set()
    for d in range(backfill_days):
        day = start_date + timedelta(days=d)
        if day >= today:
            break
        if (day.isoformat(), name, "discord_messages") not in existing_entries:
            days_needed.add(day)

    if not days_needed:
        print(f"  -> All message days already recorded")
        return {"name": name, "members": member_count, "messages_by_date": {}}

    # Fetch channels
    channels_url = f"https://discord.com/api/v10/guilds/{guild_id}/channels"
    try:
        resp = requests.get(channels_url, headers=headers, timeout=30)
        resp.raise_for_status()
        channels = resp.json()
    except Exception as e:
        print(f"  [ERROR] Discord channels fetch failed: {e}")
        return {"name": name, "members": member_count, "messages_by_date": None}

    # Count messages per day across all text channels and threads
    earliest_needed = min(days_needed)
    after_snowflake = snowflake_from_datetime(earliest_needed)

    text_channel_types = {0, 5}  # GUILD_TEXT and GUILD_ANNOUNCEMENT
    thread_types = {10, 11, 12}  # ANNOUNCEMENT_THREAD, PUBLIC_THREAD, PRIVATE_THREAD
    messages_by_date = defaultdict(int)

    def count_messages_in_channel(ch_id):
        """Count messages in a channel/thread from after_snowflake, bucketed by date."""
        messages_url = f"https://discord.com/api/v10/channels/{ch_id}/messages"
        try:
            after = str(after_snowflake)
            while True:
                resp = requests.get(
                    messages_url,
                    headers=headers,
                    params={"after": after, "limit": 100},
                    timeout=30,
                )
                if resp.status_code == 403:
                    break
                resp.raise_for_status()
                msgs = resp.json()
                if not msgs:
                    break
                for msg in msgs:
                    msg_date = date_from_snowflake(msg["id"])
                    if msg_date in days_needed:
                        messages_by_date[msg_date] += 1
                if len(msgs) < 100:
                    break
                after = msgs[-1]["id"]
        except Exception:
            pass

    def fetch_archived_threads(ch_id):
        """Fetch public and private archived threads for a channel."""
        thread_ids = []
        for kind in ["public", "private"]:
            url = f"https://discord.com/api/v10/channels/{ch_id}/threads/archived/{kind}"
            try:
                resp = requests.get(url, headers=headers, timeout=30)
                if resp.status_code == 403:
                    continue
                resp.raise_for_status()
                for t in resp.json().get("threads", []):
                    thread_ids.append(t["id"])
            except Exception:
                continue
        return thread_ids

    # Collect all channel IDs to scan (text channels + threads)
    channel_ids = []
    text_channel_ids = []
    for channel in channels:
        if channel.get("type") in text_channel_types:
            channel_ids.append(channel["id"])
            text_channel_ids.append(channel["id"])
        elif channel.get("type") in thread_types:
            channel_ids.append(channel["id"])

    # Fetch active threads
    try:
        resp = requests.get(
            f"https://discord.com/api/v10/guilds/{guild_id}/threads/active",
            headers=headers, timeout=30,
        )
        if resp.status_code == 200:
            for t in resp.json().get("threads", []):
                if t["id"] not in channel_ids:
                    channel_ids.append(t["id"])
    except Exception:
        pass

    # Fetch archived threads from each text channel
    for ch_id in text_channel_ids:
        for t_id in fetch_archived_threads(ch_id):
            if t_id not in channel_ids:
                channel_ids.append(t_id)

    print(f"  -> Scanning {len(channel_ids)} channels/threads")

    for ch_id in channel_ids:
        count_messages_in_channel(ch_id)

    # Fill in zeros for days with no messages
    for day in days_needed:
        if day not in messages_by_date:
            messages_by_date[day] = 0

    return {"name": name, "members": member_count, "messages_by_date": dict(messages_by_date)}


def append_rows(rows):
    """Append rows to the CSV file, creating it with headers if needed."""
    os.makedirs(DATA_DIR, exist_ok=True)
    file_exists = os.path.exists(CSV_PATH)
    with open(CSV_PATH, "a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_HEADERS)
        if not file_exists:
            writer.writeheader()
        writer.writerows(rows)


def main():
    config = load_config()
    existing = load_existing_data()
    new_rows = []
    csv_updates: Dict[tuple, int] = {}

    recency_cutoff = (date.today() - timedelta(days=RECENCY_DAYS)).isoformat()

    pypi_packages = config.get("pypi", []) or []
    npm_packages = config.get("npm", []) or []
    github_owners, github_repos = parse_github_config(config)

    print(
        "Tracking "
        f"{len(pypi_packages)} PyPI package(s), "
        f"{len(npm_packages)} npm package(s), "
        f"{len(github_owners)} GitHub owner(s), "
        f"{len(github_repos)} explicit GitHub repo(s)"
    )

    for pkg in pypi_packages:
        print(f"Fetching PyPI: {pkg}")
        results = fetch_pypi_downloads(pkg)
        added = updated = 0
        for result in results:
            key = (result["date"], pkg, "pypi")
            if key not in existing:
                new_rows.append({
                    "date": result["date"],
                    "package": pkg,
                    "source": "pypi",
                    "downloads": result["downloads"],
                })
                added += 1
            elif result["date"] >= recency_cutoff and result["downloads"] != existing[key]:
                csv_updates[key] = result["downloads"]
                updated += 1
        print(f"  -> {len(results)} data points fetched, {added} new, {updated} updated")

    for pkg in npm_packages:
        print(f"Fetching npm: {pkg}")
        results = fetch_npm_downloads(pkg)
        added = updated = 0
        for result in results:
            key = (result["date"], pkg, "npm")
            if key not in existing:
                new_rows.append({
                    "date": result["date"],
                    "package": pkg,
                    "source": "npm",
                    "downloads": result["downloads"],
                })
                added += 1
            elif result["date"] >= recency_cutoff and result["downloads"] != existing[key]:
                csv_updates[key] = result["downloads"]
                updated += 1
        print(f"  -> {len(results)} data points fetched, {added} new, {updated} updated")

    github_rows = fetch_github_repo_stats(config)
    github_added = github_updated = 0
    for row in github_rows:
        key = (row["date"], row["package"], row["source"])
        if key not in existing:
            new_rows.append(row)
            github_added += 1
        elif (
            row["source"] == "github_clones"
            and row["date"] >= recency_cutoff
            and row["downloads"] != existing[key]
        ):
            # GitHub's /traffic/clones endpoint returns a rolling 14-day window
            # whose recent days are still accruing — refresh the stored count
            # whenever the API reports a different value within the recency window.
            csv_updates[key] = row["downloads"]
            github_updated += 1
    if github_rows:
        print(f"GitHub rows fetched: {len(github_rows)}, {github_added} new, {github_updated} updated")

    discord_guilds = config.get("discord", []) or []
    today = date.today().isoformat()
    for guild_id in discord_guilds:
        guild_id = str(guild_id)
        print(f"Fetching Discord: {guild_id}")
        result = fetch_discord_stats(guild_id, existing)
        if result:
            # Total members (snapshot, recorded for today)
            key = (today, result["name"], "discord_members")
            if key not in existing:
                new_rows.append({
                    "date": today,
                    "package": result["name"],
                    "source": "discord_members",
                    "downloads": result["members"],
                })
                print(f"  -> {result['name']}: {result['members']} total members")
            # Daily message counts
            if result["messages_by_date"] is not None:
                msg_added = 0
                for day, count in sorted(result["messages_by_date"].items()):
                    key = (day.isoformat(), result["name"], "discord_messages")
                    if key not in existing:
                        new_rows.append({
                            "date": day.isoformat(),
                            "package": result["name"],
                            "source": "discord_messages",
                            "downloads": count,
                        })
                        msg_added += 1
                print(f"  -> {msg_added} days of message data added")

    if csv_updates:
        rewrite_csv_with_updates(csv_updates)
        print(f"\nUpdated {len(csv_updates)} existing entries in {CSV_PATH}")

    if new_rows:
        append_rows(new_rows)
        print(f"Appended {len(new_rows)} new entries to {CSV_PATH}")

    if not csv_updates and not new_rows:
        print("\nNo new data to append.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
