#!/usr/bin/env python3
"""Generate trend plots from traction data."""

import csv
import json
import os
import sys
from collections import defaultdict
from datetime import date, timedelta

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT_DIR, "data", "downloads.csv")
SUMMARY_PATH = os.path.join(ROOT_DIR, "data", "summary.json")
PLOTS_DIR = os.path.join(ROOT_DIR, "plots")

# (label, days or None for all-time)
TIME_WINDOWS = [
    ("7d", "Last 7 Days", 7),
    ("14d", "Last 14 Days", 14),
    ("30d", "Last 30 Days", 30),
    ("365d", "Last 365 Days", 365),
    ("all", "All Time", None),
]

SOURCE_LABELS = {
    "developer_activations": "Developer Activations (PyPI + npm + Clones)",
    "pypi": "PyPI",
    "npm": "npm",
    "github_stars": "GitHub Stars",
    "github_forks": "GitHub Forks",
    "github_open_issues": "GitHub Open Issues",
    "github_clones": "GitHub Clones",
    "discord_members": "Discord Members",
    "discord_messages": "Discord Messages",
}

# Pseudo-source: combined cumulative across pypi + npm + github_clones,
# summed over all packages. Not present in the CSV; rendered by its own
# plotting function.
COMBINED_ACTIVATIONS_KEY = "developer_activations"
COMBINED_ACTIVATIONS_SOURCES = {"pypi", "npm", "github_clones"}

# Sources that represent point-in-time snapshots rather than daily increments.
SNAPSHOT_SOURCES = {"github_stars", "github_forks", "github_open_issues", "discord_members"}


def load_data():
    """Load CSV into a dict: {(package, source): [(date, downloads), ...]}."""
    series = defaultdict(list)
    if not os.path.exists(CSV_PATH):
        return series
    with open(CSV_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            key = (row["package"], row["source"])
            d = date.fromisoformat(row["date"])
            downloads = int(row["downloads"])
            series[key].append((d, downloads))
    # Sort each series by date
    for key in series:
        series[key].sort(key=lambda x: x[0])
    return series


def filter_by_window(series, days):
    """Filter series to only include data within the last N days."""
    if days is None:
        return series
    cutoff = date.today() - timedelta(days=days)
    filtered = {}
    for key, points in series.items():
        pts = [(d, dl) for d, dl in points if d >= cutoff]
        if pts:
            filtered[key] = pts
    return filtered


SOURCE_ORDER = [COMBINED_ACTIVATIONS_KEY, "pypi", "npm", "github_stars", "github_clones", "github_forks", "github_open_issues", "discord_members", "discord_messages"]

# Sources to plot as cumulative totals instead of daily values.
CUMULATIVE_SOURCES = {"pypi", "npm", "discord_messages", "github_clones"}

# Sources whose cumulative totals contribute to the headline "Total downloads"
# figure in the README.
DOWNLOAD_TOTAL_SOURCES = {"pypi", "npm", "github_clones"}
DOWNLOAD_TOTAL_LABEL = "PyPI + npm + GitHub clones"


def make_cumulative(points):
    """Convert a sorted list of (date, value) into cumulative (date, running_total)."""
    cumulative = []
    total = 0
    for d, v in points:
        total += v
        cumulative.append((d, total))
    return cumulative


def generate_combined_activations_plot(all_series, window_label, window_name, days):
    """Plot cumulative pypi + npm + github_clones summed across all packages."""
    daily_totals = defaultdict(int)
    for (pkg, source), points in all_series.items():
        if source not in COMBINED_ACTIVATIONS_SOURCES:
            continue
        for d, v in points:
            daily_totals[d] += v
    if not daily_totals:
        return None

    sorted_points = sorted(daily_totals.items())
    cumulative = make_cumulative(sorted_points)

    if days is not None:
        cutoff = date.today() - timedelta(days=days)
        cumulative = [(d, v) for d, v in cumulative if d >= cutoff]
    if not cumulative:
        return None

    os.makedirs(PLOTS_DIR, exist_ok=True)
    fig, ax = plt.subplots(figsize=(7, 4))
    dates = [p[0] for p in cumulative]
    values = [p[1] for p in cumulative]
    ax.plot(dates, values, marker="o", markersize=3, linewidth=1.5,
            label="All packages")
    ax.set_title(
        f"{SOURCE_LABELS[COMBINED_ACTIVATIONS_KEY]} — {window_name}",
        fontsize=16, fontweight="bold",
    )
    ax.set_xlabel("Date", fontsize=14)
    ax.set_ylabel("Cumulative Downloads", fontsize=14)
    ax.legend(fontsize=14)
    ax.grid(True, alpha=0.3)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    ax.tick_params(axis="x", rotation=45, labelsize=14)
    ax.tick_params(axis="y", labelsize=14)
    plt.tight_layout()
    filename = f"{COMBINED_ACTIVATIONS_KEY}_{window_label}.png"
    path = os.path.join(PLOTS_DIR, filename)
    fig.savefig(path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return filename


def generate_plots(all_series, window_label, window_name, days):
    """Generate one PNG per source for a time window. Returns list of (source, path).

    For cumulative sources (pypi, npm), the cumulative total is computed from
    all available data, then the plot is windowed to the requested range.
    """
    filtered = filter_by_window(all_series, days)
    if not filtered:
        print(f"  No data for {window_name}, skipping")
        return []

    grouped_by_source = defaultdict(dict)
    for (pkg, source), points in filtered.items():
        grouped_by_source[source][(pkg, source)] = points

    ordered_sources = []
    for source in SOURCE_ORDER:
        if source in grouped_by_source:
            ordered_sources.append(source)
    for source in sorted(grouped_by_source.keys()):
        if source not in ordered_sources:
            ordered_sources.append(source)

    os.makedirs(PLOTS_DIR, exist_ok=True)
    generated = []

    for source in ordered_sources:
        source_series = grouped_by_source[source]
        fig, ax = plt.subplots(figsize=(7, 4))

        if source in CUMULATIVE_SOURCES:
            # Compute cumulative from full history, then filter to window
            cutoff = date.today() - timedelta(days=days) if days else None
            for (pkg, src), _ in sorted(source_series.items()):
                full_points = all_series.get((pkg, src), [])
                cum_points = make_cumulative(full_points)
                if cutoff:
                    cum_points = [(d, v) for d, v in cum_points if d >= cutoff]
                if cum_points:
                    dates = [p[0] for p in cum_points]
                    values = [p[1] for p in cum_points]
                    ax.plot(dates, values, marker="o", markersize=3, linewidth=1.5, label=pkg)
            ylabel = "Cumulative Messages" if source == "discord_messages" else "Cumulative Downloads"
        else:
            for (pkg, _), points in sorted(source_series.items()):
                dates = [p[0] for p in points]
                values = [p[1] for p in points]
                ax.plot(dates, values, marker="o", markersize=3, linewidth=1.5, label=pkg)
            ylabel = "Value"

        ax.set_title(f"{SOURCE_LABELS.get(source, source)} — {window_name}", fontsize=16, fontweight="bold")
        ax.set_xlabel("Date", fontsize=14)
        ax.set_ylabel(ylabel, fontsize=14)
        ax.legend(fontsize=14)
        ax.grid(True, alpha=0.3)
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
        ax.tick_params(axis="x", rotation=45, labelsize=14)
        ax.tick_params(axis="y", labelsize=14)
        plt.tight_layout()
        filename = f"{source}_{window_label}.png"
        path = os.path.join(PLOTS_DIR, filename)
        fig.savefig(path, dpi=150, bbox_inches="tight")
        plt.close(fig)
        generated.append((source, filename))

    print(f"  {window_name}: saved {len(generated)} plots")
    return generated


def compute_items(series):
    """Reduce the series into one row per (package, source), plus the headline download total."""
    items = []
    download_total = 0
    for pkg, source in sorted(set(series.keys())):
        points = series[(pkg, source)]
        if source in SNAPSHOT_SOURCES:
            metric = "Latest Value"
            value = points[-1][1]
        elif source == "discord_messages":
            metric = "Total Messages"
            value = sum(dl for _, dl in points)
        else:
            metric = "Total Downloads"
            value = sum(dl for _, dl in points)
        counts = metric == "Total Downloads" and source in DOWNLOAD_TOTAL_SOURCES
        if counts:
            download_total += value
        items.append({
            "package": pkg,
            "source": source,
            "label": SOURCE_LABELS.get(source, source),
            "metric": metric,
            "value": value,
            "counts_toward_download_total": counts,
        })
    return items, download_total


def write_summary(items, download_total):
    """Machine-readable mirror of the README table, so consumers do not parse markdown."""
    summary = {
        "last_updated": date.today().isoformat(),
        "download_total": download_total,
        "download_total_label": DOWNLOAD_TOTAL_LABEL,
        "download_total_sources": sorted(DOWNLOAD_TOTAL_SOURCES),
        "items": items,
    }
    with open(SUMMARY_PATH, "w") as f:
        json.dump(summary, f, indent=2)
        f.write("\n")
    print(f"  Wrote {SUMMARY_PATH}")


def update_readme(items, download_total):
    """Regenerate README.md with current plots and package table."""
    readme_path = os.path.join(ROOT_DIR, "README.md")

    table_rows = [
        f"| {it['package']} | {it['label']} | {it['metric']} | {it['value']:,} |"
        for it in items
    ]

    table = (
        f"**Total downloads ({DOWNLOAD_TOTAL_LABEL}):** {download_total:,}\n\n"
        "| Item | Source | Metric | Value |\n"
        "|------|--------|--------|-------|\n"
        + "\n".join(table_rows)
    )

    today = date.today().isoformat()

    readme = f"""# Traction Dashboard

Automated daily tracking of package and repository traction metrics from PyPI, npm, and GitHub.

**Last updated:** {today}

## Tracked Items

{table}

## Metric Trends

"""

    for label, name, _ in TIME_WINDOWS:
        # Collect plots that exist for this window
        plot_cells = []
        for source in SOURCE_ORDER:
            filename = f"{source}_{label}.png"
            if os.path.exists(os.path.join(PLOTS_DIR, filename)):
                plot_cells.append(
                    f'<td align="center"><img src="plots/{filename}" width="100%"></td>'
                )
        if not plot_cells:
            continue

        plot_rows = []
        for i in range(0, len(plot_cells), 2):
            pair = plot_cells[i:i + 2]
            if len(pair) == 1:
                pair.append("<td></td>")
            plot_rows.append(f"<tr>{''.join(pair)}</tr>")

        readme += f"### {name}\n\n"
        readme += '<table width="100%">\n'
        readme += "\n".join(plot_rows)
        readme += "\n</table>\n\n"

    readme += """---

*Updated daily by [GitHub Actions](.github/workflows/update.yml). Edit [config.yaml](config.yaml) to add or remove packages.*
"""

    with open(readme_path, "w") as f:
        f.write(readme)
    print(f"  Updated {readme_path}")


def main():
    print("Loading download data...")
    series = load_data()
    if not series:
        print("No data found. Run fetch_downloads.py first.")
        return 0

    print(f"Found data for {len(series)} package(s)")

    print("Generating plots...")
    for label, name, days in TIME_WINDOWS:
        generate_combined_activations_plot(series, label, name, days)
        generate_plots(series, label, name, days)

    print("Updating README...")
    items, download_total = compute_items(series)
    update_readme(items, download_total)
    write_summary(items, download_total)

    print("Done!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
