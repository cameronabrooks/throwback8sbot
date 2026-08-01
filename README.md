# Throwback 8s Bot

Discord bot for the Throwback 8s server. Forked from the AJCL bot codebase, with the
Cod-stats scraper, server rank tiers (Kyanite/Obsidian/etc.), Twitch live notifications,
and the team-scheduling system (GM roles, match scheduling, casters, rosters, emergency
subs, picks/bans) removed. The 8s queue's ELO rating system was kept.

Setup

1. Install dependencies:

```bash
cd b:\throwback8sbot
npm install
```

2. `.env` is already populated with the bot token, guild ID, and log channel ID.
   Everything else in the codebase that still needs a real ID is marked with a
   `SET_...` placeholder or a `// TODO` comment — search for `SET_` to find them all:

```bash
grep -rn "SET_" commands lib src config
```

3. Deploy slash commands, then start the bot:

```bash
npm run deploy-commands
npm start
```

Notes

- Commands are auto-loaded from the `commands` folder.
- `config/reaction_roles_config.json` and `config/applications_config.json` ship with
  blank role/channel IDs — fill them in once the roles/channels exist on this server.
- The 8s queue (`/startqueue`, `/8srating`, etc.) and its ELO ratings are stored in
  `database/throwback8s_data.db` (created automatically on first run).
