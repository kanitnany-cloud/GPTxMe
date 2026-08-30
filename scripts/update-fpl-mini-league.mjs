import { mkdir, writeFile } from 'node:fs/promises';

const LEAGUE_ID = 872362;
const MY_ENTRY_ID = 3944270;
const OUT_DIR = 'mini-league';
const API_DIR = 'api';

const urls = {
  bootstrap: 'https://fantasy.premierleague.com/api/bootstrap-static/',
  fixtures: 'https://fantasy.premierleague.com/api/fixtures/',
  league: (page = 1) => `https://fantasy.premierleague.com/api/leagues-classic/${LEAGUE_ID}/standings/?page_standings=${page}`,
  picks: (entry, event) => `https://fantasy.premierleague.com/api/entry/${entry}/event/${event}/picks/`,
  history: (entry) => `https://fantasy.premierleague.com/api/entry/${entry}/history/`,
};

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      'user-agent': 'AI-Kanitnan-FPL-GitHub-Pages-Updater/1.0',
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function pickFlag(pick) {
  if (pick.is_captain && pick.multiplier === 3) return 'TC';
  if (pick.is_captain) return 'C';
  if (pick.is_vice_captain) return 'VC';
  if (pick.multiplier === 0) return 'B';
  return 'XI';
}

function likelyTransferLevel(team, medianPoints) {
  let score = 0;
  score += team.picks.filter((pick) => pick.player.status !== 'a').length * 3;
  score += (team.current?.event_transfers ?? 0) > 0 ? 2 : 0;
  score += (team.current?.event_transfers_cost ?? 0) > 0 ? 2 : 0;
  score += team.chips.length ? 1 : 0;
  score += (team.current?.points_on_bench ?? 0) >= 8 ? 1 : 0;
  score += team.event_total < medianPoints ? 1 : 0;
  score += team.overlap15 <= 3 ? 1 : 0;
  if (score >= 4) return 'สูง';
  if (score >= 2) return 'กลาง';
  return 'ต่ำ';
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(API_DIR, { recursive: true });

  const [bootstrap, fixtures] = await Promise.all([
    fetchJson(urls.bootstrap),
    fetchJson(urls.fixtures),
  ]);
  const event = bootstrap.events.find((item) => item.is_current) || bootstrap.events.find((item) => item.is_next) || bootstrap.events[0];
  const playersById = new Map(bootstrap.elements.map((player) => [player.id, player]));
  const clubsById = new Map(bootstrap.teams.map((team) => [team.id, team]));

  const firstLeague = await fetchJson(urls.league(1));
  const standings = [...(firstLeague.standings?.results || [])];
  for (let page = 2; firstLeague.standings?.has_next && page <= 20; page += 1) {
    const next = await fetchJson(urls.league(page));
    standings.push(...(next.standings?.results || []));
    if (!next.standings?.has_next) break;
  }

  const teams = await mapLimit(standings, 5, async (row) => {
    const [picksData, history] = await Promise.all([
      fetchJson(urls.picks(row.entry, event.id)),
      fetchJson(urls.history(row.entry)),
    ]);
    const picks = picksData.picks.map((pick) => {
      const player = playersById.get(pick.element);
      const club = clubsById.get(player.team);
      return {
        ...pick,
        player,
        club,
        points: Number(player.event_points || 0) * Number(pick.multiplier || 0),
      };
    });
    return {
      ...row,
      picks,
      chips: history.chips || [],
      current: (history.current || []).find((gw) => gw.event === event.id),
      captain: picks.find((pick) => pick.is_captain),
    };
  });

  const myTeam = teams.find((team) => team.entry === MY_ENTRY_ID) || teams[0];
  const myPicks = new Set(myTeam.picks.map((pick) => pick.element));
  const myXi = new Set(myTeam.picks.filter((pick) => pick.multiplier > 0).map((pick) => pick.element));

  for (const team of teams) {
    const pickSet = new Set(team.picks.map((pick) => pick.element));
    const xiSet = new Set(team.picks.filter((pick) => pick.multiplier > 0).map((pick) => pick.element));
    team.overlap15 = [...pickSet].filter((id) => myPicks.has(id)).length;
    team.overlapXI = [...xiSet].filter((id) => myXi.has(id)).length;
  }

  const sortedPoints = teams.map((team) => Number(team.event_total || 0)).sort((a, b) => a - b);
  const medianPoints = sortedPoints[Math.floor(sortedPoints.length / 2)] || 0;
  for (const team of teams) team.transferLikelihood = likelyTransferLevel(team, medianPoints);

  const playerMap = new Map();
  for (const team of teams) {
    for (const pick of team.picks) {
      if (!playerMap.has(pick.element)) {
        playerMap.set(pick.element, {
          id: pick.element,
          web_name: pick.player.web_name,
          team_short: pick.club.short_name,
          owners: 0,
          captains: 0,
          tripleCaptains: 0,
          event_points: Number(pick.player.event_points || 0),
          total_points: 0,
          ownedByMe: myPicks.has(pick.element),
        });
      }
      const row = playerMap.get(pick.element);
      row.owners += 1;
      row.total_points += pick.points;
      if (pick.is_captain) row.captains += 1;
      if (pick.is_captain && pick.multiplier === 3) row.tripleCaptains += 1;
    }
  }

  const playerRows = [...playerMap.values()].sort((a, b) =>
    b.owners - a.owners ||
    b.captains - a.captains ||
    b.total_points - a.total_points ||
    a.web_name.localeCompare(b.web_name)
  );

  const generatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
  const fplFixtures = fixtures
    .filter((fixture) => fixture.event === event.id)
    .slice(0, 10)
    .map((fixture) => ({
      kickoff_time: fixture.kickoff_time,
      started: fixture.started,
      finished: fixture.finished,
      home: clubsById.get(fixture.team_h)?.short_name || String(fixture.team_h),
      away: clubsById.get(fixture.team_a)?.short_name || String(fixture.team_a),
      home_score: fixture.team_h_score,
      away_score: fixture.team_a_score,
    }));

  const json = {
    league: firstLeague.league,
    event,
    generatedAt,
    teams: teams.map((team) => ({
      entry: team.entry,
      entry_name: team.entry_name,
      player_name: team.player_name,
      rank: team.rank,
      event_total: team.event_total,
      total: team.total,
      captain: team.captain?.player.web_name,
      captain_multiplier: team.captain?.multiplier,
      chips: team.chips,
      overlap15: team.overlap15,
      overlapXI: team.overlapXI,
      transferLikelihood: team.transferLikelihood,
      picks: team.picks.map((pick) => ({
        element: pick.element,
        web_name: pick.player.web_name,
        club: pick.club.short_name,
        multiplier: pick.multiplier,
        flag: pickFlag(pick),
        event_points: Number(pick.player.event_points || 0),
        points: pick.points,
      })),
    })),
    playerRows,
    fixtures: fplFixtures,
  };

  const teamCsv = [
    ['rank', 'entry', 'team', 'manager', 'gw_points', 'total', 'captain', 'captain_multiplier', 'chips', 'overlap15', 'overlapXI', 'transfer_likelihood'].join(','),
    ...json.teams.map((team) => [
      team.rank,
      team.entry,
      team.entry_name,
      team.player_name,
      team.event_total,
      team.total,
      team.captain || '',
      team.captain_multiplier || '',
      team.chips.map((chip) => `${chip.name}:GW${chip.event}`).join('|'),
      team.overlap15,
      team.overlapXI,
      team.transferLikelihood,
    ].map(csvEscape).join(',')),
  ].join('\n');

  const playerCsv = [
    ['player', 'club', 'owners', 'captains', 'triple_captains', 'gw_points', 'total_points', 'owned_by_me'].join(','),
    ...playerRows.map((row) => [
      row.web_name,
      row.team_short,
      row.owners,
      row.captains,
      row.tripleCaptains,
      row.event_points,
      row.total_points,
      row.ownedByMe,
    ].map(csvEscape).join(',')),
  ].join('\n');

  const leader = json.teams[0] || null;
  const deviceFeed = {
    project: 'AI x Kanitnan FPL Quest',
    updated_at_th: generatedAt,
    gameweek: event.id,
    team: {
      name: myTeam.entry_name,
      entry_id: myTeam.entry,
      rank: myTeam.rank,
      points: myTeam.total,
      gw_points: myTeam.event_total,
      captain: myTeam.captain?.player.web_name || '-',
      captain_multiplier: myTeam.captain?.multiplier || 0,
    },
    mini_league: {
      id: LEAGUE_ID,
      name: firstLeague.league.name,
      leader: leader ? {
        team: leader.entry_name,
        manager: leader.player_name,
        points: leader.total,
        captain: leader.captain || '-',
      } : null,
      top: json.teams.slice(0, 8).map((team) => ({
        rank: team.rank,
        team: team.entry_name,
        points: team.total,
        captain: team.captain || '-',
        chips: team.chips.map((chip) => chip.name),
      })),
    },
    template_players: playerRows.slice(0, 8).map((player) => ({
      name: player.web_name,
      club: player.team_short,
      owners: player.owners,
      captains: player.captains,
      gw_points: player.event_points,
      total_points: player.total_points,
      owned_by_me: player.ownedByMe,
    })),
    fixtures: fplFixtures,
    strategy: {
      mode: 'confidence-first',
      safe: 'Block high EO captain threats first.',
      attack: 'Use differential only when minutes and fixture are strong.',
    },
  };

  const asciiAliases = new Map([
    ['ทีมของ Apirak', 'Apirak FC'],
    ['ช่วยใจดีกับลุงหน่อย', 'Palm FC'],
    ['ทีมของ Satawat', 'Satawat FC'],
    ['ปีศาจแดง4ever', 'Red Devils 4ever'],
  ]);
  const safeAscii = (value) => {
    const original = String(value ?? '');
    const alias = asciiAliases.get(original) || original;
    const cleaned = alias
      .normalize('NFKD')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return (cleaned || 'Team').slice(0, 32);
  };

  const deviceLite = {
    u: generatedAt,
    gw: event.id,
    team: safeAscii(myTeam.entry_name),
    pts: myTeam.total,
    rank: myTeam.rank,
    cap: safeAscii(myTeam.captain?.player.web_name || '-'),
    leader: safeAscii(leader?.entry_name || '-'),
    leader_pts: leader?.total || 0,
    top: json.teams.slice(0, 5).map((team) => ({
      r: team.rank,
      t: safeAscii(team.entry_name),
      p: team.total,
    })),
    tpl: playerRows.slice(0, 5).map((player) => ({
      n: safeAscii(player.web_name),
      c: player.team_short,
      o: player.owners,
      p: player.total_points,
    })),
    scout: [
      {
        n: 'Calafiori',
        c: 'ARS',
        tag: 'BLOCK',
        conf: 82,
        why: 'High mini ownership. Protect rank.',
      },
      {
        n: 'Szoboszlai',
        c: 'LIV',
        tag: 'WATCH',
        conf: 72,
        why: 'Template threat. Buy only if role holds.',
      },
      {
        n: 'De Cuyper',
        c: 'BHA',
        tag: 'HOLD',
        conf: 76,
        why: 'Good start, avoid knee-jerk sale.',
      },
    ],
  };

  await writeFile(`${OUT_DIR}/mini-league-intel-gw${event.id}.json`, JSON.stringify(json, null, 2), 'utf8');
  await writeFile(`${OUT_DIR}/team-summary-gw${event.id}.csv`, teamCsv, 'utf8');
  await writeFile(`${OUT_DIR}/player-template-gw${event.id}.csv`, playerCsv, 'utf8');
  await writeFile(`${API_DIR}/fpl-device-live.json`, JSON.stringify(deviceFeed, null, 2), 'utf8');
  await writeFile(`${API_DIR}/fpl-device-lite.json`, JSON.stringify(deviceLite), 'utf8');

  console.log(JSON.stringify({
    generatedAt,
    league: firstLeague.league.name,
    event: event.id,
    teams: teams.length,
    myTeam: myTeam.entry_name,
    myTotal: myTeam.total,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
