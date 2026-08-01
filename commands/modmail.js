const { SlashCommandBuilder } = require('discord.js');

// Execution is handled inline in src/index.js (needs _modmailThreadMap scope).
module.exports = {
  data: new SlashCommandBuilder()
    .setName('modmail')
    .setDescription('Open a modmail ticket with staff')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Your message to staff')
        .setRequired(false))
};
