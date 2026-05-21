# CLAUDE.md — showcase-moderator refactor

## Context
Bot is currently live on a Raspberry Pi running main branch.
Existing .claude/settings.local.json should be left untouched.
Only 4 existing posts in the channel — migration is a one-shot manual script.

## Deployment order (for developer, not Claude Code)
1. Pull new code on the Pi
2. npm install (only if discord.js version changed)
3. node deploy.js  ← must run before restarting bot or /submit won't exist
4. Restart the bot process
5. Run: node migrate.js  ← one time only, then delete the file

## Repo structure after refactor
showcase-moderator/
  index.js        # bot entry point + interaction handler
  deploy.js       # one-shot slash command registration
  migrate.js      # one-shot migration runner, delete after use
  package.json
  .env
  .claude/
    settings.local.json   # do not touch

## Constants (top of index.js)
TRACK_COLORS = {
  'Startup':       0x5865F2,
  'Internal Tool': 0xFEE75C,
  'AI System':     0x57F287,
}
STATUS_EMOJI = {
  'Prototype': '🔧',
  'MVP':       '🚀',
  'Production':'✅',
}
FOOTER_TEXT = 'RocketRide Project Showcase · #submissions'

## Environment variables
DISCORD_TOKEN
CLIENT_ID
GUILD_ID
SUBMISSIONS_CHANNEL_ID

## Phase 1 — deploy.js
Register exactly three slash commands against the guild:
  /submit   — no options
  /setup    — no options
  /migrate  — DO NOT register this. It is a standalone script, not a slash command.

## Phase 2 — rewrite index.js
Remove ALL existing logic. Fresh interactionCreate handler only.

### /submit
Reply ephemeral with a StringSelectMenu (customId: 'select_track'):
  - Startup        💼  "Building a product or business"
  - Internal Tool  🔧  "Tooling for your team or workflow"
  - AI System      🤖  "Agent, pipeline, or AI-native system"
Message: "**Step 1 of 2** — Pick your track, then fill out the submission form."

### select_track (StringSelectMenu)
Show modal with customId: `submit_modal:{track}`
Title: `Submit Project — {track}`
Fields in order:
  1. project_name  Short      required  max:80   label:"Project name"
  2. problem       Paragraph  required  max:500  label:"Problem"
  3. built         Paragraph  required  max:600  label:"What I built + how it uses RocketRide"
                                                 placeholder:"What you made, and which nodes/SDK features you used."
  4. demo_status   Short      required  max:200  label:"Demo / Repo  +  Status"
                                                 placeholder:"github.com/... | Prototype / MVP / Production"
  5. feedback      Paragraph  required  max:300  label:"Feedback wanted"

### submit_modal (ModalSubmit)
- Parse track from customId: interaction.customId.split(':')[1]
- Split demo_status value on '|' -> [demo, status], trim both
- Build embed:
    color:   TRACK_COLORS[track]
    author:  "{interaction.user.displayName} submitted a project"
             iconURL: interaction.user.displayAvatarURL()
    title:   project_name field value
    fields:
      { name: 'Track',           value: `\`${track}\``,                          inline: true  }
      { name: 'Status',          value: `${STATUS_EMOJI[status] ?? ''} \`${status}\``, inline: true }
      { name: '\u200b',          value: '\u200b',                                 inline: true  }
      { name: 'Problem',         value: problem field value                                     }
      { name: 'What I built + how it uses RocketRide', value: built field value               }
      { name: 'Demo / Repo',     value: demo,                                    inline: true  }
      { name: 'Feedback wanted', value: feedback field value                                   }
    footer:    FOOTER_TEXT + bot avatar
    timestamp: now

- interaction.reply({ embeds: [embed] })
- After reply, fetch the sent message:
    const reply = await interaction.fetchReply()
- Start a thread on it:
    await reply.startThread({
      name: `Feedback: ${projectName}`,
      autoArchiveDuration: 1440,
    })

### /setup (requires ManageChannels permission — reject silently if missing)
1. Deny SendMessages for @everyone on interaction.channel
2. Allow SendMessages for client.user.id on interaction.channel
3. Set channel topic: "Use /submit to post your project. Manual messages are disabled."
4. Build how-to embed:
     color:  0x5865F2
     title:  "How to submit your project"
     description:
       "This channel only accepts submissions through the bot.\n
        Manual messages are disabled.\n\n
        **Run `/submit` anywhere in this server to open the form.**\n\n
        Pick your track first, then fill out a short form.
        The bot posts your submission here as a formatted card,
        and opens a feedback thread automatically."
     fields:
       { name: 'Tracks',         value: '`Startup` · `Internal Tool` · `AI System`' }
       { name: 'Status options',  value: '`Prototype` · `MVP` · `Production`'        }
     footer: FOOTER_TEXT
5. Add a disabled primary Button labeled "/submit" with emoji 📦 as visual affordance
6. Send embed + button row to channel, then pin the message
7. Reply ephemeral: "Channel locked and pinned how-to posted."

## Phase 3 — migrate.js (standalone, delete after use)
This script runs independently with its own Client login, not part of index.js.

Steps:
1. Login with DISCORD_TOKEN
2. Fetch the submissions channel by SUBMISSIONS_CHANNEL_ID
3. Fetch up to 100 messages (4 posts, so one fetch is enough)
4. Filter: skip messages where message.author.bot is true
5. For each plain-text user message:
   a. Attempt to parse fields using these labels (regex, case-insensitive):
        "Project Name:", "Track:", "Problem:", "What I built:",
        "How it uses our platform:", "Demo / Repo:", "Current status:", "Feedback wanted:"
   b. Map parsed fields to the new embed structure:
        - "Project Name:"           -> embed title
        - "Track:"                  -> track field (match to TRACK_COLORS keys, default Startup)
        - "Problem:"                -> Problem field
        - "What I built:"           -> "What I built + how it uses RocketRide" field
          (append "How it uses our platform:" value if present)
        - "Demo / Repo:"            -> Demo/Repo field
        - "Current status:"         -> Status field
        - "Feedback wanted:"        -> Feedback wanted field
   c. Build embed using same structure as submit_modal handler
      Set author to original message.author.displayName + avatar
   d. Send embed to the channel
   e. Start a thread on it: `Feedback: {project_name}`
   f. Delete the original plain-text message
   g. Log: "Migrated: {project_name} by {author}"
6. Log total: "Migration complete. {n} posts migrated."
7. client.destroy()

If a message can't be parsed (missing required fields), log a warning and skip it.
Do not throw — process remaining messages.

## Intents required (index.js)
GatewayIntentBits.Guilds
GatewayIntentBits.GuildMessages

MessageContent privileged intent: NOT needed

## Bot role permissions needed in Discord server
Send Messages
Manage Messages      (to delete originals in migration)
Manage Channels      (for /setup permission overwrites)
Embed Links
Create Public Threads
Send Messages in Threads
Read Message History

## package.json
Check discord.js version. If below ^14.0.0, update it and note that npm install
must be re-run on the Pi before starting the bot.
No other new dependencies.

## Instructions for Claude Code
1. Read existing index.js in full before writing anything
2. Read package.json — check discord.js version, update if needed
3. Write deploy.js
4. Write migrate.js
5. Rewrite index.js from scratch — do not preserve any old logic
6. Do not run node, npm start, or node deploy.js
7. Do not modify .claude/settings.local.json
