// eval/bakeoff/make-review-doc.ts — renders the review as a document (markdown) for Google Docs.
//
//   tsx eval/bakeoff/make-review-doc.ts   → eval/bakeoff/review-doc.md
//
// Same data as review.html, ordered by how much judgement each row needs, so the reader only has
// to read closely where a decision actually hangs on it. The rule for the reader is "mark only
// what you would change" — silence means the proposal stands.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { bench } from '../bench/config';

const rows = readFileSync('eval/bakeoff/labels.jsonl', 'utf8').split('\n').map((l) => l.trim())
	.filter((l) => l && !l.startsWith('#')).map((l) => JSON.parse(l));
const propG = JSON.parse(readFileSync('eval/bakeoff/proposals-grader.json', 'utf8'));
const propJ = JSON.parse(readFileSync('eval/bakeoff/proposals-judge.json', 'utf8'));

const db = new DatabaseSync(bench.dbPath, { readOnly: true });
const cur: Record<string, string> = {};
const q: Record<string, string> = {};
try {
	for (const r of rows.filter((x) => x.kind === 'grader')) {
		const t = db.prepare('SELECT outcome, cause, question FROM threads WHERE thread_id = ?').get(r.threadId) as any;
		cur[r.id] = `${t?.outcome ?? '—'}${t?.cause ? ' / ' + t.cause : ''}`;
		const ev = db.prepare("SELECT text FROM events WHERE thread_id = ? AND type = 'question' AND text != '' LIMIT 1").get(r.threadId) as any;
		q[r.id] = String(ev?.text ?? t?.question ?? '').replace(/\s+/g, ' ').trim();
	}
} finally { db.close(); }

// Google Docs' markdown importer mangles emoji outside the BMP and renders **bold** inside table
// cells as literal asterisks. Strip the first, avoid the second.
const deEmoji = (s: string) => s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu, '').replace(/ {2,}/g, ' ');
const one = (s: string, n = 150) => { const t = deEmoji(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const pro = (r: any) => r.kind === 'grader'
	? `${propG[r.id].outcome}${propG[r.id].cause ? ' / ' + propG[r.id].cause : ''}`
	: propJ[r.id].verdict;
// Short, unambiguous, writable-by-hand codes (G01…, J01…). The doc is reviewed by a human who has
// to type these into the Overrides block, so a truncated snowflake id is not good enough.
const code = new Map<string, string>();
{
	let g = 0, j = 0;
	for (const r of rows) code.set(r.id, r.kind === 'grader' ? `G${String(++g).padStart(2, '0')}` : `J${String(++j).padStart(2, '0')}`);
}
const short = (id: string) => {
	const r = rows.find((x) => x.id === id)!;
	return `${code.get(id)} · …${r.threadId.slice(-6)}${r._perturbation ? ' ' + r._perturbation : ''}`;
};

const grader = rows.filter((r) => r.kind === 'grader');
const judge = rows.filter((r) => r.kind === 'judge');
const disagree = grader.filter((r) => pro(r) !== cur[r.id]);
const agree = grader.filter((r) => pro(r) === cur[r.id]);
const byVerdict = (v: string) => judge.filter((r) => propJ[r.id].verdict === v);

const L: string[] = [];
L.push('# Rocket Ralph bake-off — ground truth for review', '');
L.push(`Prepared ${new Date().toISOString().slice(0, 10)} · 142 rows · 60 grader + 82 judge`, '');

L.push('## How to use this', '');
L.push('**Mark only what you would change.** Anything you do not comment on, I take as approved. Comment inline, or write the row id and your label in the Overrides section at the end — whichever is quicker.', '');
L.push('Sections are ordered by how much judgement each row needs. Sections 1–3 are where decisions actually hang; 4–6 are there so you can spot-check, not read line by line.', '');
L.push('Two things worth knowing before you start:', '');
L.push('- **The proposals are mine, and they anchor you.** They come from a model in neither arm (not Sonnet 5, not Jev), so neither side gets a home-field advantage — but a gold set built by approving proposals is not fully independent. The final report will split every agreement number across rows you approved and rows you changed, so you can see whether the anchor moved the result.');
L.push('- **The "current answer" column is production\'s GPT-5.4 grader**, not truth. It is there for contrast, not authority.', '');

L.push('## 0. Two decisions that apply to groups', '');
L.push('These two patterns recur. Decide once and I will apply it to every row in the group.', '');
L.push('| Group | Rows | Proposed | If you disagree |', '|---|---|---|---|');
L.push('| Bare greetings (hi, hii, Hello everyone, Yes) | 8 | excluded — no question was asked | They become resolved_unconfirmed and Ralph\'s success rate rises |');
L.push('| PR announcements ("PR 2062 needs approval") | 6 | excluded — no support question to resolve | Same: resolved_unconfirmed, success rate rises |', '');

L.push(`## 1. Grader — ${disagree.length} rows where I disagree with production`, '');
L.push('**This is the section that matters.** Each row: what production stored, what I propose, and why.', '');
for (const r of disagree) {
	const p = propG[r.id];
	L.push(`### ${short(r.id)} · ${p.conf} confidence`);
	L.push(`*"${one(q[r.id], 180)}"*`, '');
	L.push(`Current: ${cur[r.id]}  →  **Proposed: ${pro(r)}**`, '');
	L.push(p.reason.replace(/^DISAGREES[^.]*\.\s*/, '').replace(/GROUP: [a-z-]+.*/, '').trim(), '');
}

L.push(`## 2. Judge — ${byVerdict('pass').length + byVerdict('partial').length} rows I propose to accept as pass or partial`, '');
L.push('A wrong `pass` in the gold set is the most expensive mistake here — it makes a lenient judge look correct. These deserve a close read even though there are few of them.', '');
for (const r of [...byVerdict('pass'), ...byVerdict('partial')]) {
	const p = propJ[r.id];
	L.push(`### ${short(r.id)}${r._perturbation ? ` · ${r._perturbation}` : ''} → **${p.verdict}** (${p.conf} confidence)`);
	L.push(`**Q** ${one(r.question, 200)}`, '');
	L.push(`**Golden** ${one(r.golden_answer, 320)}`, '');
	L.push(`**Reply** ${one(r.reply, 320)}`, '');
	L.push(`*${p.reason}*`, '');
}

L.push(`## 3. Judge — ${byVerdict('skip').length} broken cases`, '');
L.push('On these the drafted golden answers a **different question** than the thread opener — the grader built the Q/A from a later turn. There is nothing to judge, so they drop out of every metric.', '');
L.push('This is a finding in its own right: about a fifth of the drafted Q/As do not match their thread, which means the golden set Phase 5 replay would be seeded from needs a review gate before you trust it — regardless of which arm wins.', '');
L.push('| Row | Question asked | Golden answers instead |', '|---|---|---|');
for (const r of byVerdict('skip')) L.push(`| ${short(r.id)} | ${one(r.question, 70)} | ${one(r.golden_answer, 90)} |`);
L.push('');

L.push(`## 4. Judge — ${byVerdict('fail').length} rows proposed as fail`, '');
L.push('These are the false-pass base. Most are unambiguous; three are deliberately not.', '');
L.push('**Worth a look:**', '');
for (const id of ['j-1538410780670820352-corrupt', 'j-1547034035082231879-corrupt', 'j-1537381181862055997-truncate']) {
	const r = judge.find((x) => x.id === id); if (!r) continue;
	L.push(`- **${short(id)}** — ${propJ[id].reason}`);
}
L.push('');
L.push('The rest are unambiguous. Codes, grouped by how the reply was broken — skim for anything that looks wrong to you:', '');
for (const kind of ['real', 'swap', 'truncate', 'corrupt']) {
	const list = byVerdict('fail').filter((r) => (r._perturbation ?? 'real') === kind);
	if (list.length) L.push(`- **${kind}** (${list.length}): ${list.map((r) => code.get(r.id)).join(', ')}`);
}
L.push('');
L.push(`## 5. Grader — ${agree.length} rows where I agree with production`, '');
L.push('My proposal matches what production stored, so these are spot-check only. Full evidence for any row is in `review.html`.', '');
const byLabel = new Map<string, string[]>();
for (const r of agree) { const k = pro(r); (byLabel.get(k) ?? byLabel.set(k, []).get(k)!).push(code.get(r.id)!); }
for (const [label, codes] of [...byLabel].sort((a, b) => b[1].length - a[1].length))
	L.push(`- **${label}** — ${codes.join(', ')}`);
L.push('');
L.push('## 6. What this set will and will not prove', '');
L.push('The headline metric is **false-pass rate** — how often a judge waves through a reply you called fail. Its precision depends on how many rows end up labelled fail, currently proposed at 47.', '');
L.push('| Comparison | Fail rows needed | Covered? |', '|---|---|---|');
L.push('| 5% vs 40% false-pass | 23 | yes |');
L.push('| 5% vs 25% | 51 | marginal |');
L.push('| 5% vs 20% | 77 | no |');
L.push('| 5% vs 15% | 142 | no |');
L.push('| 5% vs 10% | 436 | no |', '');
L.push('So this set can show **"Arm C is clearly worse"** or **"Arm C is not clearly worse"**. It cannot resolve a 5-point gap. With zero observed false passes the true rate could still be as high as 3 ÷ n — at 47 fails, "we saw none" means "under 6.4%", not "zero".', '');
L.push('The binding constraint is the store, not the design: only 42 of 184 gradable threads have a usable question, a Ralph reply and a golden that actually answers the question.', '');

L.push('## Overrides', '');
L.push('Anything not listed here stands as proposed. One per line — row id, then your label, then a note if you want one.', '');
L.push('```', 'code   label                    note', 'G12    overridden / bad_answer  (example — delete this line)', 'J07    pass                     (example — delete this line)', '', '', '', '```', '');
L.push('**Group decisions** (section 0): greetings → ______   ·   PR announcements → ______', '');

L.push('---', '', '*Codes map to thread ids in `eval/bakeoff/code-map.json`. Row evidence in full: `eval/bakeoff/review.html`.*', '');
writeFileSync('eval/bakeoff/code-map.json', JSON.stringify(Object.fromEntries([...code].map(([id, c]) => [c, id])), null, 1));
writeFileSync('eval/bakeoff/review-doc.md', L.join('\n'));
console.log(`wrote eval/bakeoff/review-doc.md — ${L.join('\n').length} chars`);
console.log(`  §1 grader disagreements: ${disagree.length}`);
console.log(`  §2 pass/partial: ${byVerdict('pass').length + byVerdict('partial').length}`);
console.log(`  §3 broken: ${byVerdict('skip').length}   §4 fail: ${byVerdict('fail').length}   §5 agreements: ${agree.length}`);
