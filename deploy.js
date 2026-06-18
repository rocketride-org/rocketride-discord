require('dotenv/config');
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('submit')
    .setDescription('Submit a project to the showcase'),
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Lock channel and post how-to embed'),
];

const rest = new REST().setToken(process.env.SHOWCASE_BOT_TOKEN);

(async () => {
  const data = await rest.put(
    Routes.applicationGuildCommands(process.env.SHOWCASE_CLIENT_ID, process.env.SHOWCASE_GUILD_ID),
    { body: commands.map(c => c.toJSON()) },
  );

  console.log(`Registered ${data.length} slash commands.`);
})();
