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
} from 'discord.js';
import { activePollings, fiatTakeOptions, stopPollingForChannel } from '../config';
import { requestOxaPay } from '../oxapay';
import { sendTransactionLogEmbed } from '../logger';

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

    await dmChannel.send({ embeds: [embed], components: [row] });
  } catch (dmErr) {
    console.error(`[DM Send Failed] Could not send privacy preference DM to user ${data.userId}. Defaulting to public log.`, dmErr);
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
        { name: '📤 支払通貨', value: `${paySymbolUpper}`, inline: true },
        { name: '📥 受取予定/受取通貨', value: `${takeSymbolUpper}`, inline: true },
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

  if (channel && 'send' in channel) {
    const prefixMsg = forceComplete ? `🔧 スタッフにより支払い完了として手動処理されました。` : `🎉 ${userMention} お支払いが確認されました！`;
    await channel.send({ content: `${prefixMsg} Auto ConvertされたUSDTから受取通貨への両替・送金処理を開始します。` });
  }

  let paidAmount = 0;

  const currenciesResponse = await requestOxaPay('GET', '/common/currencies', null, merchantKey);
  let withdrawFee = 0;
  if (currenciesResponse.status === 200) {
    const currencyData = currenciesResponse.data || {};
    const takeCoinInfo = currencyData[takeSymbolUpper] || currencyData[takeSymbol.toLowerCase()];
    if (takeCoinInfo && takeCoinInfo.networks) {
      let networkKey = Object.keys(takeCoinInfo.networks)[0];
      if (takeSymbolUpper === 'USDT' && takeCoinInfo.networks['TRON']) {
        networkKey = 'TRON';
      } else if (takeSymbolUpper === 'USDT' && takeCoinInfo.networks['BSC']) {
        networkKey = 'BSC';
      }
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

  const payoutData = {
    address: userAddress,
    currency: takeSymbolUpper,
    amount: finalPayoutAmount
  };

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
        { name: '📤 支払った通貨', value: `${paySymbolUpper}`, inline: true },
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

  return true;
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
        { name: '📤 支払通貨', value: `${paySymbolUpper}`, inline: true },
        { name: '📥 受取方法', value: `${takeLabel}`, inline: true }
      )
      .setColor(isPaid ? '#00ff00' : '#0099ff')
      .setTimestamp();

    if (channel && 'send' in channel) {
      await channel.send({ embeds: [statusEmbed] });
    }
  }

  if (!isPaid) return false;

  const staffEmbed = new EmbedBuilder()
    .setTitle('🎉 お支払いが確認されました！ポチ袋送金依頼')
    .setDescription(`${forceComplete ? '🔧 スタッフの手動操作により支払い完了扱いとなりました。\n' : ''}${userMention} 様のお支払いが完了しました。\nサポートスタッフは以下の内容を確認の上、ポチ袋（PayPayポチ袋 / 楽天Pay送金リンクなど）を生成してこのチケットチャンネル内に送信してください。`)
    .addFields(
      { name: '📥 送金額 (日本円)', value: `**${Math.round(takeJpyValue).toLocaleString()} 円**`, inline: true },
      { name: '📋 送金形式', value: `**${takeLabel} (ポチ袋/送金リンク)**`, inline: true }
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
              { name: '📥 受け取り方法', value: `**${takeLabel}**`, inline: true },
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
    // 新ルート（リクエストチャンネル経由）の場合は、
    // 完了ボタン (handleFiatSendCompleteButton) 押下時に DM/ログ送信を行うためここでは何もしない
    return true;
  }

  const payText = payJpyAmount 
    ? `${payJpyAmount.toLocaleString()} 円`
    : `${paySymbolUpper}`;

  const jpyVal = payJpyAmount || takeJpyValue || 0;
  const usdVal = payUsdAmount ? parseFloat(payUsdAmount) : 0;

  const userIdMatch = userMention.match(/\d+/);
  const userId = userIdMatch ? userIdMatch[0] : '';

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

  return true;
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
      if (activePollings.has(trackId)) {
        clearInterval(activePollings.get(trackId)!.timer);
        activePollings.delete(trackId);
      }
      await interaction.editReply({ content: 'お支払いが確認され、自動両替・送金処理が完了しました！' });
      return;
    }

    await interaction.editReply({ content: '「支払い完了」ボタンが押されました。即時確認を行いましたが、まだ着金が確認できていません。\n**1分間隔で自動的に支払状況を継続確認します。** 着金次第、全自動で両替・送金が完了します。' });

    if (!activePollings.has(trackId)) {
      console.log(`[Auto Polling Started] Track ID: ${trackId} for Channel: ${channelId} (Interval: 60s)`);
      const timer = setInterval(async () => {
        try {
          console.log(`[Auto Polling Check] Executing payment check for Track ID: ${trackId}`);
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
            payCryptoAmount
          );

          if (success) {
            console.log(`[Auto Polling Success] Payment confirmed & processed for Track ID: ${trackId}`);
            if (interaction.message) {
              await interaction.message.edit({ components: [] }).catch(() => {});
            }
            clearInterval(timer);
            activePollings.delete(trackId);
          }
        } catch (pollErr: any) {
          console.error(`[Auto Polling Error] Track ID: ${trackId}:`, pollErr);
          await sendStaffErrorThread(channel, '自動監視・両替・送金処理エラー', pollErr.message || String(pollErr));
          if (pollErr.message?.includes('Unknown Channel') || pollErr.code === 10003) {
            console.log(`[Auto Polling Stopped] Channel deleted, clearing polling for Track ID: ${trackId}`);
            clearInterval(timer);
            activePollings.delete(trackId);
            return;
          }
        }
      }, 60000);

      activePollings.set(trackId, { timer, channelId });
    }

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
      if (activePollings.has(trackId)) {
        clearInterval(activePollings.get(trackId)!.timer);
        activePollings.delete(trackId);
      }
      await interaction.editReply({ content: 'お支払いが確認され、スタッフへポチ袋送金手配の通知を送信しました！' });
      return;
    }

    await interaction.editReply({ content: '「支払い完了」ボタンが押されました。即時確認を行いましたが、まだ着金が確認できていません。\n**1分間隔で自動的に支払状況を継続確認します。** 着金次第、スタッフへポチ袋送金手配の通知を送信します。' });

    if (!activePollings.has(trackId)) {
      console.log(`[Auto Fiat Polling Started] Track ID: ${trackId} for Channel: ${channelId} (Interval: 60s)`);
      const timer = setInterval(async () => {
        try {
          console.log(`[Auto Fiat Polling Check] Executing payment check for Track ID: ${trackId}`);
          const success = await processFiatPaymentCheckCore(
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

          if (success) {
            console.log(`[Auto Fiat Polling Success] Payment confirmed & processed for Track ID: ${trackId}`);
            if (interaction.message) {
              await interaction.message.edit({ components: [] }).catch(() => {});
            }
            clearInterval(timer);
            activePollings.delete(trackId);
          }
        } catch (pollErr: any) {
          console.error(`[Auto Fiat Polling Error] Track ID: ${trackId}:`, pollErr);
          await sendStaffErrorThread(channel, 'Fiat支払い自動監視エラー', pollErr.message || String(pollErr));
          if (pollErr.message?.includes('Unknown Channel') || pollErr.code === 10003) {
            console.log(`[Auto Fiat Polling Stopped] Channel deleted, clearing polling for Track ID: ${trackId}`);
            clearInterval(timer);
            activePollings.delete(trackId);
            return;
          }
        }
      }, 60000);

      activePollings.set(trackId, { timer, channelId });
    }

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
    const fetchedMessages = await channel.messages.fetch({ limit: 25 });
    let targetButton: any = null;
    let targetMsg: any = null;

    for (const msg of fetchedMessages.values()) {
      if (msg.components && msg.components.length > 0) {
        for (const row of msg.components as any[]) {
          if (row.components && Array.isArray(row.components)) {
            for (const comp of row.components) {
              if (comp.customId && (comp.customId.startsWith('check_payment:') || comp.customId.startsWith('check_fiat_payment:'))) {
                targetButton = comp;
                targetMsg = msg;
                break;
              }
            }
          }
          if (targetButton) break;
        }
      }
      if (targetButton) break;
    }

    if (!targetButton) {
      await message.reply('⚠️ このチャンネルでお支払い待ち（リンク発行済み）の取引が見つかりませんでした。');
      return;
    }

    const customId = targetButton.customId;

    if (customId.startsWith('check_payment:')) {
      const parts = customId.split(':');
      const trackId = parts[1];

      let paymentData: any = {};
      if (targetMsg.embeds.length > 0) {
        const embed = targetMsg.embeds[targetMsg.embeds.length - 1];
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

      await message.reply('🔧 手動コマンドにより支払い完了として処理を実行します...');

      const success = await processPaymentCheckCore(
        channel,
        trackId,
        paySymbol,
        takeSymbol,
        finalTakeAmount,
        userAddress,
        `<@${message.author.id}>`,
        payJpyAmount,
        payUsdAmount,
        payCryptoAmount,
        true
      );

      if (success) {
        stopPollingForChannel(channel.id);
        await targetMsg.edit({ components: [] }).catch(() => {});
      }

    } else if (customId.startsWith('check_fiat_payment:')) {
      const parts = customId.split(':');
      const trackId = parts[1];

      let paymentData: any = {};
      if (targetMsg.embeds.length > 0) {
        const embed = targetMsg.embeds[targetMsg.embeds.length - 1];
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

      await message.reply('🔧 手動コマンドにより支払い完了として処理を実行します...');

      const success = await processFiatPaymentCheckCore(
        channel,
        trackId,
        paySymbol,
        takeSymbol,
        takeJpyValue,
        `<@${message.author.id}>`,
        payJpyAmount,
        payUsdAmount,
        payCryptoAmount,
        true
      );

      if (success) {
        stopPollingForChannel(channel.id);
        await targetMsg.edit({ components: [] }).catch(() => {});
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
      originalEmbed.setTitle('✅ 【完了済】Crypto To Fiat ポチ袋手配リクエスト');
      originalEmbed.setFooter(null); // フッターを消去しておく（任意）
      
      const ticketChannel = await interaction.client.channels.fetch(ticketChannelId);
      if (ticketChannel && 'send' in ticketChannel) {
        let sendDesc = '';
        if (requestData.fiat_link) sendDesc += `**送金リンク:**\n${requestData.fiat_link}\n\n`;
        if (requestData.fiat_pass) sendDesc += `**パスワード:**\n\`\`\`${requestData.fiat_pass}\`\`\`\n\n`;
        
        if (sendDesc) {
          const sendEmbed = new EmbedBuilder()
            .setTitle('🎁 お受け取り情報')
            .setDescription(`スタッフより以下の情報が届きました。\n内容をご確認ください。\n\n${sendDesc.trim()}`)
            .setColor('#00ff00')
            .setTimestamp()
            .setFooter({ text: `RequestData: ${JSON.stringify(requestData)}` });

          const receiveCompleteBtn = new ButtonBuilder()
            .setCustomId('fiat_receive_complete')
            .setLabel('受け取り完了 (チケットを閉じる)')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅');
          
          const rowAction = new ActionRowBuilder<ButtonBuilder>().addComponents(receiveCompleteBtn);

          // Embed内だけでは通知が飛ばないため、content に userMention を入れてプッシュ通知を発生させる
          await ticketChannel.send({ 
            content: `${requestData.userMention || ''} 様、お待たせいたしました！ポチ袋等の送付処理が完了しました。`,
            embeds: [sendEmbed],
            components: [rowAction]
          });
        }
      }

      await message.edit({
        embeds: [originalEmbed],
        components: [] // ボタンを消去
      });

      await interaction.editReply({ content: 'リクエストを完了済みに更新し、ユーザーへDMを送信しました。' });
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
