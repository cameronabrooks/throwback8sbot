const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getLeaderboard } = require('../lib/queue_ratings');

const MEDALS = ['🥇', '🥈', '🥉'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('8sleaderboard')
    .setDescription('Show the top 10 8s queue players by rating'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: false });
    const rows = getLeaderboard(interaction.guildId, 10);

    if (!rows.length) {
      return interaction.editReply('No ratings yet — play some matches first!');
    }

    const lines = rows.map((r, i) => {
      const medal = MEDALS[i] ?? `\`${i + 1}.\``;
      const wr = r.wins + r.losses > 0 ? ((r.wins / (r.wins + r.losses)) * 100).toFixed(1) : '0.0';
      return `${medal} <@${r.user_id}> — **${Math.round(r.rating)}** MMR (${r.wins}W/${r.losses}L · ${wr}%)`;
    });

    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('🏆 8s Queue Leaderboard')
      .setDescription(lines.join('\n'))
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
