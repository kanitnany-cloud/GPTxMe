import { readFile, writeFile } from 'node:fs/promises';

const TARGET_GW = Number(process.env.FPL_TARGET_GW || 5);
const BASELINE_GW = TARGET_GW - 1;
const LEAGUE_ID = 872362;
const MY_ENTRY_ID = 3944270;
const basePath = `mini-league/mini-league-intel-gw${BASELINE_GW}.json`;
const outPath = `mini-league/mini-league-intel-gw${TARGET_GW}.json`;

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'AI-Kanitnan-FPL-GW-Preview/1.0' },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

function fixtureFor(fixtures, teamId) {
  const fixture = fixtures.find((item) => item.team_h === teamId || item.team_a === teamId);
  if (!fixture) return null;
  const home = fixture.team_h === teamId;
  return {
    opponentId: home ? fixture.team_a : fixture.team_h,
    venue: home ? 'H' : 'A',
    difficulty: home ? fixture.team_h_difficulty : fixture.team_a_difficulty,
  };
}

function behavior(team) {
  const history = team.weekly_history || [];
  const transfers = history.reduce((sum, item) => sum + Number(item.event_transfers || 0), 0);
  const hits = history.reduce((sum, item) => sum + Number(item.event_transfers_cost || 0), 0);
  if (hits >= 8) return 'สายแก้แรง/ยอม hit';
  if (transfers >= history.length + 2) return 'Active trader';
  if (transfers <= 1) return 'นิ่งและเน้น template';
  return 'สมดุล รอข่าวก่อนขยับ';
}

function outScore(player, pick, fixture) {
  let score = 0;
  if (player.status !== 'a') score += player.chance_of_playing_next_round === 75 ? 35 : 90;
  if (Number(player.ep_next || 0) < 2) score += 34;
  else if (Number(player.ep_next || 0) < 4) score += 18;
  if ((fixture?.difficulty || 3) >= 5) score += 20;
  else if ((fixture?.difficulty || 3) === 4) score += 10;
  if (Number(player.transfers_out_event || 0) > Number(player.transfers_in_event || 0) * 1.7) score += 13;
  if (pick.flag === 'B') score -= 15;
  if (pick.flag === 'B' && Number(player.now_cost || 0) >= 55) score += 18;
  if (Number(player.minutes || 0) < 180) score += 7;
  return score;
}

function targetScore(player, fixture) {
  let score = Number(player.ep_next || 0) * 6 + Number(player.form || 0) * 2;
  if ((fixture?.difficulty || 3) === 2) score += 15;
  if ((fixture?.difficulty || 3) === 3) score += 6;
  if (Number(player.transfers_in_event || 0) > Number(player.transfers_out_event || 0) * 2) score += 10;
  score += Math.min(Number(player.selected_by_percent || 0), 50) / 5;
  const preferred = new Map([
    [391, 28], // Gvardiol
    [229, 18], // Tarkowski
    [330, 16], // Bogle
    [40, 26], // Rogers
    [480, 26], // Gibbs-White
    [124, 16], // Gross
    [94, 14], // Schade
    [165, 16], // Joao Pedro
  ]);
  score += preferred.get(player.id) || 0;
  if (Number(player.starts || 0) < 2) score -= 26;
  else if (Number(player.minutes || 0) < 220) score -= 12;
  if (player.status !== 'a') score -= 80;
  return score;
}

function labelPosition(type) {
  return ({ 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' })[type] || '-';
}

async function main() {
  const baseline = JSON.parse(await readFile(basePath, 'utf8'));
  const [bootstrap, allFixtures] = await Promise.all([
    fetchJson('https://fantasy.premierleague.com/api/bootstrap-static/'),
    fetchJson('https://fantasy.premierleague.com/api/fixtures/'),
  ]);
  const targetEvent = bootstrap.events.find((item) => item.id === TARGET_GW);
  if (!targetEvent) throw new Error(`Gameweek ${TARGET_GW} is unavailable`);
  if (targetEvent.is_current || targetEvent.is_previous || targetEvent.finished) {
    console.log(JSON.stringify({ skipped: true, reason: `GW${TARGET_GW} is no longer a pre-deadline preview` }, null, 2));
    return;
  }

  const players = new Map(bootstrap.elements.map((player) => [player.id, player]));
  const clubs = new Map(bootstrap.teams.map((club) => [club.id, club]));
  const targetFixtures = allFixtures.filter((item) => item.event === TARGET_GW);
  const fixturesByTeam = new Map(bootstrap.teams.map((club) => [club.id, fixtureFor(targetFixtures, club.id)]));
  const generatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });

  const teams = [];
  const rivalPredictions = [];

  for (const team of baseline.teams) {
    const transfers = await fetchJson(`https://fantasy.premierleague.com/api/entry/${team.entry}/transfers/`);
    const confirmed = transfers.filter((item) => item.event === TARGET_GW).map((item) => ({
      time: item.time,
      out: players.get(item.element_out)?.web_name || String(item.element_out),
      in: players.get(item.element_in)?.web_name || String(item.element_in),
    }));
    const heldIds = new Set(team.picks.map((pick) => pick.element));
    const clubCounts = new Map();
    for (const pick of team.picks) {
      const player = players.get(pick.element);
      clubCounts.set(player.team, (clubCounts.get(player.team) || 0) + 1);
    }

    const outgoing = team.picks
      .map((pick) => {
        const player = players.get(pick.element);
        const fixture = fixturesByTeam.get(player.team);
        return { pick, player, fixture, score: outScore(player, pick, fixture) };
      })
      .sort((a, b) => b.score - a.score)[0];

    const budget = Number(outgoing.player.now_cost || 0) + Math.round(Number(team.bank || 0) * 10);
    const targets = bootstrap.elements
      .filter((player) =>
        player.element_type === outgoing.player.element_type &&
        player.now_cost <= budget &&
        player.status === 'a' &&
        Number(player.starts || 0) >= 2 &&
        !heldIds.has(player.id) &&
        (clubCounts.get(player.team) || 0) - (player.team === outgoing.player.team ? 1 : 0) < 3
      )
      .map((player) => ({ player, fixture: fixturesByTeam.get(player.team) }))
      .map((item) => ({ ...item, score: targetScore(item.player, item.fixture) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const problemCount = team.picks.filter((pick) => {
      const player = players.get(pick.element);
      const relevant = pick.flag !== 'B' || player.status !== 'a' || Number(player.now_cost || 0) >= 55;
      return relevant && outScore(player, pick, fixturesByTeam.get(player.team)) >= 35;
    }).length;
    const historyStyle = behavior(team);
    let likelihood = outgoing.score >= 55 || problemCount >= 3 ? 'สูง' : outgoing.score >= 30 ? 'กลาง' : 'ต่ำ';
    if (confirmed.length) likelihood = 'ยืนยันแล้ว';

    const captainOptions = team.picks
      .filter((pick) => pick.flag !== 'B')
      .map((pick) => {
        const player = players.get(pick.element);
        const fixture = fixturesByTeam.get(player.team);
        const availability = player.status === 'a' ? 0 : -4;
        return { player, score: Number(player.ep_next || 0) + (fixture?.difficulty === 2 ? 1.5 : 0) + availability };
      })
      .sort((a, b) => b.score - a.score);

    const wildcardUsed = (team.chips || []).some((chip) => chip.name === 'wildcard');
    const chipPrediction = wildcardUsed
      ? 'ไม่น่าใช้ Wildcard ซ้ำ; No chip สูง'
      : problemCount >= 5
        ? 'Wildcard 25-35% หากต้องแก้หลายตำแหน่ง'
        : 'No chip 80%+';
    const confidence = confirmed.length ? 100 : Math.min(86, 50 + outgoing.score / 2 + (historyStyle.includes('Active') ? 6 : 0));
    const targetText = targets.map(({ player, fixture }) =>
      `${player.web_name} (${clubs.get(player.team)?.short_name}, ${fixture ? `${clubs.get(fixture.opponentId)?.short_name} ${fixture.venue}` : '-'})`
    );
    if (!targetText.length) targetText.push('Roll FT / ต้องย้ายงบจากตำแหน่งอื่น');

    rivalPredictions.push({
      rank: team.rank,
      entry: team.entry,
      team: team.entry_name,
      manager: team.player_name,
      total: team.total,
      gapToYedtsuna: team.total - (baseline.teams.find((item) => item.entry === MY_ENTRY_ID)?.total || 0),
      likelihood,
      behavior: historyStyle,
      problem: `${outgoing.player.web_name} · ${labelPosition(outgoing.player.element_type)} · xP ${outgoing.player.ep_next || '-'} · ${outgoing.fixture ? `${clubs.get(outgoing.fixture.opponentId)?.short_name} ${outgoing.fixture.venue}` : '-'}`,
      predictedOut: outgoing.player.web_name,
      predictedIn: targetText,
      confirmedTransfers: confirmed,
      predictedCaptain: captainOptions[0]?.player.web_name || '-',
      chipPrediction,
      confidence: Math.round(confidence),
      strategicRead: team.entry === MY_ENTRY_ID
        ? 'ทีมเรา: Gvardiol เป็น shield หลัก; Rogers เน้นป้องกันอันดับ, Gibbs-White เน้นบุก GW5'
        : likelihood === 'สูง'
          ? 'มีปัญหาชัดและมีแรงจูงใจเปลี่ยนทีม จับ target ที่ ownership กำลังขึ้น'
          : 'มีแนวโน้มเก็บ FT หรือเปลี่ยนเพียงจุดเดียว ไม่ควร mirror ทั้งทีม',
    });

    teams.push({
      ...team,
      previous_event_total: team.event_total,
      event_total: 0,
      captain: captainOptions[0]?.player.web_name || team.captain,
      captain_multiplier: 2,
      transfer_audit: {
        count: confirmed.length,
        cost: 0,
        moves: confirmed.map((item) => ({ out: item.out, in: item.in })),
      },
      transferLikelihood: likelihood,
      picks: team.picks.map((pick) => {
        const player = players.get(pick.element);
        return {
          ...pick,
          baseline_event_points: Number(pick.event_points || 0),
          baseline_points: Number(pick.points || 0),
          current_price: player.now_cost / 10,
          status: player.status,
          chance_next: player.chance_of_playing_next_round,
          ep_next: Number(player.ep_next || 0),
          transfers_in_event: player.transfers_in_event,
          transfers_out_event: player.transfers_out_event,
        };
      }),
    });
  }

  const playerRows = baseline.playerRows.map((row) => {
    const player = players.get(row.id);
    return {
      ...row,
      baseline_event_points: Number(row.event_points || 0),
      current_price: player?.now_cost ? player.now_cost / 10 : null,
      status: player?.status || null,
      chance_next: player?.chance_of_playing_next_round ?? null,
      ep_next: Number(player?.ep_next || 0),
      transfers_in_event: player?.transfers_in_event || 0,
      transfers_out_event: player?.transfers_out_event || 0,
    };
  });

  const output = {
    ...baseline,
    event: targetEvent,
    previousEvent: baseline.event,
    baselineEvent: BASELINE_GW,
    preview: true,
    generatedAt,
    teams,
    playerRows,
    fixtures: targetFixtures.map((fixture) => ({
      kickoff_time: fixture.kickoff_time,
      started: fixture.started,
      finished: fixture.finished,
      home: clubs.get(fixture.team_h)?.short_name || String(fixture.team_h),
      away: clubs.get(fixture.team_a)?.short_name || String(fixture.team_a),
      home_score: fixture.team_h_score,
      away_score: fixture.team_a_score,
      home_difficulty: fixture.team_h_difficulty,
      away_difficulty: fixture.team_a_difficulty,
    })),
    rivalPredictions,
    methodology: {
      confirmed: 'อันดับ คะแนน ทีมล่าสุด Chips และ Transfer ที่ API เปิดเผย',
      inferred: 'ตัวออก/ตัวเข้า กัปตัน และ Chip probability คำนวณจากปัญหาทีม ราคา โปรแกรม ฟอร์ม Transfer trend และพฤติกรรมเดิม',
      warning: 'ก่อน deadline การจัดทีมและ Captain ของคู่แข่งยังไม่เปิดเผย ค่าทั้งหมดจึงเป็นความน่าจะเป็น ไม่ใช่ข้อมูลยืนยัน',
    },
  };

  await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ outPath, generatedAt, teams: teams.length, predictions: rivalPredictions.length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
