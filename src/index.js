require('dotenv').config();

const fs = require('fs');

const path = require('path');

const { Client, GatewayIntentBits, Collection, EmbedBuilder, ChannelType, PermissionsBitField, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

const logger = require('../lib/logger');
const { handleEditMessageModal } = require('../commands/edit_message_context');

const {
  loadConfig: loadApplicationsConfig,
  readApplications,
  writeApplications,
  fillTemplate: fillApplicationTemplate,
  memberHasAnyRole: applicantHasAnyRole,
  startApplicationFlow,
  isApplying
} = require('../lib/applications');

const { loadConfig: loadReactionRolesConfig, getRoleEntry: getReactionRoleEntry } = require('../lib/reactionRoles');
const { init: initMusicPlayer } = require('../lib/musicPlayer');



// TODO: populate with source channel IDs whose deletions/edits shouldn't be logged, if any.
const EXCLUDED_SOURCE_CHANNELS = new Set([]);

// Matches the ephemeral channels the 8s queue system creates/renames/deletes on its own
// (match text channels, team/staging voice channels, the queue lobby itself, results
// channel, and the "8s Matches" category) so none of that churn hits the server log.
const Q8_CHANNEL_NAME_RE = /^(queue-\d+|in-queue-\d+|🎮 ?Queue ?#\d+|🔵 ?Team ?1|🔴 ?Team ?2|queue-results|8s results|8s matches)$/i;
function isQueueRelatedChannel(channel) {
  if (!channel) return false;
  const name = (channel.name || '').toLowerCase();
  if (Q8_CHANNEL_NAME_RE.test(name)) return true;
  const parentName = channel.parent?.name?.toLowerCase();
  return parentName === '8s matches';
}



// Automod configuration

const AUTOMOD_BANNED_WORDS = new Set([

  'dyke', 'dykes', 'fag', 'faggot', 'faggots', 'fags', 'homo', 'homos', 'kyke', 'kykes',

  'nigger', 'niggers', 'queer', 'queers', 'retard', 'retarded', 'retards', 'tard', 'tards'

]);

// TODO: channel/role IDs where banned words are allowed through (e.g. a staff-only or NSFW channel, a trusted staff role).
const AUTOMOD_ALLOWED_CHANNELS = new Set([]);

const AUTOMOD_ALLOWED_ROLES = new Set([]);

const AUTOMOD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes



// Modmail configuration — TODO: fill in for this server.

const MODMAIL_CATEGORY_ID = '1532928998693273802'; // category where ticket channels are created

const MODMAIL_LOG_CHANNEL_ID = '1532929061742182581'; // channel where closed ticket logs are posted

const MODMAIL_STAFF_ROLE_ID = 'SET_MODMAIL_STAFF_ROLE_ID';

const MODMAIL_CLOSE_COMMAND = /^\/close$/i;

const _modmailThreadMap = new Map(); // user ID -> ticket channel ID mapping

// Welcome message configuration
const WELCOME_CHANNEL_ID = '1532815441657860176';
function buildWelcomeMessage(member) {
  return `Welcome <@${member.id}> to Throwback 8s! Grab your roles (<#1532930768613937172>) and jump into the 8s queue whenever you're ready.

If you have any questions, DM the bot and a member of staff will reach out to assist!`;
}

// Leave message configuration — TODO: set this server's leave/goodbye channel ID.
const LEAVE_CHANNEL_ID = 'SET_LEAVE_CHANNEL_ID';
function buildLeaveMessage(member) {
  return `${member.user.username} has left the server. See you around!`;
}



const client = new Client({

  intents: [

    GatewayIntentBits.Guilds,

    GatewayIntentBits.GuildMembers,

    GatewayIntentBits.GuildModeration,

    GatewayIntentBits.GuildMessages,

    GatewayIntentBits.MessageContent,

    GatewayIntentBits.DirectMessages,

    GatewayIntentBits.GuildVoiceStates

  ],

  partials: ['MESSAGE', 'CHANNEL', 'REACTION', 'GUILD_MEMBER', 'USER']

});

client.commands = new Collection();



const _recentDMMessageIds = new Set();

const DM_MESSAGE_DEDUPE_MS = 10000;



async function getOrCreateModmailThread(userId, userName, source) {

  let threadId = _modmailThreadMap.get(userId);

  let thread = null;



  if (threadId) {

    try {

      thread = await client.channels.fetch(threadId);

      logger.debug({ userId, threadId, source }, 'Fetched existing modmail thread');

    } catch (e) {

      logger.warn({ userId, threadId, err: e.message, source }, 'Failed to fetch existing modmail thread; creating new ticket channel');

      threadId = null;

    }

  }



  if (!thread) {

    const category = await client.channels.fetch(MODMAIL_CATEGORY_ID).catch(e => null);

    if (!category || category.type !== ChannelType.GuildCategory) {

      logger.error({ userId, categoryId: MODMAIL_CATEGORY_ID, channelType: category?.type, source }, 'Modmail category not available');

      return null;

    }



    const guild = category.guild;

    const baseName = userName.split('#')[0] || `user-${userId}`;

    const safeName = `modmail-${baseName.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90)}`;

    thread = await guild.channels.create({ name: safeName, type: ChannelType.GuildText, parent: category.id, reason: `Modmail ticket created from ${source}` });

    threadId = thread.id;

    _modmailThreadMap.set(userId, threadId);



    const infoEmbed = new EmbedBuilder()

      .setTitle('Modmail Started')

      .setColor(0x3498DB)

      .setDescription(`User <@${userId}> has started a modmail conversation.`)

      .addFields(

        { name: 'User', value: `${userName} (${userId})`, inline: true },

        { name: 'Close Command', value: '/close or ~close', inline: true }

      )

      .setTimestamp();

    await thread.send({ content: `<@&${MODMAIL_STAFF_ROLE_ID}>`, embeds: [infoEmbed] });

    logger.info({ userId, threadId, guildId: guild.id, source }, 'Created new modmail thread');

  }



  return thread;

}



async function handleRawModmailDM(payload) {

  let userId;

  let messageId;

  let channelId;

  try {

    if (!payload) {

      logger.warn({ payload }, 'Raw DM payload missing');

      return;

    }

    if (payload.guild_id) {

      logger.debug({ payloadGuildId: payload.guild_id }, 'Raw MESSAGE_CREATE ignored because it belongs to a guild');

      return;

    }

    if (payload.author?.bot) {

      logger.debug({ authorId: payload.author?.id }, 'Raw DM ignored because author is a bot');

      return;

    }

    if (isApplying(payload.author?.id)) {

      logger.debug({ authorId: payload.author?.id }, 'Raw DM ignored because author is mid-application');

      return;

    }



    messageId = payload.id;

    if (!messageId) {

      logger.warn({ payload }, 'Raw DM payload missing id');

      return;

    }

    if (_recentDMMessageIds.has(messageId)) {

      logger.debug({ messageId }, 'Skipping duplicate raw DM payload');

      return;

    }

    _recentDMMessageIds.add(messageId);

    setTimeout(() => _recentDMMessageIds.delete(messageId), DM_MESSAGE_DEDUPE_MS);



    userId = payload.author?.id;

    if (!userId) {

      logger.error({ payload }, 'Raw DM payload missing author id');

      return;

    }



    const userName = `${payload.author.username || 'Unknown'}#${payload.author.discriminator || '0000'}`;

    const content = payload.content || '(no text)';

    channelId = payload.channel_id;



    logger.info({ userId, channelId, messageId, rawDM: true }, 'Handling raw DM for modmail ticket fallback');



    const thread = await getOrCreateModmailThread(userId, userName, 'raw DM');

    if (!thread) {

      logger.error({ userId, channelId, messageId }, 'Unable to create or fetch modmail thread for raw DM');

      return;

    }



    const userMessageEmbed = new EmbedBuilder()

      .setAuthor({ name: userName })

      .setDescription(content)

      .setColor(0x3498DB)

      .setTimestamp();

    await thread.send({ embeds: [userMessageEmbed] });



    const userObj = await client.users.fetch(userId).catch(() => null);

    if (userObj) {

      const confirmEmbed = new EmbedBuilder()

        .setTitle('Message Received')

        .setColor(0x2ECC71)

        .setDescription('Your message has been sent to staff. They will respond shortly.')

        .setTimestamp();

      await userObj.send({ embeds: [confirmEmbed] }).catch(() => {});

    }



    logger.info({ userId, channelId, messageId }, 'Raw DM modmail fallback completed');

  } catch (e) {

    logger.error({ err: e, userId, channelId, messageId }, 'Failed processing raw DM modmail fallback');

  }

}



async function handleDirectModmailDM(message, source = 'messageCreate') {

  const isDirectMessage = !message.guild;

  if (!isDirectMessage || (message.channel.isThread?.() ?? false)) return false;



  if (_recentDMMessageIds.has(message.id)) {

    logger.debug({ messageId: message.id, authorId: message.author.id, source }, 'Skipping direct DM already processed');

    return true;

  }



  _recentDMMessageIds.add(message.id);

  setTimeout(() => _recentDMMessageIds.delete(message.id), DM_MESSAGE_DEDUPE_MS);



  const userId = message.author.id;

  const userName = message.author.tag;

  logger.info({ userId, tag: userName, channelType: message.channel?.type, source }, 'Modmail DM handler entered - processing DM');



  const thread = await getOrCreateModmailThread(userId, userName, source);

  if (!thread) {

    await message.author.send('❌ Modmail system error: could not create or find a ticket channel. Please contact an admin.').catch(() => {});

    return true;

  }



  const userMessageEmbed = new EmbedBuilder()

    .setAuthor({ name: userName, iconURL: message.author.displayAvatarURL() })

    .setDescription(message.content || '(no text)')

    .setColor(0x3498DB)

    .setTimestamp(message.createdTimestamp);



  if (message.attachments?.size > 0) {

    const attachmentLinks = message.attachments

      .map(att => `[${att.name}](${att.url})`)

      .join(', ');

    userMessageEmbed.addFields(

      { name: 'Attachments', value: attachmentLinks, inline: false }

    );

  }



  await thread.send({ embeds: [userMessageEmbed] });

  logger.info({ userId, threadId: thread.id, messageId: message.id }, 'Sent user message to modmail thread');



  const confirmEmbed = new EmbedBuilder()

    .setTitle('Message Received')

    .setColor(0x2ECC71)

    .setDescription('Your message has been sent to staff. They will respond shortly.')

    .setTimestamp();



  await message.author.send({ embeds: [confirmEmbed] }).catch(e => {

    logger.warn({ userId, err: e.message }, 'Failed to send confirmation DM to user');

  });



  logger.info({ userId }, 'Modmail DM processed successfully');

  return true;

}



// Temporary raw gateway listener to detect incoming DM MESSAGE_CREATE payloads.

// This is intentionally minimal and only logs non-guild messages so we can

// verify whether Discord is delivering DM events to this process. Remove

// this after debugging.

try {

  client.on(Events.Raw, packet => {

    try {

      if (packet.t !== 'MESSAGE_CREATE') return;

      const payload = packet.d;

      if (!payload || payload.guild_id) return;

      logger.info({ rawDM: true, packetType: 'raw', messageId: payload.id, channelId: payload.channel_id, authorId: payload.author?.id, content: payload.content }, 'Raw DM message received via Events.Raw');

      handleRawModmailDM(payload).catch(err => {

        logger.error({ err, packet }, 'Raw DM fallback promise rejected via Events.Raw');

      });

    } catch (e) {

      logger.error({ err: e, packet }, 'Error in Events.Raw MESSAGE_CREATE listener');

    }

  });

} catch (e) {

  logger.error({ err: e }, 'Failed to attach Events.Raw listener');

}



try {

  client.ws.on('MESSAGE_CREATE', payload => {

    try {

      if (!payload.guild_id) {

        logger.info({ rawDM: true, packetType: 'ws', messageId: payload.id, channelId: payload.channel_id, authorId: payload.author?.id, content: payload.content }, 'Raw DM MESSAGE_CREATE received via client.ws');

        handleRawModmailDM(payload).catch(err => {

          logger.error({ err, payload }, 'Raw DM fallback promise rejected via client.ws');

        });

      }

    } catch (e) {

      logger.error({ err: e, payload }, 'Error in raw MESSAGE_CREATE listener');

    }

  });

} catch (e) {

  logger.error({ err: e }, 'Failed to attach raw MESSAGE_CREATE listener');

}





// Load command modules from ../commands

const commandsPath = path.join(__dirname, '..', 'commands');

if (fs.existsSync(commandsPath)) {

  const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

  for (const file of commandFiles) {

    try {

      const filePath = path.join(commandsPath, file);

      const command = require(filePath);

      if (command.data && command.execute) client.commands.set(command.data.name, command);

    } catch (e) {

      logger.error({ err: e, file }, 'Failed loading command');

    }

  }

}



const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

let _logChannelWarned = false;

let _cachedLogChannel = null;



async function getLogChannel() {

  if (!LOG_CHANNEL_ID) {

    if (!_logChannelWarned) {

      logger.warn('LOG_CHANNEL_ID is not configured; server log channel disabled');

      _logChannelWarned = true;

    }

    return null;

  }



  if (_cachedLogChannel) return _cachedLogChannel;



  try {

    const channel = await client.channels.fetch(LOG_CHANNEL_ID, { force: true });

    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {

      logger.warn({ channelId: LOG_CHANNEL_ID, channelType: channel?.type }, 'Configured log channel is not sendable');

      return null;

    }

    logger.debug({ channelId: LOG_CHANNEL_ID, channelType: channel.type, guildId: channel.guild?.id }, 'Fetched configured log channel');

    _cachedLogChannel = channel;

    return channel;

  } catch (e) {

    logger.error({ err: e, channelId: LOG_CHANNEL_ID }, 'Failed to fetch log channel');

    return null;

  }

}





async function sendServerLog(guild, embed, dedupeKey) {

  // Log every call to diagnose duplicate logs issue

  logger.info({ guild: guild?.id, key: dedupeKey, hasKey: !!dedupeKey }, 'sendServerLog called');

  

  // If a dedupeKey is provided, check the in-memory cache to avoid duplicate logs

  try {

    if (dedupeKey && !_shouldSendServerLog(dedupeKey)) {

      logger.warn({ guild: guild?.id, key: dedupeKey }, 'In-memory dedupe: suppressing duplicate server log');

      return;

    }

  } catch (e) {

    // if dedupe check fails for any reason, continue to attempt send

    logger.debug({ err: e }, 'Dedupe check failed, proceeding to send');

  }



  const channel = await getLogChannel();

  if (!channel) return;

  try {

    // Additional cross-process dedupe: inspect recent messages in the log channel

    try {

      const recent = await channel.messages.fetch({ limit: 12 });

      const now = Date.now();

      for (const [mid, m] of recent) {

        if (!m.author || !m.embeds || !m.embeds.length) continue;

        if (m.author.id !== client.user.id) continue; // only consider same-bot messages

        const e = m.embeds[0];

        // If dedupeKey is present, prefer matching against embed footer text

        if (dedupeKey && e.footer && e.footer.text && e.footer.text.includes(dedupeKey)) {

          const ageMs = now - (m.createdTimestamp || 0);

          if (ageMs <= SERVER_LOG_DEDUPE_MS) {

            logger.warn({ guild: guild?.id, key: dedupeKey, messageId: m.id }, 'Duplicate server log suppressed by footer match');

            return;

          }

        }

        // fallback: match by title+description

        if (e.title === embed.data?.title && e.description === embed.data?.description) {

          const ageMs = now - (m.createdTimestamp || 0);

          if (ageMs <= SERVER_LOG_DEDUPE_MS) {

            logger.warn({ guild: guild?.id, key: dedupeKey, messageId: m.id }, 'Duplicate server log suppressed by title/description match');

            return;

          }

        }

      }

    } catch (e) {

      // ignore fetch errors and proceed to send

      logger.debug({ err: e }, 'Recent messages fetch failed during dedupe check');

    }



    const msg = await channel.send({ embeds: [embed] });

    logger.info({ guild: guild?.id, channel: LOG_CHANNEL_ID, messageId: msg.id }, 'Server log message sent');

  } catch (e) {

    logger.error({ err: e, guild: guild?.id, channel: LOG_CHANNEL_ID }, 'Failed to send server log message');

  }

}



// Simple in-memory dedupe for server logs to avoid duplicate messages

const _recentServerLogKeys = new Map(); // key -> timestamp

const SERVER_LOG_DEDUPE_MS = 5000;



function _shouldSendServerLog(key) {

  const now = Date.now();

  // prune old entries

  for (const [k, ts] of _recentServerLogKeys) {

    if (now - ts > SERVER_LOG_DEDUPE_MS) _recentServerLogKeys.delete(k);

  }

  if (!_recentServerLogKeys.has(key)) {

    _recentServerLogKeys.set(key, now);

    return true;

  }

  return false;

}



// guild ID -> Map<inviteCode, uses>, used to detect which invite a new member used
const _inviteUsesByGuild = new Map();

async function cacheGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    const uses = new Map(invites.map(inv => [inv.code, inv.uses]));
    _inviteUsesByGuild.set(guild.id, uses);
  } catch (e) {
    logger.debug({ err: e, guild: guild.id }, 'Failed to cache guild invites');
  }
}

// Diffs current invite uses against the cache to find which invite a new
// member came in on, then refreshes the cache. Returns { code, inviterId }
// or null if it can't be determined (e.g. vanity URL, missing permission).
async function resolveJoinInvite(guild) {
  try {
    const invites = await guild.invites.fetch();
    const previous = _inviteUsesByGuild.get(guild.id) || new Map();
    let used = null;

    for (const invite of invites.values()) {
      const prevUses = previous.get(invite.code) ?? 0;
      if (invite.uses > prevUses) {
        used = invite;
        break;
      }
    }

    _inviteUsesByGuild.set(guild.id, new Map(invites.map(inv => [inv.code, inv.uses])));

    if (!used) return null;
    return { code: used.code, inviterId: used.inviter?.id ?? null };
  } catch (e) {
    logger.debug({ err: e, guild: guild.id }, 'Failed to resolve join invite');
    return null;
  }
}

client.once('ready', async () => {

  logger.info({ user: client.user.tag }, 'Logged in');

  logger.info({ channelId: LOG_CHANNEL_ID }, 'Ready handler starting log channel fetch');

  const logChannel = await getLogChannel();

  logger.info({ channelId: LOG_CHANNEL_ID, channelFetched: Boolean(logChannel) }, 'Ready handler finished log channel fetch');

  for (const guild of client.guilds.cache.values()) {
    await cacheGuildInvites(guild);
  }

  const { recoverQueues } = require('../lib/queue8');
  recoverQueues(client).catch(err => logger.error({ err }, 'Queue recovery failed'));

});



client.on('guildCreate', async guild => {

  let addedBy = 'Unknown';

  try {

    const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 30 }).catch(() => null);

    if (auditLogs && auditLogs.entries.first()) {

      const entry = auditLogs.entries.first();

      addedBy = entry.executor ? `<@${entry.executor.id}>` : 'Unknown';

    }

  } catch (e) {

    logger.debug({ err: e }, 'Failed to fetch audit log for guildCreate');

  }

  const embed = new EmbedBuilder()

    .setTitle('Server Joined')

    .setColor(0x2ECC71)

    .setDescription(`Joined server **${guild.name}** (${guild.id})`)

    .addFields(

      { name: 'Added By', value: addedBy, inline: true },

      { name: 'Member Count', value: `${guild.memberCount ?? 'Unknown'}`, inline: true },

      { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true }

    )

    .setTimestamp();

  logger.info({ guild: guild.id, name: guild.name }, 'Joined guild');

  await sendServerLog(guild, embed, `guildCreate:${guild.id}`);

});



client.on('guildDelete', async guild => {

  let removedBy = 'Unknown';

  try {

    const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 30 }).catch(() => null);

    if (auditLogs && auditLogs.entries.first()) {

      const entry = auditLogs.entries.first();

      removedBy = entry.executor ? `<@${entry.executor.id}>` : 'Unknown';

    }

  } catch (e) {

    logger.debug({ err: e }, 'Failed to fetch audit log for guildDelete');

  }

  const embed = new EmbedBuilder()

    .setTitle('Server Removed')

    .setColor(0xE74C3C)

    .setDescription(`Removed from server **${guild.name}** (${guild.id})`)

    .addFields(

      { name: 'Removed By', value: removedBy, inline: true }

    )

    .setTimestamp();

  logger.info({ guild: guild.id, name: guild.name }, 'Removed from guild');

  await sendServerLog(guild, embed, `guildDelete:${guild.id}`);

});



client.on('guildMemberAdd', async member => {

  const createdAt = member.user?.createdAt;
  const ageValue = createdAt
    ? `${createdAt.toLocaleDateString()} ${createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n<t:${Math.floor(createdAt.getTime() / 1000)}:R>`
    : 'Unknown';

  const invite = await resolveJoinInvite(member.guild);

  const embed = new EmbedBuilder()

    .setColor(0x3498DB)

    .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })

    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))

    .setDescription(`<@${member.id}> joined the server.`)

    .addFields(

      { name: 'Age of account:', value: ageValue, inline: false },

      { name: 'Inviter', value: invite?.inviterId ? `<@${invite.inviterId}>` : 'Unknown', inline: true },

      { name: 'Invite Code', value: invite?.code || 'Unknown', inline: true }

    )

    .setFooter({ text: member.guild.name })

    .setTimestamp();



  logger.info({ guild: member.guild.id, user: member.id }, 'Member joined guild');

  await sendServerLog(member.guild, embed, `memberAdd:${member.id}`);

  try {
    const welcomeChannel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID);
    if (welcomeChannel && welcomeChannel.isTextBased()) {
      await welcomeChannel.send(buildWelcomeMessage(member));
    } else {
      logger.warn({ channelId: WELCOME_CHANNEL_ID }, 'Welcome channel not found or not text-based');
    }
  } catch (e) {
    logger.error({ err: e, guild: member.guild.id, user: member.id }, 'Failed to send welcome message');
  }

  try {
    await member.roles.add('1532809524375715860', 'Auto-assigned on join');
  } catch (e) {
    logger.error({ err: e, guild: member.guild.id, user: member.id }, 'Failed to assign member role on join');
  }

});



async function sendQuitterMessage(member) {
  try {
    const leaveChannel = await member.guild.channels.fetch(LEAVE_CHANNEL_ID);
    if (leaveChannel && leaveChannel.isTextBased()) {
      await leaveChannel.send(buildLeaveMessage(member));
    } else {
      logger.warn({ channelId: LEAVE_CHANNEL_ID }, 'Leave channel not found or not text-based');
    }
  } catch (e) {
    logger.error({ err: e, guild: member.guild.id, user: member.id }, 'Failed to send leave message');
  }
}

client.on('guildMemberRemove', async member => {

  // A kick fires guildMemberRemove just like a voluntary leave does, so the
  // only way to tell them apart is a matching, recent MEMBER_KICK audit log entry.
  let kickEntry = null;
  try {
    const auditLogs = await member.guild.fetchAuditLogs({ limit: 5, type: 20 }).catch(() => null);
    kickEntry = auditLogs?.entries.find(entry =>
      entry.targetId === member.id && Date.now() - entry.createdTimestamp < 10000
    ) || null;
  } catch (e) {
    logger.debug({ err: e, guild: member.guild.id, user: member.id }, 'Failed to check audit log for kick');
  }

  if (kickEntry) {
    const kickedBy = kickEntry.executor ? `<@${kickEntry.executor.id}>` : 'Unknown';
    const kickEmbed = new EmbedBuilder()
      .setColor(0xE67E22)
      .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .setDescription(`<@${member.id}> was kicked by ${kickedBy}.`)
      .setFooter({ text: member.guild.name })
      .setTimestamp();

    logger.info({ guild: member.guild.id, user: member.id, kickedBy: kickEntry.executor?.id }, 'Member kicked');
    await sendServerLog(member.guild, kickEmbed, `memberKick:${member.id}:${kickEntry.id}`);
    await sendQuitterMessage(member);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xE67E22)
    .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setDescription(`<@${member.id}> left.`)
    .setFooter({ text: member.guild.name })
    .setTimestamp();

  logger.info({ guild: member.guild.id, user: member.id }, 'Member left guild');

  await sendServerLog(member.guild, embed, `memberRemove:${member.id}`);
  await sendQuitterMessage(member);

});



client.on('messageDelete', async message => {

  const guild = message.guild;

  if (!guild) return;

  // Try to fetch partial message if possible to obtain content

  if (message.partial) {

    try { await message.fetch(); } catch (e) { /* ignore */ }

  }

  const content = message.content || '';

  const authorId = message.author ? message.author.id : null;

  const channelId = message.channel ? message.channel.id : null;

  if (channelId && EXCLUDED_SOURCE_CHANNELS.has(channelId)) {

    logger.debug({ guild: guild.id, channel: channelId, messageId: message.id }, 'Ignoring deletion log for excluded source channel');

    return;

  }

  if (isQueueRelatedChannel(message.channel)) return;



  const embed = new EmbedBuilder()

    .setTitle('Message Deleted')

    .setColor(0xE74C3C)

    .setDescription(`Message sent by <@${authorId || 'unknown'}> deleted in <#${channelId || 'unknown'}>`)

    .addFields(

      { name: 'Old', value: content ? `\`\`\`\n${content.slice(0, 1000)}\n\`\`\`` : 'No content available', inline: false }

    )

    .setFooter({ text: guild.name })

    .setTimestamp();



  logger.info({ guild: guild.id, channel: channelId, messageId: message.id }, 'Message deleted');

  await sendServerLog(guild, embed);

});



client.on('messageDeleteBulk', async messages => {

  if (!messages.size) return;

  const first = messages.first();

  if (!first || !first.guild) return;

  const guild = first.guild;

  const channelId = first.channel ? first.channel.id : null;

  if (channelId && EXCLUDED_SOURCE_CHANNELS.has(channelId)) {

    logger.debug({ guild: guild.id, channel: channelId, count: messages.size }, 'Ignoring bulk deletion log for excluded source channel');

    return;

  }

  if (isQueueRelatedChannel(first.channel)) return;

  let deletedBy = 'Unknown';

  try {

    const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 72 }).catch(() => null);

    if (auditLogs && auditLogs.entries.first()) {

      const entry = auditLogs.entries.first();

      deletedBy = entry.executor ? `<@${entry.executor.id}>` : 'Unknown';

    }

  } catch (e) {

    logger.debug({ err: e }, 'Failed to fetch audit log for messageDeleteBulk');

  }

  const embed = new EmbedBuilder()

    .setTitle('Bulk Message Deletion')

    .setColor(0xE74C3C)

    .setDescription(`${messages.size} messages were deleted in **${guild.name}**`)

    .addFields(

      { name: 'Deleted By', value: deletedBy, inline: true },

      { name: 'Channel', value: first.channel ? `<#${first.channel.id}>` : 'Unknown', inline: true }

    )

    .setTimestamp();

  logger.info({ guild: guild.id, count: messages.size }, 'Bulk message deletion');

  await sendServerLog(guild, embed, `messageDeleteBulk:${guild.id}:${first.channel?.id}:${messages.size}`);

});



client.on('messageUpdate', async (oldMessage, newMessage) => {

  const guild = oldMessage.guild || newMessage.guild;

  if (!guild) return;



  if (oldMessage.partial) {

    try { await oldMessage.fetch(); } catch (e) { /* ignore */ }

  }

  if (newMessage.partial) {

    try { await newMessage.fetch(); } catch (e) { /* ignore */ }

  }



  const oldContent = oldMessage.content ?? '';

  const newContent = newMessage.content ?? '';

  const oldAttachments = oldMessage.attachments?.size ?? 0;

  const newAttachments = newMessage.attachments?.size ?? 0;

  // Discord auto-generates link embeds (e.g. gifs) shortly after a message
  // is sent, which fires messageUpdate with no real content change. Only
  // log when the content or attachments actually changed.
  if (oldContent === newContent && oldAttachments === newAttachments) return;



  const authorId = newMessage.author?.id ?? oldMessage.author?.id ?? 'unknown';

  const isMusicMessage = authorId === client.user?.id && (
    newMessage.embeds?.some(e => e.title === '🎵 Now Playing') ||
    oldMessage.embeds?.some(e => e.title === '🎵 Now Playing') ||
    newMessage.components?.some(row => row.components?.some(c => c.customId?.startsWith('music_') || c.customId === 'play_song_select')) ||
    oldMessage.components?.some(row => row.components?.some(c => c.customId?.startsWith('music_') || c.customId === 'play_song_select'))
  );
  if (isMusicMessage) return;

  const channelId = newMessage.channel?.id ?? oldMessage.channel?.id ?? 'unknown';

  if (channelId && EXCLUDED_SOURCE_CHANNELS.has(channelId)) {

    logger.debug({ guild: guild.id, channel: channelId, messageId: newMessage.id }, 'Ignoring edit log for excluded source channel');

    return;

  }

  if (isQueueRelatedChannel(newMessage.channel ?? oldMessage.channel)) return;

  const jumpUrl = `https://discord.com/channels/${guild.id}/${channelId}/${newMessage.id}`;



  const embed = new EmbedBuilder()

    .setTitle('Message Edited')

    .setColor(0xF1C40F)

    .setDescription(`Message sent by <@${authorId}> edited in <#${channelId}>. [Jump to Message](${jumpUrl})`)

    .addFields(

      { name: 'Old', value: oldContent ? `\`\`\`\n${oldContent.slice(0, 1000)}\n\`\`\`` : 'Unavailable (partial)', inline: false },

      { name: 'New', value: newContent ? `\`\`\`\n${newContent.slice(0, 1000)}\n\`\`\`` : 'No content', inline: false }

    )

    .setFooter({ text: guild.name })

    .setTimestamp();






  logger.info({ guild: guild.id, channel: channelId, messageId: newMessage.id }, 'Message edited');

  await sendServerLog(guild, embed);

});



client.on('channelCreate', async channel => {

  if (!channel.guild) return;

  if (isQueueRelatedChannel(channel)) return;

  let createdBy = 'Unknown';

  try {

    const auditLogs = await channel.guild.fetchAuditLogs({ limit: 1, type: 10 }).catch(() => null);

    if (auditLogs && auditLogs.entries.first()) {

      const entry = auditLogs.entries.first();

      if (entry.targetId === channel.id) {

        createdBy = entry.executor ? `<@${entry.executor.id}>` : 'Unknown';

      }

    }

  } catch (e) {

    logger.debug({ err: e }, 'Failed to fetch audit log for channelCreate');

  }

  const embed = new EmbedBuilder()

    .setTitle('Channel Created')

    .setColor(0x1ABC9C)

    .setDescription(`A new channel was created in **${channel.guild.name}**`)

    .addFields(

      { name: 'Created By', value: createdBy, inline: true },

      { name: 'Channel', value: `<#${channel.id}>`, inline: true },

      { name: 'Type', value: `${channel.type}`, inline: true },

      { name: 'Channel ID', value: channel.id, inline: true }

    )

    .setTimestamp();

  logger.info({ guild: channel.guild.id, channel: channel.id, type: channel.type }, 'Channel created');

  await sendServerLog(channel.guild, embed, `channelCreate:${channel.id}`);

});



client.on('channelDelete', async channel => {

  if (!channel.guild) return;

  if (isQueueRelatedChannel(channel)) return;

  let deletedBy = 'Unknown';

  try {

    const auditLogs = await channel.guild.fetchAuditLogs({ limit: 1, type: 12 }).catch(() => null);

    if (auditLogs && auditLogs.entries.first()) {

      const entry = auditLogs.entries.first();

      deletedBy = entry.executor ? `<@${entry.executor.id}>` : 'Unknown';

    }

  } catch (e) {

    logger.debug({ err: e }, 'Failed to fetch audit log for channelDelete');

  }

  const embed = new EmbedBuilder()

    .setTitle('Channel Deleted')

    .setColor(0xE74C3C)

    .setDescription(`Channel **${channel.name}** (<#${channel.id}>) was deleted from **${channel.guild.name}**`)

    .addFields(

      { name: 'Deleted By', value: deletedBy, inline: true },

      { name: 'Channel ID', value: channel.id, inline: true },

      { name: 'Type', value: `${channel.type}`, inline: true }

    )

    .setTimestamp();

  logger.info({ guild: channel.guild.id, channel: channel.id, type: channel.type }, 'Channel deleted');

  await sendServerLog(channel.guild, embed, `channelDelete:${channel.id}`);

});



client.on('guildBanAdd', async ban => {

  let bannedBy = 'Unknown';

  let reason = ban.reason || 'No reason provided';

  try {

    const auditLogs = await ban.guild.fetchAuditLogs({ limit: 1, type: 22 }).catch(() => null);

    const entry = auditLogs?.entries.first();

    if (entry && entry.targetId === ban.user.id) {

      bannedBy = entry.executor ? `<@${entry.executor.id}>` : 'Unknown';

      reason = entry.reason || reason;

    }

  } catch (e) {

    logger.debug({ err: e }, 'Failed to fetch audit log for guildBanAdd');

  }

  const embed = new EmbedBuilder()

    .setTitle('Member Banned')

    .setColor(0xE74C3C)

    .setDescription(`<@${ban.user.id}> (${ban.user.tag}) was banned`)

    .addFields(

      { name: 'Banned By', value: bannedBy, inline: true },

      { name: 'Reason', value: reason, inline: false }

    )

    .setFooter({ text: ban.guild.name })

    .setTimestamp();

  logger.info({ guild: ban.guild.id, user: ban.user.id }, 'Member banned');

  await sendServerLog(ban.guild, embed, `banAdd:${ban.guild.id}:${ban.user.id}`);

});



client.on('guildBanRemove', async ban => {

  let unbannedBy = 'Unknown';

  try {

    const auditLogs = await ban.guild.fetchAuditLogs({ limit: 1, type: 23 }).catch(() => null);

    const entry = auditLogs?.entries.first();

    if (entry && entry.targetId === ban.user.id) {

      unbannedBy = entry.executor ? `<@${entry.executor.id}>` : 'Unknown';

    }

  } catch (e) {

    logger.debug({ err: e }, 'Failed to fetch audit log for guildBanRemove');

  }

  const embed = new EmbedBuilder()

    .setTitle('Member Unbanned')

    .setColor(0x2ECC71)

    .setDescription(`<@${ban.user.id}> (${ban.user.tag}) was unbanned`)

    .addFields(

      { name: 'Unbanned By', value: unbannedBy, inline: true }

    )

    .setFooter({ text: ban.guild.name })

    .setTimestamp();

  logger.info({ guild: ban.guild.id, user: ban.user.id }, 'Member unbanned');

  await sendServerLog(ban.guild, embed, `banRemove:${ban.guild.id}:${ban.user.id}`);

});



client.on('channelUpdate', async (oldChannel, newChannel) => {

  if (!newChannel.guild) return;

  const oldSlowmode = oldChannel.rateLimitPerUser ?? 0;

  const newSlowmode = newChannel.rateLimitPerUser ?? 0;

  if (oldSlowmode === newSlowmode) return;

  let changedBy = 'Unknown';

  try {

    const auditLogs = await newChannel.guild.fetchAuditLogs({ limit: 1, type: 11 }).catch(() => null);

    const entry = auditLogs?.entries.first();

    if (entry && entry.targetId === newChannel.id) {

      changedBy = entry.executor ? `<@${entry.executor.id}>` : 'Unknown';

    }

  } catch (e) {

    logger.debug({ err: e }, 'Failed to fetch audit log for channelUpdate slowmode change');

  }

  const embed = new EmbedBuilder()

    .setTitle(newSlowmode > 0 ? 'Slow Mode Activated' : 'Slow Mode Disabled')

    .setColor(newSlowmode > 0 ? 0xF1C40F : 0x2ECC71)

    .setDescription(newSlowmode > 0
      ? `Slow mode set to **${newSlowmode}s** in <#${newChannel.id}>`
      : `Slow mode disabled in <#${newChannel.id}>`)

    .addFields(

      { name: 'Changed By', value: changedBy, inline: true },

      { name: 'Previous', value: `${oldSlowmode}s`, inline: true }

    )

    .setFooter({ text: newChannel.guild.name })

    .setTimestamp();

  logger.info({ guild: newChannel.guild.id, channel: newChannel.id, oldSlowmode, newSlowmode }, 'Channel slow mode changed');

  await sendServerLog(newChannel.guild, embed, `slowmode:${newChannel.id}:${newSlowmode}`);

});



client.on('guildMemberUpdate', async (oldMember, newMember) => {

  if (!newMember || !newMember.guild) return;



  try {

    if (oldMember?.partial) await oldMember.fetch();

    if (newMember?.partial) await newMember.fetch();

  } catch (e) {

    logger.debug({ err: e }, 'Failed to fetch partial guild members for update event');

  }



  const changes = [];



  // Nickname change

  const oldNick = oldMember?.nickname ?? oldMember?.user?.username;

  const newNick = newMember.nickname ?? newMember.user.username;

  if (oldNick !== newNick) {

    changes.push({ type: 'nick', before: oldNick, after: newNick });

  }



  // Timeout change
  const oldTimeout = oldMember?.communicationDisabledUntilTimestamp ?? null;
  const newTimeout = newMember.communicationDisabledUntilTimestamp ?? null;
  if (oldTimeout !== newTimeout) {
    changes.push({ type: 'timeout', before: oldTimeout, after: newTimeout });
  }



  // Role changes: compute added and removed roles (excluding @everyone)

  const oldRoles = oldMember ? new Set(oldMember.roles.cache.filter(r => r.id !== oldMember.guild.id).map(r => r.id)) : new Set();

  const newRoles = new Set(newMember.roles.cache.filter(r => r.id !== newMember.guild.id).map(r => r.id));

  const added = [];

  const removed = [];

  for (const id of newRoles) if (!oldRoles.has(id)) {

    const role = newMember.guild.roles.cache.get(id);

    if (role) added.push(role.name);

  }

  for (const id of oldRoles) if (!newRoles.has(id)) {

    const role = oldMember.guild.roles.cache.get(id);

    if (role) removed.push(role.name);

  }

  if (added.length || removed.length) {

    changes.push({ type: 'roles', added, removed });

  }




  if (changes.length === 0) return;

  let changedBy = 'Unknown';

  if (changes.some(c => c.type === 'roles')) {

    try {

      const auditLogs = await newMember.guild.fetchAuditLogs({ limit: 1, type: 25 }).catch(() => null);

      if (auditLogs && auditLogs.entries.first()) {

        const entry = auditLogs.entries.first();

        if (entry.targetId === newMember.id) {

          changedBy = entry.executor ? `<@${entry.executor.id}>` : 'Unknown';

        }

      }

    } catch (e) {

      logger.debug({ err: e }, 'Failed to fetch audit log for guildMemberUpdate role change');

    }

  } else if (changes.some(c => c.type === 'nick' || c.type === 'timeout')) {

    try {

      const auditLogs = await newMember.guild.fetchAuditLogs({ limit: 1, type: 24 }).catch(() => null);

      if (auditLogs && auditLogs.entries.first()) {

        const entry = auditLogs.entries.first();

        if (entry.targetId === newMember.id) {

          changedBy = entry.executor ? `<@${entry.executor.id}>` : 'Unknown';

        }

      }

    } catch (e) {

      logger.debug({ err: e }, 'Failed to fetch audit log for guildMemberUpdate nickname/timeout change');

    }

  }

  const embed = new EmbedBuilder()

    .setColor(0x3498DB)

    .setAuthor({ name: newMember.user.username, iconURL: newMember.user.displayAvatarURL() })

    .setThumbnail(newMember.user.displayAvatarURL({ size: 256 }))

    .setDescription(`<@${newMember.id}> has been updated.`)

    .setFooter({ text: newMember.guild.name })

    .setTimestamp();



  const roleChange = changes.find(c => c.type === 'roles');

  if (roleChange) {

    const roleLines = [];

    if (roleChange.added.length) roleLines.push(...roleChange.added.map(role => `✅ ${role}`));

    if (roleChange.removed.length) roleLines.push(...roleChange.removed.map(role => `⛔ ${role}`));



    embed.addFields(

      { name: 'Roles :', value: roleLines.length ? roleLines.join('\n') : 'None', inline: false }

    );

  }



  embed.addFields({ name: 'Changed By', value: changedBy, inline: true });



  const nickChange = changes.find(c => c.type === 'nick');

  if (nickChange) {

    embed.addFields(

      { name: 'Nickname Changed', value: `\`${nickChange.before}\` → \`${nickChange.after}\``, inline: false }

    );

  }



  const timeoutChange = changes.find(c => c.type === 'timeout');

  if (timeoutChange) {

    const value = timeoutChange.after
      ? `Timed out until <t:${Math.floor(timeoutChange.after / 1000)}:f>`
      : 'Timeout removed';

    embed.addFields(
      { name: 'Timeout', value, inline: false }
    );

  }



  logger.info({ guild: newMember.guild.id, user: newMember.id, changes }, 'Member updated');

  await sendServerLog(newMember.guild, embed);

});

async function handleReactionRoleButton(interaction) {
  if (!interaction.guild) return;

  const roleEntryId = interaction.customId.replace(/^rr_/, '');
  const config = loadReactionRolesConfig();
  const roleEntry = getReactionRoleEntry(config, roleEntryId);

  if (!roleEntry) {
    return interaction.reply({ content: '❌ Unknown role button.', ephemeral: true });
  }

  try {
    const hasRole = interaction.member.roles.cache.has(roleEntry.roleId);
    if (hasRole) {
      await interaction.member.roles.remove(roleEntry.roleId);
      await interaction.reply({ content: `➖ Removed the **${roleEntry.label}** role.`, ephemeral: true });
    } else {
      await interaction.member.roles.add(roleEntry.roleId);
      await interaction.reply({ content: `➕ Added the **${roleEntry.label}** role.`, ephemeral: true });
    }
  } catch (e) {
    logger.error({ err: e, roleId: roleEntry.roleId, userId: interaction.user.id }, 'Failed to toggle reaction role');
    await interaction.reply({ content: '❌ Failed to update your roles. The bot may be missing permissions.', ephemeral: true });
  }
}



async function finalizeApplicationDecision(interaction, applicationId, decision, reason) {
  const config = loadApplicationsConfig();
  const applications = readApplications();
  const idx = applications.findIndex(a => a.id === applicationId);

  if (idx === -1) {
    return interaction.reply({ content: '❌ Could not find that application (it may have already been processed).', ephemeral: true });
  }

  const application = applications[idx];
  if (application.status !== 'Pending') {
    return interaction.reply({ content: `❌ This application was already **${application.status}**.`, ephemeral: true });
  }

  const category = config.categories.find(c => c.id === application.categoryId);

  application.status = decision === 'approve' ? 'Approved' : 'Denied';
  application.reviewedBy = interaction.user.id;
  application.reviewedAt = Date.now();
  if (reason) application.reason = reason;
  applications[idx] = application;
  writeApplications(applications);

  if (decision === 'approve' && category?.rolesOnApproval?.length) {
    try {
      const targetMember = await interaction.guild.members.fetch(application.userId);
      for (const roleId of category.rolesOnApproval) {
        await targetMember.roles.add(roleId).catch(e =>
          logger.warn({ err: e, applicationId, roleId }, 'Failed to add role on application approval')
        );
      }
    } catch (e) {
      logger.warn({ err: e, applicationId }, 'Failed to fetch member to add approval roles');
    }
  }

  const templateKey = decision === 'approve' ? 'approved' : 'denied';
  const defaultMsg = decision === 'approve'
    ? '✅ Your **%applicationName%** application has been approved!%reason%'
    : '❌ Your **%applicationName%** application has been denied.%reason%';
  const dmMsg = fillApplicationTemplate(config.messages?.[templateKey] || defaultMsg, {
    applicationName: application.categoryName,
    reason: reason ? ` Reason: ${reason}` : ''
  });

  try {
    const targetUser = await interaction.client.users.fetch(application.userId);
    await targetUser.send(dmMsg);
  } catch (e) {
    logger.warn({ err: e, applicationId }, 'Failed to DM applicant their decision');
  }

  const decisionLabel = decision === 'approve' ? `💚 Approved by ${interaction.user}` : `❤️ Denied by ${interaction.user}`;
  const summary = `${decisionLabel} — **${application.categoryName}** application from <@${application.userId}>${reason ? `\nReason: ${reason}` : ''}`;

  try {
    await interaction.update({ content: summary, embeds: [], components: [] });
  } catch (e) {
    // interaction may have come from a modal submit (no prior message to update directly); fall back to editing the original message
    try {
      const channel = await interaction.client.channels.fetch(application.notificationChannelId);
      const msg = await channel.messages.fetch(application.notificationMessageId);
      await msg.edit({ content: summary, embeds: [], components: [] });
      await interaction.reply({ content: 'Decision recorded.', ephemeral: true });
    } catch (e2) {
      logger.warn({ err: e2, applicationId }, 'Failed to update application notification message after decision');
    }
  }

  logger.info({ applicationId, decision, reviewedBy: interaction.user.id }, 'Application decision recorded');
}

async function handleApplicationDecisionButton(interaction) {
  if (!interaction.guild) return;

  const config = loadApplicationsConfig();
  const applicationId = interaction.customId.replace(/^app_(approve|deny)_/, '');
  const decision = interaction.customId.startsWith('app_approve_') ? 'approve' : 'deny';

  const applications = readApplications();
  const application = applications.find(a => a.id === applicationId);
  if (!application) {
    return interaction.reply({ content: '❌ Could not find that application.', ephemeral: true });
  }

  const category = config.categories.find(c => c.id === application.categoryId);
  if (category?.requireRoleToProcess && !applicantHasAnyRole(interaction.member, category.processRoleIds)) {
    return interaction.reply({ content: '❌ You are not authorized to process this application.', ephemeral: true });
  }

  if (config.requireReasonOnDecision) {
    const modal = new ModalBuilder()
      .setCustomId(`app_modal_${decision}_${applicationId}`)
      .setTitle(decision === 'approve' ? 'Approve Application' : 'Deny Application');

    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Reason (shown to the applicant)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    return interaction.showModal(modal);
  }

  await finalizeApplicationDecision(interaction, applicationId, decision, null);
}

async function handleApplicationDecisionModal(interaction) {
  const match = interaction.customId.match(/^app_modal_(approve|deny)_(.+)$/);
  if (!match) return;
  const [, decision, applicationId] = match;
  const reason = interaction.fields.getTextInputValue('reason');
  await finalizeApplicationDecision(interaction, applicationId, decision, reason);
}



client.on('interactionCreate', async interaction => {
  try {

  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command?.autocomplete) {
      try { await command.autocomplete(interaction); } catch (e) { logger.warn({ err: e }, 'autocomplete error'); }
    }
    return;
  }

  if (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand()) {

    try {

      const MUSIC_COMMANDS = new Set(['play', 'skip', 'stop', 'queue', 'pause']);
      const QUEUE8_COMMANDS = new Set(['startqueue', 'stopqueue', 'testqueue', 'renamequeue', 'lockqueue', 'unlockqueue', 'cancel', 'outcomecancel', '8srating', '8sleaderboard', '8sreset']);
      if (!MUSIC_COMMANDS.has(interaction.commandName) && !QUEUE8_COMMANDS.has(interaction.commandName)) {
        logger.info({ user: interaction.user?.id, command: interaction.commandName, guild: interaction.guildId }, 'Interaction received');
      }

    } catch (e) {

      // ignore logging errors

    }

    // /close — runs the modmail close flow in the current channel.
    if (interaction.commandName === 'close') {
      if (!interaction.guild || interaction.channel.parentId !== MODMAIL_CATEGORY_ID) {
        return interaction.reply({ content: '❌ This command can only be used inside a modmail ticket channel.', ephemeral: true });
      }
      const threadId = interaction.channel.id;
      let userId = null;
      for (const [uid, tid] of _modmailThreadMap) {
        if (tid === threadId) { userId = uid; break; }
      }
      if (!userId) {
        try {
          const oldest = await interaction.channel.messages.fetch({ limit: 5, after: '0' });
          for (const m of oldest.values()) {
            const embed = m.embeds?.[0];
            if (embed?.title?.startsWith('Modmail Started')) {
              const userField = embed.fields?.find(f => f.name === 'User');
              const mention = embed.description?.match(/<@!?(\d+)>/);
              const idMatch = userField?.value?.match(/\((\d+)\)/) || mention;
              if (idMatch) { userId = idMatch[1]; _modmailThreadMap.set(userId, threadId); }
              break;
            }
          }
        } catch (e) { logger.warn({ err: e, threadId }, 'close slash: failed to recover user ID'); }
      }
      if (!userId) {
        return interaction.reply({ content: '❌ Could not identify the user for this ticket. Try closing manually.', ephemeral: true });
      }
      await interaction.deferReply();
      try {
        const userObj = await client.users.fetch(userId);
        const { EmbedBuilder } = require('discord.js');
        const closeEmbed = new EmbedBuilder()
          .setTitle('Modmail Closed')
          .setColor(0xE74C3C)
          .setDescription('This modmail conversation has been closed by staff. If you need further assistance, you can DM the bot again.')
          .setTimestamp();
        await userObj.send({ embeds: [closeEmbed] }).catch(e => logger.warn({ userId, err: e }, 'close slash: failed to DM user'));

        const fetched = await interaction.channel.messages.fetch({ limit: 100 });
        const msgs = Array.from(fetched.values()).reverse();
        const lines = msgs.map(m => `${new Date(m.createdTimestamp).toISOString()} ${m.author.tag}: ${m.content || '[embed/attachment]'}`);
        const logChannel = await client.channels.fetch(MODMAIL_LOG_CHANNEL_ID).catch(() => null);
        if (logChannel?.isTextBased()) {
          await logChannel.send({ files: [{ attachment: Buffer.from(lines.join('\n'), 'utf8'), name: `modmail-${userId}-${threadId}.txt` }] });
          const summaryEmbed = new EmbedBuilder().setTitle('Modmail Ticket Logged').setColor(0x95A5A6)
            .setDescription(`Ticket for <@${userId}> logged by ${interaction.user.tag}`)
            .addFields({ name: 'Channel', value: `<#${threadId}>`, inline: true }).setTimestamp();
          await logChannel.send({ embeds: [summaryEmbed] }).catch(() => {});
        }

        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false }).catch(() => {});
        await interaction.channel.setName(`closed-${interaction.channel.name}`).catch(() => {});
        _modmailThreadMap.delete(userId);

        const archiveEmbed = new EmbedBuilder().setTitle('Ticket Closed').setColor(0x95A5A6)
          .setDescription(`Modmail ticket closed by ${interaction.user.tag}`).setTimestamp();
        await interaction.editReply({ embeds: [archiveEmbed] });

        const guildMember = interaction.guild.members.me || await interaction.guild.members.fetch(client.user.id).catch(() => null);
        const perms = interaction.channel.permissionsFor(guildMember);
        if (perms?.has(PermissionsBitField.Flags.ManageChannels)) {
          await interaction.channel.delete('Modmail closed by staff');
        }
      } catch (e) {
        logger.error({ userId, threadId, err: e }, 'close slash: failed');
        await interaction.editReply({ content: '❌ Something went wrong closing the ticket.' });
      }
      return;
    }

    // /modmail — open a modmail ticket from inside the guild.
    if (interaction.commandName === 'modmail') {
      const supplied = interaction.options.getString('message') || '';
      try {
        const category = await client.channels.fetch(MODMAIL_CATEGORY_ID);
        if (!category || category.type !== ChannelType.GuildCategory) {
          return interaction.reply({ content: '❌ Modmail system is not configured correctly.', ephemeral: true });
        }
        const guild = category.guild;
        const baseName = interaction.user.username || `user-${interaction.user.id}`;
        const safeName = `modmail-${baseName.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90)}`;
        const chan = await guild.channels.create({ name: safeName, type: ChannelType.GuildText, parent: category.id, reason: 'Modmail ticket created via /modmail' });
        _modmailThreadMap.set(interaction.user.id, chan.id);
        const { EmbedBuilder } = require('discord.js');
        const infoEmbed = new EmbedBuilder()
          .setTitle('Modmail Started (via command)')
          .setColor(0x3498DB)
          .setDescription(`User <@${interaction.user.id}> started modmail via command.`)
          .addFields({ name: 'User', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true })
          .setTimestamp();
        await chan.send({ embeds: [infoEmbed] });
        if (supplied) {
          const { EmbedBuilder: EB2 } = require('discord.js');
          const userEmbed = new EB2().setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
            .setDescription(supplied).setColor(0x3498DB).setTimestamp();
          await chan.send({ embeds: [userEmbed] });
        }
        await interaction.reply({ content: 'Your message has been sent to staff via modmail.', ephemeral: true });
        logger.info({ userId: interaction.user.id, channelId: chan.id }, 'Created modmail channel via /modmail slash command');
      } catch (e) {
        logger.error({ err: e, userId: interaction.user.id }, 'modmail slash: failed');
        await interaction.reply({ content: '❌ Failed to open modmail channel.', ephemeral: true });
      }
      return;
    }

    const command = client.commands.get(interaction.commandName);

    if (!command) return;

    try {

      await command.execute(interaction);

    } catch (err) {

      logger.error({ err }, 'Command error');

      if (interaction.replied || interaction.deferred) {

        try { await interaction.followUp({ content: 'There was an error executing that command.', ephemeral: true }); } catch (e) {}

      } else {

        try { await interaction.reply({ content: 'There was an error executing that command.', ephemeral: true }); } catch (e) {}

      }

    }

    return;

  }



  if (interaction.isStringSelectMenu() && interaction.customId === 'application_category_select') {
    await startApplicationFlow(interaction, interaction.values[0]);
    // Reset the dropdown so the same option can be selected again
    interaction.message.edit({ components: interaction.message.components }).catch(() => {});
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('music_')) {
    const { canUseMusic } = require('../lib/musicPermissions');
    if (!canUseMusic(interaction.member)) {
      await interaction.reply({ content: '❌ You need the VIP or Staff role to use music commands.', ephemeral: true });
      return;
    }
    const { skip, stop: musicStop, pause, resume, getQueue, shuffleQueue } = require('../lib/musicPlayer');
    const id = interaction.customId;
    if (id === 'music_shuffle') {
      const shuffled = shuffleQueue(interaction.guildId);
      await interaction.reply({ content: shuffled ? '🔀 Queue shuffled.' : '❌ Nothing in the queue to shuffle.', ephemeral: true });
    } else if (id === 'music_skip') {
      const skipped = skip(interaction.guildId);
      await interaction.reply({ content: skipped ? '⏭ Skipped.' : '❌ Nothing playing.', ephemeral: true });
    } else if (id === 'music_stop') {
      await musicStop(interaction.guildId);
      await interaction.reply({ content: '⏹ Stopped and left the channel.', ephemeral: true });
    } else if (id === 'music_pause') {
      const { current } = getQueue(interaction.guildId);
      if (!current) return interaction.reply({ content: '❌ Nothing playing.', ephemeral: true });
      const paused = pause(interaction.guildId);
      if (paused) {
        await interaction.update({ components: [new (require('discord.js').ActionRowBuilder)().addComponents(
          new (require('discord.js').ButtonBuilder)().setCustomId('music_skip').setLabel('⏭ Skip').setStyle(2),
          new (require('discord.js').ButtonBuilder)().setCustomId('music_resume').setLabel('▶ Resume').setStyle(1),
          new (require('discord.js').ButtonBuilder)().setCustomId('music_shuffle').setLabel('🔀 Shuffle').setStyle(2),
          new (require('discord.js').ButtonBuilder)().setCustomId('music_stop').setLabel('⏹ Stop').setStyle(4),
        )] });
      } else {
        await interaction.reply({ content: '❌ Nothing playing.', ephemeral: true });
      }
    } else if (id === 'music_resume') {
      resume(interaction.guildId);
      await interaction.update({ components: [new (require('discord.js').ActionRowBuilder)().addComponents(
        new (require('discord.js').ButtonBuilder)().setCustomId('music_skip').setLabel('⏭ Skip').setStyle(2),
        new (require('discord.js').ButtonBuilder)().setCustomId('music_pause').setLabel('⏸ Pause').setStyle(2),
        new (require('discord.js').ButtonBuilder)().setCustomId('music_shuffle').setLabel('🔀 Shuffle').setStyle(2),
        new (require('discord.js').ButtonBuilder)().setCustomId('music_stop').setLabel('⏹ Stop').setStyle(4),
      )] });
    }
    return;
  }

  if (interaction.isButton() && (interaction.customId.startsWith('app_approve_') || interaction.customId.startsWith('app_deny_'))) {
    await handleApplicationDecisionButton(interaction);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('app_modal_')) {
    await handleApplicationDecisionModal(interaction);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('rr_')) {
    await handleReactionRoleButton(interaction);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('editmsg_modal_')) {
    await handleEditMessageModal(interaction);
    return;
  }

  if (interaction.isButton() && (interaction.customId === 'q8_join' || interaction.customId === 'q8_leave' || interaction.customId === 'q8_clear')) {
    const { joinQueue, leaveQueue, clearQueue } = require('../lib/queue8');
    const id = interaction.customId;
    if (id === 'q8_join') {
      await interaction.deferUpdate();
      const result = await joinQueue(interaction.channelId, interaction.member);
      if (result.status === 'already_in') return interaction.followUp({ content: '❌ You are already in the queue.', ephemeral: true });
      if (result.status === 'inactive') return interaction.followUp({ content: '❌ No active queue.', ephemeral: true });
      if (result.status === 'locked') return interaction.followUp({ content: '🔒 The queue is currently locked by staff.', ephemeral: true });
      if (result.status === 'must_vote') return interaction.followUp({ content: '❌ You must vote on the current match result before re-queuing.', ephemeral: true });
      if (result.status === 'banned') {
        const { getBan } = require('../lib/queue_ratings');
        const ban = getBan(interaction.guildId, interaction.user.id);
        const expiry = ban?.expires_at ? ` Ban expires <t:${Math.floor(ban.expires_at / 1000)}:R>.` : '';
        return interaction.followUp({ content: `❌ You are banned from the 8s queue.${expiry}`, ephemeral: true });
      }
      return;
    }
    if (id === 'q8_leave') {
      await interaction.deferUpdate();
      const result = await leaveQueue(interaction.channelId, interaction.user.id);
      if (result.status === 'not_in') return interaction.followUp({ content: '❌ You are not in the queue.', ephemeral: true });
      if (result.status === 'inactive') return interaction.followUp({ content: '❌ No active queue.', ephemeral: true });
      return;
    }
    if (id === 'q8_clear') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '❌ Only staff can clear the queue.', ephemeral: true });
      }
      await interaction.deferUpdate();
      await clearQueue(interaction.channelId);
      return;
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('q8_pick_')) {
    const { handlePick } = require('../lib/queue8');
    const captainId = interaction.customId.slice('q8_pick_'.length);
    const pickedId = interaction.values[0];
    await interaction.deferUpdate();
    const result = await handlePick(interaction.channelId, captainId, pickedId);
    if (result.status === 'not_your_turn') {
      return interaction.followUp({ content: "❌ It's not your turn to pick.", ephemeral: true });
    }
    return;
  }

  if (interaction.isButton() && (interaction.customId === 'q8_vote_A' || interaction.customId === 'q8_vote_B')) {
    const { handleMatchVote } = require('../lib/queue8');
    const vote = interaction.customId === 'q8_vote_A' ? 'A' : 'B';
    await interaction.deferUpdate();
    const result = await handleMatchVote(interaction.channelId, interaction.user.id, vote);
    if (result.status === 'not_in_match') return interaction.followUp({ content: '❌ You were not in this match.', ephemeral: true });
    if (result.status === 'already_voted') return interaction.followUp({ content: '❌ You already voted.', ephemeral: true });
    if (result.status === 'no_match') return interaction.followUp({ content: '❌ No active match to vote on.', ephemeral: true });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('q8_method_')) {
    const { handleMethodVote, finalizeMethodVote } = require('../lib/queue8');
    const method = interaction.customId.slice('q8_method_'.length);
    if (method === 'decide') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '❌ Only staff can decide the method early.', ephemeral: true });
      }
      await interaction.deferUpdate();
      await finalizeMethodVote(interaction.channelId);
    } else {
      await interaction.deferUpdate();
      const result = await handleMethodVote(interaction.channelId, interaction.user.id, method);
      if (result.status === 'not_in_queue') return interaction.followUp({ content: '❌ You are not in this queue.', ephemeral: true });
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('q8_mode_')) {
    const { handleFormatVote, finalizeFormatVote } = require('../lib/queue8');
    const format = interaction.customId.slice('q8_mode_'.length);
    if (format === 'decide') {
      if (!interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '❌ Only staff can decide the format early.', ephemeral: true });
      }
      await interaction.deferUpdate();
      await finalizeFormatVote(interaction.channelId);
    } else {
      await interaction.deferUpdate();
      const result = await handleFormatVote(interaction.channelId, interaction.user.id, format);
      if (result.status === 'not_in_queue') return interaction.followUp({ content: '❌ You are not in this queue.', ephemeral: true });
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'q8_capvote') {
    const { handleCaptainVote } = require('../lib/queue8');
    await interaction.deferUpdate();
    await handleCaptainVote(interaction.channelId, interaction.user.id, interaction.values);
    return;
  }

  if (interaction.isButton() && interaction.customId === 'q8_capvote_random') {
    const { randomizeCaptains } = require('../lib/queue8');
    await interaction.deferUpdate();
    const result = await randomizeCaptains(interaction.channelId, interaction.user.id);
    if (result.status === 'not_in_queue') return interaction.followUp({ content: '❌ You are not in this queue.', ephemeral: true });
    return;
  }

  if (interaction.isButton() && interaction.customId === 'q8_cancel_vote') {
    const { handleCancelVote } = require('../lib/queue8');
    await interaction.deferUpdate();
    const result = await handleCancelVote(interaction.channelId, interaction.user.id);
    if (result.status === 'not_in_match') return interaction.followUp({ content: '❌ You are not in this match.', ephemeral: true });
    if (result.status === 'no_match') return interaction.followUp({ content: '❌ No active match.', ephemeral: true });
    return;
  }

  if (interaction.isButton() && interaction.customId === 'q8_capvote_end') {
    const { finalizeCaptainVote } = require('../lib/queue8');
    if (!interaction.member.permissions.has('ManageGuild')) {
      return interaction.reply({ content: '❌ Only staff can end captain voting early.', ephemeral: true });
    }
    await interaction.deferUpdate();
    await finalizeCaptainVote(interaction.channelId);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('q8_rematch_')) {
    const { handleRematch } = require('../lib/queue8');
    const matchNum = parseInt(interaction.customId.slice('q8_rematch_'.length), 10);
    await interaction.deferUpdate();
    const result = await handleRematch(interaction.guildId, matchNum, interaction.user.id);
    if (result.status === 'not_in_match') return interaction.followUp({ content: '❌ You were not in this match.', ephemeral: true });
    if (result.status === 'no_queue') return interaction.followUp({ content: '❌ The queue is no longer active.', ephemeral: true });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('q8_mvp_') && !interaction.customId.startsWith('q8_mvp_vote_')) {
    const { handleMvpOpen } = require('../lib/queue8');
    const matchNum = parseInt(interaction.customId.slice('q8_mvp_'.length), 10);
    await interaction.deferUpdate();
    await handleMvpOpen(interaction.guildId, matchNum, interaction.channel);
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('q8_mvp_vote_')) {
    const { handleMvpVote } = require('../lib/queue8');
    const matchNum = parseInt(interaction.customId.slice('q8_mvp_vote_'.length), 10);
    await interaction.deferUpdate();
    const result = await handleMvpVote(interaction.guildId, matchNum, interaction.user.id, interaction.values[0]);
    if (result.status === 'not_in_match') return interaction.followUp({ content: '❌ You were not in this match.', ephemeral: true });
    return;
  }

  if (interaction.isButton()) {

    if (!interaction.guild) return;

    const memberPerms = interaction.memberPermissions ?? interaction.member?.permissions;

    if (!memberPerms?.has(PermissionsBitField.Flags.ManageNicknames) && !memberPerms?.has(PermissionsBitField.Flags.Administrator)) {

      return interaction.reply({ content: '❌ You lack the necessary staff credentials to authorize nickname modifications.', ephemeral: true });

    }



    const customId = interaction.customId;

    if (customId.startsWith('nick_approve_')) {

      const parts = customId.split('_');

      const targetUserId = parts[2];

      const encodedName = parts.slice(3).join('_');

      const newName = Buffer.from(encodedName, 'base64url').toString('utf8');



      try {

        const targetMember = await interaction.guild.members.fetch(targetUserId);

        await targetMember.setNickname(newName, `Staff approval by ${interaction.user.tag}`);

        try {

          await targetMember.send(`✅ Your nickname change request has been approved! Your handle is now set to: \`${newName}\`.`);

        } catch (dmErr) {

          // ignore DM failures

        }



        await interaction.update({

          content: `💚 **Request Approved** by ${interaction.user} — applied name \`${newName}\` to <@${targetUserId}>.`,

          components: [],

          embeds: []

        });

      } catch (err) {

        logger.error({ err }, 'Nickname approval failed');

        await interaction.reply({ content: '❌ Failed to modify user nickname. Check if the bot has permission and a high enough role.', ephemeral: true });

      }

      return;

    }



    if (customId.startsWith('nick_deny_')) {

      const parts = customId.split('_');

      const targetUserId = parts[2];

      try {

        const targetMember = await interaction.guild.members.fetch(targetUserId);

        try {

          await targetMember.send('❌ Your nickname change request has been declined by staff.');

        } catch (dmErr) {

          // ignore DM failures

        }

        await interaction.update({

          content: `❤️ **Request Declined** by ${interaction.user} for user <@${targetUserId}>.`,

          components: [],

          embeds: []

        });

      } catch (err) {

        logger.error({ err }, 'Nickname denial failed');

        await interaction.reply({ content: '❌ Problem completing the request. Please check the server state and try again.', ephemeral: true });

      }

      return;

    }

  }

  } catch (err) {
    const _q8cmds = new Set(['startqueue','stopqueue','testqueue','renamequeue','cancel','outcomecancel','8srating','8sleaderboard','8sreset']);
    const isQ8 = interaction.customId?.startsWith('q8_') || _q8cmds.has(interaction.commandName);
    if (!isQ8) logger.error({ err, customId: interaction.customId, commandName: interaction.commandName }, 'interactionCreate: unhandled error, would have crashed the process');
    try {
      if (interaction.isRepliable && interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Something went wrong handling that. Try again.', ephemeral: true });
      }
    } catch (e) {
      // interaction may already be unacknowledged/expired — nothing more we can do
    }
  }

});



client.on(Events.MessageCreate, async message => {

  logger.info({ channelId: message.channelId, authorId: message.author.id, isBot: message.author.bot }, 'MessageCreate event received - NEW DEBUG');

  if (message.author.bot) return;

  // Message forwarding: Copy messages from a source channel to a destination channel.
  // TODO: populate with { sourceId, destId, react } entries for this server, if needed.
  const FORWARD_CONFIGS = [];

  const forwardConfig = FORWARD_CONFIGS.find(c => c.sourceId === message.channelId);

  if (forwardConfig && message.guild) {
    if (forwardConfig.react) {
      try {
        await message.react('👍');
      } catch (e) {
        logger.warn({ err: e, sourceChannel: forwardConfig.sourceId, messageId: message.id }, 'Failed to react to forwarded message');
      }
    }

    try {
      logger.info({ sourceChannel: forwardConfig.sourceId, destChannel: forwardConfig.destId, messageId: message.id }, 'Attempting to forward message');
      const destChannel = await message.guild.channels.fetch(forwardConfig.destId);
      if (destChannel && destChannel.isTextBased()) {
        const lines = [message.content || '(no text)'];
        if (message.attachments.size > 0) {
          lines.push(...message.attachments.map(a => a.url));
        }

        await destChannel.send({ content: lines.join('\n') });
        logger.info({ sourceChannel: forwardConfig.sourceId, destChannel: forwardConfig.destId, messageId: message.id }, 'Message forwarded successfully');
      } else {
        logger.warn({ destChannel: forwardConfig.destId }, 'Destination channel not found or not text-based');
      }
    } catch (e) {
      logger.error({ err: e, sourceChannel: forwardConfig.sourceId, destChannel: forwardConfig.destId }, 'Failed to forward message');
    }
  }

  const messageInfo = {

    messageId: message.id,

    authorId: message.author.id,

    authorTag: message.author.tag,

    channelId: message.channel?.id,

    channelType: message.channel?.type,

    guildId: message.guild?.id,

    isThread: message.channel.isThread?.(),

    contentPreview: message.content?.slice(0, 120)

  };

  logger.info(messageInfo, 'messageCreate received');



  // Log DMs specifically for debugging

  if (!message.guild) {

    logger.info({ ...messageInfo, isDM: true }, 'Received non-guild message (likely DM)');

  }






  // Skip modmail entirely for users mid-application — their DM replies are
  // answers being collected by the application flow, not support requests.
  if (!message.guild && isApplying(message.author.id)) {

    return;

  }



  // MODMAIL: Handle direct messages from users

  if (await handleDirectModmailDM(message, 'messageCreate')) {

    return;

  }



  // MODMAIL: Handle staff messages in ticket channels (channels under the modmail category)

  if (message.guild && message.channel.parentId === MODMAIL_CATEGORY_ID) {

    const threadId = message.channel.id;

    let userId = null;



    // Find the user ID associated with this thread

    for (const [uid, tid] of _modmailThreadMap) {

      if (tid === threadId) {

        userId = uid;

        break;

      }

    }



    // The map above is in-memory only and is wiped on bot restart, so tickets
    // opened before the last restart won't be found there. Fall back to
    // reading the user ID out of the channel's original "Modmail Started"
    // embed, which every ticket channel has as one of its first messages.
    if (!userId) {

      try {

        const oldest = await message.channel.messages.fetch({ limit: 5, after: '0' });

        for (const m of oldest.values()) {

          const embed = m.embeds?.[0];

          if (embed?.title?.startsWith('Modmail Started')) {

            const userField = embed.fields?.find(f => f.name === 'User');

            const mention = embed.description?.match(/<@!?(\d+)>/);

            const idMatch = userField?.value?.match(/\((\d+)\)/) || mention;

            if (idMatch) {

              userId = idMatch[1];

              _modmailThreadMap.set(userId, threadId);

            }

            break;

          }

        }

      } catch (e) {

        logger.warn({ err: e, threadId }, 'Failed to recover user ID from modmail channel history');

      }

    }



    if (!userId) {

      logger.warn({ threadId }, 'Could not find user ID for modmail channel');

      return;

    }



    // Check if it's a close command

    if (MODMAIL_CLOSE_COMMAND.test(message.content)) {

      try {

        const userObj = await client.users.fetch(userId);

        const closeEmbed = new EmbedBuilder()

          .setTitle('Modmail Closed')

          .setColor(0xE74C3C)

          .setDescription('This modmail conversation has been closed by staff. If you need further assistance, you can DM the bot again.')

          .setTimestamp();



        await userObj.send({ embeds: [closeEmbed] }).catch(e => {

          logger.warn({ userId, err: e }, 'Failed to send close notification to user');

        });



        // Fetch recent messages from the ticket channel and log them

        try {

          const fetched = await message.channel.messages.fetch({ limit: 100 });

          const msgs = Array.from(fetched.values()).reverse();

          const lines = msgs.map(m => `${new Date(m.createdTimestamp).toISOString()} ${m.author.tag}: ${m.content || '[embed/attachment]'}`);

          const text = lines.join('\n');



          const logChannel = await client.channels.fetch(MODMAIL_LOG_CHANNEL_ID).catch(() => null);

          if (logChannel && logChannel.isTextBased()) {

            await logChannel.send({ files: [{ attachment: Buffer.from(text, 'utf8'), name: `modmail-${userId}-${threadId}.txt` }] });

            const summary = new EmbedBuilder()

              .setTitle('Modmail Ticket Logged')

              .setColor(0x95A5A6)

              .setDescription(`Ticket for <@${userId}> logged by ${message.author.tag}`)

              .addFields({ name: 'Channel', value: `<#${threadId}>`, inline: true })

              .setTimestamp();

            await logChannel.send({ embeds: [summary] }).catch(() => {});

          } else {

            logger.warn({ logChannelId: MODMAIL_LOG_CHANNEL_ID }, 'Modmail log channel not found or not text-based');

          }

        } catch (e) {

          logger.error({ err: e, threadId }, 'Failed to collect messages for ticket log');

        }



        // Lock the channel (prevent further sending) and rename

        try {

          await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false }).catch(() => {});

          await message.channel.setName(`closed-${message.channel.name}`).catch(() => {});

        } catch (e) {

          logger.warn({ err: e, threadId }, 'Failed to archive/lock ticket channel');

        }



        _modmailThreadMap.delete(userId);

        logger.info({ userId, threadId }, 'Closed modmail channel');



        const archiveEmbed = new EmbedBuilder()

          .setTitle('Ticket Closed')

          .setColor(0x95A5A6)

          .setDescription(`Modmail ticket closed by ${message.author.tag}`)

          .setTimestamp();

        await message.reply({ embeds: [archiveEmbed] });



        // Attempt to delete the ticket channel after archiving/logging.

        try {

          const guildMember = message.guild?.members?.me || (await message.guild.members.fetch(client.user.id).catch(() => null));

          const perms = message.channel.permissionsFor(guildMember) || message.channel.permissionsFor(client.user);

          const canDelete = perms?.has(PermissionsBitField.Flags.ManageChannels);

          if (!canDelete) {

            logger.warn({ userId, threadId }, 'Bot lacks ManageChannels permission; skipping channel deletion');

          } else {

            logger.info({ userId, threadId }, 'Attempting to delete modmail channel');

            await message.channel.delete('Modmail closed by staff');

            logger.info({ userId, threadId }, 'Deleted modmail channel after close');

          }

        } catch (e) {

          logger.warn({ err: e, userId, threadId }, 'Failed to delete modmail channel after close');

        }

      } catch (e) {

        logger.error({ userId, threadId, err: e }, 'Failed to close modmail channel');

      }

      return;

    }



    // Check if user has staff role

    let isStaff = false;

    if (message.member) {

      isStaff = message.member.roles.cache.has(MODMAIL_STAFF_ROLE_ID);

    }



    if (!isStaff) {

      const noPermEmbed = new EmbedBuilder()

        .setColor(0xE74C3C)

        .setDescription('You do not have permission to respond in modmail threads.');

      await message.reply({ embeds: [noPermEmbed] }).catch(() => {});

      return;

    }



    // Send staff's message to the user

    try {

      const userObj = await client.users.fetch(userId);

      const staffMessageEmbed = new EmbedBuilder()

        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })

        .setDescription(message.content || '(no text)')

        .setColor(0x9B59B6)

        .setTimestamp(message.createdTimestamp);



      if (message.attachments.size > 0) {

        const attachmentLinks = message.attachments

          .map(att => `[${att.name}](${att.url})`)

          .join(', ');

        staffMessageEmbed.addFields(

          { name: 'Attachments', value: attachmentLinks, inline: false }

        );

      }



      await userObj.send({ embeds: [staffMessageEmbed] });

      logger.info({ userId, threadId, staffId: message.author.id }, 'Sent staff message to user');



      // React to show it was delivered

      await message.react('✅').catch(() => {});

    } catch (e) {

      logger.error({ userId, threadId, staffId: message.author.id, err: e }, 'Failed to send staff message to user');

      const errorEmbed = new EmbedBuilder()

        .setColor(0xE74C3C)

        .setDescription(`Failed to send message to user (they may have closed DMs).`);

      await message.reply({ embeds: [errorEmbed] }).catch(() => {});

    }

    return;

  }



  // AUTOMOD: Guild message filtering

  if (!message.guild) return;



  const content = (message.content || '').toLowerCase();

  let foundBannedWord = null;

  for (const word of AUTOMOD_BANNED_WORDS) {

    if (content.includes(word)) {

      foundBannedWord = word;

      break;

    }

  }



  if (!foundBannedWord) return;



  // Check if user is in an allowed channel

  if (AUTOMOD_ALLOWED_CHANNELS.has(message.channelId)) {

    logger.debug({ guild: message.guild.id, user: message.author.id, channel: message.channelId, word: foundBannedWord }, 'Banned word in allowed channel, skipping automod');

    return;

  }



  // Check if user has an allowed role

  let member;

  try {

    member = await message.guild.members.fetch(message.author.id);

    if (member.roles.cache.some(role => AUTOMOD_ALLOWED_ROLES.has(role.id))) {

      logger.debug({ guild: message.guild.id, user: message.author.id, word: foundBannedWord }, 'Banned word from user with allowed role, skipping automod');

      return;

    }

  } catch (e) {

    logger.warn({ guild: message.guild.id, user: message.author.id, err: e }, 'Failed to fetch member for automod role check');

  }



  // Apply timeout and delete message

  try {

    if (!member) member = await message.guild.members.fetch(message.author.id);

    await member.timeout(AUTOMOD_TIMEOUT_MS, `Automod: used banned word "${foundBannedWord}"`);

    logger.info({ guild: message.guild.id, user: message.author.id, word: foundBannedWord, timeout: AUTOMOD_TIMEOUT_MS }, 'Applied automod timeout');



    // Send log to the log channel

    const embed = new EmbedBuilder()

      .setTitle('Automod: User Timeout')

      .setColor(0xFF6B6B)

      .setDescription(`<@${message.author.id}> was timed out by automod`)

      .addFields(

        { name: 'User', value: `${message.author.tag} (${message.author.id})`, inline: true },

        { name: 'Reason', value: `Banned word: **${foundBannedWord}**`, inline: true },

        { name: 'Duration', value: '5 minutes', inline: true },

        { name: 'Channel', value: `<#${message.channelId}>`, inline: true },

        { name: 'Message Content', value: message.content.substring(0, 100) || '(empty)', inline: false }

      )

      .setTimestamp();

    await sendServerLog(message.guild, embed, `automod:${message.author.id}:${foundBannedWord}`);

  } catch (e) {

    logger.error({ guild: message.guild.id, user: message.author.id, err: e }, 'Failed to apply timeout');

  }



  try {

    await message.delete();

    logger.info({ guild: message.guild.id, user: message.author.id, messageId: message.id, word: foundBannedWord }, 'Deleted message with banned word');

  } catch (e) {

    logger.error({ guild: message.guild.id, user: message.author.id, messageId: message.id, err: e }, 'Failed to delete message');

  }

});



const token = process.env.BOT_TOKEN;

if (!token) {

  logger.error('Missing BOT_TOKEN environment variable. Create a .env file or set BOT_TOKEN.');

  process.exit(1);

}



initMusicPlayer(client);
client.login(token).catch(err => {

  logger.error({ err }, 'Failed to login');

  process.exit(1);

});

