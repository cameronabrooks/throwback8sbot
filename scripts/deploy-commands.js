require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const logger = require('../lib/logger');

async function main(){
  const token = process.env.BOT_TOKEN;
  if(!token){
    logger.error('BOT_TOKEN missing in environment');
    process.exit(1);
  }

  const commandsPath = path.join(__dirname, '..', 'commands');
  const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
  const commands = [];
  for(const file of commandFiles){
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if(command.data) commands.push(command.data.toJSON());
  }

  const rest = new REST({ version: '10' }).setToken(token);

  try{
    // fetch application id dynamically
    const app = await rest.get(Routes.oauth2CurrentApplication());
    const appId = app.id;
    const guildId = process.env.GUILD_ID;

    if(guildId){
      logger.info({ appId, guildId, count: commands.length }, 'Deploying commands to guild');
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
      logger.info('Guild commands registered');
    } else {
      logger.info({ appId, count: commands.length }, 'Deploying global commands');
      await rest.put(Routes.applicationCommands(appId), { body: commands });
      logger.info('Global commands registered');
    }
  } catch(e){
    logger.error({ err: e }, 'Failed to deploy commands');
    process.exit(1);
  }
}

main();
