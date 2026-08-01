const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const logger = require('../lib/logger');



const STAFF_REVIEW_CHANNEL_ID = process.env.NICKNAME_STAFF_CHANNEL_ID || 'SET_NICKNAME_STAFF_CHANNEL_ID';

const STAFF_ROLE_ID = process.env.NICKNAME_STAFF_ROLE_ID || 'SET_NICKNAME_STAFF_ROLE_ID';



function base64UrlEncode(value) {

  return Buffer.from(value, 'utf8').toString('base64')

    .replace(/\+/g, '-')

    .replace(/\//g, '_')

    .replace(/=+$/g, '');

}



module.exports = {

  data: new SlashCommandBuilder()

    .setName('nickname')

    .setDescription('Submit a nickname change for staff approval')

    .addStringOption(option =>

      option.setName('requestedname')

        .setDescription('The exact name you want to use (e.g., AVJ | PlayerName)')

        .setRequired(true)),



  async execute(interaction) {

    const requestedName = interaction.options.getString('requestedname');

    const user = interaction.user;



    if (!interaction.guild) {

      return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });

    }



    const reviewChannelId = STAFF_REVIEW_CHANNEL_ID;

    if (!reviewChannelId) {

      console.error('[NICKNAME ERROR] NICKNAME_STAFF_CHANNEL_ID is not configured.');

      return interaction.reply({ content: 'Server misconfiguration: staff review channel is not configured.', ephemeral: true });

    }



    await interaction.reply({

      content: `⏳ **Submission Received!** Your requested nickname (\`${requestedName}\`) has been forwarded to staff for verification.`,

      ephemeral: true

    });



    let reviewChannel;

    try {

      reviewChannel = await interaction.client.channels.fetch(reviewChannelId);

    } catch (error) {

      console.error(`[NICKNAME ERROR] Failed to fetch staff review channel ${reviewChannelId}.`, error);

    }



    if (!reviewChannel || !reviewChannel.isTextBased()) {

      console.error(`[NICKNAME ERROR] Nickname review channel ID ${reviewChannelId} not found or not text-based.`);

      return;

    }



    const encodedName = base64UrlEncode(requestedName);

    const approveId = `nick_approve_${user.id}_${encodedName}`;

    const denyId = `nick_deny_${user.id}`;



    const adminEmbed = new EmbedBuilder()

      .setTitle('📝 Nickname Change Request')

      .setColor(0xF39C12)

      .setDescription('A player has submitted a handle modification request. Review their format before authorizing.')

      .addFields(

        { name: '👤 User Account', value: `${user} (${user.tag})`, inline: true },

        { name: '🆔 User ID', value: `\`${user.id}\``, inline: true },

        { name: '✨ Requested Nickname', value: `\`${requestedName}\``, inline: false },

        { name: 'Status', value: 'Pending review', inline: false }

      )

      .setTimestamp()

      .setFooter({ text: 'Staff Operations' });



    const actionRow = new ActionRowBuilder().addComponents(

      new ButtonBuilder()

        .setCustomId(approveId)

        .setLabel('Approve & Apply')

        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()

        .setCustomId(denyId)

        .setLabel('Deny Request')

        .setStyle(ButtonStyle.Danger)

    );



    try {

      await reviewChannel.send({ content: `<@&${STAFF_ROLE_ID}>`, embeds: [adminEmbed], components: [actionRow] });

    } catch (error) {

      console.error('[NICKNAME ERROR] Failed to send nickname review message.', error);

    }

  }

};

