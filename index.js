// === KEEP ALIVE ===
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(3000, () => console.log('🌐 Server running on port 3000'));

// === BOT SETUP ===
require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder,
    ChannelType,
    Events
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// === CONFIG ===
// Replace these IDs with your own if different (kept as you provided)
const ADMIN_CHANNEL_ID = '1430039834835025920';     // Admin review channel (where staff sees submissions)
const VERIFICATION_LOG_ID = '1342342913585053705';  // Verification log channel (where accepted entries go)
const STAFF_LOG_CHANNEL_ID = '1358627364132884690'; // Staff action log channel (records which staff approved/denied)
const VERIFIED_ROLE_IDS = ['1358619270472401031', '1369025309600518255']; // Roles to add on approval

const GESTURES = ["peace sign ✌️", "thumbs up 👍", "hold up 3 fingers 🤟", "point to the ceiling ☝️", "make a heart with your hands ❤️"];

// --- In-memory maps
const userActiveTicket = new Map();      // userId -> tempChannel
const adminSubmissionMap = new Map();    // userId -> adminMessageId (the admin channel message for this submission)

// === READY ===
client.once(Events.ClientReady, () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

// === UI COMPONENTS ===
class VerifyButton {
    static create() {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('start_verify')
                .setLabel('✅ Start Verification')
                .setStyle(ButtonStyle.Primary)
        );
    }
}

class VerificationSelect {
    static create() {
        return new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('verification_type')
                .setPlaceholder('Choose verification method...')
                .addOptions([
                    { label: 'ID Verification', description: 'Submit ID and gesture video', value: 'id' },
                    { label: 'Cross Verification', description: 'Screenshot from trusted server', value: 'cross' },
                    { label: 'Vouch Verification', description: 'Trusted member vouch', value: 'vouch' }
                ])
        );
    }
}

// === SETUP COMMAND ===
client.on(Events.MessageCreate, async message => {
    if (message.content === '!setupverify' && message.member.permissions.has('Administrator')) {
        await message.channel.send({
            embeds: [{ title: '🔰 Verification System', description: 'Click below to start verification.', color: 0x00BFFF }],
            components: [VerifyButton.create()]
        });
        await message.delete().catch(() => {});
    }
});

// === HELPERS ===
async function safeFetchChannel(guild, id) {
    try {
        return await guild.channels.fetch(id);
    } catch (e) {
        return null;
    }
}
async function safeDeleteMessage(channel, messageId) {
    try {
        if (!channel) return;
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
    } catch (e) {
        // ignore
    }
}

// === INTERACTIONS ===
client.on(Events.InteractionCreate, async interaction => {
    try {
        // ----- BUTTONS -----
        if (interaction.isButton()) {

            // START VERIFICATION (persistent button)
            if (interaction.customId === 'start_verify') {
                if (userActiveTicket.has(interaction.user.id)) {
                    return await interaction.reply({ content: '❌ You already have an active verification ticket. Please finish or wait.', flags: 1 << 6 });
                }
                return await interaction.reply({ content: 'Select your verification method:', components: [VerificationSelect.create()], flags: 1 << 6 });
            }

            // UPLOAD FILES (user in temp channel clicks this to send files to admin)
            if (interaction.customId === 'upload_files') {
                const tempChannel = userActiveTicket.get(interaction.user.id);
                if (!tempChannel || !tempChannel.filesCollected || tempChannel.filesCollected.length === 0) {
                    return await interaction.reply({ content: '❌ Please upload files before pressing Upload.', flags: 1 << 6 });
                }

                const adminChannel = await safeFetchChannel(interaction.guild, ADMIN_CHANNEL_ID);
                if (!adminChannel) return await interaction.reply({ content: '⚠️ Admin review channel not found.', flags: 1 << 6 });

                // Prepare files array for a single message (Discord accepts up to 10 files per message)
                const files = tempChannel.filesCollected.map(att => att.url);

                // send single admin message with attachments + buttons
                const adminMsg = await adminChannel.send({
                    content: `<@${interaction.user.id}> submitted verification files:`,
                    files: files,
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`approve_${interaction.user.id}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`deny_${interaction.user.id}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger)
                    )]
                }).catch(err => {
                    console.error('Failed to send to admin channel:', err);
                    return null;
                });

                if (adminMsg) {
                    adminSubmissionMap.set(interaction.user.id, { messageId: adminMsg.id, channelId: adminChannel.id });
                }

                await interaction.reply({ content: '✅ Submission sent to staff. This temp channel will self-destruct in 1 minute.', flags: 1 << 6 });

                // schedule a deletion if not handled (still keep 1 minute so staff can act)
                setTimeout(async () => {
                    if (userActiveTicket.has(interaction.user.id)) {
                        const ch = userActiveTicket.get(interaction.user.id);
                        await ch.delete().catch(() => {});
                        userActiveTicket.delete(interaction.user.id);
                    }
                }, 60_000);

                return;
            }

            // CLOSE TICKET (user)
            if (interaction.customId === 'close_ticket') {
                const tempChannel = userActiveTicket.get(interaction.user.id);
                if (tempChannel) {
                    await tempChannel.delete().catch(() => {});
                    userActiveTicket.delete(interaction.user.id);
                    return await interaction.reply({ content: '✅ Your verification ticket has been closed.', flags: 1 << 6 });
                } else {
                    return await interaction.reply({ content: '❌ No active ticket to close.', flags: 1 << 6 });
                }
            }

            // VOUCH MODAL (user)
            if (interaction.customId === 'vouch_modal') {
                const modal = new ModalBuilder()
                    .setCustomId('vouch_submit') // modal id handled below
                    .setTitle('Submit Vouch');

                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('vouch_name')
                        .setLabel('Trusted Member Name')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ));
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('vouch_text')
                        .setLabel('Why they vouch (details)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                ));

                return await interaction.showModal(modal);
            }

            // ADMIN: Approve / Deny buttons -> show staff modal
            if (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('deny_')) {
                const isApprove = interaction.customId.startsWith('approve_');
                const targetUserId = interaction.customId.split('_')[1];

                // Show modal for staff to input info / reason
                const modal = new ModalBuilder()
                    .setCustomId(`${isApprove ? 'approve_modal_' : 'deny_modal_'}${targetUserId}`)
                    .setTitle(isApprove ? 'Approve Submission' : 'Deny Submission');

                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('staff_text')
                        .setLabel(isApprove ? 'Enter text to log' : 'Enter deny reason')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                ));

                return await interaction.showModal(modal);
            }
        }

        // ----- SELECT MENU -----
        if (interaction.isStringSelectMenu() && interaction.customId === 'verification_type') {
            // create temp channel
            const choice = interaction.values[0];
            const member = interaction.user;
            const guild = interaction.guild;

            if (userActiveTicket.has(member.id)) {
                return await interaction.reply({ content: '❌ You already have an active verification ticket.', flags: 1 << 6 });
            }

            const channel = await guild.channels.create({
                name: `verify-${member.username}`,
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    { id: guild.id, deny: ['ViewChannel'] },
                    { id: member.id, allow: ['ViewChannel', 'SendMessages', 'AttachFiles', 'ReadMessageHistory'] },
                    { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'ManageChannels', 'ReadMessageHistory'] }
                ]
            });

            channel.filesCollected = [];
            userActiveTicket.set(member.id, channel);

            let msgContent = '';
            let actionButtons = [];

            switch (choice) {
                case 'id':
                    msgContent = `🪪 **ID Verification**\nUpload your ID photos and short gesture video.\nPress **Upload** once all files have been fully sent.`;
                    actionButtons.push(new ButtonBuilder().setCustomId('upload_files').setLabel('Upload').setStyle(ButtonStyle.Primary));
                    break;
                case 'cross':
                    msgContent = `🔄 **Cross Verification**\nUpload your screenshot showing a verified role from a trusted server.\nPress **Upload** once files are fully sent.`;
                    actionButtons.push(new ButtonBuilder().setCustomId('upload_files').setLabel('Upload').setStyle(ButtonStyle.Primary));
                    break;
                case 'vouch':
                    msgContent = `🗣️ **Vouch Verification**\nClick below to submit a vouch via modal.`;
                    actionButtons.push(new ButtonBuilder().setCustomId('vouch_modal').setLabel('Submit Vouch').setStyle(ButtonStyle.Primary));
                    break;
            }

            // Close Ticket button on the temp channel message
            actionButtons.push(new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Secondary));

            await interaction.reply({ content: `✅ Verification channel created: ${channel}`, flags: 1 << 6 });
            await channel.send({ content: msgContent, components: [new ActionRowBuilder().addComponents(actionButtons)] });

            // Auto-delete after 5 minutes if nothing happens
            setTimeout(async () => {
                if (userActiveTicket.has(member.id)) {
                    const tmp = userActiveTicket.get(member.id);
                    await tmp.send('❌ No submission received — closing verification channel.').catch(() => {});
                    await tmp.delete().catch(() => {});
                    userActiveTicket.delete(member.id);

                    // inform admins about abandoned ticket
                    const admin = await safeFetchChannel(interaction.guild, ADMIN_CHANNEL_ID);
                    if (admin) await admin.send(`❌ <@${member.id}> opened a verification ticket but submitted nothing.`).catch(() => {});
                }
            }, 300_000);

            return;
        }

        // ----- MODAL SUBMISSIONS -----
        if (interaction.isModalSubmit()) {
            const cid = interaction.customId;

            // === MODAL #1: VOUCH SUBMIT ===
            if (cid === 'vouch_submit') {
                const name = interaction.fields.getTextInputValue('vouch_name');
                const vouchText = interaction.fields.getTextInputValue('vouch_text');
                const member = interaction.user;
                const adminChannel = await safeFetchChannel(interaction.guild, ADMIN_CHANNEL_ID);
                if (!adminChannel) {
                    await interaction.reply({ content: '⚠️ Admin channel not found.', flags: 1 << 6 });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setTitle('🗣️ New Vouch Submission')
                    .addFields(
                        { name: 'User', value: `<@${member.id}> (${name})` },
                        { name: 'Vouch', value: vouchText }
                    )
                    .setTimestamp();

                const adminMsg = await adminChannel.send({
                    embeds: [embed],
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`approve_${member.id}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`deny_${member.id}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger)
                    )]
                }).catch(err => {
                    console.error('Failed to send vouch to admin channel:', err);
                    return null;
                });

                if (adminMsg) adminSubmissionMap.set(member.id, { channelId: adminChannel.id, messageId: adminMsg.id });

                await interaction.reply({ content: '✅ Your vouch was submitted to staff. The temp channel will self-destruct in 1 minute.', flags: 1 << 6 });

                // schedule temp channel deletion in 1 minute
                setTimeout(async () => {
                    if (userActiveTicket.has(member.id)) {
                        const c = userActiveTicket.get(member.id);
                        await c.delete().catch(() => {});
                        userActiveTicket.delete(member.id);
                    }
                }, 60_000);

                return;
            }

            // === MODAL #2 & #3: STAFF APPROVE / DENY MODAL SUBMITS ===
            if (cid.startsWith('approve_modal_') || cid.startsWith('deny_modal_')) {
                const isApprove = cid.startsWith('approve_modal_');
                const memberId = cid.split('_')[2];
                const staff = interaction.user;
                const staffText = interaction.fields.getTextInputValue('staff_text');

                // Fetch member
                const member = await interaction.guild.members.fetch(memberId).catch(() => null);
                if (!member) {
                    await interaction.reply({ content: '⚠️ Target user not found in guild.', flags: 1 << 6 });
                    return;
                }

                // If approve: assign roles and log
                if (isApprove) {
                    for (const roleId of VERIFIED_ROLE_IDS) {
                        try { await member.roles.add(roleId); } catch (e) { /* ignore role add errors */ }
                    }
                    // Log verification
                    const logChannel = await safeFetchChannel(interaction.guild, VERIFICATION_LOG_ID);
                    if (logChannel) await logChannel.send(`✅ Verified <@${member.id}> | Info: ${staffText}`).catch(() => {});
                } else {
                    // Deny: DM user the reason
                    await member.send(`❌ Your verification was denied.\nReason: ${staffText}`).catch(() => {});
                }

                // Staff action log (include staff who acted)
                const staffLog = await safeFetchChannel(interaction.guild, STAFF_LOG_CHANNEL_ID);
                if (staffLog) {
                    await staffLog.send(`${isApprove ? '✅ Approved' : '❌ Denied'} by <@${staff.id}> for <@${member.id}> | ${staffText}`).catch(() => {});
                }

                // --- INSTANT CLEANUP: delete admin submission message & delete temp channel immediately ---
                const submissionInfo = adminSubmissionMap.get(memberId);
                if (submissionInfo) {
                    // Try to fetch the admin channel and delete the message
                    const adminChannel = await safeFetchChannel(interaction.guild, submissionInfo.channelId);
                    await safeDeleteMessage(adminChannel, submissionInfo.messageId);
                    adminSubmissionMap.delete(memberId);
                } else {
                    // No tracked admin message found; try to search recent messages in admin channel and delete any matching to this user
                    try {
                        const adminChannel = await safeFetchChannel(interaction.guild, ADMIN_CHANNEL_ID);
                        if (adminChannel) {
                            const recent = await adminChannel.messages.fetch({ limit: 50 });
                            const found = recent.find(m => m.content && m.content.includes(`<@${memberId}>`));
                            if (found) await found.delete().catch(() => {});
                        }
                    } catch (e) { /* ignore */ }
                }

                // Delete temp channel immediately
                if (userActiveTicket.has(memberId)) {
                    const tmp = userActiveTicket.get(memberId);
                    await tmp.delete().catch(() => {});
                    userActiveTicket.delete(memberId);
                }

                // Reply to staff interaction
                await interaction.reply({ content: `✅ Submission ${isApprove ? 'approved' : 'denied'} and cleaned up.`, flags: 1 << 6 });
                return;
            }
        }

    } catch (err) {
        console.error('Interaction error:', err);
        if (interaction && !interaction.replied) {
            await interaction.reply({ content: '⚠️ An error occurred. Please try again later.', flags: 1 << 6 }).catch(() => {});
        }
    }
});

// === MESSAGE ATTACHMENTS: record uploads in temp channel ===
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (!userActiveTicket.has(message.author.id)) return;

    const tempChannel = userActiveTicket.get(message.author.id);
    if (!tempChannel) return;

    if (message.attachments.size > 0) {
        // store attachments (MessageAttachment-like objects) as { url, name }
        const attachments = [];
        for (const att of message.attachments.values()) {
            attachments.push({ url: att.url, name: att.name || 'file' });
        }
        tempChannel.filesCollected.push(...attachments);
        await message.react('✅').catch(() => {});
    }
});

// === LOGIN ===
client.login(process.env.TOKEN);
