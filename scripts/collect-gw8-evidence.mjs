import {mkdir,writeFile,readFile} from 'node:fs/promises';
const dir='output/gw8-evidence'; await mkdir(dir,{recursive:true});
const sources=[];
async function get(endpoint){
 const url=`https://fantasy.premierleague.com/api/${endpoint}/`;
 const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
 if(!response.ok) throw new Error(`${response.status}: ${url}`);
 const data=await response.json(); sources.push({url,retrievedAt:new Date().toISOString()}); return data;
}
async function limited(items,fn){let i=0; const out=[];await Promise.all(Array.from({length:5},async()=>{while(i<items.length){const n=i++;out[n]=await fn(items[n]);}}));return out;}
const [bootstrap,fixtures,league,overall]=await Promise.all(['bootstrap-static','fixtures','leagues-classic/872362/standings','leagues-classic/314/standings'].map(get));
if(league.standings.has_next)throw new Error('League pagination required');
const current=bootstrap.events.find(e=>e.is_current).id;
if(current!==8){console.log(`GW8 evidence frozen: current event is ${current}`);process.exit(0);}
const live=Object.fromEntries(await Promise.all([5,6,7,8].map(async gw=>[gw,await get(`event/${gw}/live`)])));
const teams=await limited(league.standings.results,async row=>{
 const [history,transfers,entry]=await Promise.all([get(`entry/${row.entry}/history`),get(`entry/${row.entry}/transfers`),get(`entry/${row.entry}`)]);
 const picks={}; for(let gw=1;gw<=current;gw++){if(history.current.some(h=>h.event===gw))picks[gw]=await get(`entry/${row.entry}/event/${gw}/picks`);}
 return {...row,history,transfers,entryInfo:entry,picks};
});
const elite=await limited(overall.standings.results.slice(0,10),async row=>{
 const [history,transfers]=await Promise.all([get(`entry/${row.entry}/history`),get(`entry/${row.entry}/transfers`)]);
 const picks={};for(const gw of [6,7,8])picks[gw]=await get(`entry/${row.entry}/event/${gw}/picks`);
 return {...row,history,transfers,picks};
});
const playerIds=[...new Set([...teams.find(t=>t.entry===3944270).picks[8].picks.map(p=>p.element),4,31,68,79,427,334,453,569,166,156,13,261])];
const summaries=Object.fromEntries(await limited(playerIds,async id=>[id,await get(`element-summary/${id}`)]));
await writeFile(`${dir}/raw.json`,JSON.stringify({retrievedAt:new Date().toISOString(),bootstrap,fixtures,league,overall,live,teams,elite,summaries,sources},null,2));
console.log(JSON.stringify({current,teams:teams.length,elite:elite.length,sources:sources.length,overall:overall.league}));
