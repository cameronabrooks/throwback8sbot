const { SlashCommandBuilder } = require('discord.js');

// Execution is handled inline in src/index.js (needs _modmailThreadMap scope).
module.exports = {
  data: new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this modmail ticket (run inside the ticket channel)')
};
