// eval/bakeoff/make-labels.ts — builds the hand-labelling skeleton for the Arm A / Arm C bake-off,
// and validates it once it comes back filled in.
//
//   tsx eval/bakeoff/make-labels.ts --generate [--grader 80] [--judge 60] [--wrong 20]
//   tsx eval/bakeoff/make-labels.ts --validate
//
// Writes two files that are read together:
//   labels.jsonl        compact, one row per decision, the fields YOU fill
//   labels-context.md   the evidence for each row, in the same order
//
// Design decisions that matter for the measurement:
//  · Nothing is pre-filled with a model's guess. Seeding the file with GPT-5.4's or Sonnet's
//    labels would anchor the labeller and inflate agreement for whichever model resembles them.
//    The ONE exception is `outcome` on threads where eval/rules.ts fixes it from events alone —
//    that is arithmetic, not a guess, so it is filled and marked `_outcome_forced`.
//  · The 20 wrong replies are built by deterministic perturbation, and the perturbation is a
//    HYPOTHESIS, not a label: a truncated reply can still legitimately pass. You set the verdict.
//  · Selection is deterministic (hashed thread id), so regenerating gives the same rows.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { bench } from '../bench/config';
import { loadGraderCases } from '../bench/tasks';
import { decideOutcome } from '../rules';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const numArg = (f: string, d: number) => { const i = args.indexOf(f); const v = Number(args[i + 1]); return i >= 0 && Number.isFinite(v) ? v : d; };

const OUT_JSONL = 'eval/bakeoff/labels.jsonl';
const OUT_CONTEXT = 'eval/bakeoff/labels-context.md';

export { OUTCOMES, CAUSES, VERDICTS } from './enums';
import { OUTCOMES, CAUSES, VERDICTS, NON_FAILURE } from './enums';

const fnv1a = (s: string): number => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
	return h >>> 0;
};
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ' …' : s);

interface Texts {
	question: string; ralph: string[]; team: string[]; escalated: boolean;
	/** The grader's drafted standalone Q/A for this thread — what production actually feeds the judge. */
	draftQ: string; draftA: string;
}

/** Second read-only pass for the message text the grader cases don't carry. */
function loadTexts(threadIds: Set<string>): Map<string, Texts> {
	const db = new DatabaseSync(bench.dbPath, { readOnly: true });
	const out = new Map<string, Texts>();
	try {
		for (const id of threadIds) {
			const rows = db.prepare('SELECT type, text FROM events WHERE thread_id = ? ORDER BY ts').all(id) as any[];
			// The opener can be missing or empty on the event (backfilled threads, image-only posts),
			// so fall through: question event → threads.question → first user message. `??` is wrong
			// here — an empty-string event text is present but useless.
			const onThread = (db.prepare('SELECT question FROM threads WHERE thread_id = ?').get(id) as any)?.question;
			const firstUser = rows.find((r) => r.type === 'user_message' && String(r.text ?? '').trim())?.text;
			const qa0 = db.prepare('SELECT question FROM qa_pairs WHERE thread_id = ? ORDER BY id DESC LIMIT 1').get(id) as any;
			// Last resort: the grader's restated question. 9 threads have a usable golden but an
			// opener that is a bare filename or emoji — recoverable rather than droppable.
			const opener = [rows.find((r) => r.type === 'question')?.text, onThread, firstUser, qa0?.question]
				.map((x) => String(x ?? '').trim()).find((x) => x.length >= 15) ?? '';
			// replay.ts judges against golden_cases.golden_answer, which is seeded from an approved
			// qa_pairs draft — a cleaned, standalone answer. Raw team messages are mostly routing
			// chatter ("can you check this?"), which cannot serve as a golden.
			const qa = db.prepare('SELECT question, answer FROM qa_pairs WHERE thread_id = ? ORDER BY id DESC LIMIT 1').get(id) as any;
			out.set(id, {
				draftQ: String(qa?.question ?? '').trim(),
				draftA: String(qa?.answer ?? '').trim(),
				question: opener,
				ralph: rows.filter((r) => r.type === 'ralph_answer' && r.text).map((r) => String(r.text)),
				team: rows.filter((r) => (r.type === 'team_reply' || r.type === 'team_mention') && r.text).map((r) => String(r.text)),
				escalated: rows.some((r) => r.type === 'escalation'),
			});
		}
	} finally { db.close(); }
	return out;
}

// --- deterministic perturbations -------------------------------------------------------------
/** Another thread's answer: fluent, on-brand, wrong topic. Catches a judge that rewards style. */
const swap = (pool: string[], i: number) => pool[(i + 37) % pool.length];
/** First sentence only: correct as far as it goes, missing the key point. Catches a lenient judge. */
function truncate(reply: string): string | null {
	const parts = reply.split(/(?<=[.!?])\s+/).filter(Boolean);
	return parts.length >= 3 ? parts[0] : null;
}
/** Right shape, wrong specifics — the failure mode that actually ships bugs. */
function corrupt(reply: string): string | null {
	const num = reply.match(/\b\d{2,}\b/);
	if (num) return reply.replace(num[0], String(Number(num[0]) + 7));
	const tick = reply.match(/`([A-Za-z_][\w.-]{3,})`/);
	if (tick) return reply.replace(tick[0], '`' + tick[1].split('').reverse().join('') + '`');
	return null;
}

function generate() {
	const nGrader = numArg('--grader', 60);
	const nJudge = numArg('--judge', 50);
	const nWrong = numArg('--wrong', 40);
	if (nWrong < 20) throw new Error('--wrong must be at least 20: a smaller set cannot measure a false-pass rate');

	const cases = loadGraderCases({});
	const texts = loadTexts(new Set(cases.map((c) => c.threadId)));
	const byHash = [...cases].sort((a, b) => fnv1a(a.threadId) - fnv1a(b.threadId));

	// --- grader rows: stratified over the outcome space, flagged where events already decide it
	const forced = new Map<string, string | null>();
	for (const c of cases) {
		const outs = new Set<string>();
		for (const t of ['none', 'ack', 'correction', 'addition'] as const)
			for (const u of ['confirmed', 'rejected', 'neutral'] as const)
				outs.add(decideOutcome(c.thread, c.events, { team_reply_kind: t, user_signal: u }, { testAllowBotIds: [], testChannelIds: [] }).outcome);
		forced.set(c.threadId, outs.size === 1 ? [...outs][0] : null);
	}
	// Bias the sample toward threads the LLM actually decides — but keep some forced ones so the
	// headline kappa stays comparable to what production sees.
	const decided = byHash.filter((c) => !forced.get(c.threadId));
	const fixed = byHash.filter((c) => forced.get(c.threadId));
	const wantFixed = Math.min(fixed.length, Math.round(nGrader * 0.2));
	const graderPick = [...decided.slice(0, nGrader - wantFixed), ...fixed.slice(0, wantFixed)]
		.sort((a, b) => fnv1a(a.threadId) - fnv1a(b.threadId));

	// --- judge rows: only threads with a team answer to serve as the golden.
	// The store caps this hard — see LABELS.md. Each eligible thread gives one REAL row; the wrong
	// replies are ADDITIONAL rows built from the same threads, because the false-pass rate's
	// precision depends on how many true-fail cases exist, not on how many threads do.
	const judgeEligible = byHash.filter((c) => {
		const t = texts.get(c.threadId)!;
		// A judge case needs three things: a question, a reply to judge, and a golden that actually
		// contains an answer. The last one is the binding constraint — see LABELS.md.
		return t.question.trim().length >= 15 && t.draftA.length >= 120 && t.ralph.some((x) => x.trim().length > 30);
	});
	if (judgeEligible.length < nJudge) console.warn(`! only ${judgeEligible.length} threads have both a team answer and a Ralph reply — capping --judge at that`);
	const judgePick = judgeEligible.slice(0, Math.min(nJudge, judgeEligible.length));
	const replyPool = judgePick.map((c) => texts.get(c.threadId)!.ralph.join('\n\n').trim());

	const rows: any[] = [];
	const ctx: string[] = [
		'# Bake-off labelling context',
		'',
		'One section per row in `labels.jsonl`, same order. Read the section, fill the blank fields in the',
		'matching jsonl line. Enum values and definitions are in `LABELS.md`.',
		'',
	];

	for (const c of graderPick) {
		const t = texts.get(c.threadId)!;
		const f = forced.get(c.threadId);
		const id = `g-${c.threadId}`;
		rows.push({
			kind: 'grader', id, threadId: c.threadId,
			outcome: f ?? '', cause: '', notes: '',
			_outcome_forced: !!f, _escalated: t.escalated, _team_replied: t.team.length > 0,
		});
		ctx.push(`## ${id}`, '');
		if (f) ctx.push(`> \`outcome\` is already filled: eval/rules.ts fixes it to **${f}** from the thread's events, whatever an LLM says. Only \`cause\` needs you.`, '');
		ctx.push('**Question**', '', clip(t.question, 1200), '');
		if (t.ralph.length) ctx.push('**Ralph**', '', t.ralph.map((x) => clip(x, 700)).join('\n\n---\n\n'), '');
		if (t.team.length) ctx.push('**Team**', '', t.team.map((x) => clip(x, 700)).join('\n\n---\n\n'), '');
		ctx.push(`*escalated: ${t.escalated ? 'yes' : 'no'} · team replied: ${t.team.length ? 'yes' : 'no'}*`, '');
	}

	const judgeRow = (c: (typeof judgePick)[number], reply: string, perturbation: string | null) => {
		const t = texts.get(c.threadId)!;
		const golden = t.draftA;
		const id = `j-${c.threadId}${perturbation ? '-' + perturbation : ''}`;
		rows.push({
			kind: 'judge', id, threadId: c.threadId,
			verdict: '', notes: '',
			_synthetic: !!perturbation, _perturbation: perturbation,
			question: clip(t.question, 1500), golden_answer: clip(golden, 2500), reply: clip(reply, 2500),
		});
		ctx.push(`## ${id}`, '');
		if (perturbation) ctx.push(`> **Synthetic reply** (\`${perturbation}\`) — altered on purpose. Judge it on its merits anyway: if it still answers the question, label it \`pass\`.`, '');
		ctx.push('**Question (what Ralph was answering)**', '', clip(t.question, 1200), '');
		if (t.draftQ) ctx.push(`*restated by the grader as: ${clip(t.draftQ, 300)}*`, '');
		ctx.push('**Golden answer** *(drafted from the team\'s messages — what production feeds the judge)*', '', clip(golden, 1500), '', '**Reply under test**', '', clip(reply, 1500), '');
	};

	// one real row per eligible thread
	judgePick.forEach((c) => judgeRow(c, texts.get(c.threadId)!.ralph.join('\n\n').trim(), null));

	// then the wrong replies, cycling the three perturbation kinds across threads in hash order
	const KINDS = ['swap', 'truncate', 'corrupt'] as const;
	let wrongMade = 0;
	for (let pass = 0; pass < KINDS.length && wrongMade < nWrong; pass++) {
		for (let i = 0; i < judgePick.length && wrongMade < nWrong; i++) {
			const c = judgePick[i];
			const real = texts.get(c.threadId)!.ralph.join('\n\n').trim();
			const kind = KINDS[(i + pass) % KINDS.length];
			const made = kind === 'swap' ? swap(replyPool, i) : kind === 'truncate' ? truncate(real) : corrupt(real);
			if (!made || made === real) continue;
			if (rows.some((r) => r.id === `j-${c.threadId}-${kind}`)) continue;
			judgeRow(c, made, kind);
			wrongMade++;
		}
	}

	const header = [
		'# labels.jsonl — fill the empty fields. Lines starting with # are ignored.',
		'# grader rows: outcome + cause   ·   judge rows: verdict   ·   notes is optional, always welcome',
		'# Enums + definitions: eval/bakeoff/LABELS.md   ·   Evidence: eval/bakeoff/labels-context.md',
		'# Validate with: tsx eval/bakeoff/make-labels.ts --validate',
	];
	writeFileSync(OUT_JSONL, header.concat(rows.map((r) => JSON.stringify(r))).join('\n') + '\n');
	writeFileSync(OUT_CONTEXT, ctx.join('\n'));

	const g = rows.filter((r) => r.kind === 'grader');
	console.log(`wrote ${rows.length} rows → ${OUT_JSONL}`);
	console.log(`  grader: ${g.length}  (${g.filter((r) => r._outcome_forced).length} with outcome pre-filled from events — cause only)`);
	console.log(`  judge:  ${rows.length - g.length}  (${wrongMade} synthetic wrong replies: ${['swap', 'truncate', 'corrupt'].map((k) => `${k}=${rows.filter((r) => r._perturbation === k).length}`).join(', ')})`);
	console.log(`  evidence → ${OUT_CONTEXT}`);
	if (wrongMade < nWrong) console.warn(`! only ${wrongMade}/${nWrong} wrong replies could be built — false-pass rate will rest on a smaller base`);
}

function validate() {
	if (!existsSync(OUT_JSONL)) throw new Error(`${OUT_JSONL} not found — run --generate first`);
	const lines = readFileSync(OUT_JSONL, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
	const problems: string[] = [];
	let grader = 0, judge = 0, gDone = 0, jDone = 0, wrong = 0, wrongDone = 0;
	const ids = new Set<string>();

	lines.forEach((line, i) => {
		let r: any;
		try { r = JSON.parse(line); } catch { problems.push(`line ${i + 1}: not valid JSON`); return; }
		if (ids.has(r.id)) problems.push(`${r.id}: duplicate id`);
		ids.add(r.id);
		if (r.kind === 'grader') {
			grader++;
			const oOk = !r.outcome || (OUTCOMES as readonly string[]).includes(r.outcome);
			const cOk = !r.cause || (CAUSES as readonly string[]).includes(r.cause);
			if (!oOk) problems.push(`${r.id}: outcome '${r.outcome}' is not a valid outcome`);
			if (!cOk) problems.push(`${r.id}: cause '${r.cause}' is not a valid cause`);
			const isFailure = !(NON_FAILURE as readonly string[]).includes(r.outcome);
			if (r.outcome && r.cause && !isFailure)
				problems.push(`${r.id}: outcome '${r.outcome}' is not a failure, so cause must be empty`);
			// A failure with no cause yet is simply unfinished — counted below, not reported as invalid.
			if (oOk && cOk && r.outcome && (!isFailure || r.cause)) gDone++;
		} else if (r.kind === 'judge') {
			judge++;
			if (r._synthetic) wrong++;
			if (r.verdict && !(VERDICTS as readonly string[]).includes(r.verdict)) problems.push(`${r.id}: verdict '${r.verdict}' must be one of ${VERDICTS.join('/')}`);
			else if (r.verdict) { jDone++; if (r._synthetic) wrongDone++; }
		} else problems.push(`${r.id ?? `line ${i + 1}`}: unknown kind '${r.kind}'`);
	});

	const needCause = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
		.filter((r) => r?.kind === 'grader' && r.outcome && !r.cause && !(NON_FAILURE as readonly string[]).includes(r.outcome)).length;
	console.log(`grader rows: ${gDone}/${grader} labelled${needCause ? `  (${needCause} have an outcome but still need a cause)` : ''}`);
	console.log(`judge rows:  ${jDone}/${judge} labelled  (${wrongDone}/${wrong} of the synthetic ones)`);
	const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
	const failLabels = parsed.filter((r) => r?.kind === 'judge' && r.verdict === 'fail').length;
	const skipped = parsed.filter((r) => r?.kind === 'judge' && r.verdict === 'skip').length;
	if (skipped) console.log(`judge rows marked 'skip' (broken case, excluded from every metric): ${skipped}`);
	console.log(`judge rows labelled 'fail': ${failLabels} — this is the base for the false-pass rate`);
	if (failLabels < 20 && jDone === judge) console.warn(`! fewer than 20 'fail' labels: a false-pass rate on this base has a wide interval`);
	if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of problems.slice(0, 40)) console.log(`  · ${p}`); process.exit(1); }
	console.log(problems.length ? '' : '\nno problems found');
	if (gDone === grader && jDone === judge) console.log('labels complete — ready to run the bake-off');
}

if (has('--generate')) generate();
else if (has('--validate')) validate();
else console.log(`usage: tsx eval/bakeoff/make-labels.ts --generate [--grader 80] [--judge 60] [--wrong 20]
                                          --validate`);
