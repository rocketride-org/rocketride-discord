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
	const qa = ''; // draft shown via the modal; keep the card compact
	const link = `https://discord.com/channels/${guildId}/${t.thread_id}`;
	const embed = new EmbedBuilder()
		.setTitle(`Review — ${t.outcome}${t.cause ? ` / ${t.cause}` : ''}`)
		.setColor(t.outcome === 'resolved_unconfirmed' ? 0x5865F2 : 0xED4245)
		.setDescription(`${String(t.question).slice(0, 300)}\n\n[open thread](${link})`)
		.addFields(
			{ name: 'Cluster', value: t.cluster_label ?? '—', inline: true },
			{ name: 'q/a score', value: `${(t.q_top_score ?? 0).toFixed(2)} / ${t.a_top_score == null ? '—' : t.a_top_score.toFixed(2)}`, inline: true },
			{ name: 'Grader summary', value: (g.summary ?? '—').slice(0, 300) },
		);
	if (t.reviewed_by) embed.setFooter({ text: `reviewed by ${t.reviewed_by}` });

	const causeSel = new StringSelectMenuBuilder().setCustomId(`eval:cause:${t.thread_id}`).setPlaceholder('cause…')
		.addOptions(CAUSES.map((c) => ({ label: c, value: c, default: c === t.cause })));
	const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`eval:confirm:${t.thread_id}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
		...(t.outcome === 'resolved_unconfirmed' ? [
			new ButtonBuilder().setCustomId(`eval:resolve:${t.thread_id}`).setLabel('Mark resolved').setStyle(ButtonStyle.Primary),
			new ButtonBuilder().setCustomId(`eval:fail:${t.thread_id}`).setLabel('Mark failed').setStyle(ButtonStyle.Danger),
		] : []),
		new ButtonBuilder().setCustomId(`eval:exclude:${t.thread_id}`).setLabel('Exclude').setStyle(ButtonStyle.Secondary),
	);
	const issueUrl = `https://github.com/rocketride-org/rocketride-server/issues/new?title=${encodeURIComponent('[support] ' + String(t.question).slice(0, 80))}`.slice(0, 512);
	const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`eval:qa:${t.thread_id}`).setLabel('Edit & approve Q/A').setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setLabel('New issue').setStyle(ButtonStyle.Link).setURL(issueUrl),
	);
	const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(causeSel);
	return { embeds: [embed], components: [row1, row3, row4] };
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
		const modal = new ModalBuilder().setCustomId(`eval:qasave:${threadId}`).setTitle('Approve Q/A')
			.addComponents(
				new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('q').setLabel('Question').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setValue((draft.question ?? '').slice(0, 4000))),
				new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('a').setLabel('Answer (this becomes Ralph’s approved answer)').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setValue((draft.answer ?? '').slice(0, 4000))),
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
	// shows "didn't respond in time", THEN apply the change and edit the card in place.
	if (interaction.isButton() || interaction.isStringSelectMenu()) {
		await interaction.deferUpdate().catch(() => {});
		try {
			if (interaction.isStringSelectMenu() && action === 'cause') store.applyReview(threadId, { cause: interaction.values[0] }, by);
			else if (action === 'confirm') store.applyReview(threadId, {}, by);
			else if (action === 'resolve') store.applyReview(threadId, { outcome: 'resolved_confirmed' }, by);
			else if (action === 'fail') store.applyReview(threadId, { outcome: 'rejected' }, by);
			else if (action === 'exclude') store.applyReview(threadId, { excluded_reason: 'manual' }, by);
			const t = store.getThreadFull(threadId);
			await interaction.editReply(card(t, interaction.guildId ?? ''));
		} catch (e) { /* already acked via deferUpdate; card just won't refresh */ }
	}
}
