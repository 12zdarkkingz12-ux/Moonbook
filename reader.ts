// ─── reader.ts ───────────────────────────────────────────────

import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  TextChannel,
} from 'discord.js';

import {
  ChapterManifest,
  ReaderSession,
  SESSION_TTL_MS,
  buildProgressBar,
} from './utils';
import { getChapterManifest, getChapterPagePath } from './upload';
import { createReadingRoom, deleteReadingRoom } from './room';
import { logRoomOpened, logRoomClosed, logError } from './logger';

// ─── Sessions store ───────────────────────────────────────────
const sessions = new Map<string, ReaderSession>();

// Cleanup تلقائي كل 30 دقيقة
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.openedAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 1000 * 60 * 30);

// ─── Buttons ─────────────────────────────────────────────────
function makeButtons(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`moonbook_first:${sessionId}`)
      .setLabel('⏮')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`moonbook_prev:${sessionId}`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`moonbook_next:${sessionId}`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`moonbook_last:${sessionId}`)
      .setLabel('⏭')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`moonbook_goto:${sessionId}`)
      .setLabel('🔢')
      .setStyle(ButtonStyle.Secondary)
  );
}

function makeCloseButton(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`moonbook_close:${sessionId}`)
      .setLabel('✕ أغلق الروم')
      .setStyle(ButtonStyle.Danger)
  );
}

// ─── Embed builder ────────────────────────────────────────────
function buildEmbed(
  chapter: ChapterManifest,
  pageIndex: number,
  imageName: string
): EmbedBuilder {
  const total = chapter.images.length;
  const current = pageIndex + 1;

  return new EmbedBuilder()
    .setTitle(`📖 ${chapter.title}`)
    .setDescription(buildProgressBar(current, total))
    .setImage(`attachment://${imageName}`)
    .setColor(0x7c5cff)
    .setFooter({ text: `Moonbook • ${chapter.id}` });
}

// ─── إرسال الصفحة الحالية (رسالة جديدة) ──────────────────────
export async function sendCurrentPage(
  channel: TextChannel,
  chapter: ChapterManifest,
  session: ReaderSession
): Promise<void> {
  const pageRel = chapter.images[session.pageIndex];
  if (!pageRel) throw new Error('Page not found');

  const pagePath = getChapterPagePath(chapter.id, pageRel);
  const imageName = path.basename(pagePath);

  const embed = buildEmbed(chapter, session.pageIndex, imageName);
  const file = new AttachmentBuilder(pagePath, { name: imageName });

  const msg = await channel.send({
    embeds: [embed],
    components: [makeButtons(session.sessionId), makeCloseButton(session.sessionId)],
    files: [file],
  });

  session.messageId = msg.id;
  sessions.set(session.sessionId, session);
}

// ─── تعديل الصفحة الحالية (edit) ─────────────────────────────
async function editCurrentPage(
  interaction: ButtonInteraction,
  chapter: ChapterManifest,
  session: ReaderSession
): Promise<void> {
  const pageRel = chapter.images[session.pageIndex];
  if (!pageRel) throw new Error('Page not found');

  const pagePath = getChapterPagePath(chapter.id, pageRel);
  const imageName = path.basename(pagePath);

  const embed = buildEmbed(chapter, session.pageIndex, imageName);
  const file = new AttachmentBuilder(pagePath, { name: imageName });

  await interaction.message.edit({
    embeds: [embed],
    components: [makeButtons(session.sessionId), makeCloseButton(session.sessionId)],
    files: [file],
  });
}

// ─── إنشاء Session + روم القراءة ─────────────────────────────
export async function createReaderSession(
  client: Client,
  chapter: ChapterManifest,
  userId: string,
  username: string
): Promise<ReaderSession> {
  const guildId = process.env.DISCORD_GUILD_ID || '';
  if (!guildId) throw new Error('DISCORD_GUILD_ID is missing');

  const sessionId = crypto.randomUUID();

  // أنشئ الروم الخاص
  const room = await createReadingRoom(client, guildId, userId, username, chapter.id);

  const session: ReaderSession = {
    sessionId,
    chapterId: chapter.id,
    channelId: room.id,
    roomChannelId: room.id,
    title: chapter.title,
    pageIndex: 0,
    userId,
    username,
    openedAt: Date.now(),
  };

  sessions.set(sessionId, session);

  // أرسل رسالة ترحيب + أول صفحة
  await room.send({
    content: `مرحباً <@${userId}>! 👋 روم قراءتك جاهز.\nاستخدم الأزرار للتنقل بين الصفحات.`,
  });

  await sendCurrentPage(room, chapter, session);

  await logRoomOpened({
    username,
    userId,
    chapterTitle: chapter.title,
    channelName: room.name,
  });

  return session;
}

// ─── معالجة تفاعلات الأزرار ───────────────────────────────────
export async function handleReaderInteraction(
  interaction: ButtonInteraction
): Promise<void> {
  const [action, sessionId] = interaction.customId.split(':');
  const session = sessions.get(sessionId);

  if (!session) {
    await interaction.reply({ content: '❌ الجلسة انتهت أو غير موجودة.', ephemeral: true });
    return;
  }

  const chapter = await getChapterManifest(session.chapterId);
  if (!chapter) {
    await interaction.reply({ content: '❌ الفصل غير موجود.', ephemeral: true });
    return;
  }

  const lastIndex = chapter.images.length - 1;

  if (action === 'moonbook_first') {
    session.pageIndex = 0;
    sessions.set(sessionId, session);
    await interaction.deferUpdate();
    await editCurrentPage(interaction, chapter, session);
    return;
  }

  if (action === 'moonbook_prev') {
    session.pageIndex = Math.max(0, session.pageIndex - 1);
    sessions.set(sessionId, session);
    await interaction.deferUpdate();
    await editCurrentPage(interaction, chapter, session);
    return;
  }

  if (action === 'moonbook_next') {
    session.pageIndex = Math.min(lastIndex, session.pageIndex + 1);
    sessions.set(sessionId, session);
    await interaction.deferUpdate();
    await editCurrentPage(interaction, chapter, session);
    return;
  }

  if (action === 'moonbook_last') {
    session.pageIndex = lastIndex;
    sessions.set(sessionId, session);
    await interaction.deferUpdate();
    await editCurrentPage(interaction, chapter, session);
    return;
  }

  if (action === 'moonbook_goto') {
    const modal = new ModalBuilder()
      .setCustomId(`moonbook_modal:${sessionId}`)
      .setTitle('انتقل إلى صفحة');

    const input = new TextInputBuilder()
      .setCustomId('page_number')
      .setLabel(`رقم الصفحة (1 – ${chapter.images.length})`)
      .setStyle(TextInputStyle.Short)
      .setMinLength(1)
      .setMaxLength(4)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (action === 'moonbook_close') {
    const durationMin = Math.round((Date.now() - session.openedAt) / 60000);
    const pagesRead = session.pageIndex + 1;

    sessions.delete(sessionId);

    await logRoomClosed({
      username: session.username,
      userId: session.userId,
      chapterTitle: session.title,
      pagesRead,
      durationMin,
    });

    await interaction.reply({ content: '🔒 تم إغلاق الروم، إلى اللقاء!', ephemeral: true });

    if (session.roomChannelId) {
      // أعطِ ثانية قبل الحذف عشان تظهر الرسالة
      setTimeout(() => {
        deleteReadingRoom(interaction.client, session.roomChannelId!);
      }, 2000);
    }
    return;
  }
}

// ─── معالجة Modal (انتقل إلى صفحة) ──────────────────────────
export async function handleGotoModal(
  interaction: ModalSubmitInteraction
): Promise<void> {
  const [, sessionId] = interaction.customId.split(':');
  const session = sessions.get(sessionId);

  if (!session) {
    await interaction.reply({ content: '❌ الجلسة انتهت.', ephemeral: true });
    return;
  }

  const chapter = await getChapterManifest(session.chapterId);
  if (!chapter) {
    await interaction.reply({ content: '❌ الفصل غير موجود.', ephemeral: true });
    return;
  }

  const raw = interaction.fields.getTextInputValue('page_number');
  const pageNum = parseInt(raw, 10);

  if (isNaN(pageNum) || pageNum < 1 || pageNum > chapter.images.length) {
    await interaction.reply({
      content: `❌ رقم غير صحيح. أدخل رقماً بين 1 و ${chapter.images.length}.`,
      ephemeral: true,
    });
    return;
  }

  session.pageIndex = pageNum - 1;
  sessions.set(sessionId, session);

  await interaction.deferUpdate();

  const pageRel = chapter.images[session.pageIndex];
  const pagePath = getChapterPagePath(chapter.id, pageRel);
  const imageName = path.basename(pagePath);

  const embed = buildEmbed(chapter, session.pageIndex, imageName);
  const file = new AttachmentBuilder(pagePath, { name: imageName });

  await interaction.message!.edit({
    embeds: [embed],
    components: [makeButtons(session.sessionId), makeCloseButton(session.sessionId)],
    files: [file],
  });
}

// ─── نشر بطاقة الفصل في قناة المكتبة ────────────────────────
export async function publishChapterCard(
  client: Client,
  chapter: ChapterManifest
): Promise<void> {
  const channelId = process.env.DISCORD_CHANNEL_ID || '';
  if (!channelId) throw new Error('DISCORD_CHANNEL_ID is missing');

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) throw new Error('Library channel not found');

  const embed = new EmbedBuilder()
    .setTitle(`📖 ${chapter.title}`)
    .setDescription(
      `> **${chapter.images.length} صفحة**\n\nاضغط الزر لبدء القراءة في روم خاص بك.`
    )
    .setColor(0x7c5cff)
    .setFooter({ text: `Moonbook • ${chapter.id}` })
    .setTimestamp();

  const startBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`moonbook_start:${chapter.id}`)
      .setLabel('🚀 ابدأ القراءة')
      .setStyle(ButtonStyle.Success)
  );

  await (channel as TextChannel).send({
    embeds: [embed],
    components: [startBtn],
  });
}

// ─── بدء قراءة من زر "ابدأ القراءة" ─────────────────────────
export async function handleStartReading(
  interaction: ButtonInteraction
): Promise<void> {
  const chapterId = interaction.customId.replace('moonbook_start:', '');

  const chapter = await getChapterManifest(chapterId);
  if (!chapter) {
    await interaction.reply({ content: '❌ الفصل غير موجود.', ephemeral: true });
    return;
  }

  await interaction.reply({
    content: '⏳ جاري إنشاء روم القراءة الخاص بك...',
    ephemeral: true,
  });

  await createReaderSession(
    interaction.client,
    chapter,
    interaction.user.id,
    interaction.user.username
  );
}

// ─── للاستخدام في slash commands ─────────────────────────────
export async function publishChapterById(
  client: Client,
  chapterId: string,
  publishedBy: string = 'Web Panel'
): Promise<void> {
  const chapter = await getChapterManifest(chapterId);
  if (!chapter) throw new Error('Chapter not found');
  await publishChapterCard(client, chapter);
}

export function getActiveSessions(): ReaderSession[] {
  return Array.from(sessions.values());
}
