// eval/review.ts — Phase 4. Review cards + weekly summary in the private #ralph-eval channel.
// Team-gated buttons/selects/modals let a human confirm/correct the grader; approving a Q/A
// pair creates a golden case (Phase 5 seed).

import {
	Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
	ModalBuilder, TextInputBuilder, TextInputStyle, type Interaction, type TextChannel,
} from 'discord.js';
import { config } from './config';
import { wilson, roundInterval, isFailure, type Outcome } from './rules';
import type { Store } from './store';
import { ingestApproved } from './ingest';

const CAUSES = ['tool_error', 'engine_error', 'policy_public', 'policy_account', 'policy_other', 'product_defect', 'feature_request', 'content_gap', 'bad_answer', 'retrieval_miss', 'unknown'];
const FAILS = ['deferred', 'deferred_unanswered', 'overridden', 'dead_end', 'no_reply', 'rejected', 'reasked'];
// Plain-language names for the failure causes, shown on the card + in the dropdown so a reviewer
// never has to decode the enum. The stored value stays the enum (metrics depend on it).
const CAUSE_LABELS: Record<string, string> = {
	tool_error: 'Tool error (GitHub/HTTP fetch failed)',
	engine_error: 'Engine error (no reply / crash)',
	policy_public: 'Policy — public info, should have answered',
	policy_account: 'Policy — needs an account/human action',
	policy_other: 'Policy — other escalation',
	product_defect: 'Product bug',
	feature_request: 'Feature request (not built yet)',
	content_gap: 'Doc gap — answer not in the KB',
	bad_answer: 'Bad answer — had the info, still wrong',
	retrieval_miss: 'Retrieval miss — in KB but not surfaced',
	unknown: 'Unknown / needs a look',
};
const causeText = (c?: string | null) => (c ? CAUSE_LABELS[c] ?? c : null);
const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + '%' : '—');
const parse = (s: string | null) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

function isTeam(interaction: Interaction): boolean {
	const uid = interaction.user.id;
	if (config.teamUserIds.includes(uid)) return true;
	const roles: any = (interaction.member as any)?.roles;
	if (Array.isArray(roles)) return roles.includes(config.escalationRoleId);
	return !!roles?.cache?.has(config.escalationRoleId);
}

// ---------- weekly summary ----------
export function buildWeeklySummary(store: Store): EmbedBuilder {
	const now = Date.now();
	const win = store.getThreads().filter((t) => t.created_at >= now - config.windowDays * 86400_000);
	const graded = win.filter((t) => (t.status === 'graded' || t.status === 'reviewed') && t.outcome && t.outcome !== 'excluded');
	const oc: Record<string, number> = {}, cc: Record<string, number> = {}, clusterCount: Record<string, { n: number; fail: number }> = {};
	for (const t of graded) {
		oc[t.outcome] = (oc[t.outcome] ?? 0) + 1;
		if (t.cause) cc[t.cause] = (cc[t.cause] ?? 0) + 1;
		const label = t.cluster_label ?? (t.cluster_id ? `#${t.cluster_id}` : '—');
		const c = (clusterCount[label] ??= { n: 0, fail: 0 }); c.n++; if (isFailure(t.outcome as Outcome)) c.fail++;
	}
	const confirmed = graded.filter((t) => t.outcome === 'resolved_confirmed').length;
	const failures = graded.filter((t) => isFailure(t.outcome as Outcome)).length;
	const pending = graded.filter((t) => t.outcome === 'resolved_unconfirmed').length;
	const denom = confirmed + failures;
	const iv = roundInterval(wilson(confirmed, denom));
	const policyFloor = (cc.policy_account ?? 0) + (cc.policy_other ?? 0);
	// grader agreement: reviewed failures where the auto cause matched the confirmed cause
	const reviewed = graded.filter((t) => t.cause_source === 'review' && isFailure(t.outcome as Outcome));
	const agree = reviewed.filter((t) => parse(t.grader_json)._auto_cause === t.cause).length;
	const topClusters = Object.entries(clusterCount).sort((a, b) => b[1].n - a[1].n).slice(0, 5);

	const e = new EmbedBuilder()
		.setTitle(`Rocket Ralph — weekly eval (${config.windowDays}d)`)
		.setColor(denom && confirmed / denom >= config.target ? 0x57F287 : 0xFEE75C)
		.setDescription(
			`**Success rate: ${pct(confirmed, denom)}**  (${confirmed}/${denom})  ·  target ${(config.target * 100).toFixed(0)}%\n` +
			`95% Wilson: ${iv ? `[${(iv[0] * 100).toFixed(1)}%, ${(iv[1] * 100).toFixed(1)}%]` : 'n/a'}\n` +
			`⏳ **${pending} pending** (resolved_unconfirmed, left out until reviewed)`,
		)
		.addFields(
			{ name: 'Outcomes', value: Object.entries(oc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join('\n') || '—', inline: true },
			{ name: 'Failures by cause', value: Object.entries(cc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}${k === 'content_gap' ? ' 📄' : ''}`).join('\n') || '—', inline: true },
			{ name: 'Policy floor', value: `${policyFloor}/${denom} (${pct(policyFloor, denom)})`, inline: true },
			{ name: 'Top clusters (28d)', value: topClusters.map(([l, c]) => `${l} — ${c.n} (${pct(c.fail, c.n)} fail)`).join('\n') || '—' },
			{ name: 'Doc gaps (content_gap)', value: String(cc.content_gap ?? 0), inline: true },
			{ name: 'Grader agreement', value: reviewed.length ? `${pct(agree, reviewed.length)} (${agree}/${reviewed.length})` : 'n/a', inline: true },
		)
		.setTimestamp(new Date(now));
	return e;
}

export async function postWeeklySummary(client: Client, store: Store, log: (...a: unknown[]) => void): Promise<void> {
	const ch = (await client.channels.fetch(config.reviewChannelId)) as TextChannel;
	await ch.send({ embeds: [buildWeeklySummary(store)] });
	log('posted weekly summary');
}

// ---------- review cards ----------
function card(t: any, guildId: string): { embeds: EmbedBuilder[]; components: any[] } {
	const g = parse(t.grader_json);
	const link = `https://discord.com/channels/${guildId}/${t.thread_id}`;
	const ct = causeText(t.cause);
	const pending = t.outcome === 'resolved_unconfirmed';
	const success = t.outcome === 'resolved_confirmed';
	const excluded = t.outcome === 'excluded';

	// Title + one-line "what to do", worded for the current state so the reviewer knows the ask
	// before touching a button.
	const head = excluded
		? { color: 0x99AAB5, title: '🚫 Excluded from the metric', line: 'Not counted. Put it back below if that was wrong.' }
		: success
		? { color: 0x57F287, title: '✅ Counted as resolved (a win)', line: 'Ralph handled this one. Flip it below if that’s wrong.' }
		: pending
		? { color: 0x5865F2, title: '🔵 Needs a verdict — did Ralph resolve this?', line: 'Ralph answered, but nothing confirmed it worked. You decide.' }
		: { color: 0xED4245, title: `🔴 Counted as a miss${ct ? ` — ${ct}` : ''}`, line: 'Ralph didn’t resolve this. Confirm it, flip it, or teach him the fix.' };

	const embed = new EmbedBuilder()
		.setTitle(head.title)
		.setColor(head.color)
		.setDescription(`${head.line}\n\n**Q:** ${String(t.question).slice(0, 280)}\n[open the real thread](${link})`)
		.addFields(
			{ name: 'Cluster', value: t.cluster_label ?? '—', inline: true },
			{ name: 'q/a match', value: `${(t.q_top_score ?? 0).toFixed(2)} / ${t.a_top_score == null ? '—' : t.a_top_score.toFixed(2)}`, inline: true },
			{ name: 'Why (grader)', value: (g.summary ?? '—').slice(0, 300) },
		);
	if (t.reviewed_by) embed.setFooter({ text: `reviewed by ${t.reviewed_by}` });

	const btn = (id: string, label: string, emoji: string, style: ButtonStyle) =>
		new ButtonBuilder().setCustomId(`eval:${id}:${t.thread_id}`).setLabel(label).setEmoji(emoji).setStyle(style);

	// Verdict row — always: [agree/keep] [flip to the other verdict] [exclude/restore].
	const verdict = pending
		? [btn('resolve', 'Ralph resolved it', '✅', ButtonStyle.Success), btn('fail', 'Ralph missed it', '❌', ButtonStyle.Danger), btn('exclude', 'Not a real question', '🚫', ButtonStyle.Secondary)]
		: success
		? [btn('confirm', 'Yes, resolved', '👍', ButtonStyle.Success), btn('fail', 'Actually a miss', '❌', ButtonStyle.Danger), btn('exclude', 'Not a real question', '🚫', ButtonStyle.Secondary)]
		: excluded
		? [btn('resolve', 'Ralph resolved it', '✅', ButtonStyle.Success), btn('fail', 'Ralph missed it', '❌', ButtonStyle.Danger)]
		: [btn('confirm', 'Yes, a miss', '👍', ButtonStyle.Success), btn('resolve', 'Actually resolved', '✅', ButtonStyle.Primary), btn('exclude', 'Not a real question', '🚫', ButtonStyle.Secondary)];

	const issueUrl = `https://github.com/rocketride-org/rocketride-server/issues/new?title=${encodeURIComponent('[support] ' + String(t.question).slice(0, 80))}`.slice(0, 512);
	const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
		btn('qa', 'Teach Ralph the answer', '📚', ButtonStyle.Primary),
		new ButtonBuilder().setLabel('File a GitHub issue').setEmoji('🐛').setStyle(ButtonStyle.Link).setURL(issueUrl),
	);
	const causeSel = new StringSelectMenuBuilder().setCustomId(`eval:cause:${t.thread_id}`)
		.setPlaceholder(pending ? 'If it was a miss, set the reason…' : 'Change the reason it missed…')
		.addOptions(CAUSES.map((c) => ({ label: (CAUSE_LABELS[c] ?? c).slice(0, 100), value: c, default: c === t.cause })));

	const verdictRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...verdict);
	const causeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(causeSel);
	return { embeds: [embed], components: [verdictRow, actions, causeRow] };
}

export async function enqueueReviewCards(client: Client, store: Store, log: (...a: unknown[]) => void): Promise<void> {
	const ch = (await client.channels.fetch(config.reviewChannelId)) as TextChannel;
	const queue = store.getReviewQueue();
	log(`review queue: ${queue.length}`);
	for (const t of queue) {
		const msg = await ch.send(card(t, ch.guildId));
		store.setReviewMessageId(t.thread_id, msg.id);
	}
}

// ---------- interactions ----------
export async function handleInteraction(interaction: Interaction, store: Store): Promise<void> {
	if (!('customId' in interaction) || !(interaction as any).customId?.startsWith('eval:')) return;
	if (!isTeam(interaction)) { if (interaction.isRepliable()) await interaction.reply({ content: 'Team only.', ephemeral: true }); return; }
	const [, action, threadId] = (interaction as any).customId.split(':');
	const by = interaction.user.username;

	// 'qa' opens a modal — a modal MUST be the first response, so never defer before it.
	if (interaction.isButton() && action === 'qa') {
		const draft = store.getLatestQaDraft(threadId) ?? {};
		const modal = new ModalBuilder().setCustomId(`eval:qasave:${threadId}`).setTitle('Teach Ralph the answer')
			.addComponents(
				new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('q').setLabel('Question (what users ask)').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setValue((draft.question ?? '').slice(0, 4000))),
				new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('a').setLabel('Answer — Ralph reuses this on similar Qs').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setValue((draft.answer ?? '').slice(0, 4000))),
			);
		await interaction.showModal(modal); return;
	}

	// Modal submit → approve the Q/A + seed a golden case (and it becomes ingestable into the KB).
	if (interaction.isModalSubmit() && action === 'qasave') {
		const q = interaction.fields.getTextInputValue('q'); const a = interaction.fields.getTextInputValue('a');
		const draft = store.getLatestQaDraft(threadId);
		if (draft) store.approveQa(draft.id, by, q, a);
		const t = store.getThreadFull(threadId);
		const expected = (t?.cause === 'policy_account' || t?.cause === 'policy_other') ? 'escalate' : 'answer';
		store.createGoldenCase({ question: q, expected, golden_answer: expected === 'answer' ? a : null, source: 'review', thread_id: threadId });
		await interaction.reply({ content: `Q/A approved (golden: ${expected}). Adding to Ralph's KB…`, ephemeral: true });
		// Push the approved answer straight into Ralph's KB (ROCKETRIDE_DOCS) from Discord — no CLI step.
		try {
			const n = draft ? await ingestApproved(store, { log: console.log }) : 0;
			await interaction.editReply(
				draft
					? `✅ Q/A approved (golden: ${expected}) and **added to Ralph's KB**${n > 1 ? ` (+${n - 1} other pending)` : ''}. He'll use it on the next matching question.`
					: `Q/A approved (golden: ${expected}). No grader draft on this thread, so it seeded a regression case but wasn't auto-ingested — run \`tsx eval/main.ts --ingest-approved\` if you want it in the KB.`,
			);
		} catch (e) {
			await interaction.editReply(`Q/A approved (golden: ${expected}), but the KB write failed: ${e instanceof Error ? e.message : e}. Retry with \`tsx eval/main.ts --ingest-approved\`.`);
		}
		return;
	}

	// Buttons/selects that mutate + refresh the card: ACK INSTANTLY (deferUpdate) so Discord never
	// shows "didn't respond in time", apply the change, refresh the card, then tell the reviewer
	// (ephemerally, just to them) exactly what that click did.
	if (interaction.isButton() || interaction.isStringSelectMenu()) {
		await interaction.deferUpdate().catch(() => {});
		try {
			let note = '';
			if (interaction.isStringSelectMenu() && action === 'cause') {
				const c = interaction.values[0];
				store.applyReview(threadId, { cause: c }, by);
				note = `Reason set to **${CAUSE_LABELS[c] ?? c}**.`;
			} else if (action === 'confirm') {
				store.applyReview(threadId, {}, by);
				const cur = store.getThreadFull(threadId);
				note = isFailure(cur?.outcome as Outcome)
					? `👍 Confirmed as a miss${causeText(cur?.cause) ? ` (${causeText(cur?.cause)})` : ''} — counts against Ralph’s success rate.`
					: '👍 Kept as resolved — counts as a success.';
			} else if (action === 'resolve') {
				store.applyReview(threadId, { outcome: 'resolved_confirmed' }, by);
				note = '✅ Marked **resolved** — now counts as a success.';
			} else if (action === 'fail') {
				store.applyReview(threadId, { outcome: 'rejected' }, by);
				note = '❌ Marked as a **miss** — now counts against Ralph’s success rate.';
			} else if (action === 'exclude') {
				store.applyReview(threadId, { excluded_reason: 'manual' }, by);
				note = '🚫 **Excluded** — dropped from the metric (not a real question).';
			}
			const t = store.getThreadFull(threadId);
			await interaction.editReply(card(t, interaction.guildId ?? ''));
			if (note) await interaction.followUp({ content: note, ephemeral: true }).catch(() => {});
		} catch (e) { /* already acked via deferUpdate; card just won't refresh */ }
	}
}
