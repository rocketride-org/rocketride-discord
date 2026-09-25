// eval/bakeoff/make-review.ts — turns labels.jsonl + the proposals into a single self-contained
// HTML page you review in a browser: current answer, proposed answer, one-line reason, approve or
// override, then export the finished labels.jsonl.
//
//   tsx eval/bakeoff/make-review.ts        → eval/bakeoff/review.html
//
// The page is a LOCAL FILE and is never published: it contains real customer questions, team
// answers and Discord user ids. Your decisions are kept in the browser's localStorage for that
// file, so you can close the tab and come back. Export writes the labels.jsonl to download.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { bench } from '../bench/config';
import { OUTCOMES, CAUSES, VERDICTS } from './enums';
const LABELS = 'eval/bakeoff/labels.jsonl';
const OUT = 'eval/bakeoff/review.html';

const rows = readFileSync(LABELS, 'utf8').split('\n').map((l) => l.trim())
	.filter((l) => l && !l.startsWith('#')).map((l) => JSON.parse(l));
const propG = JSON.parse(readFileSync('eval/bakeoff/proposals-grader.json', 'utf8'));
const propJ = JSON.parse(readFileSync('eval/bakeoff/proposals-judge.json', 'utf8'));

// --- current answers -------------------------------------------------------------------------
const db = new DatabaseSync(bench.dbPath, { readOnly: true });
const current: Record<string, any> = {};
const evidence: Record<string, any> = {};
try {
	for (const r of rows) {
		if (r.kind === 'grader') {
			const t = db.prepare('SELECT outcome, cause FROM threads WHERE thread_id = ?').get(r.threadId) as any;
			current[r.id] = { outcome: t?.outcome ?? null, cause: t?.cause ?? null };
			const ev = db.prepare('SELECT type, text FROM events WHERE thread_id = ? ORDER BY ts').all(r.threadId) as any[];
			evidence[r.id] = {
				question: ev.find((e) => e.type === 'question' && e.text)?.text
					?? (db.prepare('SELECT question FROM threads WHERE thread_id = ?').get(r.threadId) as any)?.question ?? '',
				ralph: ev.filter((e) => e.type === 'ralph_answer' && e.text).map((e) => String(e.text).slice(0, 1400)),
				team: ev.filter((e) => (e.type === 'team_reply' || e.type === 'team_mention') && e.text).map((e) => String(e.text).slice(0, 1400)),
			};
		}
	}
} finally { db.close(); }

// For a perturbed judge row, the "current" reality is the untouched reply it was built from.
const realReplyByThread = new Map<string, string>();
for (const r of rows) if (r.kind === 'judge' && !r._synthetic) realReplyByThread.set(r.threadId, r.reply);

const data = rows.map((r) => {
	if (r.kind === 'grader') {
		const p = propG[r.id] ?? {};
		return {
			...r,
			current: current[r.id],
			proposed: { outcome: p.outcome ?? '', cause: p.cause ?? '' },
			conf: p.conf ?? 'low',
			reason: p.reason ?? '',
			group: /GROUP: ([a-z-]+)/.exec(p.reason ?? '')?.[1] ?? null,
			evidence: evidence[r.id],
		};
	}
	const p = propJ[r.id] ?? {};
	return {
		...r,
		current: null,
		proposed: { verdict: p.verdict ?? '' },
		conf: p.conf ?? 'low',
		reason: p.reason ?? '',
		group: null,
		original: r._synthetic ? realReplyByThread.get(r.threadId) ?? null : null,
	};
});

const page = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bake-off label review</title>
<style>
  :root{--bg:#fff;--fg:#1a1a2e;--mut:#5b5b70;--line:#e6e6ef;--card:#fff;--soft:#f6f7fb;--accent:#5865F2;
        --ok:#1f9d55;--warn:#c77700;--bad:#c0392b}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15151c;--fg:#e8e8f0;--mut:#9a9aae;
    --line:#2a2a36;--card:#1c1c25;--soft:#20202b;--ok:#4ecb85;--warn:#e0a33a;--bad:#f0736a}}
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--fg);margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px}
  .wrap{max-width:1040px;margin:0 auto;padding:0 16px}
  h1{font-size:18px;margin:0 0 6px}
  .bar{height:6px;background:var(--soft);border-radius:4px;overflow:hidden;margin:8px 0}
  .bar i{display:block;height:100%;background:var(--accent);width:0%}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  button{font:inherit;padding:5px 11px;border:1px solid var(--line);background:var(--card);color:var(--fg);
    border-radius:7px;cursor:pointer}
  button:hover{border-color:var(--accent)}
  button.on{background:var(--accent);border-color:var(--accent);color:#fff}
  .card{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:16px;margin:14px 0}
  .card.done{opacity:.55}
  .card.changed{border-color:var(--warn)}
  .id{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mut)}
  .tag{display:inline-block;background:var(--soft);border-radius:20px;padding:1px 9px;font-size:11.5px;
    font-weight:600;margin-left:6px;text-transform:uppercase;letter-spacing:.03em}
  .tag.low{color:var(--bad)}.tag.med{color:var(--warn)}.tag.high{color:var(--ok)}
  .ev{background:var(--soft);border-radius:8px;padding:10px 12px;margin:8px 0;font-size:14px;white-space:pre-wrap;
    max-height:230px;overflow:auto}
  .ev b{display:block;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin-bottom:3px}
  .cmp{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
  @media(max-width:700px){.cmp{grid-template-columns:1fr}}
  .cmp>div{border:1px solid var(--line);border-radius:8px;padding:9px 11px}
  .cmp b{display:block;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
  .val{font-weight:600;font-size:15px;margin-top:2px}
  .why{font-size:13.5px;color:var(--mut);margin:6px 0 10px}
  select,input[type=text]{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:7px;
    background:var(--bg);color:var(--fg)}
  input[type=text]{width:100%;margin-top:8px}
  mark{background:#ffe08a;color:#000;border-radius:3px;padding:0 2px}
  .hint{font-size:12.5px;color:var(--mut)}
  footer{padding:30px 16px 60px}
</style></head><body>
<header><div class="wrap">
  <h1>Bake-off label review</h1>
  <div class="hint" id="count"></div>
  <div class="bar"><i id="prog"></i></div>
  <div class="row">
    <button data-f="all" class="on">All</button><button data-f="todo">Unreviewed</button>
    <button data-f="grader">Grader</button><button data-f="judge">Judge</button>
    <button data-f="lowconf">Low confidence</button><button data-f="broken">Broken cases</button>
    <button data-f="changed">I changed</button>
    <span style="flex:1"></span>
    <button id="acceptAll">Accept all remaining</button>
    <button id="export">Export labels.jsonl</button>
  </div>
  <div class="hint" style="margin-top:6px">Keys: <b>a</b> accept · <b>1/2/3</b> pass/partial/fail · <b>s</b> skip · <b>j/k</b> next/prev. Saved in this browser as you go.</div>
</div></header>
<div class="wrap" id="list"></div>
<footer class="wrap hint">Local file — nothing here is uploaded. Export when the counter reads complete.</footer>
<script>
const DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
const OUTCOMES = ${JSON.stringify(OUTCOMES)};
const CAUSES = ${JSON.stringify(CAUSES)};
const VERDICTS = ${JSON.stringify(VERDICTS)};
const SUCCESS = ['resolved_confirmed','resolved_unconfirmed','excluded'];
const KEY = 'bakeoff-review-v1';
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { state = {}; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} };
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// word-level diff so a one-token corruption is impossible to miss
function diff(orig, mod){
  if(!orig) return esc(mod);
  const a=orig.split(/(\\s+)/), b=mod.split(/(\\s+)/), out=[];
  let i=0,j=0;
  while(j<b.length){
    if(a[i]===b[j]){out.push(esc(b[j]));i++;j++;continue;}
    const at=a.indexOf(b[j],i);
    if(at>i&&at-i<6){i=at;continue;}
    out.push('<mark>'+esc(b[j])+'</mark>');
    if(i<a.length)i++;
    j++;
  }
  return out.join('');
}

function decided(d){
  const s = state[d.id];
  if(!s) return false;
  if(d.kind==='judge') return !!s.verdict;
  if(!s.outcome) return false;
  return SUCCESS.includes(s.outcome) || !!s.cause;
}
const proposalOf = d => d.kind==='judge' ? {verdict:d.proposed.verdict} : {outcome:d.proposed.outcome,cause:d.proposed.cause};
const changedFromProposal = d => { const s=state[d.id]; if(!s) return false;
  return JSON.stringify(s)!==JSON.stringify(proposalOf(d)); };

let filter='all';
function visible(){
  return DATA.filter(d=>{
    if(filter==='todo') return !decided(d);
    if(filter==='grader') return d.kind==='grader';
    if(filter==='judge') return d.kind==='judge';
    if(filter==='lowconf') return d.conf==='low';
    if(filter==='broken') return /BROKEN CASE/.test(d.reason);
    if(filter==='changed') return changedFromProposal(d);
    return true;
  });
}

function card(d){
  const s = state[d.id] || {};
  const done = decided(d);
  const ch = changedFromProposal(d) && done;
  let ev='';
  if(d.kind==='grader'){
    const e=d.evidence||{};
    ev = '<div class="ev"><b>Question</b>'+esc(e.question)+'</div>'
      + (e.ralph&&e.ralph.length?'<div class="ev"><b>Ralph</b>'+esc(e.ralph.join('\\n\\n— — —\\n\\n'))+'</div>':'')
      + (e.team&&e.team.length?'<div class="ev"><b>Team</b>'+esc(e.team.join('\\n\\n— — —\\n\\n'))+'</div>':'');
  } else {
    ev = '<div class="ev"><b>Question</b>'+esc(d.question)+'</div>'
      + '<div class="ev"><b>Golden answer</b>'+esc(d.golden_answer)+'</div>'
      + '<div class="ev"><b>Reply under test'+(d._perturbation?' — '+d._perturbation+' (changes highlighted)':'')+'</b>'
      + (d._perturbation?diff(d.original,d.reply):esc(d.reply))+'</div>';
  }
  const cur = d.kind==='grader'
    ? (d.current? esc(d.current.outcome)+(d.current.cause?' / '+esc(d.current.cause):'') : '—')
    : (d._synthetic? 'reply altered ('+d._perturbation+') — never judged' : 'never judged');
  const prop = d.kind==='grader'
    ? esc(d.proposed.outcome)+(d.proposed.cause?' / '+esc(d.proposed.cause):'')
    : esc(d.proposed.verdict);

  let controls;
  if(d.kind==='judge'){
    controls = VERDICTS.map(v=>'<button data-v="'+v+'" class="'+(s.verdict===v?'on':'')+'">'+v+'</button>').join('');
  } else {
    const oc = '<select data-k="outcome"><option value="">— outcome —</option>'+OUTCOMES.map(o=>
      '<option '+(s.outcome===o?'selected':'')+(d._outcome_forced&&o!==d.outcome?' disabled':'')+'>'+o+'</option>').join('')+'</select>';
    const cc = '<select data-k="cause"><option value="">— cause —</option>'+CAUSES.map(c=>
      '<option '+(s.cause===c?'selected':'')+'>'+c+'</option>').join('')+'</select>';
    controls = oc+' '+cc;
  }
  return '<div class="card'+(done?' done':'')+(ch?' changed':'')+'" id="c-'+esc(d.id)+'" data-id="'+esc(d.id)+'">'
    + '<div class="id">'+esc(d.id)+'<span class="tag '+d.conf+'">'+d.conf+' confidence</span>'
    + (d._outcome_forced?'<span class="tag">outcome fixed by rules.ts</span>':'')
    + (d._synthetic?'<span class="tag">synthetic</span>':'')+'</div>'
    + ev
    + '<div class="cmp"><div><b>Current answer</b><div class="val">'+cur+'</div></div>'
    + '<div><b>Proposed</b><div class="val">'+prop+'</div></div></div>'
    + '<div class="why">'+esc(d.reason)+'</div>'
    + '<div class="row"><button data-accept="1">✓ Accept proposal</button> '+controls+'</div>'
    + '<input type="text" data-k="notes" placeholder="notes (optional)" value="'+esc(s.notes||'')+'">'
    + '</div>';
}

function render(){
  document.getElementById('list').innerHTML = visible().map(card).join('');
  const n=DATA.length, d=DATA.filter(decided).length;
  document.getElementById('count').textContent =
    d+' of '+n+' decided · '+DATA.filter(x=>changedFromProposal(x)&&decided(x)).length+' changed from the proposal'
    + (d===n?' · complete — export now':'');
  document.getElementById('prog').style.width = (100*d/n)+'%';
}
function setState(id, patch){
  const d = DATA.find(x=>x.id===id);
  state[id] = Object.assign({}, proposalOf(d), state[id], patch);
  if(d.kind==='grader' && SUCCESS.includes(state[id].outcome)) state[id].cause='';
  save(); render();
}
document.addEventListener('click', e=>{
  const f = e.target.closest('[data-f]');
  if(f){ filter=f.dataset.f; document.querySelectorAll('[data-f]').forEach(b=>b.classList.toggle('on',b===f)); render(); return; }
  const card = e.target.closest('.card'); if(!card) return;
  const id = card.dataset.id;
  if(e.target.closest('[data-accept]')) return setState(id, proposalOf(DATA.find(x=>x.id===id)));
  const v = e.target.closest('[data-v]'); if(v) return setState(id, {verdict:v.dataset.v});
});
document.addEventListener('change', e=>{
  const card = e.target.closest('.card'); if(!card) return;
  const k = e.target.dataset.k; if(!k) return;
  setState(card.dataset.id, {[k]: e.target.value});
});
document.getElementById('acceptAll').onclick = ()=>{
  if(!confirm('Accept the proposal for every row you have not decided yet?')) return;
  for(const d of DATA) if(!decided(d)) state[d.id]=proposalOf(d);
  save(); render();
};
document.getElementById('export').onclick = ()=>{
  const out = DATA.map(d=>{
    const s = state[d.id] || {};
    const base = {kind:d.kind, id:d.id, threadId:d.threadId};
    const meta = d.kind==='grader'
      ? {_outcome_forced:d._outcome_forced, _reviewed:decided(d), _from_proposal:!changedFromProposal(d)}
      : {_synthetic:d._synthetic, _perturbation:d._perturbation, _reviewed:decided(d), _from_proposal:!changedFromProposal(d)};
    const vals = d.kind==='grader'
      ? {outcome:s.outcome||'', cause:s.cause||'', notes:s.notes||''}
      : {verdict:s.verdict||'', notes:s.notes||''};
    return JSON.stringify(Object.assign(base, vals, meta));
  }).join('\\n')+'\\n';
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([out],{type:'application/x-ndjson'}));
  a.download='labels.jsonl'; a.click();
};
let cursor=0;
document.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
  const vis=visible(); if(!vis.length) return;
  if(e.key==='j'||e.key==='k'){ cursor=Math.max(0,Math.min(vis.length-1,cursor+(e.key==='j'?1:-1)));
    document.getElementById('c-'+vis[cursor].id)?.scrollIntoView({block:'center'}); return; }
  const d=vis[cursor]; if(!d) return;
  if(e.key==='a') setState(d.id, proposalOf(d));
  if(d.kind==='judge'){ const m={'1':'pass','2':'partial','3':'fail','s':'skip'};
    if(m[e.key]) setState(d.id,{verdict:m[e.key]}); }
});
render();
</script></body></html>`;

writeFileSync(OUT, page);
const g = rows.filter((r) => r.kind === 'grader').length;
console.log(`wrote ${OUT}  (${rows.length} rows: ${g} grader, ${rows.length - g} judge)`);
console.log(`open it with:  open ${OUT}`);
