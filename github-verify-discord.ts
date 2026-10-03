import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	Events,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type Client,
	type ModalSubmitInteraction,
} from 'discord.js';
import {
	CONTRIBUTOR_ROLE_ID,
	REPO,
	countMergedPRs,
	hasClientId,
	store,
	verifier,
	type IdentityProof,
} from './github-verify';

// Discord half of contributor verification: the panel message, and a SEPARATE
// InteractionCreate listener. It is deliberately its own listener rather than an extra branch
// inside Ralph's "Escalate to Slack" handler — that handler early-returns on anything which
// isn't its own context-menu command, so leaving it untouched means this feature cannot
// regress escalation. discord.js dispatches to every registered listener.
//
// Needs no new intent and no new command registration: buttons ride on a message, and the
// member arrives on the interaction payload (so the GuildMembers intent stays off).

export const START_ID = 'gh_verify_start';
export const CHECK_ID = 'gh_verify_check';
export const LOGIN_MODAL_ID = 'gh_verify_login';
const LOGIN_FIELD_ID = 'login';

type Logger = (...args: unknown[]) => void;

/** The panel: one embed plus one button. Shared by the publisher script and any re-post. */
export function panelPayload(): Record<string, unknown> {
	const embed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle('Get the Contributor role')
		.setDescription(
			[
				`Merged a pull request into [${REPO}](https://github.com/${REPO})? Verify your GitHub account and the bot will give you the **@Contributor** role straight away.`,
				'',
				'Press the button below. Everything after that is private to you — nobody else in the server sees it.',
			].join('\n'),
		)
		.addFields(
			{
				name: 'How it works',
				value: [
					'**1.** Press **Verify GitHub** — you get a short code.',
					'**2.** Enter the code at `github.com/login/device` and approve.',
					'**3.** Press **I\'ve authorized**. The role is granted immediately.',
				].join('\n'),
			},
			{
				name: 'What the bot stores',
				value: 'Your Discord id, your GitHub account id and username. Nothing else — the GitHub token from step 2 is used once to read your username, then discarded.',
			},
			{
				name: 'No merged PRs yet?',
				value: `Verifying still links your account. Once a PR of yours is merged, press the button again and the role is granted — no need to re-verify.`,
			},
		)
		.setFooter({ text: 'RocketRide · GitHub contributor verification' });

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(START_ID).setStyle(ButtonStyle.Primary).setLabel('Verify GitHub').setEmoji('🔗'),
	);

	return { embeds: [embed.toJSON()], components: [row.toJSON()] };
}

/** "I've authorized" / "I've added it" — label depends on which verifier is active. */
function checkRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(CHECK_ID)
			.setStyle(ButtonStyle.Success)
			.setLabel(verifier.needsLogin ? "I've added it" : "I've authorized")
			.setEmoji('✅'),
	);
}

function loginModal(): ModalBuilder {
	return new ModalBuilder()
		.setCustomId(LOGIN_MODAL_ID)
		.setTitle('Verify your GitHub account')
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId(LOGIN_FIELD_ID)
					.setLabel('Your GitHub username')
					.setPlaceholder('octocat')
					.setStyle(TextInputStyle.Short)
					.setMaxLength(39)
					.setRequired(true),
			),
		);
}

type RoleOutcome = { ok: true; already: boolean } | { ok: false; error: string };

/**
 * Grant the Contributor role. The role id comes from the environment and is NEVER taken from
 * interaction input — Ralph holds guild-wide Manage Roles, so a role id sourced from a
 * customId would be a privilege-escalation hole.
 */
async function ensureRole(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<RoleOutcome> {
	if (!interaction.guild) return { ok: false, error: 'not in a server' };
	try {
		const member = await interaction.guild.members.fetch(interaction.user.id);
		if (member.roles.cache.has(CONTRIBUTOR_ROLE_ID)) return { ok: true, already: true };
		await member.roles.add(CONTRIBUTOR_ROLE_ID, 'Verified GitHub contributor');
		return { ok: true, already: false };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

const roleFailure = (error: string): string =>
	`⚠️ Verified, but I couldn't assign the role (\`${error}\`). Please tell a moderator — pressing the button again will retry.`;

/** Shared tail: claim checks, PR count, role grant, record. */
async function finish(interaction: ButtonInteraction | ModalSubmitInteraction, proof: IdentityProof, log: Logger): Promise<void> {
	const conflict = store.claimConflict(interaction.user.id, proof.githubId);
	if (conflict) {
		log(`github-verify: ${interaction.user.username} blocked — ${conflict.kind} (@${conflict.existing.github_login})`);
		await interaction.editReply(
			conflict.kind === 'discord_linked'
				? `🚫 Your Discord account is already linked to **@${conflict.existing.github_login}**. One GitHub account per Discord user — ask a moderator if you need that changed.`
				: `🚫 **@${proof.githubLogin}** is already linked to another Discord account. One Discord user per GitHub account — ask a moderator if that's wrong.`,
		).catch(() => {});
		return;
	}

	const prs = await countMergedPRs(proof.githubLogin);
	if (!prs.ok) {
		await interaction.editReply(`⚠️ Verified as **@${proof.githubLogin}**, but the pull-request check failed: ${prs.reason}`).catch(() => {});
		return;
	}

	// Record before granting: if the grant fails the link still stands, so pressing the
	// button again retries the grant instead of starting a fresh verification.
	store.upsert({
		discord_id: interaction.user.id,
		github_id: proof.githubId,
		github_login: proof.githubLogin,
		verified_at: Date.now(),
		merged_prs: prs.count,
		method: verifier.name,
	});

	if (prs.count === 0) {
		log(`github-verify: ${interaction.user.username} verified as @${proof.githubLogin} — 0 merged PRs, no role`);
		await interaction.editReply(
			`✅ Verified as **@${proof.githubLogin}** — but no merged pull requests in \`${REPO}\` yet, so no role for now.\n\nYour accounts are linked. Once a PR of yours is merged, press **Verify GitHub** again and the role is granted instantly.`,
		).catch(() => {});
		return;
	}

	const role = await ensureRole(interaction);
	if (!role.ok) {
		log(`github-verify: role grant FAILED for ${interaction.user.username} (@${proof.githubLogin}): ${role.error}`);
		await interaction.editReply(roleFailure(role.error)).catch(() => {});
		return;
	}
	log(`github-verify: ${interaction.user.username} → @${proof.githubLogin} (${prs.count} merged PRs), role ${role.already ? 'already held' : 'granted'}`);
	await interaction.editReply(
		`🎉 Verified as **@${proof.githubLogin}** — ${prs.count} merged pull request${prs.count === 1 ? '' : 's'} in \`${REPO}\`.\n\nYou now have the **@Contributor** role. Welcome aboard.`,
	).catch(() => {});
}

/** Already-linked member pressed the panel again: re-check PRs, grant if they're eligible now. */
async function recheck(interaction: ButtonInteraction, log: Logger): Promise<void> {
	const existing = store.byDiscordId(interaction.user.id)!;
	const prs = await countMergedPRs(existing.github_login);
	if (!prs.ok) {
		await interaction.editReply(`Your account is linked to **@${existing.github_login}**, but the pull-request check failed: ${prs.reason}`).catch(() => {});
		return;
	}
	store.upsert({ ...existing, merged_prs: prs.count });

	if (prs.count === 0) {
		await interaction.editReply(
			`Your account is linked to **@${existing.github_login}**, but there are still no merged pull requests in \`${REPO}\`.\n\nPress this button again after one is merged.`,
		).catch(() => {});
		return;
	}
	const role = await ensureRole(interaction);
	if (!role.ok) {
		log(`github-verify: recheck role grant FAILED for ${interaction.user.username}: ${role.error}`);
		await interaction.editReply(roleFailure(role.error)).catch(() => {});
		return;
	}
	log(`github-verify: recheck ${interaction.user.username} → @${existing.github_login} (${prs.count} merged PRs), role ${role.already ? 'already held' : 'granted'}`);
	await interaction.editReply(
		role.already
			? `✅ Already verified as **@${existing.github_login}** — ${prs.count} merged pull request${prs.count === 1 ? '' : 's'}, and you already have **@Contributor**.`
			: `🎉 **@${existing.github_login}** now has ${prs.count} merged pull request${prs.count === 1 ? '' : 's'} — **@Contributor** granted.`,
	).catch(() => {});
}

async function onStart(interaction: ButtonInteraction, log: Logger): Promise<void> {
	if (!interaction.inGuild()) {
		await interaction.reply({ content: 'Please press this from inside the server.', ephemeral: true }).catch(() => {});
		return;
	}

	// Already linked => re-check path. Deferring is safe here because no modal is involved.
	if (store.byDiscordId(interaction.user.id)) {
		await interaction.deferReply({ ephemeral: true }).catch(() => {});
		await recheck(interaction, log);
		return;
	}

	// showModal must be the FIRST response to an interaction, so it cannot follow deferReply.
	// Only the bio/gist fallback needs it; Device Flow has nothing to ask for.
	if (verifier.needsLogin) {
		await interaction.showModal(loginModal()).catch(() => {});
		return;
	}

	await interaction.deferReply({ ephemeral: true }).catch(() => {});
	const begun = await verifier.begin(interaction.user.id);
	if (!begun.ok) {
		log(`github-verify: begin failed for ${interaction.user.username}: ${begun.reason}`);
		await interaction.editReply(`⚠️ ${begun.reason}`).catch(() => {});
		return;
	}
	log(`github-verify: started ${verifier.name} for ${interaction.user.username}`);
	await interaction.editReply({ content: begun.instructions, components: [checkRow()] }).catch(() => {});
}

async function onLogin(interaction: ModalSubmitInteraction, log: Logger): Promise<void> {
	await interaction.deferReply({ ephemeral: true }).catch(() => {});
	const login = interaction.fields.getTextInputValue(LOGIN_FIELD_ID);
	const begun = await verifier.begin(interaction.user.id, login);
	if (!begun.ok) {
		await interaction.editReply(`⚠️ ${begun.reason}`).catch(() => {});
		return;
	}
	log(`github-verify: started ${verifier.name} for ${interaction.user.username} (@${login.trim()})`);
	await interaction.editReply({ content: begun.instructions, components: [checkRow()] }).catch(() => {});
}

async function onCheck(interaction: ButtonInteraction, log: Logger): Promise<void> {
	await interaction.deferReply({ ephemeral: true }).catch(() => {});
	const result = await verifier.check(interaction.user.id);
	switch (result.status) {
		case 'verified':
			await finish(interaction, result.proof, log);
			return;
		case 'pending':
			await interaction.editReply({ content: result.hint, components: [checkRow()] }).catch(() => {});
			return;
		case 'expired':
			await interaction.editReply('⏱️ That code expired. Press **Verify GitHub** on the panel to get a fresh one.').catch(() => {});
			return;
		case 'denied':
			await interaction.editReply('🚫 The request was denied on GitHub. Press **Verify GitHub** again if that was a mistake.').catch(() => {});
			return;
		case 'none':
			await interaction.editReply('I have no verification in progress for you — press **Verify GitHub** on the panel to start one.').catch(() => {});
			return;
		default:
			log(`github-verify: check error for ${interaction.user.username}: ${result.message}`);
			await interaction.editReply(`⚠️ ${result.message}`).catch(() => {});
	}
}

/**
 * Register the verification listener on an existing client. Call once from the bot's main().
 * Refuses to arm itself (loudly, without throwing) if configuration is missing, so a
 * misconfigured deploy leaves Ralph's other features working rather than taking it down.
 */
export function initGithubVerify(discord: Client, log: Logger): void {
	if (!CONTRIBUTOR_ROLE_ID) {
		log('github-verify: DISABLED — ROCKETRIDE_DISCORD_CONTRIBUTOR_ROLE_ID is not set');
		return;
	}
	if (!verifier.needsLogin && !hasClientId()) {
		log('github-verify: DISABLED — ROCKETRIDE_GITHUB_CLIENT_ID is not set (needed for Device Flow)');
		return;
	}

	discord.on(Events.InteractionCreate, async (interaction) => {
		try {
			if (interaction.isButton() && interaction.customId === START_ID) return void (await onStart(interaction, log));
			if (interaction.isButton() && interaction.customId === CHECK_ID) return void (await onCheck(interaction, log));
			if (interaction.isModalSubmit() && interaction.customId === LOGIN_MODAL_ID) return void (await onLogin(interaction, log));
		} catch (e) {
			// Never let a verification bug escape into Ralph's other handlers.
			log(`  !! github-verify: ${e instanceof Error ? e.message : e}`);
		}
	});

	log(`github-verify: listening (method=${verifier.name}, repo=${REPO}, role=${CONTRIBUTOR_ROLE_ID})`);
}
