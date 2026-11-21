import { mkdir, writeFile, readFile } from 'node:fs/promises';

const LEAGUE_ID = 872362;
const MY_ENTRY = 3944270;
const OUT = 'mini-league/rival-simulation.json';
const API = 'https://fantasy.premierleague.com/api';

const get = async (url) => {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Kanitnan-FPL-Rival-Simulation/1.0' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};
const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length); let cursor = 0;
  const worker = async () => { while (cursor < items.length) { const i = cursor++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)); return out;
};
const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const pct = (n, d) => d ? Math.round((n / d) * 100) : 0;

async function main() {
  let previous = null;
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  const [bootstrap, fixtures, league] = await Promise.all([
    get(`${API}/bootstrap-static/`), get(`${API}/fixtures/`), get(`${API}/leagues-classic/${LEAGUE_ID}/standings/?page_standings=1&page_new_entries=1`),
  ]);
  const current = bootstrap.events.find((e) => e.is_current) || bootstrap.events.find((e) => e.is_next) || bootstrap.events[0];
  const next = bootstrap.events.find((e) => e.id > current.id && !e.finished) || current;
  const clubs = new Map(bootstrap.teams.map((x) => [x.id, x]));
  const players = new Map(bootstrap.elements.map((x) => [x.id, x]));
  const rows = (league.standings?.results || []).slice(0, 10);

  const rivals = await mapLimit(rows, 4, async (row) => {
    const [history, transfers, currentPicks] = await Promise.all([
      get(`${API}/entry/${row.entry}/history/`), get(`${API}/entry/${row.entry}/transfers/`), get(`${API}/entry/${row.entry}/event/${current.id}/picks/`),
    ]);
    const gwPicks = await mapLimit((history.current || []).map((h) => h.event), 3, async (gw) => {
      try { return { event: gw, data: await get(`${API}/entry/${row.entry}/event/${gw}/picks/`) }; } catch { return null; }
    });
    const currentHistory = history.current || [];
    const recent = currentHistory.slice(-5);
    const recentTransfers = (transfers || []).filter((x) => x.event >= Math.max(1, current.id - 4) && x.event <= current.id);
    const recentChips = (history.chips || []).filter((x) => x.event >= Math.max(1, current.id - 5));
    const picks = currentPicks.picks || [];
    const cap = picks.find((x) => x.is_captain);
    const transferByGw = new Map();
    for (const x of transfers || []) transferByGw.set(x.event, (transferByGw.get(x.event) || 0) + 1);
    const gwWithMoves = [...transferByGw.values()];
    const hitGws = currentHistory.filter((x) => x.event_transfers_cost > 0).length;
    const avgMoves = avg(gwWithMoves);
    const action = current.id >= next.id ? 'awaiting_next_gw' : 'observe';
    const hasInjury = picks.filter((x) => players.get(x.element)?.status !== 'a').length;
    const candidatePool = [...players.values()]
      .filter((p) => !p.id || !p.web_name || p.status === 'u')
      .sort((a, b) => Number(b.form || 0) - Number(a.form || 0));
    const owned = new Set(picks.map((x) => x.element));
    const candidates = [...players.values()].filter((p) => !owned.has(p.id) && p.status === 'a')
      .sort((a, b) => (Number(b.form || 0) + Number(b.transfers_in_event || 0) / 100000) - (Number(a.form || 0) + Number(a.transfers_in_event || 0) / 100000))
      .slice(0, 5).map((p) => ({ player: p.web_name, club: clubs.get(p.team)?.short_name, price: p.now_cost / 10, form: Number(p.form || 0), globalOwner: Number(p.selected_by_percent || 0) }));
    const transferPressure = Math.min(100, Math.round(avgMoves * 28 + hasInjury * 14 + (recent.at(-1)?.points < 50 ? 18 : 0)));
    const profile = {
      transferRate: pct(gwWithMoves.filter((n) => n > 0).length, Math.max(1, currentHistory.length)),
      avgMoves: Number(avgMoves.toFixed(2)),
      hitRate: pct(hitGws, Math.max(1, currentHistory.length)),
      captainHaalandRate: pct((gwPicks.filter(Boolean).map((x) => x.data.picks.find((p) => p.is_captain)?.element).filter((id) => players.get(id)?.web_name === 'Haaland')).length, Math.max(1, gwPicks.filter(Boolean).length)),
      chipCountRecent: recentChips.length, sampleGWs: currentHistory.length,
    };
    const simulated = {
      action: profile.transferRate >= 60 || transferPressure >= 55 ? 'likely_transfer' : 'likely_roll',
      confidence: profile.sampleGWs >= 6 ? (transferPressure >= 55 ? 'medium' : 'low') : 'low',
      transferPressure, candidates, captain: cap ? players.get(cap.element)?.web_name : null,
      captainConfidence: cap?.is_captain ? 'last_revealed' : 'unknown',
      reason: hasInjury ? `มีผู้เล่น status ไม่พร้อม ${hasInjury} คน` : `อัตราใช้ FT จากอดีต ${profile.transferRate}%`,
    };
    const old = previous?.rivals?.find((x) => x.entry === row.entry);
    const actualMoves = Number(currentPicks.entry_history?.event_transfers ?? 0);
    const actualCaptain = cap ? players.get(cap.element)?.web_name : null;
    const priorForecast = old?.simulated;
    const forecastVsActual = previous?.nextEvent === current.id && priorForecast ? [{
      targetEvent: current.id,
      predictedAction: priorForecast.action,
      actualAction: actualMoves > 0 ? 'likely_transfer' : 'likely_roll',
      actionCorrect: priorForecast.action === (actualMoves > 0 ? 'likely_transfer' : 'likely_roll'),
      predictedCaptain: old.current?.captain || null,
      actualCaptain,
      captainCorrect: old.current?.captain === actualCaptain,
    }] : (old?.learning?.forecastVsActual || []);
    return {
      entry: row.entry, rank: row.rank, name: row.player_name, team: row.entry_name, total: row.total,
      current: { event: current.id, points: currentPicks.entry_history?.points ?? null, captain: cap ? players.get(cap.element)?.web_name : null, captainMultiplier: cap?.multiplier ?? 1, picks: picks.map((x) => ({ name: players.get(x.element)?.web_name, club: clubs.get(players.get(x.element)?.team)?.short_name, flag: x.is_captain ? 'C' : x.is_vice_captain ? 'VC' : x.multiplier ? 'XI' : 'B' })) },
      history: currentHistory.map((x) => ({ event: x.event, points: x.points, rank: x.rank, transfers: x.event_transfers, hit: x.event_transfers_cost, bench: x.points_on_bench })),
      transfers: (transfers || []).map((x) => ({ event: x.event, out: players.get(x.element_out)?.web_name, in: players.get(x.element_in)?.web_name, time: x.time })),
      chips: history.chips || [], profile, simulated, learning: { forecastVsActual, modelVersion: 'v1.0' },
    };
  });
  const generatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
  const json = { generatedAt, modelVersion: 'v1.0', league: league.league, currentEvent: current.id, nextEvent: next.id, currentStatus: { finished: current.finished, dataChecked: current.data_checked, deadline: current.deadline_time }, fixtures: fixtures.filter((x) => x.event === next.id).map((x) => ({ kickoff: x.kickoff_time, home: clubs.get(x.team_h)?.short_name, away: clubs.get(x.team_a)?.short_name })), rivals, notes: ['Forecast เป็น inference จากประวัติ ไม่ใช่ข้อมูล transfer ที่ยังไม่เปิดเผย', 'หลัง GW จบให้เติม actual และวัด action/captain/player accuracy ก่อนปรับ model weights'] };
  await mkdir('mini-league', { recursive: true }); await writeFile(OUT, JSON.stringify(json, null, 2));
  console.log(JSON.stringify({ generatedAt, currentEvent: current.id, nextEvent: next.id, rivals: rivals.length, out: OUT }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
