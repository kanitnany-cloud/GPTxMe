import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const sources=[];
async function get(path){const url='https://fantasy.premierleague.com/api/'+path;const r=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`${r.status}: ${url}`);sources.push({url,at:new Date().toISOString()});return r.json();}
async function map(xs,fn){let i=0;const out=[];await Promise.all(Array.from({length:5},async()=>{while(i<xs.length){const n=i++;out[n]=await fn(xs[n]);}}));return out;}
const b=await get('bootstrap-static/');
if(b.events.find(e=>e.is_current)?.id!==9){console.log('GW9 collector frozen outside current GW9');process.exit(0);}
const [fixtures,league,live,o1,o2]=await Promise.all(['fixtures/','leagues-classic/872362/standings/','event/9/live/','leagues-classic/314/standings/?page_standings=1','leagues-classic/314/standings/?page_standings=2'].map(get));
assert(!league.standings.has_next,'Mini pagination needed');
const teams=await map(league.standings.results,async r=>{const [picks,previous,history,transfers]=await Promise.all([`entry/${r.entry}/event/9/picks/`,`entry/${r.entry}/event/8/picks/`,`entry/${r.entry}/history/`,`entry/${r.entry}/transfers/`].map(get));return {...r,picks,previous,history,transfers};});
const rows=[...o1.standings.results,...o2.standings.results].slice(0,100);assert.equal(new Set(rows.map(r=>r.entry)).size,100);
const world=await map(rows,async r=>({...r,picks:await get(`entry/${r.entry}/event/9/picks/`)}));
const me=teams.find(t=>t.entry===3944270);assert(me);assert.equal(me.picks.picks.length,15);
const ids=[...new Set([...me.picks.picks.map(p=>p.element),4,31,334,166,379,79,68,427,426,212,165])];
const summaries=Object.fromEntries(await map(ids,async id=>[id,await get(`element-summary/${id}/`)]));
const forecast=JSON.parse(await readFile('mini-league/gw9-rival-forecast-20261026.json','utf8'));
const players=b.elements.map(p=>({id:p.id,name:p.web_name,team:p.team,pos:p.element_type,price:p.now_cost/10,status:p.status,news:p.news,newsAdded:p.news_added,chance:p.chance_of_playing_next_round,minutes:p.minutes,starts:p.starts,xGI:p.expected_goal_involvements,xGI90:p.expected_goal_involvements_per_90,ep:p.ep_next,ownership:p.selected_by_percent,priceEvent:p.cost_change_event/10,priceSeason:p.cost_change_start/10,tin:p.transfers_in_event,tout:p.transfers_out_event,pen:p.penalties_order,fk:p.direct_freekicks_order,corner:p.corners_and_indirect_freekicks_order}));
const d={generatedAt:new Date().toISOString(),event:b.events.find(e=>e.id===9),next:b.events.find(e=>e.id===10),leagueUpdated:league.last_updated_data,league:league.league,teams,world,players,clubs:b.teams,fixtures:fixtures.filter(f=>f.event>=9&&f.event<=13),live:live.elements,summaries,forecast,sources};
await writeFile('mini-league/gw9-intel-evidence.json',JSON.stringify(d));
console.log(JSON.stringify({at:d.generatedAt,event:d.event,top:teams.slice(0,4).map(t=>({name:t.entry_name,total:t.total,gw:t.event_total})),mine:me.transfers.filter(t=>t.event===9),teams:teams.length,world:world.length}));
