import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  CommandInteraction,
  ButtonInteraction,
  TextChannel,
} from 'discord.js';
import { stopPollingForChannel } from '../config';

/**
 * チケット作成用パネルを送信する
 */
export async function setupTicketPanel(interaction: CommandInteraction) {
  const member = interaction.member;
  if (!member || !('roles' in member)) {
    await interaction.reply({ content: 'サーバー内でのみ実行可能です。', ephemeral: true });
    return;
  }

  const supportRoleId = process.env.SUPPORT_ROLE_ID;
  let hasSupportRole = false;
  if (supportRoleId) {
    if (Array.isArray(member.roles)) {
      hasSupportRole = member.roles.includes(supportRoleId);
    } else {
      hasSupportRole = member.roles.cache.has(supportRoleId);
    }
  }
  const isAdministrator = typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.Administrator);

  if (!hasSupportRole && !isAdministrator) {
    await interaction.reply({
      content: 'このコマンドを実行する権限がありません。必要なロール（SUPPORT_ROLE_ID）または管理者権限が必要です。',
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const embed = new EmbedBuilder()
    .setTitle('サポートチケット作成')
    .setDescription('ご用件に合わせたボタンをクリックしてチケットを作成してください。')
    .setColor('#0099ff')
    .setFooter({ text: 'Crypto Exchange Service Support' });

  const exchangeButton = new ButtonBuilder()
    .setCustomId('create_ticket_exchange')
    .setLabel('Exchange')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('💱');

  const middlemanButton = new ButtonBuilder()
    .setCustomId('create_ticket_middleman')
    .setLabel('取引仲介(mm)')
    .setStyle(ButtonStyle.Success)
    .setEmoji('🤝');

  const donutButton = new ButtonBuilder()
    .setCustomId('create_ticket_donut')
    .setLabel('DonutMoney')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('🍩');

  const otherButton = new ButtonBuilder()
    .setCustomId('create_ticket_other')
    .setLabel('その他')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('❓');

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(exchangeButton, middlemanButton, donutButton, otherButton);

  const channel = interaction.channel;
  if (!channel || !('send' in channel)) {
    await interaction.editReply({ content: 'このチャンネルでは実行できません。' });
    return;
  }

  await channel.send({ embeds: [embed], components: [row] });
  await interaction.editReply({ content: 'チケットパネルを設置しました！' });
}

/**
 * チケット作成ボタン押下時にそれぞれの種類に応じたチケットチャンネルを直接作成する
 */
export async function createTicketChannel(interaction: ButtonInteraction) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'サーバー内でのみ実行可能です。', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const member = interaction.user;
  const categoryId = process.env.TICKET_CATEGORY_ID;
  const supportRoleId = process.env.SUPPORT_ROLE_ID;

  const suffix = member.username.toLowerCase().replace(/[^a-z0-9]/g, '');
  try {
    const channels = await guild.channels.fetch();
    const existingChannel = channels.find(channel => {
      if (!channel) return false;
      const name = channel.name;
      return name === `exch-${suffix}` ||
             name === `mm-${suffix}` ||
             name === `donut-${suffix}` ||
             name === `other-${suffix}`;
    });

    if (existingChannel) {
      await interaction.editReply({
        content: `すでに開いているチケットがあります: ${existingChannel}`,
      });
      return;
    }
  } catch (error) {
    console.error('Failed to fetch channels for checking duplicate tickets:', error);
  }

  let ticketType = 'general';
  let displayType = 'その他';
  let prefix = 'ticket';

  if (interaction.customId === 'create_ticket_exchange') {
    ticketType = 'exchange';
    displayType = 'Exchange';
    prefix = 'exch';
  } else if (interaction.customId === 'create_ticket_middleman') {
    ticketType = 'mm';
    displayType = '取引仲介(mm)';
    prefix = 'mm';
  } else if (interaction.customId === 'create_ticket_donut') {
    ticketType = 'donut';
    displayType = 'DonutMoney';
    prefix = 'donut';
  } else if (interaction.customId === 'create_ticket_other') {
    ticketType = 'other';
    displayType = 'その他';
    prefix = 'other';
  }

  const permissionOverwrites: any[] = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: guild.members.me!.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  ];

  if (supportRoleId) {
    permissionOverwrites.push({
      id: supportRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  try {
    const channelName = `${prefix}-${member.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId || null,
      permissionOverwrites,
    });

    const embeds: EmbedBuilder[] = [];
    const components: any[] = [];

    if (ticketType === 'exchange') {
      const embedInfo = new EmbedBuilder()
        .setTitle('Exchange チケットが作成されました')
        .setDescription(`${member} 様、お問い合わせありがとうございます。\nサポートが対応するまでお待ちください。\n\nチケットを閉じるには、下のボタンを押してください。`)
        .setColor('#0099ff')
        .setTimestamp();

      const embedType = new EmbedBuilder()
        .setTitle('取引タイプの選択')
        .setDescription('まずは下のメニューから、**【取引のタイプ】**を選択してください。')
        .setColor('#00ff99');

      const { StringSelectMenuBuilder } = await import('discord.js');

      const typeMenu = new StringSelectMenuBuilder()
        .setCustomId('exchange_type')
        .setPlaceholder('取引のタイプを選択してください')
        .addOptions([
          { label: 'Crypto To Crypto (暗号通貨 ➔ 暗号通貨)', value: 'crypto_to_crypto' },
          { label: 'Crypto To Fiat (暗号通貨 ➔ 日本円)', value: 'crypto_to_fiat' },
          { label: 'Fiat To Crypto (日本円 ➔ 暗号通貨)', value: 'fiat_to_crypto' },
        ]);

      const closeButton = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('チケットを閉じる')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒');

      const rowType = new ActionRowBuilder<any>().addComponents(typeMenu);
      const rowClose = new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton);

      embeds.push(embedInfo, embedType);
      components.push(rowType, rowClose);
    } else {
      const embed = new EmbedBuilder()
        .setTitle(`${displayType} チケットが作成されました`)
        .setDescription(`${member} 様、お問い合わせありがとうございます。\nサポートが対応するまでお待ちください。\n\nチケットを閉じるには、下のボタンを押してください。`)
        .addFields(
          { name: '📋 チケットカテゴリ', value: displayType }
        )
        .setColor('#00ff99')
        .setTimestamp();

      const closeButton = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('チケットを閉じる')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒');

      const rowClose = new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton);

      embeds.push(embed);
      components.push(rowClose);
    }

    await ticketChannel.send({
      content: `${member} さん、こちらのチャンネルで要件を教えてください。`,
      embeds: embeds,
      components: components,
    });

    await interaction.editReply({
      content: `チケットを作成しました: ${ticketChannel}`,
    });
  } catch (error) {
    console.error('Failed to create ticket channel:', error);
    await interaction.editReply({
      content: 'チケットチャンネルの作成中にエラーが発生しました。権限設定などを確認してください。',
    });
  }
}

/**
 * チケット閉じるボタン押下時の処理 (確認ダイアログの表示)
 */
export async function closeTicketChannel(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  const isTicketChannel = channel && (
    channel.name.startsWith('exch-') ||
    channel.name.startsWith('mm-') ||
    channel.name.startsWith('donut-') ||
    channel.name.startsWith('other-') ||
    channel.name.startsWith('ticket-')
  );

  if (!channel || channel.type !== ChannelType.GuildText || !isTicketChannel) {
    await interaction.reply({ content: 'このチャンネルではチケットを閉じることができません。', ephemeral: true });
    return;
  }

  const confirmEmbed = new EmbedBuilder()
    .setTitle('⚠️ チケット削除の確認')
    .setDescription('本当にこのチケットを閉じますか？\n「はい」を押すとこのチャンネルは削除されます。')
    .setColor('#ffaa00');

  const confirmButton = new ButtonBuilder()
    .setCustomId('confirm_close_ticket')
    .setLabel('はい (チケットを閉じる)')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('✅');

  const cancelButton = new ButtonBuilder()
    .setCustomId('cancel_close_ticket')
    .setLabel('いいえ (キャンセル)')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('❌');

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton);

  await interaction.reply({
    embeds: [confirmEmbed],
    components: [row],
  });
}

/**
 * 実際にチケットチャンネルを削除する (「はい」選択時)
 */
export async function handleConfirmCloseTicket(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel || channel.type !== ChannelType.GuildText) return;

  stopPollingForChannel(channel.id);

  await interaction.reply({
    content: 'チケットを閉じます。このチャンネルは5秒後に削除されます。',
  });

  setTimeout(async () => {
    try {
      await channel.delete('Ticket closed by user confirm.');
    } catch (error) {
      console.error('Failed to delete ticket channel:', error);
    }
  }, 5000);
}

/**
 * チケット削除をキャンセルする (「いいえ」選択時)
 */
export async function handleCancelCloseTicket(interaction: ButtonInteraction) {
  await interaction.update({
    content: 'チケットの削除をキャンセルしました。',
    embeds: [],
    components: []
  });
}

/**
 * サポートスタッフ専用 `/close` コマンドによるチケットの強制クローズ処理
 */
export async function handleForceCloseCommand(interaction: CommandInteraction) {
  const member = interaction.member;
  if (!member || !('roles' in member)) {
    await interaction.reply({ content: 'サーバー内でのみ実行可能です。', ephemeral: true });
    return;
  }

  const supportRoleId = process.env.SUPPORT_ROLE_ID;
  let hasSupportRole = false;
  if (supportRoleId) {
    if (Array.isArray(member.roles)) {
      hasSupportRole = member.roles.includes(supportRoleId);
    } else {
      hasSupportRole = member.roles.cache.has(supportRoleId);
    }
  }
  const isAdministrator = typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.Administrator);

  if (!hasSupportRole && !isAdministrator) {
    await interaction.reply({
      content: '⚠️ このコマンドを実行する権限がありません。（サポートスタッフ専用）',
      ephemeral: true
    });
    return;
  }

  const channel = interaction.channel as TextChannel;
  const isTicketChannel = channel && (
    channel.name.startsWith('exch-') ||
    channel.name.startsWith('mm-') ||
    channel.name.startsWith('donut-') ||
    channel.name.startsWith('other-') ||
    channel.name.startsWith('ticket-')
  );

  if (!channel || channel.type !== ChannelType.GuildText || !isTicketChannel) {
    await interaction.reply({ content: '⚠️ このチャンネルではチケットを閉じることができません。', ephemeral: true });
    return;
  }

  stopPollingForChannel(channel.id);

  await interaction.reply({
    content: '🔒 チケットを強制的に閉じます。このチャンネルは5秒後に削除されます。',
  });

  setTimeout(async () => {
    try {
      await channel.delete('Ticket closed by support staff via /close command.');
    } catch (error) {
      console.error('Failed to delete ticket channel:', error);
    }
  }, 5000);
}
