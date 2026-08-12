import { EmbedBuilder } from 'discord.js';

/**
 * 取引完了ログを LOG_CHANNEL_ID のチャンネルに送信する
 * 成功時は投稿されたメッセージのリンク (URL) を返す
 */
export async function sendTransactionLogEmbed(channel: any, data: {
  userMention: string;
  exchangeTypeLabel: string;
  pairLabel: string;
  payAmountText: string;
  takeAmountText?: string;
  trackId?: string;
}): Promise<string | null> {
  const logChannelId = process.env.LOG_CHANNEL_ID;
  if (!logChannelId) {
    console.log('[Log Channel] LOG_CHANNEL_ID is not set in environment. Skipping transaction log embed.');
    return null;
  }

  try {
    let targetChannel: any = null;
    if (channel && channel.client && channel.client.channels) {
      targetChannel = await channel.client.channels.fetch(logChannelId).catch((err: any) => {
        console.error(`[Log Channel Error] Could not fetch log channel (${logChannelId}):`, err.message || err);
        return null;
      });
    }

    if (!targetChannel || !('send' in targetChannel)) {
      console.error(`[Log Channel] Could not fetch or access log channel ID: ${logChannelId}`);
      if (channel && 'send' in channel) {
        await channel.send({ content: `⚠️ ログチャンネル (${logChannelId}) へのアクセス権限がないため、ログ送信をスキップしました。` }).catch(() => {});
      }
      return null;
    }

    const nowStr = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    const logEmbed = new EmbedBuilder()
      .setTitle('📊 交換取引完了ログ')
      .setDescription(`取引が正常に完了しました。`)
      .addFields(
        { name: '👤 実行ユーザー', value: data.userMention, inline: true },
        { name: '📋 取引タイプ', value: data.exchangeTypeLabel, inline: true },
        { name: '💱 通貨ペア', value: data.pairLabel, inline: true },
        { name: '📤 支払金額', value: data.payAmountText, inline: false },
        { name: '⏰ 完了時間', value: `\`${nowStr}\``, inline: true }
      )
      .setColor('#00ff00')
      .setTimestamp();

    const sentMsg = await targetChannel.send({ embeds: [logEmbed] });
    console.log(`[Log Channel] Successfully sent transaction log for user: ${data.userMention}`);

    const guildId = sentMsg.guild ? sentMsg.guild.id : (channel.guild ? channel.guild.id : '@me');
    return `https://discord.com/channels/${guildId}/${targetChannel.id}/${sentMsg.id}`;
  } catch (error: any) {
    console.error(`[Log Channel Error] Missing permissions or failed to send log embed to channel (${logChannelId}):`, error.message || error);
    if (error.code === 50013 || error.message?.includes('Missing Permissions')) {
      console.error(`[Log Channel Instruction] Discordサーバー設定で、Botにログチャンネル (${logChannelId}) の「チャンネルを見る (View Channel)」「メッセージを送信 (Send Messages)」「埋め込みリンク (Embed Links)」権限を許可してください。`);
    }
    if (channel && 'send' in channel) {
      await channel.send({
        content: `⚠️ ログチャンネルへの権限不足 (Missing Permissions) のため、取引完了ログの送信に失敗しました。\nDiscordでBotのログチャンネル表示・送信権限をご確認ください。`
      }).catch(() => {});
    }
    return null;
  }
}
