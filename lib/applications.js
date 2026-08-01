const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const logger = require('./logger');
const { appendRowSafe } = require('./googleSheets');

const SEASON_REGISTRATION_SHEET_ID = '1Jp_f5J0QvgtGTu-VVA1BnmJNwypwAKZ2ApDUVH6tXCA';
const SEASON_REGISTRATION_SHEET_NAME = 'Sheet1';

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'applications_config.json');
const DATA_PATH = path.join(__dirname, '..', 'data', 'applications.json');
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per question

// Users currently mid-application, so DM message handling elsewhere (e.g.
// modmail) can skip their answers instead of also treating them as a ticket.
const activeApplicants = new Set();

function isApplying(userId) {
  return activeApplicants.has(userId);
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function readApplications() {
  if (!fs.existsSync(DATA_PATH)) fs.writeFileSync(DATA_PATH, '[]', 'utf8');
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
}

function writeApplications(applications) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(applications, null, 2), 'utf8');
}

function getCategory(config, categoryId) {
  return config.categories.find(c => c.id === categoryId);
}

function fillTemplate(template, vars) {
  return Object.entries(vars).reduce(
    (str, [key, value]) => str.split(`%${key}%`).join(value ?? ''),
    template
  );
}

function memberHasAnyRole(member, roleIds) {
  if (!roleIds || roleIds.length === 0) return true;
  return member.roles.cache.some(r => roleIds.includes(r.id));
}

// The dropdown menu posted in the applications info channel
function buildCategorySelectRow(config) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('application_category_select')
    .setPlaceholder('Select an application category...')
    .addOptions(config.categories.slice(0, 25).map(cat => ({
      label: cat.name,
      value: cat.id,
      description: cat.description?.slice(0, 100),
      emoji: cat.emoji || undefined
    })));

  return new ActionRowBuilder().addComponents(menu);
}

// Drives the full DM question/answer flow for a category, then posts the
// result to the category's notification channel. `interaction` can be a
// ChatInputCommandInteraction or a StringSelectMenuInteraction — anything
// with .user, .member, .client, and .reply.
async function startApplicationFlow(interaction, categoryId) {
  const config = loadConfig();
  const category = getCategory(config, categoryId);

  if (!category) {
    return interaction.reply({ content: '❌ Unknown application category.', ephemeral: true });
  }

  if (category.requireRoleToApply && !memberHasAnyRole(interaction.member, category.applyRoleIds)) {
    return interaction.reply({
      content: category.missingRoleError || '❌ You do not meet the requirements to apply for this category.',
      ephemeral: true
    });
  }

  if (config.cooldown?.enabled) {
    const applications = readApplications();
    const last = applications
      .filter(a => a.userId === interaction.user.id && a.categoryId === categoryId)
      .sort((a, b) => b.submittedAt - a.submittedAt)[0];

    if (last) {
      const retryAt = last.submittedAt + config.cooldown.durationMs;
      if (Date.now() < retryAt) {
        const msg = fillTemplate(config.cooldown.message || '⏳ Please wait before applying again.', {
          timeRelative: `<t:${Math.floor(retryAt / 1000)}:R>`,
          timeAbsolute: `<t:${Math.floor(retryAt / 1000)}:f>`
        });
        return interaction.reply({ content: msg, ephemeral: true });
      }
    }
  }

  let dmChannel;
  try {
    dmChannel = await interaction.user.createDM();
    await dmChannel.send(`📋 Starting your **${category.name}** application. Answer each question I send — you have 10 minutes per question. Type \`cancel\` at any time to stop.`);
  } catch (e) {
    return interaction.reply({ content: '❌ I could not DM you. Please enable DMs from server members and try again.', ephemeral: true });
  }

  await interaction.reply({ content: '📬 Check your DMs to continue your application!', ephemeral: true });

  activeApplicants.add(interaction.user.id);

  const answers = [];
  try {
    for (let i = 0; i < category.questions.length; i++) {
      const questionMsg = fillTemplate(
        config.messages?.question || '**Question %currentQuestionNumber%/%amountOfTotalQuestions%**: %question%',
        {
          question: category.questions[i],
          applicationName: category.name,
          currentQuestionNumber: String(i + 1),
          amountOfTotalQuestions: String(category.questions.length)
        }
      );

      try {
        await dmChannel.send(questionMsg);
        const collected = await dmChannel.awaitMessages({
          filter: m => m.author.id === interaction.user.id,
          max: 1,
          time: QUESTION_TIMEOUT_MS
        });
        const reply = collected.first();
        if (!reply) {
          await dmChannel.send('⌛ You took too long to respond. Application cancelled — select the category again to restart.');
          return;
        }
        if ((reply.content || '').trim().toLowerCase() === 'cancel') {
          await dmChannel.send('🛑 Application cancelled. Select the category again if you want to restart.');
          return;
        }
        answers.push({ question: category.questions[i], answer: (reply.content || '(no text)').slice(0, 4000) });
      } catch (e) {
        logger.error({ err: e, userId: interaction.user.id, categoryId }, 'Application question loop failed');
        await dmChannel.send('❌ Something went wrong collecting your application. Please try again later.').catch(() => {});
        return;
      }
    }
  } finally {
    activeApplicants.delete(interaction.user.id);
  }

  const requiresApproval = category.requiresApproval !== false; // defaults to true

  const applicationId = `app_${Date.now()}_${interaction.user.id}`;
  const application = {
    id: applicationId,
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    categoryId,
    categoryName: category.name,
    answers,
    status: requiresApproval ? 'Pending' : 'Approved',
    submittedAt: Date.now()
  };
  if (!requiresApproval) {
    application.reviewedBy = 'auto';
    application.reviewedAt = application.submittedAt;
  }

  const allApplications = readApplications();
  allApplications.push(application);
  writeApplications(allApplications);

  logger.info({ applicationId, userId: interaction.user.id, categoryId, requiresApproval }, 'Application submitted');

  if (categoryId === 'season_registration' && answers.length > 0) {
    const sheetValues = [
      new Date(application.submittedAt).toISOString(),
      interaction.user.tag,
      answers[0].answer
    ];
    logger.info({ spreadsheetId: SEASON_REGISTRATION_SHEET_ID, sheetName: SEASON_REGISTRATION_SHEET_NAME, values: sheetValues }, 'Attempting to append row to Google Sheet');
    const ok = await appendRowSafe(SEASON_REGISTRATION_SHEET_ID, SEASON_REGISTRATION_SHEET_NAME, sheetValues);
    logger.info({ ok }, 'Google Sheet append result');
  }

  if (!requiresApproval && category.rolesOnApproval?.length) {
    try {
      const targetMember = await interaction.guild.members.fetch(interaction.user.id);
      for (const roleId of category.rolesOnApproval) {
        await targetMember.roles.add(roleId).catch(e =>
          logger.warn({ err: e, applicationId, roleId }, 'Failed to add role on no-approval submission')
        );
      }
    } catch (e) {
      logger.warn({ err: e, applicationId }, 'Failed to fetch member to add roles on no-approval submission');
    }
  }

  const notifEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
    .addFields(answers.map(a => ({
      name: a.question,
      value: a.answer || '(no answer)',
      inline: false
    })));

  let components = [];
  if (requiresApproval) {
    const approveButton = new ButtonBuilder().setCustomId(`app_approve_${applicationId}`).setLabel('Approve').setStyle(ButtonStyle.Success);
    const denyButton = new ButtonBuilder().setCustomId(`app_deny_${applicationId}`).setLabel('Deny').setStyle(ButtonStyle.Danger);
    components = [new ActionRowBuilder().addComponents(approveButton, denyButton)];
  }

  if (category.notificationChannelId) {
    try {
      const notifChannel = await interaction.client.channels.fetch(category.notificationChannelId);
      if (notifChannel && notifChannel.isTextBased()) {
        const notifMsg = await notifChannel.send({ embeds: [notifEmbed], components });

        const apps = readApplications();
        const idx = apps.findIndex(a => a.id === applicationId);
        if (idx !== -1) {
          apps[idx].notificationMessageId = notifMsg.id;
          apps[idx].notificationChannelId = notifChannel.id;
          writeApplications(apps);
        }
      } else {
        logger.warn({ categoryId, channelId: category.notificationChannelId }, 'Application notification channel not found or not text-based');
      }
    } catch (e) {
      logger.error({ err: e, applicationId, channelId: category.notificationChannelId }, 'Failed to post application notification');
    }
  }

  const submittedKey = requiresApproval ? 'submitted' : 'registered';
  const defaultSubmittedMsg = requiresApproval
    ? '✅ Your **%applicationName%** application has been submitted!'
    : '✅ Your **%applicationName%** registration is complete!';
  const submittedMsg = fillTemplate(config.messages?.[submittedKey] || defaultSubmittedMsg, {
    applicationName: category.name
  });
  await dmChannel.send(submittedMsg).catch(() => {});
}

module.exports = {
  CONFIG_PATH,
  DATA_PATH,
  loadConfig,
  readApplications,
  writeApplications,
  getCategory,
  fillTemplate,
  memberHasAnyRole,
  buildCategorySelectRow,
  startApplicationFlow,
  isApplying
};
