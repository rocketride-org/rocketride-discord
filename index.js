require('dotenv/config');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');

const TRACK_COLORS = {
  'Startup':       0x5865F2,
  'Internal Tool': 0xFEE75C,
  'AI System':     0x57F287,
};

const STATUS_EMOJI = {
  'Prototype': '🔧',
  'MVP':       '🚀',
  'Production': '✅',
};

const FOOTER_TEXT = 'RocketRide Project Showcase · #submissions';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

client.on('interactionCreate', async (interaction) => {
  try {
  // /submit — show track select menu
  if (interaction.isChatInputCommand() && interaction.commandName === 'submit') {
    const select = new StringSelectMenuBuilder()
      .setCustomId('select_track')
      .setPlaceholder('Pick a track')
      .addOptions(
        { label: 'Startup',       emoji: '💼', description: 'Building a product or business',       value: 'Startup' },
        { label: 'Internal Tool', emoji: '🔧', description: 'Tooling for your team or workflow',    value: 'Internal Tool' },
        { label: 'AI System',     emoji: '🤖', description: 'Agent, pipeline, or AI-native system', value: 'AI System' },
      );

    const row = new ActionRowBuilder().addComponents(select);

    await interaction.reply({
      content: '**Step 1 of 2** — Pick your track, then fill out the submission form.',
      components: [row],
      ephemeral: true,
    });
    return;
  }

  // Track selection → show modal
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_track') {
    const track = interaction.values[0];

    const modal = new ModalBuilder()
      .setCustomId(`submit_modal:${track}`)
      .setTitle(`Submit Project — ${track}`);

    const projectName = new TextInputBuilder()
      .setCustomId('project_name')
      .setLabel('Project name')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80);

    const problem = new TextInputBuilder()
      .setCustomId('problem')
      .setLabel('Problem')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(500);

    const built = new TextInputBuilder()
      .setCustomId('built')
      .setLabel('What I built + how it uses RocketRide')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(600)
      .setPlaceholder('What you made, and which nodes/SDK features you used.');

    const demoStatus = new TextInputBuilder()
      .setCustomId('demo_status')
      .setLabel('Demo / Repo  +  Status')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(200)
      .setPlaceholder('github.com/... | Prototype / MVP / Production');

    const feedback = new TextInputBuilder()
      .setCustomId('feedback')
      .setLabel('Feedback wanted')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(300);

    modal.addComponents(
      new ActionRowBuilder().addComponents(projectName),
      new ActionRowBuilder().addComponents(problem),
      new ActionRowBuilder().addComponents(built),
      new ActionRowBuilder().addComponents(demoStatus),
      new ActionRowBuilder().addComponents(feedback),
    );

    await interaction.showModal(modal);
    return;
  }

  // Modal submit → build embed + thread
  if (interaction.isModalSubmit() && interaction.customId.startsWith('submit_modal:')) {
    await interaction.deferReply({ ephemeral: true });

    const track       = interaction.customId.split(':')[1];
    const projectName = interaction.fields.getTextInputValue('project_name');
    const problem     = interaction.fields.getTextInputValue('problem');
    const built       = interaction.fields.getTextInputValue('built');
    const demoStatus  = interaction.fields.getTextInputValue('demo_status');
    const feedback    = interaction.fields.getTextInputValue('feedback');

    const [demo, status] = demoStatus.split('|').map(s => s.trim());

    const embed = new EmbedBuilder()
      .setColor(TRACK_COLORS[track])
      .setAuthor({
        name: `${interaction.user.displayName} submitted a project`,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTitle(projectName)
      .addFields(
        { name: 'Track',    value: `\`${track}\``,                                          inline: true },
        { name: 'Status',   value: `${STATUS_EMOJI[status] ?? ''} \`${status ?? 'N/A'}\``,  inline: true },
        { name: '\u200b',   value: '\u200b',                                                  inline: true },
        { name: 'Problem',  value: problem },
        { name: 'What I built + how it uses RocketRide', value: built },
        { name: 'Demo / Repo',     value: demo ?? demoStatus, inline: true },
        { name: 'Feedback wanted', value: feedback },
      )
      .setFooter({ text: FOOTER_TEXT, iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    const showcase = await client.channels.fetch(process.env.SHOWCASE_CHANNEL_ID);
    const sent = await showcase.send({ embeds: [embed] });
    await sent.startThread({
      name: `Feedback: ${projectName}`,
      autoArchiveDuration: 1440,
    });

    await interaction.editReply({
      content: `Submitted! See your post in <#${process.env.SHOWCASE_CHANNEL_ID}>.`,
    });
    return;
  }

  // /setup — lock channel + post how-to
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({ content: 'Missing ManageChannels permission.', ephemeral: true });
      return;
    }

    const channel = interaction.channel;

    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
      SendMessages: false,
    });

    await channel.permissionOverwrites.edit(client.user.id, {
      SendMessages: true,
    });

    await channel.setTopic('Use /submit to post your project. Manual messages are disabled.');

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('How to submit your project')
      .setDescription(
        'This channel only accepts submissions through the bot.\n' +
        'Manual messages are disabled.\n\n' +
        '**Run `/submit` anywhere in this server to open the form.**\n\n' +
        'Pick your track first, then fill out a short form.\n' +
        'The bot posts your submission here as a formatted card,\n' +
        'and opens a feedback thread automatically.'
      )
      .addFields(
        { name: 'Tracks',         value: '`Startup` · `Internal Tool` · `AI System`' },
        { name: 'Status options', value: '`Prototype` · `MVP` · `Production`' },
      )
      .setFooter({ text: FOOTER_TEXT });

    const button = new ButtonBuilder()
      .setCustomId('submit_visual')
      .setLabel('/submit')
      .setEmoji('📦')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true);

    const row = new ActionRowBuilder().addComponents(button);

    const sent = await channel.send({ embeds: [embed], components: [row] });
    await sent.pin();

    await interaction.reply({ content: 'Channel locked and pinned how-to posted.', ephemeral: true });
    return;
  }
  } catch (err) {
    console.error('interactionCreate error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.BOT_TOKEN);
