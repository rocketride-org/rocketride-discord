import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { PANEL_CHANNEL_ID } from './github-verify';
import { START_ID, panelPayload } from './github-verify-discord';

// One-shot: publish (or update) the contributor-verification panel.
//
//   ./node_modules/.bin/tsx verify-panel.ts            # create, or edit the existing panel in place
//   ./node_modules/.bin/tsx verify-panel.ts --dry-run  # print what would be sent, touch nothing
//
// tsx is project-local (there is no global `tsx`), hence the explicit path — same as start-bots.sh.
//
// REST only — no gateway connection. That matters: Ralph's token is already running a live
// gateway session in support.ts, and logging in a second Client with the same token would put
// two sessions on one identity. Re-runnable: it finds its own previous panel by looking for a
// message of ours carrying the START_ID button, and PATCHes that rather than posting a duplicate.

const TOKEN = (process.env.SUPPORT_BOT_TOKEN ?? '').trim();
const DRY_RUN = process.argv.includes('--dry-run');

interface PartialMessage {
	id: string;
	author?: { id?: string };
	components?: unknown;
}

async function main(): Promise<void> {
	const payload = panelPayload();

	if (DRY_RUN) {
		console.log(`channel: ${PANEL_CHANNEL_ID}`);
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	if (!TOKEN) throw new Error('Set SUPPORT_BOT_TOKEN in .env (the Ralph bot token).');
	if (!PANEL_CHANNEL_ID) throw new Error('Set VERIFY_PANEL_CHANNEL_ID in .env (the channel for the panel).');

	const rest = new REST({ version: '10' }).setToken(TOKEN);
	const me = (await rest.get(Routes.user('@me'))) as { id: string; username: string };

	const recent = (await rest.get(Routes.channelMessages(PANEL_CHANNEL_ID), {
		query: new URLSearchParams({ limit: '50' }),
	})) as PartialMessage[];

	const existing = recent.find(
		(m) => m.author?.id === me.id && JSON.stringify(m.components ?? []).includes(START_ID),
	);

	if (existing) {
		await rest.patch(Routes.channelMessage(PANEL_CHANNEL_ID, existing.id), { body: payload });
		console.log(`updated existing panel (message ${existing.id}) in channel ${PANEL_CHANNEL_ID} as ${me.username}`);
		return;
	}

	const posted = (await rest.post(Routes.channelMessages(PANEL_CHANNEL_ID), { body: payload })) as { id: string };
	console.log(`posted new panel (message ${posted.id}) in channel ${PANEL_CHANNEL_ID} as ${me.username}`);
	console.log('Re-run this script after editing the panel copy — it will edit that message in place.');
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
