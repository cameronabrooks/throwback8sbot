require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');

const token = process.env.BOT_TOKEN;
if (!token) {
  logger.error('BOT_TOKEN missing in environment');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    const app = await rest.get(Routes.oauth2CurrentApplication());
    const appId = app.id;

    // Clear global commands
    logger.info({ appId }, 'Clearing global commands');
    await rest.put(Routes.applicationCommands(appId), { body: [] });
    logger.info('Global commands cleared');

    // Clear guild commands if GUILD_ID is set
    const guildId = process.env.GUILD_ID;
    if (guildId) {
      logger.info({ appId, guildId }, 'Clearing guild commands');
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [] });
      logger.info('Guild commands cleared');
    }

    // Deploy fresh commands to guild
    if (guildId) {
      const commandsPath = path.join(__dirname, '..', 'commands');
      const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
      const commands = [];
      
      for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if (command.data) {
          commands.push(command.data.toJSON());
        }
      }

      logger.info({ appId, guildId, count: commands.length }, 'Deploying commands to guild');
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
      logger.info({ count: commands.length }, 'Guild commands deployed');
    }

  } catch (e) {
    logger.error({ err: e }, 'Failed to refresh commands');
    process.exit(1);
  }
})();
