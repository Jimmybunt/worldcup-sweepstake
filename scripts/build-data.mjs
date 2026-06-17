// Pulls live World Cup data from football-data.org (free tier includes the
// World Cup, competition code "WC") and writes data.json in the shape the
// dashboard expects. Runs inside the GitHub Action, where FOOTBALL_DATA_TOKEN
// is provided as a secret. Nothing here ends up in the published page.
//
// If football-data.org ever changes its field names, the three map* functions
// below are the only places you should need to touch.

import { writeFileSync } from "node:fs";

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const BASE = "https://api.football-data.org/v4/competitions/WC";

if (!TOKEN) {
  console.error("FOOTBALL_DATA_TOKEN is not set. Add it as a repo secret.");
  process.exit(1);
}

async function api(path) {
  const res = await fetch(BASE + path, { headers: { "X-Auth-Token": TOKEN } });
  if (!res.ok) throw new Error(path + " returned " + res.status);
  return res.json();
}

// The feed's team names do not always match the names used in the dashboard /
// sweepstake (e.g. it may say "Korea Republic" or "Czech Republic"). Normalise
// here so the Sweepstake tab keeps matching. Verify these against a real
// response the first time you run it and adjust as needed.
const TEAM_NAME_FIX = {
  "Korea Republic": "South Korea",
  "Republic of Korea": "South Korea",
  "Czech Republic": "Czechia",
  "United States": "USA",
  "United States of America": "USA",
  "Turkey": "Türkiye",
  "Turkiye": "Türkiye",
  "DR Congo": "DR Congo",
  "Congo DR": "DR Congo",
  "Democratic Republic of Congo": "DR Congo",
  "Ivory Coast": "Ivory Coast",
  "Côte d'Ivoire": "Ivory Coast",
  "Cote d'Ivoire": "Ivory Coast",
  "Bosnia-Herzegovina": "Bosnia and Herzegovina",
  "Bosnia & Herzegovina": "Bosnia and Herzegovina",
  "Cape Verde": "Cape Verde",
  "Cabo Verde": "Cape Verde",
  "Netherlands": "Netherlands"
};
function fixName(n) {
  if (!n) return n;
  return TEAM_NAME_FIX[n] || n;
}

function mapState(status) {
  if (status === "FINISHED") return "FT";
  if (status === "IN_PLAY" || status === "PAUSED" || status === "LIVE") return "LIVE";
  return "UP";
}

function mapGroups(standingsResp) {
  // football-data returns one standings block per group, each with a group like
  // "GROUP_A" and a table of rows already in standings order.
  const blocks = (standingsResp.standings || []).filter(s => s.group);
  return blocks.map(block => ({
    name: String(block.group).replace(/GROUP_?/i, "").trim(),
    teams: (block.table || []).map(row => ({
      team: fixName(row.team && row.team.name),
      P: row.playedGames || 0,
      W: row.won || 0,
      D: row.draw || 0,
      L: row.lost || 0,
      GF: row.goalsFor || 0,
      GA: row.goalsAgainst || 0,
      GD: row.goalDifference || 0,
      Pts: row.points || 0
    }))
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function mapMatchdays(matchesResp) {
  const all = (matchesResp.matches || []).map(m => ({
    utc: m.utcDate,
    date: new Date(m.utcDate),
    home: fixName(m.homeTeam && m.homeTeam.name),
    away: fixName(m.awayTeam && m.awayTeam.name),
    homeScore: m.score && m.score.fullTime ? m.score.fullTime.home : null,
    awayScore: m.score && m.score.fullTime ? m.score.fullTime.away : null,
    state: mapState(m.status)
  }));

  // Keep yesterday, today and tomorrow (UK time) so the Match day tab stays tight.
  const now = new Date();
  const dayKey = d => d.toLocaleDateString("en-GB", { timeZone: "Europe/London" });
  const wanted = new Set([
    dayKey(new Date(now.getTime() - 864e5)),
    dayKey(now),
    dayKey(new Date(now.getTime() + 864e5))
  ]);

  const byDay = {};
  all.forEach(m => {
    const key = dayKey(m.date);
    if (!wanted.has(key)) return;
    const label = m.date.toLocaleDateString("en-GB",
      { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long" });
    (byDay[label] = byDay[label] || { date: label, sort: m.date.getTime(), matches: [] })
      .matches.push({ home: m.home, away: m.away, homeScore: m.homeScore, awayScore: m.awayScore, state: m.state });
  });

  return Object.values(byDay).sort((a, b) => a.sort - b.sort)
    .map(d => ({ date: d.date, matches: d.matches }));
}

function mapScorers(scorersResp) {
  return (scorersResp.scorers || []).slice(0, 8).map(s => ({
    name: s.player && s.player.name,
    country: fixName(s.team && s.team.name),
    goals: s.goals || 0
  }));
}

async function main() {
  const [standings, matches, scorers] = await Promise.all([
    api("/standings"),
    api("/matches"),
    api("/scorers?limit=10").catch(() => ({ scorers: [] }))
  ]);

  const out = {
    asOf: "Live · " + new Date().toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" }),
    matchdays: mapMatchdays(matches),
    groups: mapGroups(standings),
    scorers: mapScorers(scorers)
  };

  if (!out.groups.length) {
    console.error("No groups parsed. Leaving existing data.json untouched.");
    process.exit(1);
  }

  writeFileSync("data.json", JSON.stringify(out, null, 2));
  console.log("Wrote data.json:", out.groups.length, "groups,",
    out.matchdays.length, "match days,", out.scorers.length, "scorers.");
}

main().catch(err => { console.error(err); process.exit(1); });

