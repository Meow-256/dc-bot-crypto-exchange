import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ButtonInteraction,
  Message,
  PermissionFlagsBits,
  User,
  ChannelType,
  TextChannel,
  ThreadChannel,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  Client,
} from 'discord.js';
import { activePollings, fiatTakeOptions, stopPollingForChannel, formatWithEmoji, fiatGiveOptions } from '../config';
import { requestOxaPay } from '../oxapay';
import { sendTransactionLogEmbed } from '../logger';
import { saveTransactionRecord, updateTransactionPrivacy } from '../transactions';
import { refreshTicketChannel } from './exchange';

export interface PendingPrivacyLog {
  userId: string;
  guildId: string;
  userMention: string;
  exchangeTypeLabel: string;
  pairLabel: string;
  payAmountText: string;
  jpyAmount: number;
  usdAmount: number;
  channel: any;
  client: any;
}

export const pendingPrivacyLogs = new Map<string, PendingPrivacyLog>();

/**
 * サポートスタッフのみが閲覧可能なプライベートスレッドを作成し、エラーログを送信する
 */
export async function sendStaffErrorThread(channel: any, title: string, errorMessage: string) {
  if (!channel || !('threads' in channel)) return;

  try {
    const supportRoleId = process.env.SUPPORT_ROLE_ID;
    const mentionContent = supportRoleId ? `<@&${supportRoleId}>` : '@Support';

    let thread: ThreadChannel | null = null;
    const activeThreads = await channel.threads.fetchActive().catch(() => null);
    if (activeThreads && activeThreads.threads) {
      thread = activeThreads.threads.find((t: ThreadChannel) => t.name === '🔑 サポート専用エラーログ') || null;
    }

    if (!thread) {
      thread = await channel.threads.create({
        name: '🔑 サポート専用エラーログ',
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: 'Error logging for support staff only'
      });
    }

    const errEmbed = new EmbedBuilder()
      .setTitle(`⚠️ ${title}`)
      .setDescription(`\`\`\`\n${errorMessage.substring(0, 4000)}\n\`\`\``)
      .setColor('#ff0000')
      .setTimestamp();

    if (thread) {
      await (thread as ThreadChannel).send({
        content: `${mentionContent} システムエラーログが発生しました。`,
        embeds: [errEmbed]
      });
    } else if ('send' in channel) {
      await channel.send({
        content: `Error ${mentionContent}`
      }).catch(() => {});
    }
  } catch (threadErr) {
    console.error('Failed to create/send to support error thread:', threadErr);
    const supportRoleId = process.env.SUPPORT_ROLE_ID;
    const mentionContent = supportRoleId ? `<@&${supportRoleId}>` : '@Support';
    if ('send' in channel) {
      await channel.send({
        content: `Error ${mentionContent}`
      }).catch(() => {});
    }
  }
}

/**
 * 取引完了時にユーザーのDMへ公開/匿名選択ボタン付きEmbedを送信する
 */
export async function triggerPrivacyPreferenceFlow(data: PendingPrivacyLog) {
  const logId = `priv_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  pendingPrivacyLogs.set(logId, data);

  try {
    const user: User = await data.client.users.fetch(data.userId);
    const dmChannel = await user.createDM();

    const embed = new EmbedBuilder()
      .setTitle('🎉 お取引ご利用ありがとうございました！')
      .setDescription('お取引が正常に完了いたしました。\nログチャンネルへの掲載表記（**公開** / **匿名**）を選択してください。\n\n※「**公開**」を選択された場合は、顧客ロール（Customer Role）の自動付与および評価用投稿コードが生成されます。')
      .setColor('#00ff99')
      .setTimestamp();

    const publicBtn = new ButtonBuilder()
      .setCustomId(`privacy_choice:public:${logId}`)
      .setLabel('公開 (ユーザー名を掲載)')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🌐');

    const anonBtn = new ButtonBuilder()
      .setCustomId(`privacy_choice:anon:${logId}`)
      .setLabel('匿名 (ユーザー名を非公開)')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('👤');

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(publicBtn, anonBtn);

    const dmMessage = await dmChannel.send({ embeds: [embed], components: [row] });

    // 5分 (300,000ミリ秒) のタイムアウトで自動公開
    setTimeout(async () => {
      const pendingData = pendingPrivacyLogs.get(logId);
      if (pendingData) {
        pendingPrivacyLogs.delete(logId);
        
        // 顧客ロール付与
        const customerRoleId = process.env.CUSTOMER_ROLE_ID;
        if (customerRoleId && pendingData.client && pendingData.guildId) {
          try {
            const guild = await pendingData.client.guilds.fetch(pendingData.guildId);
            const member = await guild.members.fetch(pendingData.userId);
            if (member) {
              await member.roles.add(customerRoleId);
              console.log(`[Customer Role Added Auto] Successfully added customer role to user ${pendingData.userId}`);
            }
          } catch (roleErr) {
            console.error(`[Customer Role Error Auto] Failed to add customer role:`, roleErr);
          }
        }

        updateTransactionPrivacy(pendingData.userId, 'public');

        // ログ送信
        await sendTransactionLogEmbed(pendingData.channel, {
          userMention: pendingData.userMention,
          exchangeTypeLabel: pendingData.exchangeTypeLabel,
          pairLabel: pendingData.pairLabel,
          payAmountText: pendingData.payAmountText
        });

        // DMのメッセージを更新
        const autoEmbed = new EmbedBuilder()
          .setTitle('✅ 自動公開設定完了')
          .setDescription('5分間選択がなかったため、自動的に「公開」として処理いたしました。\n公開へのご協力ありがとうございます！顧客ロールを付与いたしました。')
          .setColor('#00ff00');
        
        await dmMessage.edit({ embeds: [autoEmbed], components: [] }).catch(() => {});
      }
    }, 5 * 60 * 1000);

  } catch (dmErr) {
    console.error(`[DM Send Failed] Could not send privacy preference DM to user ${data.userId}. Defaulting to public log.`, dmErr);
    updateTransactionPrivacy(data.userId, 'public');
    await sendTransactionLogEmbed(data.channel, {
      userMention: data.userMention,
      exchangeTypeLabel: data.exchangeTypeLabel,
      pairLabel: data.pairLabel,
      payAmountText: data.payAmountText
    });
    pendingPrivacyLogs.delete(logId);
  }
}

/**
 * DM内の「公開」/「匿名」ボタン押下時のハンドラー
 */
export async function handlePrivacyChoice(interaction: ButtonInteraction) {
  const parts = interaction.customId.split(':');
  const choice = parts[1]; // 'public' or 'anon'
  const logId = parts[2];

  const data = pendingPrivacyLogs.get(logId);
  if (!data) {
    await interaction.reply({ content: '⚠️ セッションが無効か期限切れです。', ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  if (choice === 'anon') {
    updateTransactionPrivacy(data.userId, 'anonymous');
    await sendTransactionLogEmbed(data.channel, {
      userMention: '匿名',
      exchangeTypeLabel: data.exchangeTypeLabel,
      pairLabel: data.pairLabel,
      payAmountText: data.payAmountText
    });

    const doneEmbed = new EmbedBuilder()
      .setTitle('✅ 設定完了')
      .setDescription('匿名でのログ掲載を受け付けました。またのご利用を心よりお待ちしております！')
      .setColor('#00ff00');

    await interaction.editReply({ embeds: [doneEmbed], components: [] });
    pendingPrivacyLogs.delete(logId);

  } else if (choice === 'public') {
    const customerRoleId = process.env.CUSTOMER_ROLE_ID;
    if (customerRoleId && data.client && data.guildId) {
      try {
        const guild = await data.client.guilds.fetch(data.guildId);
        const member = await guild.members.fetch(data.userId);
        if (member) {
          await member.roles.add(customerRoleId);
          console.log(`[Customer Role Added] Successfully added customer role (${customerRoleId}) to user ${data.userId}`);
        }
      } catch (roleErr) {
        console.error(`[Customer Role Error] Failed to add customer role to user ${data.userId}:`, roleErr);
      }
    }

    updateTransactionPrivacy(data.userId, 'public');
    const msgLink = await sendTransactionLogEmbed(data.channel, {
      userMention: data.userMention,
      exchangeTypeLabel: data.exchangeTypeLabel,
      pairLabel: data.pairLabel,
      payAmountText: data.payAmountText
    });

    const amountText = `${Math.round(data.jpyAmount).toLocaleString()}円($${data.usdAmount.toFixed(2)})`;
    const repCode = `+rep <@1482268541976711219> ${amountText} ${msgLink || ''}`;

    const repEmbed = new EmbedBuilder()
      .setTitle('🌟 評価（+rep）ご協力のお願い')
      .setDescription('公開へのご協力ありがとうございます！顧客ロールを付与いたしました。\n\n以下の枠内のコードをコピーして、評価（+rep）チャンネルへ送信していただけると大変励みになります！')
      .addFields(
        { name: '📋 コピー用コード', value: `\`\`\`\n${repCode}\n\`\`\`` }
      )
      .setColor('#00ff99')
      .setTimestamp();

    await interaction.editReply({ embeds: [repEmbed], components: [] });
    pendingPrivacyLogs.delete(logId);
  }
}

// 同時実行制御・二重送金防止用の排他制御ロック
export const processingTrackIds = new Set<string>();
export const completedTrackIds = new Set<string>();

/**
 * 支払い状況確認・自動Swap・自動Payoutを行う中核ロジック
 */
export async function processPaymentCheckCore(
  channel: any,
  trackId: string,
  paySymbol: string,
  takeSymbol: string,
  finalTakeAmount: number,
  userAddress: string,
  userMention: string,
  payJpyAmount?: number,
  payUsdAmount?: string,
  payCryptoAmount?: string,
  forceComplete: boolean = false
): Promise<boolean> {
  // 既に完了済みの場合は重複処理をスキップ
  if (completedTrackIds.has(trackId)) {
    console.log(`[Payment Lock] Track ID ${trackId} is already completed. Skipping duplicate execution.`);
    return true;
  }

  // 現在別スレッド/Webhookで処理中の場合は重複処理を防止
  if (processingTrackIds.has(trackId)) {
    console.log(`[Payment Lock] Track ID ${trackId} is currently being processed by another worker. Skipping concurrent run.`);
    return false;
  }

  const merchantKey = process.env.OXAPAY_MERCHANT_KEY;
  const generalKey = process.env.OXAPAY_GENERAL_KEY;
  const payoutKey = process.env.OXAPAY_PAYOUT_KEY;

  const paySymbolUpper = paySymbol.toUpperCase();
  const takeSymbolUpper = takeSymbol.toUpperCase();

  if (!merchantKey || !generalKey || !payoutKey) {
    if (channel && 'send' in channel) {
      await channel.send({ content: '⚠️ システムエラー: OxaPay設定（APIキー群）が不足しています。' });
    }
    return false;
  }

  let isPaid = forceComplete;
  let rawStatus = forceComplete ? 'Confirmed (Manual)' : 'Unknown';

  if (!forceComplete) {
    const statusResponse = await requestOxaPay('GET', `/payment/${trackId}`, null, merchantKey);
    const dataObj = statusResponse.data || {};
    const txStatus = (Array.isArray(dataObj.txs) && dataObj.txs.length > 0) ? dataObj.txs[0].status : null;
    rawStatus = dataObj.status || txStatus || statusResponse.pay_status || statusResponse.payStatus || (typeof statusResponse.status === 'string' && statusResponse.status !== '200' ? statusResponse.status : 'Unknown');

    const lowerStatus = String(rawStatus).toLowerCase();
    isPaid = lowerStatus === 'paid' || 
             lowerStatus === 'confirmed' || 
             lowerStatus === 'complete' || 
             lowerStatus === 'completed' || 
             statusResponse.result === 100 || 
             statusResponse.result === 1;

    let statusLabel = `\`${rawStatus}\``;
    if (lowerStatus === 'confirmed') {
      statusLabel = '✅ 支払い・承認完了 (Confirmed)';
    } else if (lowerStatus === 'paid') {
      statusLabel = '✅ 支払い完了 (Paid)';
    } else if (lowerStatus === 'waiting' || lowerStatus === 'new') {
      statusLabel = '⏳ お支払い待ち (Waiting)';
    } else if (lowerStatus === 'confirming') {
      statusLabel = '🔄 ブロックチェーン確認中 (Confirming)';
    } else if (lowerStatus === 'expired') {
      statusLabel = '❌ 期限切れ (Expired)';
    }

    const statusEmbed = new EmbedBuilder()
      .setTitle('🔍 現在の取引ステータス')
      .setDescription(`支払確認が実行されました。現在の取引状況は以下の通りです。`)
      .addFields(
        { name: '📌 取引ステータス', value: statusLabel, inline: true },
        { name: '📤 支払通貨', value: `${formatWithEmoji(paySymbolUpper)}`, inline: true },
        { name: '📥 受取予定/受取通貨', value: `${formatWithEmoji(takeSymbolUpper)}`, inline: true },
        { name: '📌 送金先アドレス', value: `\`${userAddress}\``, inline: false }
      )
      .setColor(isPaid ? '#00ff00' : '#0099ff')
      .setTimestamp();

    if (channel && 'send' in channel) {
      await channel.send({ embeds: [statusEmbed] });
    }
  }

  if (!isPaid) {
    return false;
  }

  processingTrackIds.add(trackId);

  try {
    if (channel && 'send' in channel) {
      const prefixMsg = forceComplete ? `🔧 スタッフにより支払い完了として手動処理されました。` : `🎉 ${userMention} お支払いが確認されました！`;
      await channel.send({ content: `${prefixMsg} Auto ConvertされたUSDTから受取通貨への両替・送金処理を開始します。` });
    }

    let paidAmount = 0;
    let selectedNetwork = '';

    const currenciesResponse = await requestOxaPay('GET', '/common/currencies', null, merchantKey);
    let withdrawFee = 0;
    if (currenciesResponse.status === 200) {
      const currencyData = currenciesResponse.data || {};
      const takeCoinInfo = currencyData[takeSymbolUpper] || currencyData[takeSymbol.toLowerCase()];
      if (takeCoinInfo && takeCoinInfo.networks) {
        let networkKey = Object.keys(takeCoinInfo.networks)[0];
        if (takeSymbolUpper === 'USDT' && takeCoinInfo.networks['Ethereum']) {
          networkKey = 'Ethereum';
        }
        selectedNetwork = networkKey;
        const netInfo = takeCoinInfo.networks[networkKey];
        if (netInfo) {
          withdrawFee = parseFloat(netInfo.withdraw_fee) || 0;
        }
      }
    }

    let finalPayoutAmount = finalTakeAmount;
    let swappedAmount = 0;
    let takePrice = 0;

    if (takeSymbolUpper === 'USDT') {
      if (channel && 'send' in channel) {
        await channel.send({ content: `指定アドレスへ ${finalPayoutAmount.toFixed(6)} USDT の自動送金を開始します。` });
      }
    } else {
      const neededTakeAmount = finalTakeAmount + withdrawFee;

      const pricesResponse = await requestOxaPay('GET', '/common/prices', null, merchantKey);
      if (pricesResponse.status === 200) {
        const prices = pricesResponse.data || {};
        takePrice = prices[takeSymbolUpper] || prices[takeSymbol.toLowerCase()] || 0;
      }
      if (takePrice <= 0) {
        throw new Error(`Could not retrieve current price for ${takeSymbolUpper}`);
      }

      let usdtToSwap = neededTakeAmount * takePrice;

      const calcResp = await requestOxaPay('POST', '/general/swap/calculate', {
        from_currency: 'USDT',
        to_currency: takeSymbolUpper,
        amount: usdtToSwap
      }, generalKey);

      if (calcResp.result === 100 || calcResp.result === 1 || calcResp.status === 200) {
        const calcToAmount = parseFloat(calcResp.to_amount || calcResp.data?.to_amount || '0');
        if (calcToAmount > 0 && calcToAmount < neededTakeAmount) {
          usdtToSwap = usdtToSwap * (neededTakeAmount / calcToAmount);
        }
      }

      if (channel && 'send' in channel) {
        await channel.send({ content: '変換を実施中...' });
      }

      const swapData = {
        from_currency: 'USDT',
        to_currency: takeSymbolUpper,
        amount: usdtToSwap
      };

      // --- 両替 (Swap) 処理 (エラー時 10秒待機してリトライ) ---
      let swapSuccess = false;
      let lastSwapError: any = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`[Executing OxaPay USDT-to-TakeSymbol Swap Request Attempt ${attempt}/3]`, JSON.stringify(swapData));
          const swapResponse = await requestOxaPay('POST', '/general/swap', swapData, generalKey);

          const isSwapSuccess = swapResponse.result === 100 || swapResponse.result === 1 || swapResponse.status === 200;
          if (!isSwapSuccess) {
            const errKey = swapResponse.error?.key;
            const errMsg = swapResponse.error?.message || swapResponse.message || JSON.stringify(swapResponse);

            if (errKey === 'invalid_ip') {
              throw new Error(`OxaPay APIのIP制限エラー (invalid_ip): OxaPayダッシュボード(oxapay.com)で General API Key の IP制限を解除してください。`);
            } else if (errKey === 'min_from_amount_not_met') {
              throw new Error(`OxaPay スワップ最小金額未達成 (min_from_amount_not_met): 送金先へスワップするための金額 (${usdtToSwap.toFixed(4)} USDT) が OxaPay の最小両替制限を下回っています。 (${errMsg})`);
            }
            throw new Error(`USDT ➔ ${takeSymbolUpper} Swap API failed: ${errMsg}`);
          }

          const swappedAmountStr = swapResponse.to_amount || swapResponse.data?.to_amount || swapResponse.amount || swapResponse.data?.amount;
          swappedAmount = parseFloat(swappedAmountStr);

          if (isNaN(swappedAmount) || swappedAmount <= 0) {
            throw new Error(`Invalid swapped to_amount received: ${swappedAmountStr}`);
          }

          swapSuccess = true;
          break;
        } catch (err: any) {
          lastSwapError = err;
          console.error(`[Swap Attempt ${attempt}/3 Failed]`, err.message || err);
          if (err.message?.includes('invalid_ip')) {
            throw err;
          }
          if (attempt < 3) {
            if (channel && 'send' in channel) {
              await channel.send({ content: `⚠️ 両替(Swap)処理中に一時的なエラーが発生しました。10秒後に再試行します... (${attempt}/3)` });
            }
            await new Promise(res => setTimeout(res, 10000));
          }
        }
      }

      if (!swapSuccess) {
        throw lastSwapError || new Error(`両替(Swap)処理が3回試行後も成功しませんでした。`);
      }

      finalPayoutAmount = Math.min(finalTakeAmount, swappedAmount - withdrawFee);
      if (finalPayoutAmount <= 0) {
        finalPayoutAmount = swappedAmount - withdrawFee;
      }

      if (finalPayoutAmount <= 0) {
        throw new Error(`スワップ後の数量 (${swappedAmount} ${takeSymbolUpper}) が送金手数料 (${withdrawFee} ${takeSymbolUpper}) 以下となり、送金できません。`);
      }

      if (channel && 'send' in channel) {
        await channel.send({ content: `両替完了: ${swappedAmount.toFixed(6)} ${takeSymbolUpper} を取得。指定アドレスへの送金を開始します。` });
      }
    }

    const payoutData: any = {
      address: userAddress,
      currency: takeSymbolUpper,
      amount: finalPayoutAmount
    };
    if (selectedNetwork) {
      payoutData.network = selectedNetwork;
    }

    // --- 送金 (Payout) 処理 (エラー時 10秒待機してリトライ) ---
    let payoutSuccess = false;
    let lastPayoutError: any = null;
    let payoutResponse: any = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[Executing OxaPay Payout Request Attempt ${attempt}/3]`, JSON.stringify(payoutData));
        payoutResponse = await requestOxaPay('POST', '/payout', payoutData, payoutKey);

        const isSuccess = payoutResponse.result === 100 || payoutResponse.result === 1 || payoutResponse.status === 200 || !!payoutResponse.track_id || !!payoutResponse.data?.track_id;
        if (!isSuccess) {
          const errKey = payoutResponse.error?.key;
          const errMsg = payoutResponse.error?.message || payoutResponse.message || JSON.stringify(payoutResponse);

          if (errKey === 'invalid_ip') {
            throw new Error(`OxaPay APIのIP制限エラー (invalid_ip): OxaPayダッシュボード(oxapay.com)で Payout API Key の IP制限 (IP Whitelist) を無効化するか、現在のIPを許可リストに追加してください。`);
          }
          throw new Error(`Payout API failed: ${errMsg}`);
        }

        payoutSuccess = true;
        break;
      } catch (err: any) {
        lastPayoutError = err;
        console.error(`[Payout Attempt ${attempt}/3 Failed]`, err.message || err);
        if (err.message?.includes('invalid_ip')) {
          throw err;
        }
        if (attempt < 3) {
          if (channel && 'send' in channel) {
            await channel.send({ content: `⚠️ 送金(Payout)処理中にエラーが発生しました。10秒後に再送金を試行します... (${attempt}/3)` });
          }
          await new Promise(res => setTimeout(res, 10000));
        }
      }
    }

    if (!payoutSuccess) {
      throw lastPayoutError || new Error(`送金(Payout)処理が3回試行後も成功しませんでした。`);
    }

    // 送金完了後に余った端数暗号通貨（0.02ドル以上）を自動的に USDT にスワップバックして還元する
    if (takeSymbolUpper !== 'USDT' && swappedAmount > 0 && takePrice > 0) {
      const remainedCrypto = swappedAmount - finalPayoutAmount - withdrawFee;
      if (remainedCrypto > 0) {
        const remainedUsd = remainedCrypto * takePrice;
        console.log(`[Residual Balance Check] Remained ${takeSymbolUpper}: ${remainedCrypto} (approx $${remainedUsd.toFixed(4)})`);
        if (remainedUsd >= 0.02) {
          console.log(`[Residual Auto-Convert] Converting remaining ${remainedCrypto} ${takeSymbolUpper} ($${remainedUsd.toFixed(4)}) back to USDT...`);
          const convertBackData = {
            from_currency: takeSymbolUpper,
            to_currency: 'USDT',
            amount: remainedCrypto
          };
          requestOxaPay('POST', '/general/swap', convertBackData, generalKey)
            .then(convertResp => {
              console.log(`[Residual Auto-Convert Success] ${takeSymbolUpper} -> USDT:`, JSON.stringify(convertResp));
            })
            .catch(err => {
              console.error(`[Residual Auto-Convert Error] Failed to convert remaining ${takeSymbolUpper} back to USDT:`, err);
            });
        }
      }
    }

    if (channel && 'send' in channel) {
      const successEmbed = new EmbedBuilder()
        .setTitle('🎉 お取引が完了しました')
        .setDescription(`${userMention} 様、ご利用ありがとうございました。\n自動両替および指定アドレスへの送金が完了しました。`)
        .addFields(
          { name: '📤 支払った通貨', value: `${formatWithEmoji(paySymbolUpper)}`, inline: true },
          { name: '📌 送金先アドレス', value: `\`${userAddress}\``, inline: false }
        )
        .setColor('#00ff00')
        .setTimestamp();

      const closeButton = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('チケットを閉じる')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒');
      const rowClose = new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton);

      await channel.send({
        embeds: [successEmbed],
        components: [rowClose]
      });
    }

    const payText = payJpyAmount
      ? `${payJpyAmount.toLocaleString()} 円`
      : `${paySymbolUpper}`;

    const jpyVal = payJpyAmount || 0;
    const usdVal = payUsdAmount ? parseFloat(payUsdAmount) : 0;

    const userIdMatch = userMention.match(/\d+/);
    const userId = userIdMatch ? userIdMatch[0] : '';

    saveTransactionRecord({
      userId: userId || 'unknown',
      exchangeType: 'crypto_to_crypto',
      pairLabel: `${paySymbolUpper} ➔ ${takeSymbolUpper}`,
      payAmount: Number(payCryptoAmount) || 0,
      payCurrency: paySymbolUpper,
      takeAmount: finalTakeAmount || 0,
      takeCurrency: takeSymbolUpper,
      usdValue: usdVal,
      timestamp: new Date().toISOString(),
      privacy: 'pending'
    });

    if (userId) {
      await triggerPrivacyPreferenceFlow({
        userId,
        guildId: channel.guild ? channel.guild.id : '',
        userMention,
        exchangeTypeLabel: 'Crypto To Crypto (暗号通貨 ➔ 暗号通貨)',
        pairLabel: `${paySymbolUpper} ➔ ${takeSymbolUpper}`,
        payAmountText: payText,
        jpyAmount: jpyVal,
        usdAmount: usdVal,
        channel,
        client: channel.client
      });
    } else {
      await sendTransactionLogEmbed(channel, {
        userMention,
        exchangeTypeLabel: 'Crypto To Crypto (暗号通貨 ➔ 暗号通貨)',
        pairLabel: `${paySymbolUpper} ➔ ${takeSymbolUpper}`,
        payAmountText: payText,
        trackId
      });
    }

    completedTrackIds.add(trackId);
    return true;
  } finally {
    processingTrackIds.delete(trackId);
  }
}

/**
 * Crypto To Fiat 用の支払い監視コアロジック (ポチ袋送金用)
 */
export async function processFiatPaymentCheckCore(
  channel: any,
  trackId: string,
  paySymbol: string,
  takeSymbol: string,
  takeJpyValue: number,
  userMention: string,
  payJpyAmount?: number,
  payUsdAmount?: string,
  payCryptoAmount?: string,
  forceComplete: boolean = false
): Promise<boolean> {
  // 既に完了済みの場合は重複処理をスキップ
  if (completedTrackIds.has(trackId)) {
    console.log(`[Payment Lock] Track ID ${trackId} is already completed. Skipping duplicate execution.`);
    return true;
  }

  // 現在別スレッド/Webhookで処理中の場合は重複処理を防止
  if (processingTrackIds.has(trackId)) {
    console.log(`[Payment Lock] Track ID ${trackId} is currently being processed by another worker. Skipping concurrent run.`);
    return false;
  }

  const merchantKey = process.env.OXAPAY_MERCHANT_KEY;
  if (!merchantKey) return false;

  const paySymbolUpper = paySymbol.toUpperCase();
  let isPaid = forceComplete;
  let rawStatus = forceComplete ? 'Confirmed (Manual)' : 'Unknown';

  const takeOption = fiatTakeOptions.find(opt => opt.value === takeSymbol);
  const takeLabel = takeOption ? takeOption.label : takeSymbol;

  if (!forceComplete) {
    const statusResponse = await requestOxaPay('GET', `/payment/${trackId}`, null, merchantKey);
    const dataObj = statusResponse.data || {};
    const txStatus = (Array.isArray(dataObj.txs) && dataObj.txs.length > 0) ? dataObj.txs[0].status : null;
    rawStatus = dataObj.status || txStatus || statusResponse.pay_status || statusResponse.payStatus || (typeof statusResponse.status === 'string' && statusResponse.status !== '200' ? statusResponse.status : 'Unknown');

    const lowerStatus = String(rawStatus).toLowerCase();
    isPaid = lowerStatus === 'paid' || lowerStatus === 'confirmed' || lowerStatus === 'complete' || lowerStatus === 'completed' || statusResponse.result === 100 || statusResponse.result === 1;

    let statusLabel = `\`${rawStatus}\``;
    if (lowerStatus === 'confirmed') statusLabel = '✅ 支払い・承認完了 (Confirmed)';
    else if (lowerStatus === 'paid') statusLabel = '✅ 支払い完了 (Paid)';
    else if (lowerStatus === 'waiting' || lowerStatus === 'new') statusLabel = '⏳ お支払い待ち (Waiting)';
    else if (lowerStatus === 'confirming') statusLabel = '🔄 ブロックチェーン確認中 (Confirming)';
    else if (lowerStatus === 'expired') statusLabel = '❌ 期限切れ (Expired)';

    const statusEmbed = new EmbedBuilder()
      .setTitle('🔍 現在の取引ステータス')
      .setDescription(`支払確認が実行されました。現在の取引状況は以下の通りです。`)
      .addFields(
        { name: '📌 取引ステータス', value: statusLabel, inline: true },
        { name: '📤 支払通貨', value: `${formatWithEmoji(paySymbolUpper)}`, inline: true },
        { name: '📥 受取方法', value: `${formatWithEmoji(takeLabel)}`, inline: true }
      )
      .setColor(isPaid ? '#00ff00' : '#0099ff')
      .setTimestamp();

    if (channel && 'send' in channel) {
      await channel.send({ embeds: [statusEmbed] });
    }
  }

  if (!isPaid) return false;

  processingTrackIds.add(trackId);

  try {
    const staffEmbed = new EmbedBuilder()
      .setTitle('🎉 お支払いが確認されました！ポチ袋送金依頼')
      .setDescription(`${forceComplete ? '🔧 スタッフの手動操作により支払い完了扱いとなりました。\n' : ''}${userMention} 様のお支払いが完了しました。\nサポートスタッフは以下の内容を確認の上、ポチ袋（PayPayポチ袋 / 楽天Pay送金リンクなど）を生成してこのチケットチャンネル内に送信してください。`)
      .addFields(
        { name: '📥 送金額 (日本円)', value: `**${Math.round(takeJpyValue).toLocaleString()} 円**`, inline: true },
        { name: '📋 送金形式', value: `**${formatWithEmoji(takeLabel)} (ポチ袋/送金リンク)**`, inline: true }
      )
      .setColor('#00ff00')
      .setTimestamp();

    const closeButton = new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('チケットを閉じる')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒');
    const rowClose = new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton);

    if (channel && 'send' in channel) {
      const userEmbed = new EmbedBuilder()
        .setTitle('✅ お支払いが確認されました')
        .setDescription(`${userMention} 様、お支払いが確認されました。\n\nただいまスタッフが **${takeLabel}** のポチ袋/送金リンクを手配しております。\nお渡しまでもうしばらくお待ちください。`)
        .setColor('#00ff00')
        .setTimestamp();

      await channel.send({ embeds: [userEmbed] });

      const fiatRequestChannelId = process.env.FIAT_SEND_REQUEST_CHANNEL_ID;
      if (fiatRequestChannelId && channel.client) {
        try {
          const reqChannel = await channel.client.channels.fetch(fiatRequestChannelId);
          if (reqChannel && 'send' in reqChannel) {
            const payText = payJpyAmount
              ? `${payJpyAmount.toLocaleString()} 円`
              : `${paySymbolUpper}`;
            const jpyVal = payJpyAmount || takeJpyValue || 0;
            const usdVal = payUsdAmount ? parseFloat(payUsdAmount) : 0;

            const requestData = {
              userMention,
              paySymbolUpper,
              takeLabel,
              payText,
              jpyVal,
              usdVal
            };

            const reqEmbed = new EmbedBuilder()
              .setTitle('🚨 【要対応】Crypto To Fiat ポチ袋手配リクエスト')
              .setDescription(`ユーザーのお支払いが完了し、ポチ袋等の手配が必要です。`)
              .addFields(
                { name: '📥 受け取り方法', value: `**${formatWithEmoji(takeLabel)}**`, inline: true },
                { name: '💴 送るべき金額', value: `**${Math.round(takeJpyValue).toLocaleString()} 円**`, inline: true },
                { name: '👤 ユーザー', value: `${userMention}`, inline: true },
                { name: '🎫 対象チケット', value: `<#${channel.id}>`, inline: true },
                { name: '⏰ 発生日時', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true }
              )
              .setColor('#ffaa00')
              .setTimestamp()
              .setFooter({ text: `RequestData: ${JSON.stringify(requestData)}` });

            const linkButton = new ButtonBuilder()
              .setCustomId(`fiat_send_link:${channel.id}`)
              .setLabel('Linkを入力')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('🔗');

            const passButton = new ButtonBuilder()
              .setCustomId(`fiat_send_pass:${channel.id}`)
              .setLabel('Passwordを入力')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('🔑');

            const completeButton = new ButtonBuilder()
              .setCustomId(`fiat_send_complete:${channel.id}`)
              .setLabel('完了')
              .setStyle(ButtonStyle.Success)
              .setEmoji('✅');

            const reqRow = new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton, passButton, completeButton);

            const supportRoleId = process.env.SUPPORT_ROLE_ID;
            const mentionContent = supportRoleId ? `<@&${supportRoleId}>` : '@Support';

            await reqChannel.send({
              content: `${mentionContent} 新しい送金手配リクエストが発生しました。`,
              embeds: [reqEmbed],
              components: [reqRow]
            });
          }
        } catch (err) {
          console.error('Failed to send fiat request to fiat channel:', err);
        }
      } else {
        // 互換性のため、FIAT_SEND_REQUEST_CHANNEL_ID がない場合は従来通り元のチャンネルに通知
        await channel.send({
          embeds: [staffEmbed],
          components: [rowClose]
        });

        const supportRoleId = process.env.SUPPORT_ROLE_ID;
        const mentionContent = supportRoleId ? `<@&${supportRoleId}>` : '@Support';
        await channel.send({
          content: `${mentionContent} お客様からの暗号通貨着金が確認されました（または手動承認）。上記の金額【${Math.round(takeJpyValue).toLocaleString()}円 (${takeLabel})】のポチ袋/送金リンクを作成し、このチャンネルへ送信してください！`
        });
      }
    }

    const fiatRequestChannelId = process.env.FIAT_SEND_REQUEST_CHANNEL_ID;
    if (fiatRequestChannelId && channel && channel.client) {
      completedTrackIds.add(trackId);
      return true;
    }

    const payText = payJpyAmount
      ? `${payJpyAmount.toLocaleString()} 円`
      : `${paySymbolUpper}`;

    const jpyVal = payJpyAmount || takeJpyValue || 0;
    const usdVal = payUsdAmount ? parseFloat(payUsdAmount) : 0;

    const userIdMatch = userMention.match(/\d+/);
    const userId = userIdMatch ? userIdMatch[0] : '';

    saveTransactionRecord({
      userId: userId || 'unknown',
      exchangeType: 'crypto_to_fiat',
      pairLabel: `${paySymbolUpper} ➔ ${takeLabel}`,
      payAmount: Number(payCryptoAmount) || 0,
      payCurrency: paySymbolUpper,
      takeAmount: takeJpyValue || 0,
      takeCurrency: 'JPY',
      usdValue: usdVal,
      timestamp: new Date().toISOString(),
      privacy: 'pending'
    });

    if (userId) {
      await triggerPrivacyPreferenceFlow({
        userId,
        guildId: channel.guild ? channel.guild.id : '',
        userMention,
        exchangeTypeLabel: 'Crypto To Fiat (暗号通貨 ➔ 日本円)',
        pairLabel: `${paySymbolUpper} ➔ ${takeLabel}`,
        payAmountText: payText,
        jpyAmount: jpyVal,
        usdAmount: usdVal,
        channel,
        client: channel.client
      });
    } else {
      await sendTransactionLogEmbed(channel, {
        userMention,
        exchangeTypeLabel: 'Crypto To Fiat (暗号通貨 ➔ 日本円)',
        pairLabel: `${paySymbolUpper} ➔ ${takeLabel}`,
        payAmountText: payText,
        trackId
      });
    }

    completedTrackIds.add(trackId);
    return true;
  } finally {
    processingTrackIds.delete(trackId);
  }
}

/**
 * 「支払い完了」ボタン押下時の処理 (Crypto To Crypto 用)
 */
export async function handleCheckPayment(interaction: ButtonInteraction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  const trackId = parts[1];

  let paymentData: any = {};
  if (interaction.message && interaction.message.embeds.length > 0) {
    const embed = interaction.message.embeds[interaction.message.embeds.length - 1];
    if (embed.footer && embed.footer.text && embed.footer.text.startsWith('PaymentData: ')) {
      try {
        paymentData = JSON.parse(embed.footer.text.replace('PaymentData: ', ''));
      } catch (e) {
        console.error('Failed to parse PaymentData from footer:', e);
      }
    }
  }

  const paySymbol = (paymentData.paySymbol || parts[2] || 'UNKNOWN').toUpperCase();
  const takeSymbol = (paymentData.takeSymbol || parts[3] || 'UNKNOWN').toUpperCase();
  const finalTakeAmount = paymentData.finalTakeAmount !== undefined ? paymentData.finalTakeAmount : parseFloat(parts[4] || '0');
  const userAddress = paymentData.userAddress || parts[5] || 'UNKNOWN';
  const payJpyAmount = paymentData.jpyAmount !== undefined ? paymentData.jpyAmount : (parts[6] ? parseFloat(parts[6]) : undefined);
  const payUsdAmount = paymentData.usdAmount !== undefined ? String(paymentData.usdAmount) : parts[7];
  const payCryptoAmount = paymentData.payAmount !== undefined ? String(paymentData.payAmount) : parts[8];

  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.channel;
  const channelId = interaction.channelId;
  const userMention = `${interaction.user}`;

  try {
    const isPaidSuccess = await processPaymentCheckCore(
      channel,
      trackId,
      paySymbol,
      takeSymbol,
      finalTakeAmount,
      userAddress,
      userMention,
      payJpyAmount,
      payUsdAmount,
      payCryptoAmount
    );

    if (isPaidSuccess) {
      if (interaction.message) {
        await interaction.message.edit({ components: [] });
      }
      await interaction.editReply({ content: 'お支払いが確認され、自動両替・送金処理が完了しました！' });
      return;
    }

    await interaction.editReply({ content: '即時確認を行いましたが、まだブロックチェーン上の着金が確認できていません。\n**着金が完了次第、Webhookにより自動的に検知・送金処理が完了します。** そのまま少々お待ちください。' });

  } catch (error: any) {
    console.error('OxaPay swap/payout process failed:', error);
    await sendStaffErrorThread(channel, 'エクスチェンジ自動処理エラー', error.message || String(error));
    if (channel && 'send' in channel) {
      const supportRoleId = process.env.SUPPORT_ROLE_ID;
      const mentionContent = supportRoleId ? `<@&${supportRoleId}>` : '@Support';
      await channel.send({
        content: `Error ${mentionContent}`
      });
    }
  }
}

/**
 * 「支払い完了」ボタン押下時の処理 (Crypto To Fiat 用)
 */
export async function handleCheckFiatPayment(interaction: ButtonInteraction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  const trackId = parts[1];

  let paymentData: any = {};
  if (interaction.message && interaction.message.embeds.length > 0) {
    const embed = interaction.message.embeds[interaction.message.embeds.length - 1];
    if (embed.footer && embed.footer.text && embed.footer.text.startsWith('PaymentData: ')) {
      try {
        paymentData = JSON.parse(embed.footer.text.replace('PaymentData: ', ''));
      } catch (e) {
        console.error('Failed to parse PaymentData from footer:', e);
      }
    }
  }

  const paySymbol = (paymentData.paySymbol || parts[2] || 'UNKNOWN').toUpperCase();
  const takeSymbol = paymentData.takeSymbol || parts[3] || 'UNKNOWN';
  const takeJpyValue = paymentData.takeJpyValue !== undefined ? paymentData.takeJpyValue : parseFloat(parts[4] || '0');
  const payJpyAmount = paymentData.payJpyAmount !== undefined ? paymentData.payJpyAmount : (parts[5] ? parseFloat(parts[5]) : undefined);
  const payUsdAmount = paymentData.usdAmount !== undefined ? String(paymentData.usdAmount) : parts[6];
  const payCryptoAmount = paymentData.payAmount !== undefined ? String(paymentData.payAmount) : parts[7];

  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.channel;
  const channelId = interaction.channelId;
  const userMention = `${interaction.user}`;

  try {
    const isPaidSuccess = await processFiatPaymentCheckCore(
      channel,
      trackId,
      paySymbol,
      takeSymbol,
      takeJpyValue,
      userMention,
      payJpyAmount,
      payUsdAmount,
      payCryptoAmount
    );

    if (isPaidSuccess) {
      if (interaction.message) {
        await interaction.message.edit({ components: [] });
      }
      await interaction.editReply({ content: 'お支払いが確認され、スタッフへポチ袋送金手配の通知を送信しました！' });
      return;
    }

    await interaction.editReply({ content: '即時確認を行いましたが、まだブロックチェーン上の着金が確認できていません。\n**着金が完了次第、Webhookにより自動的に検知・スタッフへ手配通知が行われます。** そのまま少々お待ちください。' });

  } catch (error: any) {
    console.error('OxaPay fiat payment check failed:', error);
    await sendStaffErrorThread(channel, 'Fiat支払い確認処理エラー', error.message || String(error));
    if (channel && 'send' in channel) {
      const supportRoleId = process.env.SUPPORT_ROLE_ID;
      const mentionContent = supportRoleId ? `<@&${supportRoleId}>` : '@Support';
      await channel.send({
        content: `Error ${mentionContent}`
      });
    }
  }
}

/**
 * スタッフによる `.mark as completed` メッセージコマンド処理
 */
export async function handleMarkAsCompletedCommand(message: Message) {
  const member = message.member;
  if (!member) return;

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
    return;
  }

  const channel = message.channel;
  if (!('messages' in channel)) return;

  try {
    // 直近メッセージから最大500件まで遡って探索
    const allFetchedMessages: any[] = [];
    let lastId: string | undefined = undefined;
    for (let i = 0; i < 5; i++) {
      const options: any = { limit: 100 };
      if (lastId) options.before = lastId;
      const msgs: any = await channel.messages.fetch(options);
      if (!msgs || msgs.size === 0) break;
      allFetchedMessages.push(...Array.from(msgs.values()));
      lastId = msgs.last()?.id;

      const hasCompleted = allFetchedMessages.some(m =>
        m.embeds?.some((e: any) => e.title === '🎉 お取引が完了しました')
      );
      const hasPayment = allFetchedMessages.some(m =>
        m.embeds?.some((e: any) => e.footer?.text?.startsWith('PaymentData: '))
      );

      if (hasCompleted || hasPayment) {
        break;
      }
      if (msgs.size < 100) break;
    }

    const alreadyCompleted = allFetchedMessages.some(m =>
      m.embeds.some((e: any) => e.title === '🎉 お取引が完了しました')
    );
    if (alreadyCompleted) {
      await message.reply('⚠️ このチケットのお取引は既に完了しています。');
      return;
    }

    let targetMsg: any = null;
    let paymentData: any = null;

    for (const msg of allFetchedMessages) {
      if (msg.embeds && msg.embeds.length > 0) {
        for (const embed of msg.embeds) {
          if (embed.footer && embed.footer.text && embed.footer.text.startsWith('PaymentData: ')) {
            try {
              paymentData = JSON.parse(embed.footer.text.replace('PaymentData: ', ''));
              targetMsg = msg;
              break;
            } catch (e) {
              console.error('Failed to parse PaymentData from footer:', e);
            }
          }
        }
      }
      if (paymentData) break;
    }

    if (!paymentData) {
      await message.reply('⚠️ このチャンネルでお支払い待ち（リンク発行済み）の取引が見つかりませんでした。');
      return;
    }

    const isPayFiat = paymentData?.paySymbol &&
      fiatGiveOptions.some(opt => opt.value === paymentData.paySymbol.toLowerCase() || opt.value === paymentData.paySymbol);
    const isTakeFiat = paymentData?.takeSymbol &&
      (paymentData.takeSymbol.toLowerCase() === 'paypay' || paymentData.takeSymbol.toLowerCase() === 'rakuten_pay');

    const trackId = String(paymentData.trackId || '');
    const paySymbol = String(paymentData.paySymbol || 'UNKNOWN').toUpperCase();
    const takeSymbol = String(paymentData.takeSymbol || 'UNKNOWN');
    const userMention = paymentData.userId ? `<@${paymentData.userId}>` : `<@${message.author.id}>`;

    if (isPayFiat) {
      // Fiat to Crypto (PayPay等 ➔ 暗号通貨)
      const { finalTakeAmount, userAddress, jpyAmount, usdAmount, userId } = paymentData;
      const takeSymbolUpper = takeSymbol.toUpperCase();

      await message.reply('🔧 手動コマンドにより、暗号資産の送金完了として処理を実行します...');

      const successEmbed = new EmbedBuilder()
        .setTitle('🎉 お取引が完了しました')
        .setDescription(`${userMention} 様、ご利用ありがとうございました。\n指定アドレスへの送金が完了しました。`)
        .addFields(
          { name: '📤 支払った額', value: `${jpyAmount ? jpyAmount.toLocaleString() : '0'} 円 (${paySymbol})`, inline: true },
          { name: '📥 受け取った額', value: `約 ${finalTakeAmount} ${takeSymbolUpper}`, inline: true },
          { name: '📌 送金先アドレス', value: `\`${userAddress}\``, inline: false }
        )
        .setColor('#00ff00')
        .setTimestamp();

      const closeButton = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('チケットを閉じる')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒');
      const rowClose = new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton);

      if ('send' in channel) {
        await (channel as any).send({
          embeds: [successEmbed],
          components: [rowClose]
        });
      }

      if (targetMsg) {
        await targetMsg.edit({ components: [] }).catch(() => {});
      }

      // スタッフ通知チャンネルのメッセージがあれば処理済みに更新
      const requestChannelId = process.env.FIAT_RECEIVE_REQUEST_CHANNEL_ID;
      if (requestChannelId) {
        try {
          const reqChannel = await message.client.channels.fetch(requestChannelId).catch(() => null);
          if (reqChannel && 'messages' in reqChannel) {
            const reqMsgs = await (reqChannel as any).messages.fetch({ limit: 20 });
            for (const rm of reqMsgs.values()) {
              if (rm.embeds && rm.embeds.length > 0) {
                const footer = rm.embeds[0].footer?.text || '';
                if (footer.includes(`"channelId":"${channel.id}"`)) {
                  const embed = EmbedBuilder.from(rm.embeds[0]);
                  embed.setTitle('✅ 【手動コマンド処理済】Fiat To Crypto 受け取り＆送金リクエスト');
                  embed.setColor('#00ff00');
                  await rm.edit({ embeds: [embed], components: [] }).catch(() => {});
                  break;
                }
              }
            }
          }
        } catch (err) {
          console.error('Failed to update fiat request channel message:', err);
        }
      }

      saveTransactionRecord({
        userId: userId || 'unknown',
        exchangeType: 'fiat_to_crypto',
        pairLabel: `${paySymbol} ➔ ${takeSymbolUpper}`,
        payAmount: jpyAmount || 0,
        payCurrency: 'JPY',
        takeAmount: finalTakeAmount || 0,
        takeCurrency: takeSymbolUpper,
        usdValue: usdAmount || 0,
        timestamp: new Date().toISOString(),
        privacy: 'pending'
      });

      const guildId = message.guild?.id || ('guild' in channel ? (channel as any).guild?.id : '') || '';

      if (userId) {
        await triggerPrivacyPreferenceFlow({
          userId,
          guildId,
          userMention,
          exchangeTypeLabel: 'Fiat To Crypto (日本円 ➔ 暗号通貨)',
          pairLabel: `${paySymbol} ➔ ${takeSymbolUpper}`,
          payAmountText: `${jpyAmount ? jpyAmount.toLocaleString() : '0'} 円`,
          jpyAmount: jpyAmount || 0,
          usdAmount: usdAmount || 0,
          channel,
          client: message.client
        }).catch(console.error);
      } else {
        await sendTransactionLogEmbed(channel, {
          userMention,
          exchangeTypeLabel: 'Fiat To Crypto (日本円 ➔ 暗号通貨)',
          pairLabel: `${paySymbol} ➔ ${takeSymbolUpper}`,
          payAmountText: `${jpyAmount ? jpyAmount.toLocaleString() : '0'} 円`
        }).catch(console.error);
      }

    } else if (isTakeFiat) {
      // Crypto to Fiat (暗号通貨 ➔ PayPay/楽天ペイ)
      const takeJpyValue = paymentData.takeJpyValue !== undefined ? paymentData.takeJpyValue : 0;
      const payJpyAmount = paymentData.payJpyAmount || paymentData.jpyAmount;
      const payUsdAmount = paymentData.usdAmount !== undefined ? String(paymentData.usdAmount) : undefined;
      const payCryptoAmount = paymentData.payAmount !== undefined ? String(paymentData.payAmount) : undefined;

      await message.reply('🔧 手動コマンドにより支払い完了として処理を実行します...');

      const success = await processFiatPaymentCheckCore(
        channel,
        trackId,
        paySymbol,
        takeSymbol,
        takeJpyValue,
        userMention,
        payJpyAmount,
        payUsdAmount,
        payCryptoAmount,
        true // forceComplete
      );

      if (success) {
        stopPollingForChannel(channel.id);
        if (targetMsg) await targetMsg.edit({ components: [] }).catch(() => {});
      }

    } else {
      // Crypto to Crypto (暗号通貨 ➔ 暗号通貨)
      const finalTakeAmount = paymentData.finalTakeAmount !== undefined ? paymentData.finalTakeAmount : 0;
      const userAddress = paymentData.userAddress || 'UNKNOWN';
      const payJpyAmount = paymentData.jpyAmount !== undefined ? paymentData.jpyAmount : paymentData.payJpyAmount;
      const payUsdAmount = paymentData.usdAmount !== undefined ? String(paymentData.usdAmount) : undefined;
      const payCryptoAmount = paymentData.payAmount !== undefined ? String(paymentData.payAmount) : undefined;

      await message.reply('🔧 手動コマンドにより支払い完了として処理を実行します...');

      const success = await processPaymentCheckCore(
        channel,
        trackId,
        paySymbol,
        takeSymbol,
        finalTakeAmount,
        userAddress,
        userMention,
        payJpyAmount,
        payUsdAmount,
        payCryptoAmount,
        true // forceComplete
      );

      if (success) {
        stopPollingForChannel(channel.id);
        if (targetMsg) await targetMsg.edit({ components: [] }).catch(() => {});
      }
    }

  } catch (error: any) {
    console.error('Failed to execute handleMarkAsCompletedCommand:', error);
    await sendStaffErrorThread(channel, '手動完遂コマンド実行エラー', error.message || String(error));
    const supportRoleId = process.env.SUPPORT_ROLE_ID;
    const mentionContent = supportRoleId ? `<@&${supportRoleId}>` : '@Support';
    await message.reply(`Error ${mentionContent}`);
  }
}

/**
 * スタッフによる `.refresh` メッセージコマンド処理 (最新レートでの再計算・更新)
 */
export async function handleRefreshCommand(message: Message) {
  const member = message.member;
  if (!member) return;

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
    return;
  }

  const channel = message.channel;
  if (!('messages' in channel)) return;

  try {
    const result = await refreshTicketChannel(channel, true);
    if (!result.success) {
      await message.reply(`⚠️ ${result.message}`);
    }
  } catch (error: any) {
    console.error('Failed to execute handleRefreshCommand:', error);
    await message.reply(`⚠️ 再計算処理中にエラーが発生しました: ${error.message || String(error)}`);
  }
}

/**
 * Fiat Request Channel の「Linkを入力」ボタンのハンドラ
 */
export async function handleFiatSendLinkButton(interaction: ButtonInteraction) {
  const parts = interaction.customId.split(':');
  const ticketChannelId = parts[1];

  const modal = new ModalBuilder()
    .setCustomId(`submit_fiat_link:${ticketChannelId}`)
    .setTitle('ポチ袋 / 送金リンクの入力');

  const urlInput = new TextInputBuilder()
    .setCustomId('fiat_link_url')
    .setLabel('送金リンク (URL)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('https://paypay.me/...');

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(urlInput);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

/**
 * Fiat Request Channel の「Passwordを入力」ボタンのハンドラ
 */
export async function handleFiatSendPassButton(interaction: ButtonInteraction) {
  const parts = interaction.customId.split(':');
  const ticketChannelId = parts[1];

  const modal = new ModalBuilder()
    .setCustomId(`submit_fiat_pass:${ticketChannelId}`)
    .setTitle('ポチ袋パスワードの入力');

  const passInput = new TextInputBuilder()
    .setCustomId('fiat_pass_code')
    .setLabel('パスワード')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('1234');

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(passInput);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

/**
 * Fiat Request Channel の Modal Submit (Link / Pass共通) ハンドラ
 */
export async function handleFiatSendModalSubmit(interaction: ModalSubmitInteraction) {
  const parts = interaction.customId.split(':');
  const type = parts[0]; // submit_fiat_link or submit_fiat_pass
  const ticketChannelId = parts[1];

  await interaction.deferReply({ ephemeral: true });

  try {
    const message = interaction.message;
    if (!message || message.embeds.length === 0) {
      await interaction.editReply({ content: '元のリクエストメッセージが見つかりません。' });
      return;
    }

    const originalEmbed = EmbedBuilder.from(message.embeds[0]);
    let requestData: any = {};
    if (originalEmbed.data.footer && originalEmbed.data.footer.text && originalEmbed.data.footer.text.startsWith('RequestData: ')) {
      try {
        requestData = JSON.parse(originalEmbed.data.footer.text.replace('RequestData: ', ''));
      } catch (e) {
        console.error('Failed to parse RequestData from footer:', e);
      }
    }

    if (type === 'submit_fiat_link') {
      const url = interaction.fields.getTextInputValue('fiat_link_url');
      requestData.fiat_link = url;
    } else {
      const pass = interaction.fields.getTextInputValue('fiat_pass_code');
      requestData.fiat_pass = pass;
    }

    originalEmbed.setFooter({ text: `RequestData: ${JSON.stringify(requestData)}` });

    // 進行状況の表示を更新
    let statusText = 'ユーザーのお支払いが完了し、ポチ袋等の手配が必要です。\n\n**【入力状況】**\n';
    statusText += `🔗 送金リンク: ${requestData.fiat_link ? '✅ 入力済み' : '未入力'}\n`;
    statusText += `🔑 パスワード: ${requestData.fiat_pass ? '✅ 入力済み' : '未入力'}`;
    originalEmbed.setDescription(statusText);

    await message.edit({ embeds: [originalEmbed] });
    await interaction.editReply({ content: '情報を保存しました。すべての入力が終わったら「完了」ボタンを押してユーザーに送信してください。' });

  } catch (error) {
    console.error('Error in handleFiatSendModalSubmit:', error);
    await interaction.editReply({ content: 'エラーが発生しました。' });
  }
}

/**
 * Fiat Request Channel の「完了」ボタンのハンドラ
 */
export async function handleFiatSendCompleteButton(interaction: ButtonInteraction) {
  const parts = interaction.customId.split(':');
  const ticketChannelId = parts[1];

  await interaction.deferReply({ ephemeral: true });

  try {
    const message = interaction.message;
    if (message && message.embeds.length > 0) {
      const originalEmbed = EmbedBuilder.from(message.embeds[0]);

      let requestData: any = {};
      if (originalEmbed.data.footer && originalEmbed.data.footer.text && originalEmbed.data.footer.text.startsWith('RequestData: ')) {
        try {
          requestData = JSON.parse(originalEmbed.data.footer.text.replace('RequestData: ', ''));
        } catch (e) {
          console.error('Failed to parse RequestData from footer:', e);
        }
      }

      originalEmbed.setColor('#808080');
      originalEmbed.setTitle('✅ 【完了済】ポチ袋送金 / 返金リクエスト');
      originalEmbed.setFooter(null);

      const ticketChannel = await interaction.client.channels.fetch(ticketChannelId).catch(() => null);

      let sendDesc = '';
      if (requestData.fiat_link) sendDesc += `**送金リンク:**\n${requestData.fiat_link}\n\n`;
      if (requestData.fiat_pass) sendDesc += `**パスワード:**\n\`\`\`${requestData.fiat_pass}\`\`\`\n\n`;

      if (!sendDesc.trim()) {
        await interaction.editReply({
          content: '⚠️ まだ送金リンクまたはパスワードが入力されていません。「Linkを入力」または「Passwordを入力」ボタンから入力してください。',
        });
        return;
      }

      const userIdMatch = requestData.userMention ? requestData.userMention.match(/\d+/) : null;
      const targetUserId = requestData.userId || (userIdMatch ? userIdMatch[0] : null);

      let dmSent = false;
      let targetUserObj: any = null;
      if (targetUserId && sendDesc) {
        try {
          targetUserObj = await interaction.client.users.fetch(targetUserId).catch(() => null);
          if (targetUserObj) {
            const dmChannel = await targetUserObj.createDM();
            const dmEmbed = new EmbedBuilder()
              .setTitle('🎁 ポチ袋 / 返金受け取り情報')
              .setDescription(`スタッフより以下の送金・返金情報が届きました。\n内容をご確認の上、お受け取りください。\n\n${sendDesc.trim()}`)
              .setColor('#00ff00')
              .setTimestamp();

            await dmChannel.send({ embeds: [dmEmbed] });
            dmSent = true;
          }
        } catch (dmErr) {
          console.warn(`[Fiat Send DM Error] Failed to send DM to user ${targetUserId}:`, dmErr);
        }
      }

      let createdClaimChannel: any = null;
      if (!dmSent && targetUserId && sendDesc) {
        // DM送信失敗時: 相手に取られないよう、受取対象ユーザー専用の仮プライベートチャンネルを作成
        try {
          const guild = (ticketChannel && 'guild' in ticketChannel && ticketChannel.guild) ? ticketChannel.guild : interaction.guild;
          if (guild) {
            const supportRoleId = process.env.SUPPORT_ROLE_ID;
            const categoryId = process.env.TICKET_CATEGORY_ID || (ticketChannel && 'parentId' in ticketChannel ? ticketChannel.parentId : null);

            const cleanName = targetUserObj?.username ? targetUserObj.username.toLowerCase().replace(/[^a-z0-9]/g, '') : 'user';
            const claimChannel = await guild.channels.create({
              name: `claim-${cleanName}`,
              type: ChannelType.GuildText,
              parent: categoryId || null,
              permissionOverwrites: [
                {
                  id: guild.roles.everyone.id,
                  deny: [PermissionFlagsBits.ViewChannel],
                },
                {
                  id: targetUserId,
                  allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                  ],
                },
                {
                  id: interaction.client.user!.id,
                  allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageChannels,
                  ],
                },
                ...(supportRoleId ? [{
                  id: supportRoleId,
                  allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                  ],
                }] : [])
              ],
            });

            createdClaimChannel = claimChannel;

            const claimEmbed = new EmbedBuilder()
              .setTitle('🎁 ポチ袋 / 返金受け取り情報 (専用受取チャンネル)')
              .setDescription(
                `スタッフより以下の送金・返金情報が届きました。\n` +
                `内容をご確認の上、お受け取りください。\n\n` +
                `${sendDesc.trim()}\n\n` +
                `⚠️ **このチャンネルはあなたとスタッフのみが閲覧可能です（取引相手からは見えません）。**\n` +
                `※お受け取りが完了したら、下の「✅ 受け取り完了」を押してください（チャンネルは自動削除されます）。\n` +
                `※何も操作されなくても安全のため、3日後（72時間後）に自動削除されます。`
              )
              .setColor('#00ff00')
              .setFooter({ text: `ClaimData: ${JSON.stringify({ ticketChannelId, targetUserId, requestData })}` })
              .setTimestamp();

            const claimCompleteBtn = new ButtonBuilder()
              .setCustomId(`fiat_claim_complete:${claimChannel.id}:${ticketChannelId}`)
              .setLabel('✅ 受け取り完了 (このチャンネルを削除)')
              .setStyle(ButtonStyle.Success)
              .setEmoji('✅');

            const claimRow = new ActionRowBuilder<ButtonBuilder>().addComponents(claimCompleteBtn);

            await claimChannel.send({
              content: `<@${targetUserId}> 様、DMへの送信ができなかったため、あなた専用の安全な受取チャンネルを作成しました。`,
              embeds: [claimEmbed],
              components: [claimRow]
            });

            // 3日後 (3 * 24 * 60 * 60 * 1000 ms) に自動削除
            setTimeout(async () => {
              try {
                const ch = await interaction.client.channels.fetch(claimChannel.id).catch(() => null);
                if (ch) {
                  await (ch as TextChannel).delete('3日経過による自動クリーンアップ').catch(() => {});
                }
              } catch (e) {}
            }, 3 * 24 * 60 * 60 * 1000);
          }
        } catch (chErr) {
          console.error('[Fiat Send Claim Channel Error] Failed to create claim channel:', chErr);
        }
      }

      if (ticketChannel && 'send' in ticketChannel) {
        if (dmSent) {
          const receiveCompleteBtn = new ButtonBuilder()
            .setCustomId('fiat_receive_complete')
            .setLabel('受け取り完了 (チケットを閉じる)')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅');

          const rowAction = new ActionRowBuilder<ButtonBuilder>().addComponents(receiveCompleteBtn);

          const noticeEmbed = new EmbedBuilder()
            .setTitle('🎁 送金・返金処理が完了しました')
            .setDescription(`${requestData.userMention || 'お客様'} 様、お待たせいたしました！\nスタッフより**DM（ダイレクトメッセージ）へポチ袋・送金情報をお送りしました**のでご確認ください。\n\nお受け取りが完了したら、下のボタンを押してください。`)
            .setColor('#00ff00')
            .setFooter({ text: `RequestData: ${JSON.stringify(requestData)}` })
            .setTimestamp();

          await (ticketChannel as any).send({
            content: `${requestData.userMention || ''} 様、DMへポチ袋をお送りしました！`,
            embeds: [noticeEmbed],
            components: [rowAction]
          });
        } else if (createdClaimChannel) {
          const noticeEmbed = new EmbedBuilder()
            .setTitle('🎁 受取専用チャンネルが作成されました')
            .setDescription(
              `${requestData.userMention || 'お客様'} 様、DMへの送信ができなかったため、\n` +
              `安全のため**あなた専用の受取チャンネル <#${createdClaimChannel.id}>** を作成いたしました。\n\n` +
              `そちらのチャンネルからポチ袋情報をご確認・お受け取りください（他の取引相手からは見えません）。`
            )
            .setColor('#00ff00')
            .setTimestamp();

          await (ticketChannel as any).send({
            content: `${requestData.userMention || ''} 様、受取専用チャンネル <#${createdClaimChannel.id}> を作成しました！`,
            embeds: [noticeEmbed],
          });
        }
      }

      await message.edit({
        embeds: [originalEmbed],
        components: []
      });

      await interaction.editReply({
        content: dmSent
          ? 'リクエストを完了済みに更新し、ユーザーのDMへポチ袋情報を送信しました！'
          : (createdClaimChannel
              ? `リクエストを完了済みに更新しました（DMが閉じられていたため、安全な専用受取チャンネル <#${createdClaimChannel.id}> を作成して送信しました）。`
              : 'リクエストを完了済みに更新しました。')
      });
    }
  } catch (error) {
    console.error('Error in handleFiatSendCompleteButton:', error);
    await interaction.editReply({ content: '完了処理中にエラーが発生しました。' });
  }
}

/**
 * ユーザーが「受け取り完了」ボタンを押したときの処理
 */
export async function handleFiatReceiveCompleteButton(interaction: ButtonInteraction) {
  try {
    const message = interaction.message;
    if (message && message.embeds.length > 0) {
      const embed = EmbedBuilder.from(message.embeds[0]);
      let requestData: any = {};
      if (embed.data.footer && embed.data.footer.text && embed.data.footer.text.startsWith('RequestData: ')) {
        try {
          requestData = JSON.parse(embed.data.footer.text.replace('RequestData: ', ''));
        } catch (e) {
          console.error('Failed to parse RequestData on receive complete:', e);
        }
      }

      const { userMention, paySymbolUpper, takeLabel, payText, jpyVal, usdVal } = requestData;
      
      if (userMention) {
        const userIdMatch = userMention.match(/\d+/);
        const userId = userIdMatch ? userIdMatch[0] : '';
        const ticketChannel = interaction.channel;

        saveTransactionRecord({
          userId: userId || 'unknown',
          exchangeType: 'crypto_to_fiat',
          pairLabel: `${paySymbolUpper || '不明'} ➔ ${takeLabel || '不明'}`,
          payAmount: parseFloat(payText) || 0,
          payCurrency: paySymbolUpper,
          takeAmount: jpyVal || 0,
          takeCurrency: 'JPY',
          usdValue: usdVal || 0,
          timestamp: new Date().toISOString(),
          privacy: 'pending'
        });

        if (userId && ticketChannel) {
          // 「お取引ありがとうございました」DM送信
          await triggerPrivacyPreferenceFlow({
            userId,
            guildId: 'guild' in ticketChannel && ticketChannel.guild ? ticketChannel.guild.id : '',
            userMention,
            exchangeTypeLabel: 'Crypto To Fiat (暗号通貨 ➔ 日本円)',
            pairLabel: `${paySymbolUpper || '不明'} ➔ ${takeLabel || '不明'}`,
            payAmountText: payText || '不明',
            jpyAmount: jpyVal || 0,
            usdAmount: usdVal || 0,
            channel: ticketChannel as any,
            client: interaction.client
          }).catch(console.error);
        } else if (ticketChannel) {
          await sendTransactionLogEmbed(ticketChannel, {
            userMention,
            exchangeTypeLabel: 'Crypto To Fiat (暗号通貨 ➔ 日本円)',
            pairLabel: `${paySymbolUpper || '不明'} ➔ ${takeLabel || '不明'}`,
            payAmountText: payText || '不明'
          }).catch(console.error);
        }
      }

      embed.setFooter(null);
      await message.edit({
        embeds: [embed],
        components: [] 
      }).catch(() => {});
    }

    const { closeTicketChannel } = require('./channel');
    await closeTicketChannel(interaction);

  } catch (error) {
    console.error('Error in handleFiatReceiveCompleteButton:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '処理中にエラーが発生しました。', ephemeral: true });
    }
  }
}

/**
 * ユーザーが専用受取チャンネルで「受け取り完了」ボタンを押したときの処理 (チャンネル削除)
 */
export async function handleFiatClaimCompleteButton(interaction: ButtonInteraction) {
  const parts = interaction.customId.split(':');
  const claimChannelId = parts[1];
  const ticketChannelId = parts[2];

  await interaction.reply({
    content: '✅ お受け取りいただきありがとうございました！この受取専用チャンネルは5秒後に自動削除されます。',
  });

  const claimChannel = interaction.channel as TextChannel;
  if (claimChannel) {
    setTimeout(async () => {
      try {
        await claimChannel.delete('ユーザーによる受け取り完了');
      } catch (err) {
        console.error('Failed to delete claim channel:', err);
      }
    }, 5000);
  }

  if (ticketChannelId) {
    try {
      const ticketChannel = await interaction.client.channels.fetch(ticketChannelId).catch(() => null);
      if (ticketChannel && 'send' in ticketChannel) {
        await (ticketChannel as any).send({
          content: `✅ <@${interaction.user.id}> 様のポチ袋受け取りが完了しました。`,
        });
      }
    } catch (e) {}
  }
}

/**
 * Fiat -> Crypto: ユーザーがポチ袋・送金情報を入力するためのモーダルを表示
 */
export async function handleFiatReceiveInputLink(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId('fiat_receive_modal_submit')
    .setTitle('ポチ袋 / 送金情報の入力');

  const linkInput = new TextInputBuilder()
    .setCustomId('fiat_receive_link')
    .setLabel('送金リンク (URL)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('https://paypay.me/...');

  const passInput = new TextInputBuilder()
    .setCustomId('fiat_receive_pass')
    .setLabel('パスワード (無い場合は「なし」等)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('1234');

  const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(linkInput);
  const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(passInput);
  modal.addComponents(row1, row2);

  await interaction.showModal(modal);
}

/**
 * Fiat -> Crypto: モーダル送信時、リクエストチャンネルへ通知する
 */
export async function handleFiatReceiveInputSubmit(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const link = interaction.fields.getTextInputValue('fiat_receive_link');
  const pass = interaction.fields.getTextInputValue('fiat_receive_pass');

  const message = interaction.message;
  let paymentData: any = {};
  if (message && message.embeds.length > 0) {
    const embed = message.embeds[message.embeds.length - 1];
    if (embed.footer && embed.footer.text && embed.footer.text.startsWith('PaymentData: ')) {
      try {
        paymentData = JSON.parse(embed.footer.text.replace('PaymentData: ', ''));
      } catch (e) {}
    }
  }

  const { paySymbol, takeSymbol, finalTakeAmount, userAddress, jpyAmount, userId } = paymentData;

  const requestChannelId = process.env.FIAT_RECEIVE_REQUEST_CHANNEL_ID;
  if (!requestChannelId) {
    await interaction.editReply({ content: 'システムエラー: FIAT_RECEIVE_REQUEST_CHANNEL_ID が設定されていません。' });
    return;
  }

  try {
    const reqChannel = await interaction.client.channels.fetch(requestChannelId);
    if (reqChannel && 'send' in reqChannel) {
      const supportRoleId = process.env.SUPPORT_ROLE_ID;
      const mentionContent = supportRoleId ? `<@&${supportRoleId}>` : '@Support';

      const requestData = {
        ...paymentData,
        userMention: userId ? `<@${userId}>` : `<@${interaction.user.id}>`,
        channelId: interaction.channelId
      };

      const reqEmbed = new EmbedBuilder()
        .setTitle('🚨 【要対応】Fiat To Crypto 受け取り＆送金リクエスト')
        .setDescription('ユーザーから送金情報が提出されました。\n内容を確認して受け取りを完了し、**【✅ 受け取り済み (送金実行)】** ボタンを押してください。')
        .addFields(
          { name: '📥 受け取る額 (日本円)', value: `**${jpyAmount.toLocaleString()} 円** (${paySymbol})`, inline: true },
          { name: '📤 送金する額 (Crypto)', value: `**約 ${finalTakeAmount} ${takeSymbol}**`, inline: true },
          { name: '👤 ユーザー', value: requestData.userMention, inline: true },
          { name: '🔗 送金リンク', value: link, inline: false },
          { name: '🔑 パスワード', value: pass, inline: false },
          { name: '📌 ユーザーの送金先', value: `\`${userAddress}\``, inline: false }
        )
        .setColor('#ffaa00')
        .setTimestamp()
        .setFooter({ text: `RequestData: ${JSON.stringify(requestData)}` });

      const confirmBtn = new ButtonBuilder()
        .setCustomId('fiat_receive_confirmed')
        .setLabel('✅ 受け取り済み (送金実行)')
        .setStyle(ButtonStyle.Success);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn);

      await (reqChannel as any).send({
        content: `${mentionContent} 新しい受け取りリクエストが発生しました。`,
        embeds: [reqEmbed],
        components: [row]
      });

      if (message && message.embeds.length > 0) {
        const embedForm = EmbedBuilder.from(message.embeds[message.embeds.length - 1]);
        embedForm.setDescription('送金情報の提出が完了しました。\nスタッフの確認後、指定のアドレスへ自動送金が行われます。');
        await message.edit({ embeds: [embedForm], components: [] }).catch(() => {});
      }

      await interaction.editReply({ content: '送金情報を送信しました。スタッフの確認をお待ちください。' });
    } else {
      await interaction.editReply({ content: 'リクエストチャンネルが見つかりませんでした。' });
    }
  } catch (error) {
    console.error('Error sending fiat receive request:', error);
    await interaction.editReply({ content: 'エラーが発生しました。' });
  }
}

/**
 * Fiat -> Crypto: スタッフが受け取り完了ボタンを押した時の処理
 */
export async function handleFiatReceiveConfirmed(interaction: ButtonInteraction) {
  const member = interaction.member;
  if (!member) return;

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
    await interaction.reply({ content: '⚠️ このボタンを押す権限がありません。', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const message = interaction.message;
  let requestData: any = {};
  if (message && message.embeds.length > 0) {
    const embed = message.embeds[0];
    if (embed.footer && embed.footer.text && embed.footer.text.startsWith('RequestData: ')) {
      try {
        requestData = JSON.parse(embed.footer.text.replace('RequestData: ', ''));
      } catch (e) {}
    }
  }

  const { paySymbol, takeSymbol, finalTakeAmount, userAddress, jpyAmount, usdAmount, userMention, channelId, userId } = requestData;
  const ticketChannel = await interaction.client.channels.fetch(channelId).catch(() => null);

  if (ticketChannel && 'send' in ticketChannel) {
    await (ticketChannel as any).send({ content: `🔧 スタッフにより入金が確認されました。\n${takeSymbol} の自動送金処理を開始します...` });
  }

  try {
    const success = await executeCryptoPayout(
      ticketChannel,
      takeSymbol,
      finalTakeAmount,
      userAddress,
      userMention,
      jpyAmount,
      usdAmount,
      paySymbol,
      userId,
      interaction.client
    );

    if (success) {
      if (message && message.embeds.length > 0) {
        const embed = EmbedBuilder.from(message.embeds[0]);
        embed.setTitle('✅ 【処理済】Fiat To Crypto 受け取り＆送金リクエスト');
        embed.setColor('#00ff00');
        await message.edit({ embeds: [embed], components: [] }).catch(() => {});
      }
      await interaction.editReply({ content: 'ユーザーへの送金処理が完了しました。' });
    } else {
      await interaction.editReply({ content: '送金処理中にエラーが発生しました。ログを確認してください。' });
    }
  } catch (error: any) {
    console.error('Fiat receive confirmed payout error:', error);
    await interaction.editReply({ content: `送金処理に失敗しました: ${error.message}` });
  }
}

/**
 * Fiat -> Crypto (手動決済): チケット内のスタッフ用「支払い完了」ボタンの処理
 */
export async function handleFiatReceiveStaffConfirm(interaction: ButtonInteraction) {
  const member = interaction.member;
  if (!member) return;

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
    await interaction.reply({ content: '⚠️ このボタンを押す権限がありません。', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const message = interaction.message;
  let paymentData: any = {};
  if (message && message.embeds.length > 0) {
    const embed = message.embeds[message.embeds.length - 1];
    if (embed.footer && embed.footer.text && embed.footer.text.startsWith('PaymentData: ')) {
      try {
        paymentData = JSON.parse(embed.footer.text.replace('PaymentData: ', ''));
      } catch (e) {}
    }
  }

  const { paySymbol, takeSymbol, finalTakeAmount, userAddress, jpyAmount, usdAmount, userId } = paymentData;
  const userMention = userId ? `<@${userId}>` : 'お客様';

  const channel = interaction.channel;
  if (channel && 'send' in channel) {
    await (channel as any).send({ content: `🔧 スタッフにより入金が確認されました。\n${takeSymbol} の送金処理を開始します...` });
  }

  try {
    const success = await executeCryptoPayout(
      channel,
      takeSymbol,
      finalTakeAmount,
      userAddress,
      userMention,
      jpyAmount,
      usdAmount,
      paySymbol,
      userId,
      interaction.client
    );

    if (success) {
      if (message) {
        await message.edit({ components: [] }).catch(() => {});
      }
      await interaction.editReply({ content: '送金処理が完了しました。' });
    } else {
      await interaction.editReply({ content: '送金処理中にエラーが発生しました。ログを確認してください。' });
    }
  } catch (error: any) {
    console.error('Fiat receive staff confirm payout error:', error);
    await interaction.editReply({ content: `送金処理に失敗しました: ${error.message}` });
  }
}

/**
 * 共通の暗号通貨Payout実行処理
 */
export async function executeCryptoPayout(
  channel: any,
  takeSymbol: string,
  finalTakeAmount: number,
  userAddress: string,
  userMention: string,
  jpyAmount: number,
  usdAmount: number,
  paySymbol: string,
  userId: string,
  client: any
): Promise<boolean> {
  const merchantKey = process.env.OXAPAY_MERCHANT_KEY;
  const generalKey = process.env.OXAPAY_GENERAL_KEY;
  const payoutKey = process.env.OXAPAY_PAYOUT_KEY;

  if (!merchantKey || !generalKey || !payoutKey) {
    if (channel && 'send' in channel) {
      await channel.send({ content: '⚠️ システムエラー: OxaPay設定（APIキー群）が不足しています。' });
    }
    return false;
  }

  const takeSymbolUpper = takeSymbol.toUpperCase();
  let withdrawFee = 0;
  let selectedNetwork = '';
  
  const currenciesResponse = await requestOxaPay('GET', '/common/currencies', null, merchantKey);
  if (currenciesResponse.status === 200) {
    const currencyData = currenciesResponse.data || {};
    const takeCoinInfo = currencyData[takeSymbolUpper] || currencyData[takeSymbol.toLowerCase()];
    if (takeCoinInfo && takeCoinInfo.networks) {
      let networkKey = Object.keys(takeCoinInfo.networks)[0];
      if (takeSymbolUpper === 'USDT' && takeCoinInfo.networks['Ethereum']) {
        networkKey = 'Ethereum';
      }
      selectedNetwork = networkKey;
      const netInfo = takeCoinInfo.networks[networkKey];
      if (netInfo) {
        withdrawFee = parseFloat(netInfo.withdraw_fee) || 0;
      }
    }
  }

  let finalPayoutAmount = finalTakeAmount;
  let swappedAmount = 0;
  let takePrice = 0;

  if (takeSymbolUpper !== 'USDT') {
    const neededTakeAmount = finalTakeAmount + withdrawFee;

    const pricesResponse = await requestOxaPay('GET', '/common/prices', null, merchantKey);
    if (pricesResponse.status === 200) {
      const prices = pricesResponse.data || {};
      takePrice = prices[takeSymbolUpper] || prices[takeSymbol.toLowerCase()] || 0;
    }
    if (takePrice <= 0) {
      throw new Error(`Could not retrieve current price for ${takeSymbolUpper}`);
    }

    let usdtToSwap = neededTakeAmount * takePrice;

    const swapData = {
      from_currency: 'USDT',
      to_currency: takeSymbolUpper,
      amount: usdtToSwap
    };

    let swapSuccess = false;
    let lastSwapError: any = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const swapResponse = await requestOxaPay('POST', '/general/swap', swapData, generalKey);
        const isSwapSuccess = swapResponse.result === 100 || swapResponse.result === 1 || swapResponse.status === 200;
        if (!isSwapSuccess) {
          throw new Error(`USDT ➔ ${takeSymbolUpper} Swap API failed: ${swapResponse.message}`);
        }

        const swappedAmountStr = swapResponse.to_amount || swapResponse.data?.to_amount || swapResponse.amount || swapResponse.data?.amount;
        swappedAmount = parseFloat(swappedAmountStr);

        swapSuccess = true;
        break;
      } catch (err: any) {
        lastSwapError = err;
        if (attempt < 3) {
          if (channel && 'send' in channel) {
            await channel.send({ content: `⚠️ 両替処理エラー。10秒後に再試行します... (${attempt}/3)` });
          }
          await new Promise(res => setTimeout(res, 10000));
        }
      }
    }

    if (!swapSuccess) {
      throw lastSwapError || new Error(`両替(Swap)処理に失敗しました。`);
    }

    finalPayoutAmount = Math.min(finalTakeAmount, swappedAmount - withdrawFee);
    if (finalPayoutAmount <= 0) {
      finalPayoutAmount = swappedAmount - withdrawFee;
    }

    if (finalPayoutAmount <= 0) {
      throw new Error(`スワップ後の数量が送金手数料以下となり、送金できません。`);
    }
  }

  const payoutData: any = {
    address: userAddress,
    currency: takeSymbolUpper,
    amount: finalPayoutAmount
  };
  if (selectedNetwork) {
    payoutData.network = selectedNetwork;
  }

  let payoutSuccess = false;
  let lastPayoutError: any = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const payoutResponse = await requestOxaPay('POST', '/payout', payoutData, payoutKey);
      const isSuccess = payoutResponse.result === 100 || payoutResponse.result === 1 || payoutResponse.status === 200 || !!payoutResponse.track_id || !!payoutResponse.data?.track_id;
      if (!isSuccess) {
        throw new Error(`Payout API failed: ${payoutResponse.message}`);
      }
      payoutSuccess = true;
      break;
    } catch (err: any) {
      lastPayoutError = err;
      if (attempt < 3) {
        if (channel && 'send' in channel) {
          await channel.send({ content: `⚠️ 送金処理エラー。10秒後に再送金を試行します... (${attempt}/3)` });
        }
        await new Promise(res => setTimeout(res, 10000));
      }
    }
  }

  if (!payoutSuccess) {
    throw lastPayoutError || new Error(`送金(Payout)処理に失敗しました。`);
  }

  if (channel && 'send' in channel) {
    const successEmbed = new EmbedBuilder()
      .setTitle('🎉 お取引が完了しました')
      .setDescription(`${userMention} 様、ご利用ありがとうございました。\n指定アドレスへの送金が完了しました。`)
      .addFields(
        { name: '📤 支払った額', value: `${jpyAmount} 円 (${paySymbol})`, inline: true },
        { name: '📌 送金先アドレス', value: `\`${userAddress}\``, inline: false }
      )
      .setColor('#00ff00')
      .setTimestamp();

    const closeButton = new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('チケットを閉じる')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒');
    const rowClose = new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton);

    await channel.send({
      embeds: [successEmbed],
      components: [rowClose]
    });
  }

  saveTransactionRecord({
    userId: userId || 'unknown',
    exchangeType: 'fiat_to_crypto',
    pairLabel: `${paySymbol} ➔ ${takeSymbolUpper}`,
    payAmount: jpyAmount || 0,
    payCurrency: 'JPY',
    takeAmount: finalPayoutAmount || 0,
    takeCurrency: takeSymbolUpper,
    usdValue: usdAmount || 0,
    timestamp: new Date().toISOString(),
    privacy: 'pending'
  });

  if (userId) {
    await triggerPrivacyPreferenceFlow({
      userId,
      guildId: channel.guild ? channel.guild.id : '',
      userMention,
      exchangeTypeLabel: 'Fiat To Crypto (日本円 ➔ 暗号通貨)',
      pairLabel: `${paySymbol} ➔ ${takeSymbolUpper}`,
      payAmountText: `${jpyAmount.toLocaleString()} 円`,
      jpyAmount,
      usdAmount,
      channel,
      client
    }).catch(console.error);
  } else {
    await sendTransactionLogEmbed(channel, {
      userMention,
      exchangeTypeLabel: 'Fiat To Crypto (日本円 ➔ 暗号通貨)',
      pairLabel: `${paySymbol} ➔ ${takeSymbolUpper}`,
      payAmountText: `${jpyAmount.toLocaleString()} 円`
    }).catch(console.error);
  }

  return true;
}

/**
 * OxaPay からの Webhook (即時決済完了通知) を受信して即座に処理するハンドラー
 */
export async function handleOxaPayWebhook(webhookBody: any, client: Client): Promise<{ success: boolean; message: string }> {
  const trackId = String(webhookBody.trackId || webhookBody.track_id || webhookBody.trackID || '');
  const orderId = String(webhookBody.orderId || webhookBody.order_id || webhookBody.orderID || '');
  const rawStatus = String(webhookBody.status || webhookBody.pay_status || webhookBody.payStatus || '');

  console.log(`[OxaPay Webhook] Received webhook notification: trackId=${trackId}, orderId=${orderId}, status=${rawStatus}`);

  if (!orderId && !trackId) {
    console.warn('[OxaPay Webhook] Missing both orderId and trackId in webhook payload.');
    return { success: false, message: 'Missing orderId and trackId' };
  }

  let channel: any = null;
  if (orderId) {
    try {
      channel = await client.channels.fetch(orderId).catch(() => null);
    } catch (e) {
      console.error(`[OxaPay Webhook] Failed to fetch channel by orderId ${orderId}:`, e);
    }
  }

  // orderId からチャンネルが見つからない場合、全アクティブチケットチャンネルから trackId を探索
  if (!channel && trackId) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const channels = await guild.channels.fetch();
        for (const ch of channels.values()) {
          if (ch && ch.isTextBased() && !ch.isDMBased() && ch.name.startsWith('exch-')) {
            try {
              const msgs = await (ch as any).messages.fetch({ limit: 10 }).catch(() => null);
              if (msgs) {
                const found = msgs.some((m: any) =>
                  m.embeds?.some((e: any) => e.footer?.text?.includes(`"trackId":"${trackId}"`) || e.footer?.text?.includes(`"trackId":${trackId}`))
                );
                if (found) {
                  channel = ch;
                  break;
                }
              }
            } catch (err) {}
          }
        }
        if (channel) break;
      } catch (err) {}
    }
  }

  if (!channel || !('messages' in channel)) {
    console.warn(`[OxaPay Webhook] Ticket channel not found for orderId=${orderId}, trackId=${trackId}`);
    return { success: false, message: 'Ticket channel not found' };
  }

  // Middleman (取引仲介) チケットチャンネルの場合の即時着金処理
  if (channel.name?.startsWith('mm-')) {
    try {
      const { handleMMOxaPayPaymentSuccess } = await import('./middleman');
      const success = await handleMMOxaPayPaymentSuccess(channel, trackId);
      console.log(`[OxaPay Webhook] Successfully processed Middleman payment in #${channel.name} (${channel.id})`);
      return { success, message: 'Processed Middleman Webhook' };
    } catch (mmErr) {
      console.error('[OxaPay Webhook] Failed to process Middleman payment:', mmErr);
      return { success: false, message: 'Failed to process MM payment' };
    }
  }

  try {
    const messages = await (channel as any).messages.fetch({ limit: 25 });
    let paymentData: any = null;
    let targetMsg: any = null;

    for (const msg of messages.values()) {
      if (msg.embeds && msg.embeds.length > 0) {
        for (const embed of msg.embeds) {
          if (embed.footer && embed.footer.text && embed.footer.text.startsWith('PaymentData: ')) {
            try {
              const parsed = JSON.parse(embed.footer.text.replace('PaymentData: ', ''));
              if (String(parsed.trackId) === String(trackId) || !trackId) {
                paymentData = parsed;
                targetMsg = msg;
                break;
              }
            } catch (e) {
              console.error('[OxaPay Webhook] Failed to parse PaymentData from message embed:', e);
            }
          }
        }
      }
      if (paymentData) break;
    }

    if (!paymentData) {
      console.warn(`[OxaPay Webhook] PaymentData not found in channel #${channel.name} (${channel.id})`);
      return { success: false, message: 'PaymentData message not found in channel' };
    }

    // 既に完了しているかチェック
    const isAlreadyCompleted = messages.some((m: any) =>
      m.embeds?.some((e: any) => e.title === '🎉 お取引が完了しました')
    );
    if (isAlreadyCompleted) {
      console.log(`[OxaPay Webhook] Transaction in channel #${channel.name} is already completed.`);
      return { success: true, message: 'Already completed' };
    }

    const paySymbol = (paymentData.paySymbol || 'UNKNOWN').toUpperCase();
    const takeSymbol = paymentData.takeSymbol || 'UNKNOWN';
    const isTakeFiat = takeSymbol.toLowerCase() === 'paypay' || takeSymbol.toLowerCase() === 'rakuten_pay';
    const userMention = paymentData.userId ? `<@${paymentData.userId}>` : 'お客様';

    console.log(`[OxaPay Webhook] Triggering instant 0s processing for channel #${channel.name} (${channel.id})...`);

    if (isTakeFiat) {
      const takeJpyValue = paymentData.takeJpyValue !== undefined ? paymentData.takeJpyValue : 0;
      const payJpyAmount = paymentData.payJpyAmount || paymentData.jpyAmount;
      const payUsdAmount = paymentData.usdAmount !== undefined ? String(paymentData.usdAmount) : undefined;
      const payCryptoAmount = paymentData.payAmount !== undefined ? String(paymentData.payAmount) : undefined;

      const isPaidSuccess = await processFiatPaymentCheckCore(
        channel,
        trackId || paymentData.trackId,
        paySymbol,
        takeSymbol,
        takeJpyValue,
        userMention,
        payJpyAmount,
        payUsdAmount,
        payCryptoAmount,
        false
      );

      if (isPaidSuccess) {
        if (targetMsg) await targetMsg.edit({ components: [] }).catch(() => {});
        stopPollingForChannel(channel.id);
        console.log(`[OxaPay Webhook] Successfully processed instant fiat payment for trackId ${trackId}`);
        return { success: true, message: 'Fiat payment processed' };
      }
    } else {
      const finalTakeAmount = paymentData.finalTakeAmount !== undefined ? paymentData.finalTakeAmount : 0;
      const userAddress = paymentData.userAddress || 'UNKNOWN';
      const payJpyAmount = paymentData.jpyAmount !== undefined ? paymentData.jpyAmount : paymentData.payJpyAmount;
      const payUsdAmount = paymentData.usdAmount !== undefined ? String(paymentData.usdAmount) : undefined;
      const payCryptoAmount = paymentData.payAmount !== undefined ? String(paymentData.payAmount) : undefined;

      const isPaidSuccess = await processPaymentCheckCore(
        channel,
        trackId || paymentData.trackId,
        paySymbol,
        takeSymbol,
        finalTakeAmount,
        userAddress,
        userMention,
        payJpyAmount,
        payUsdAmount,
        payCryptoAmount,
        false
      );

      if (isPaidSuccess) {
        if (targetMsg) await targetMsg.edit({ components: [] }).catch(() => {});
        stopPollingForChannel(channel.id);
        console.log(`[OxaPay Webhook] Successfully processed instant crypto payout for trackId ${trackId}`);
        return { success: true, message: 'Crypto payout processed' };
      }
    }

    return { success: true, message: 'Webhook checked, awaiting confirmation' };
  } catch (error: any) {
    console.error(`[OxaPay Webhook Error] Failed to process webhook for trackId ${trackId}:`, error);
    return { success: false, message: error.message || 'Error processing webhook' };
  }
}

