require('dotenv/config');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    const channel = await client.channels.fetch(process.env.SHOWCASE_CHANNEL_ID);
    const messages = await channel.messages.fetch({ limit: 100 });

    // Collect bot-posted submissions (messages with embeds that have an author field)
    const submissions = [...messages.values()]
      .filter(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].author)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (submissions.length === 0) {
      console.log('No submissions found to migrate.');
      client.destroy();
      return;
    }

    console.log(`Found ${submissions.length} submissions to repost.`);

    // Save embed data before deleting
    const saved = submissions.map(m => ({
      embed: EmbedBuilder.from(m.embeds[0]),
      threadName: m.thread?.name,
      projectName: m.embeds[0].title,
    }));

    // Delete originals
    for (const msg of submissions) {
      await msg.delete();
      console.log(`Deleted: ${msg.embeds[0].title}`);
    }

    // Repost in chronological order (now after the how-to)
    let reposted = 0;
    for (const { embed, threadName, projectName } of saved) {
      const sent = await channel.send({ embeds: [embed] });
      await sent.startThread({
        name: threadName || `Feedback: ${projectName}`,
        autoArchiveDuration: 1440,
      });
      console.log(`Reposted: ${projectName}`);
      reposted++;
    }

    console.log(`Migration complete. ${reposted} posts reposted.`);
  } catch (err) {
    console.error('Migration failed:', err);
  }

  client.destroy();
});

client.login(process.env.BOT_TOKEN);
