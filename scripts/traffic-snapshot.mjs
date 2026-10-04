#!/usr/bin/env node
// Appends this repo's GitHub traffic to CSV history files. GitHub keeps only the last 14 days
// (Insights → Traffic), so .github/workflows/traffic.yml runs this weekly and commits the
// result to the `traffic-stats` branch; consecutive runs overlap by a week and merge by date.
//
// Usage: GITHUB_TOKEN=… node scripts/traffic-snapshot.mjs <owner/repo> <out dir>
// The token needs read access to repository Administration (fine-grained) or `repo` (classic):
// the Actions GITHUB_TOKEN can't read traffic.
//
// Files written in <out dir>:
//   views.csv, clones.csv  date,count,uniques — one row per UTC day. The latest fetch wins for a
//                          date already present (a day still in progress grows between runs).
//   referrers.csv          snapshot_date,referrer,count,uniques — the 14-day top 10 as of the run.
//   paths.csv              snapshot_date,path,title,count,uniques — likewise.
import fs from "node:fs";
import path from "node:path";

const [repo, outDir] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
if (!repo || !outDir || !token) {
  console.error(
    "usage: GITHUB_TOKEN=… node scripts/traffic-snapshot.mjs <owner/repo> <out dir>",
  );
  process.exit(2);
}

async function get(endpoint) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/traffic/${endpoint}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok)
    throw new Error(
      `GET traffic/${endpoint}: ${res.status} ${await res.text()}`,
    );
  return res.json();
}

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (cells) => cells.map(csvCell).join(",");

/** Minimal CSV reader for the files this script writes (quoted cells, no embedded newlines). */
function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(1);
  return lines.map((line) => {
    const cells = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') ((cur += '"'), i++);
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") (cells.push(cur), (cur = ""));
      else cur += c;
    }
    cells.push(cur);
    return cells;
  });
}

function write(file, header, rows) {
  fs.writeFileSync(
    file,
    [csvLine(header), ...rows.map(csvLine)].join("\n") + "\n",
  );
}

/** views/clones: merge the API's per-day buckets into the history by date. */
function mergeDaily(file, buckets) {
  const byDate = new Map(
    readRows(file).map(([date, count, uniques]) => [date, [count, uniques]]),
  );
  for (const b of buckets)
    byDate.set(b.timestamp.slice(0, 10), [b.count, b.uniques]);
  const rows = [...byDate]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, [c, u]]) => [d, c, u]);
  write(file, ["date", "count", "uniques"], rows);
  return rows.length;
}

/** referrers/paths: append today's snapshot, replacing one already taken today (a re-run). */
function appendSnapshot(file, header, today, rows) {
  const kept = readRows(file).filter((r) => r[0] !== today);
  write(file, header, [...kept, ...rows.map((r) => [today, ...r])]);
}

fs.mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const [views, clones, referrers, paths] = await Promise.all([
  get("views?per=day"),
  get("clones?per=day"),
  get("popular/referrers"),
  get("popular/paths"),
]);

const nViews = mergeDaily(path.join(outDir, "views.csv"), views.views);
const nClones = mergeDaily(path.join(outDir, "clones.csv"), clones.clones);
appendSnapshot(
  path.join(outDir, "referrers.csv"),
  ["snapshot_date", "referrer", "count", "uniques"],
  today,
  referrers.map((r) => [r.referrer, r.count, r.uniques]),
);
appendSnapshot(
  path.join(outDir, "paths.csv"),
  ["snapshot_date", "path", "title", "count", "uniques"],
  today,
  paths.map((p) => [p.path, p.title, p.count, p.uniques]),
);

console.log(
  `${repo}: last 14 days ${views.count} views (${views.uniques} unique visitors), ` +
    `${clones.count} clones (${clones.uniques} unique cloners); history ${nViews} view days, ${nClones} clone days`,
);
