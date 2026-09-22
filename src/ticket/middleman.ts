import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  UserSelectMenuBuilder,
  UserSelectMenuInteraction,
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  TextChannel,
  Message,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import {
  fiatGiveOptions,
  fiatTakeOptions,
  cryptoOptions,
  formatWithEmoji,
  currentUsdJpyRate,
  activePollings,
  getCryptoSymbolFromLabel,
  isValidCryptoAddress,
} from '../config';
import { requestOxaPay } from '../oxapay';
import { parseUserInputAmount, calculateExchangeQuote } from './exchange';
import { saveTransactionRecord } from '../transactions';

const dataDir = path.join(process.cwd(), 'data');
const mmSessionsFile = path.join(dataDir, 'mm_sessions.json');

export interface MMSession {
  channelId: string;
  mainMessageId?: string;
  creatorId: string;
  creatorName?: string;
  partnerId?: string;
  partnerName?: string;
  buyerId?: string;
  buyerName?: string;
  sellerId?: string;
  sellerName?: string;
  currentTurn: number; // 1: 相手・役割選択, 2: 取引内容設定, 3: 代金預かり, 4: 商品引き渡し, 5: 代金リリース・完了

  // Turn 1
  creatorRoleChosen?: 'buyer' | 'seller';
  creatorRoleConfirmed?: boolean;
  partnerRoleConfirmed?: boolean;

  // Turn 2
  itemDescription?: string; // 売り手が設定
  payAmountText?: string;   // 売り手が設定
  payMethodRaw?: string;    // 買い手が選択したキー (e.g. 'paypay', 'btc', 'usdt')
  payMethod?: string;       // 買い手が選択した表示名 (e.g. 'Paypay', 'BTC')
  payMethodType?: 'fiat' | 'crypto';
  buyerAgreed?: boolean;
  sellerAgreed?: boolean;

  // Turn 3 (OxaPay / Fiat)
  oxapayPayLink?: string;
  oxapayTrackId?: string;
  oxapayUsdAmount?: number;
  fiatLink?: string;
  fiatPass?: string;
  buyerPaid?: boolean;
  escrowConfirmed?: boolean;

  // Turn 4
  sellerSentItem?: boolean;
  buyerReceivedItem?: boolean;

  // Turn 5 (Release / Payout)
  releaseMethod?: string;        // 売り手が選択した受取方法表示名 (e.g. 'Paypay', 'LTC')
  releaseMethodType?: 'fiat' | 'crypto';
  releaseSymbolRaw?: string;     // e.g. 'paypay', 'ltc'
  isConvertedRelease?: boolean;  // 買い手支払方法と異なるかどうか
  releaseAmountText?: string;    // 表示用受取額（例: '約 0.85 LTC (約 10,000 円)', '10,000 円' 等）
  releaseFinalCryptoAmount?: number; // 送金数量 (Crypto時)
  releaseUsdAmount?: number;     // USD価値
  releaseJpyAmount?: number;     // JPY価値 (Fiat時)
  sellerCryptoAddress?: string;  // 売り手のアドレス (Crypto時)
  payoutSuccess?: boolean;
  released?: boolean;
}

export const mmSessions = new Map<string, MMSession>();

/**
 * ディスクからセッションデータをロードする
 */
export function loadMMSessions() {
  if (fs.existsSync(mmSessionsFile)) {
    try {
      const content = fs.readFileSync(mmSessionsFile, 'utf8');
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, val] of Object.entries(parsed)) {
          mmSessions.set(key, val as MMSession);
        }
        console.log(`[MM Persistence] Loaded ${mmSessions.size} active MM sessions from disk.`);
      }
    } catch (err) {
      console.error('[MM Persistence] Failed to load mm_sessions.json:', err);
    }
  }
}

/**
 * ディスクへセッションデータを保存する
 */
export function saveMMSessions() {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const obj: Record<string, MMSession> = {};
    for (const [key, val] of mmSessions.entries()) {
      obj[key] = val;
    }
    fs.writeFileSync(mmSessionsFile, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('[MM Persistence] Failed to save mm_sessions.json:', err);
  }
}

/**
 * チケット削除時にセッションを削除する
 */
export function removeMMSession(channelId: string) {
  if (mmSessions.has(channelId)) {
    mmSessions.delete(channelId);
    saveMMSessions();
    console.log(`[MM Persistence] Removed MM session for channel ${channelId}`);
  }
}

// 起動時に自動ロード
loadMMSessions();

export function getOrCreateMMSession(channelId: string, creatorId: string = ''): MMSession {
  let session = mmSessions.get(channelId);
  if (!session) {
    session = {
      channelId,
      creatorId,
      currentTurn: 1,
    };
    mmSessions.set(channelId, session);
    saveMMSessions();
  } else if (creatorId && !session.creatorId) {
    session.creatorId = creatorId;
    saveMMSessions();
  }
  return session;
}

/**
 * 現在のターンに応じたEmbedとコンポーネントを生成する
 */
export function buildTurnPayload(session: MMSession) {
  const buyerMention = session.buyerId ? `<@${session.buyerId}>` : '未設定';
  const sellerMention = session.sellerId ? `<@${session.sellerId}>` : '未設定';
  const partnerMention = session.partnerId ? `<@${session.partnerId}>` : '未選択';
  const creatorMention = session.creatorId ? `<@${session.creatorId}>` : '作成者';

  const buyerLabel = session.buyerName ? `@${session.buyerName}` : (session.buyerId ? `<@${session.buyerId}>` : '買い手');
  const sellerLabel = session.sellerName ? `@${session.sellerName}` : (session.sellerId ? `<@${session.sellerId}>` : '売り手');
  const creatorLabel = session.creatorName ? `@${session.creatorName}` : '作成者';

  let content = '';
  if (!session.partnerId) {
    content = `${creatorMention} 取引仲介を開始します。取引相手を選択してください。`;
  } else {
    content = `${creatorMention} - ${partnerMention} の取引仲介を開始します`;
  }

  const embeds: EmbedBuilder[] = [];
  const components: any[] = [];

  switch (session.currentTurn) {
    case 1: {
      if (!session.partnerId) {
        const embed = new EmbedBuilder()
          .setTitle('🤝 取引仲介 (Middleman) チケット')
          .setDescription(
            `${creatorMention} 様、取引仲介チケットを作成しました。\n\n` +
            `**【ステップ 1: 取引相手の選択】**\n` +
            `まずは下のメニューから、**取引相手のDiscordユーザー**を選択してください。\n` +
            `選択すると相手がこのチャンネルに自動招待されます。\n\n` +
            `💡 *スタッフまたは参加者は \`.next\` コマンドでいつでも次のステップに進めることができます。*`
          )
          .setColor('#00ff99')
          .setFooter({ text: 'Turn 1 / 5: 取引相手の選択' })
          .setTimestamp();

        const userSelect = new UserSelectMenuBuilder()
          .setCustomId('mm_select_partner')
          .setPlaceholder('取引相手のユーザーを選択してください')
          .setMinValues(1)
          .setMaxValues(1);

        const nextButton = new ButtonBuilder()
          .setCustomId('mm_btn_next')
          .setLabel('次へ進む (.next)')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('⏩');

        const closeButton = new ButtonBuilder()
          .setCustomId('close_ticket')
          .setLabel('チケットを閉じる')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔒');

        const rowSelect = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);
        const rowButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(nextButton, closeButton);

        embeds.push(embed);
        components.push(rowSelect, rowButtons);
      } else if (!session.creatorRoleChosen) {
        const embed = new EmbedBuilder()
          .setTitle('👥 役割（買い手 / 売り手）の選択')
          .setDescription(
            `${partnerMention} 様をチケットに招待しました！\n\n` +
            `次に、取引作成者 ${creatorMention} の役割を選択してください。\n\n` +
            `💰 **買い手**: 代金を支払って物を受け取る側\n` +
            `📦 **売り手**: 物を渡して代金を受け取る側`
          )
          .addFields(
            { name: '👤 取引作成者', value: creatorMention, inline: true },
            { name: '👤 取引相手', value: partnerMention, inline: true }
          )
          .setColor('#0099ff')
          .setFooter({ text: 'Turn 1 / 5: 作成者の役割選択' })
          .setTimestamp();

        const buyerBtn = new ButtonBuilder()
          .setCustomId('mm_role:buyer')
          .setLabel(`私 (${creatorLabel}) が「買い手」`)
          .setStyle(ButtonStyle.Primary)
          .setEmoji('💰');

        const sellerBtn = new ButtonBuilder()
          .setCustomId('mm_role:seller')
          .setLabel(`私 (${creatorLabel}) が「売り手」`)
          .setStyle(ButtonStyle.Success)
          .setEmoji('📦');

        const nextBtn = new ButtonBuilder()
          .setCustomId('mm_btn_next')
          .setLabel('次へ進む (.next)')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('⏩');

        const rowRoles = new ActionRowBuilder<ButtonBuilder>().addComponents(buyerBtn, sellerBtn, nextBtn);
        embeds.push(embed);
        components.push(rowRoles);
      } else {
        const creatorRoleText = session.creatorRoleChosen === 'buyer' ? '💰 買い手（お金を払う側）' : '📦 売り手（物を渡す側）';
        const partnerRoleText = session.creatorRoleChosen === 'buyer' ? '📦 売り手（物を渡す側）' : '💰 買い手（お金を払う側）';

        const creatorStatus = session.creatorRoleConfirmed ? '✅ 同意済み' : '⏳ 未同意';
        const partnerStatus = session.partnerRoleConfirmed ? '✅ 同意済み' : '⏳ 未同意';

        const embed = new EmbedBuilder()
          .setTitle('👥 役割分担の確認と双方同意 (Turn 1)')
          .setDescription(
            `役割の初期選択が行われました。\n` +
            `**作成者・取引相手の両方**が下の「役割を確認・同意する」を押して合意してください。\n\n` +
            `双方が同意すると、自動的に次のステップ（取引内容の設定）へ進みます。`
          )
          .addFields(
            { name: '👤 取引作成者', value: `${creatorMention}\n役割: **${creatorRoleText}**\nステータス: **${creatorStatus}**`, inline: true },
            { name: '👤 取引相手', value: `${partnerMention}\n役割: **${partnerRoleText}**\nステータス: **${partnerStatus}**`, inline: true }
          )
          .setColor('#0099ff')
          .setFooter({ text: 'Turn 1 / 5: 双方による役割の確認と合意' })
          .setTimestamp();

        const confirmBtn = new ButtonBuilder()
          .setCustomId('mm_btn_confirm_role')
          .setLabel('役割を確認・同意する')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅');

        const resetBtn = new ButtonBuilder()
          .setCustomId('mm_btn_reset_role')
          .setLabel('役割を選び直す')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🔄');

        const nextBtn = new ButtonBuilder()
          .setCustomId('mm_btn_next')
          .setLabel('次へ進む (.next)')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('⏩');

        const rowConfirm = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn, resetBtn, nextBtn);
        embeds.push(embed);
        components.push(rowConfirm);
      }
      break;
    }

    case 2: {
      const isSellerDone = !!(session.itemDescription && session.payAmountText);
      const isBuyerDone = !!session.payMethod;

      if (!isSellerDone) {
        // === Step 2-1: 売り手の商品・金額設定 ===
        const embed = new EmbedBuilder()
          .setTitle('📋 取引内容の設定 (Step 1/3: 商品と金額)')
          .setDescription(
            `売り手 ${sellerMention} 様、まずは**引き渡す商品（アカウントやアイテム等）**と**希望金額**を設定してください。\n\n` +
            `下のボタンを押して入力してください。`
          )
          .addFields(
            { name: '📦 売り手 (物を渡す側)', value: sellerMention, inline: true },
            { name: '💰 買い手 (支払う側)', value: buyerMention, inline: true }
          )
          .setColor('#0099ff')
          .setFooter({ text: 'Turn 2 (Step 1/3): 売り手による商品と金額の設定' })
          .setTimestamp();

        const sellerBtn = new ButtonBuilder()
          .setCustomId('mm_btn_seller_set_item')
          .setLabel(`商品・金額を入力 (${sellerLabel})`)
          .setStyle(ButtonStyle.Primary)
          .setEmoji('📦');

        const nextBtn = new ButtonBuilder()
          .setCustomId('mm_btn_next')
          .setLabel('次へ進む (.next)')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('⏩');

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(sellerBtn, nextBtn);
        embeds.push(embed);
        components.push(row);
      } else if (!isBuyerDone) {
        // === Step 2-2: 買い手の支払方法選択 (Exchangeと同じセレクトメニュー) ===
        const embed = new EmbedBuilder()
          .setTitle('📋 支払方法の選択 (Step 2/3: 支払方法)')
          .setDescription(
            `売り手による商品・金額の設定が完了しました！\n\n` +
            `買い手 ${buyerMention} 様、下のメニューから**代金の支払方法（PayPay, 楽天Pay, 暗号資産等）**を選択してください。`
          )
          .addFields(
            { name: '📦 引き渡す商品', value: `**${session.itemDescription}**`, inline: true },
            { name: '💴 取引金額', value: `**${session.payAmountText}**`, inline: true },
            { name: '​', value: '​', inline: true },
            { name: '💰 買い手 (支払う側)', value: buyerMention, inline: true },
            { name: '📦 売り手 (物を渡す側)', value: sellerMention, inline: true }
          )
          .setColor('#0099ff')
          .setFooter({ text: 'Turn 2 (Step 2/3): 買い手による支払方法の選択' })
          .setTimestamp();

        const mmAllowedFiatKeys = ['paypay', 'rakuten_pay', 'kyash'];
        const mmFiatOptions = fiatGiveOptions.filter(opt => mmAllowedFiatKeys.includes(opt.value));

        const payOptions = [
          ...mmFiatOptions.map(opt => ({
            label: opt.label,
            value: `fiat:${opt.value}:${opt.label}`,
            description: '日本円（電子マネー/送金リンク）での支払い',
            emoji: (opt as any).emoji,
          })),
          ...cryptoOptions.map(opt => ({
            label: opt.label,
            value: `crypto:${opt.value}:${opt.label}`,
            description: '暗号資産（仮想通貨）での支払い',
            emoji: (opt as any).emoji,
          })),
        ];

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('mm_select_pay_method')
          .setPlaceholder(`支払方法を選択してください (${buyerLabel})`)
          .addOptions(payOptions);

        const editSellerBtn = new ButtonBuilder()
          .setCustomId('mm_btn_seller_set_item')
          .setLabel(`商品・金額を修正 (${sellerLabel})`)
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('✏️');

        const nextBtn = new ButtonBuilder()
          .setCustomId('mm_btn_next')
          .setLabel('次へ進む (.next)')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('⏩');

        const rowSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
        const rowBtns = new ActionRowBuilder<ButtonBuilder>().addComponents(editSellerBtn, nextBtn);
        embeds.push(embed);
        components.push(rowSelect, rowBtns);
      } else {
        // === Step 2-3: 最終確認と双方合意 ===
        const buyerAgreedStatus = session.buyerAgreed ? '✅ 同意済み' : '⏳ 未同意';
        const sellerAgreedStatus = session.sellerAgreed ? '✅ 同意済み' : '⏳ 未同意';

        const embed = new EmbedBuilder()
          .setTitle('📋 取引内容の確認と合意 (Step 3/3)')
          .setDescription(
            `すべての取引条件の設定が完了しました！\n\n` +
            `内容をご確認の上、**買い手・売り手の両方**が「取引内容に同意する」を押してください。\n` +
            `双方が同意すると、自動的に次のステップ（代金のお預かり）へ進みます。`
          )
          .addFields(
            { name: '📦 引き渡す商品', value: `**${session.itemDescription}**`, inline: true },
            { name: '💴 取引金額', value: `**${session.payAmountText}**`, inline: true },
            { name: '💳 支払方法', value: `${session.payMethod ? formatWithEmoji(session.payMethod) : '未設定'}`, inline: true },
            { name: '💰 買い手 (支払う側)', value: `${buyerMention}\nステータス: **${buyerAgreedStatus}**`, inline: true },
            { name: '📦 売り手 (物を渡す側)', value: `${sellerMention}\nステータス: **${sellerAgreedStatus}**`, inline: true }
          )
          .setColor('#ffaa00')
          .setFooter({ text: 'Turn 2 (Step 3/3): 最終確認と双方合意' })
          .setTimestamp();

        const agreeBtn = new ButtonBuilder()
          .setCustomId('mm_btn_agree')
          .setLabel('取引内容に同意する')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅');

        const editBuyerBtn = new ButtonBuilder()
          .setCustomId('mm_btn_reset_pay')
          .setLabel(`支払方法を変更 (${buyerLabel})`)
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('💳');

        const editSellerBtn = new ButtonBuilder()
          .setCustomId('mm_btn_seller_set_item')
          .setLabel(`商品・金額を修正 (${sellerLabel})`)
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('✏️');

        const nextBtn = new ButtonBuilder()
          .setCustomId('mm_btn_next')
          .setLabel('次へ進む (.next)')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('⏩');

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(agreeBtn, editBuyerBtn, editSellerBtn, nextBtn);
        embeds.push(embed);
        components.push(row);
      }
      break;
    }

    case 3: {
      const payMethod = session.payMethod ? formatWithEmoji(session.payMethod) : 'Fiat / 暗号資産';
      const payAmount = session.payAmountText || '指定金額';

      const isFiat = session.payMethodType === 'fiat' ||
        (!session.payMethod?.toLowerCase().includes('usdt') &&
         !session.payMethod?.toLowerCase().includes('btc') &&
         !session.payMethod?.toLowerCase().includes('ltc') &&
         !session.payMethod?.toLowerCase().includes('eth') &&
         !session.payMethod?.toLowerCase().includes('sol') &&
         !session.payMethod?.toLowerCase().includes('xmr') &&
         !session.payMethod?.toLowerCase().includes('crypto'));

      if (!isFiat) {
        // === 暗号資産（Crypto）の OxaPay インボイス画面 ===
        const embed = new EmbedBuilder()
          .setTitle('🔒 代金のお預かり (Turn 3: 暗号資産 OxaPay)')
          .setDescription(
            `買い手 ${buyerMention} 様、下の**「💳 お支払い画面を開く」**ボタンから OxaPay の支払い画面を開き、代金をお支払いください。\n\n` +
            `🛡️ **安全のため、Bot/サポートスタッフが代金を一時的にお預かり（Hold）します。**\n` +
            `⚠️ **代金の着金が確認されるまで、売り手 ${sellerMention} は絶対に商品を渡さないでください。**\n\n` +
            `🔄 **お支払いはブロックチェーン上で自動検知されます。** 着金が確認され次第、自動で次のステップ（商品引き渡し）へ進みます。`
          )
          .addFields(
            { name: '💰 買い手 (支払う人)', value: buyerMention, inline: true },
            { name: '💴 支払金額', value: `**${payAmount} (${payMethod})**`, inline: true },
            { name: '​', value: '​', inline: true },
            { name: '🔗 OxaPay Track ID', value: session.oxapayTrackId ? `\`${session.oxapayTrackId}\`` : '⏳ 発行中...', inline: true },
            { name: '⏱️ 着金ステータス', value: session.escrowConfirmed ? '✅ 預かり確認完了' : '⏳ 支払い・承認待ち (Webhook自動検知)', inline: true }
          )
          .setColor('#0099ff')
          .setFooter({ text: 'Turn 3 / 5: 暗号資産エスクロー預かり (OxaPay Webhook連動)' })
          .setTimestamp();

        const actionButtons: ButtonBuilder[] = [];

        if (session.oxapayPayLink) {
          const payLinkBtn = new ButtonBuilder()
            .setLabel('お支払い画面を開く (OxaPay)')
            .setURL(session.oxapayPayLink)
            .setStyle(ButtonStyle.Link)
            .setEmoji('💳');
          actionButtons.push(payLinkBtn);
        }

        const checkBtn = new ButtonBuilder()
          .setCustomId('mm_btn_check_oxapay')
          .setLabel(`支払状況を確認 (${buyerLabel})`)
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔍');

        const nextBtn = new ButtonBuilder()
          .setCustomId('mm_btn_next')
          .setLabel('次へ進む (.next)')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('⏩');

        actionButtons.push(checkBtn, nextBtn);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(actionButtons);
        embeds.push(embed);
        components.push(row);
      } else {
        // === Fiat（PayPay等）の送金画面 ===
        const buyerPaidStatus = session.buyerPaid ? '✅ 送金情報提出済み' : '⏳ 送金情報入力待ち';
        const escrowStatus = session.escrowConfirmed ? '✅ 預かり確認完了' : '⏳ スタッフ受取確認待ち';

        const embed = new EmbedBuilder()
          .setTitle('🔒 代金のお預かり (Turn 3: 日本円 / 送金リンク)')
          .setDescription(
            `買い手 ${buyerMention} 様、下の**「送金リンク・Passを入力」**ボタンからPayPayポチ袋等の送金情報を送信してください。\n\n` +
            `🛡️ **安全のため、サポートスタッフが代金を一時的にお預かり（Hold）します。**\n` +
            `⚠️ **代金の受取確認が完了するまで、売り手 ${sellerMention} は絶対に商品を渡さないでください。**\n\n` +
            `**【進行ステータス】**\n` +
            `・送金情報の提出: **${buyerPaidStatus}**\n` +
            `・スタッフ預かり確認: **${escrowStatus}**\n\n` +
            `💡 *送金情報が提出されるとスタッフへ通知され、スタッフの確認完了後に自動で次のステップへ進みます。*`
          )
          .addFields(
            { name: '💰 買い手 (支払う人)', value: buyerMention, inline: true },
            { name: '💴 支払金額', value: `${payAmount} (${payMethod})`, inline: true }
          )
          .setColor('#0099ff')
          .setFooter({ text: 'Turn 3 / 5: エスクロー代金預かり (スタッフ確認連動)' })
          .setTimestamp();

        const inputFiatBtn = new ButtonBuilder()
          .setCustomId('mm_btn_fiat_input')
          .setLabel(`送金リンク・Passを入力 (${buyerLabel})`)
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔗');

        const nextBtn = new ButtonBuilder()
          .setCustomId('mm_btn_next')
          .setLabel('次へ進む (.next)')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('⏩');

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(inputFiatBtn, nextBtn);
        embeds.push(embed);
        components.push(row);
      }
      break;
    }

    case 4: {
      const itemDetail = session.itemDescription || '指定の商品・データ';
      const payMethod = session.payMethod ? formatWithEmoji(session.payMethod) : 'Fiat / 暗号資産';
      const payAmount = session.payAmountText || '指定金額';

      const embed = new EmbedBuilder()
        .setTitle('📦 商品の引き渡しと受取確認 (Turn 4)')
        .setDescription(
          `🎉 **代金のお預かり（エスクロー）が完了しています！**\n\n` +
          `1. 売り手 ${sellerMention} 様は、このチャンネル内で**【${itemDetail}】**を買い手へお渡しください。\n` +
          `2. 買い手 ${buyerMention} 様は、商品を受け取って内容や動作を確認し、問題なければ下の**「受取完了」**を押してください。\n\n` +
          `⚠️ 売り手側で商品を用意できない等のお取引中止時は、売り手の方が**「返金」**を押してください。`
        )
        .addFields(
          { name: '📦 引き渡す商品', value: `**${itemDetail}**`, inline: true },
          { name: '💴 お預かり代金', value: `**${payAmount} (${payMethod})**`, inline: true },
          { name: '​', value: '​', inline: true },
          { name: '💰 買い手 (受取確認)', value: buyerMention, inline: true },
          { name: '📦 売り手 (商品引渡)', value: sellerMention, inline: true }
        )
        .setColor('#00ff99')
        .setFooter({ text: 'Turn 4 / 5: 商品引き渡しと受取確認' })
        .setTimestamp();

      const receivedBtn = new ButtonBuilder()
        .setCustomId('mm_btn_item_received')
        .setLabel(`受取完了 (${buyerLabel})`)
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅');

      const refundBtn = new ButtonBuilder()
        .setCustomId('mm_btn_seller_refund')
        .setLabel(`返金 (${sellerLabel})`)
        .setStyle(ButtonStyle.Danger)
        .setEmoji('↩️');

      const nextBtn = new ButtonBuilder()
        .setCustomId('mm_btn_next')
        .setLabel('次へ進む (.next)')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⏩');

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(receivedBtn, refundBtn, nextBtn);
      embeds.push(embed);
      components.push(row);
      break;
    }

    case 5: {
      const buyerPayMethod = session.payMethod ? formatWithEmoji(session.payMethod) : 'Fiat / 暗号資産';
      const payAmount = session.payAmountText || '指定金額';

      if (!session.releaseMethod) {
        // Step 5-1: 売り手による受取方法の選択
        const embed = new EmbedBuilder()
          .setTitle('🎉 お取引完了！受取方法の選択 (Turn 5)')
          .setDescription(
            `買い手 ${buyerMention} 様による商品の受取確認が完了しました！\n\n` +
            `お預かりしている代金 **【${payAmount} (${buyerPayMethod})】** を売り手 ${sellerMention} 様へ送金（リリース）します。\n\n` +
            `売り手 ${sellerMention} 様、下のメニューから**ご希望の受取方法**を選択してください。\n\n` +
            `💡 *買い手が支払った方法と同じ方法で受け取る場合は手数料無料、別の通貨・決済方法で受け取る場合は自動両替（Exchange手数料・レート換算）が適用されます。*`
          )
          .addFields(
            { name: '💰 買い手 (支払完了)', value: buyerMention, inline: true },
            { name: '📦 売り手 (受取人)', value: sellerMention, inline: true },
            { name: '💴 お預かり代金', value: `**${payAmount} (${buyerPayMethod})**`, inline: true }
          )
          .setColor('#00ff99')
          .setFooter({ text: 'Turn 5 / 5: 売り手による受取方法の選択' })
          .setTimestamp();

        const allowKyash = session.payMethodRaw === 'kyash';
        const mmReleaseFiatOptions = fiatTakeOptions.slice();
        if (allowKyash) {
          const kyashOpt = fiatGiveOptions.find(o => o.value === 'kyash');
          if (kyashOpt && !mmReleaseFiatOptions.some(o => o.value === 'kyash')) {
            mmReleaseFiatOptions.push(kyashOpt);
          }
        }

        const releaseOptions = [
          ...mmReleaseFiatOptions.map(opt => ({
            label: opt.label,
            value: `fiat:${opt.value}:${opt.label}`,
            description: '日本円（電子マネー/送金リンク）で受け取る',
            emoji: (opt as any).emoji,
          })),
          ...cryptoOptions.map(opt => ({
            label: opt.label,
            value: `crypto:${opt.value}:${opt.label}`,
            description: '暗号資産（仮想通貨）で受け取る',
            emoji: (opt as any).emoji,
          })),
        ];

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('mm_select_release_method')
          .setPlaceholder(`受取方法を選択してください (${sellerLabel})`)
          .addOptions(releaseOptions);

        const closeBtn = new ButtonBuilder()
          .setCustomId('close_ticket')
          .setLabel('チケットを閉じる')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔒');

        const rowSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
        const rowClose = new ActionRowBuilder<ButtonBuilder>().addComponents(closeBtn);
        embeds.push(embed);
        components.push(rowSelect, rowClose);
      } else {
        const releaseMethod = formatWithEmoji(session.releaseMethod);
        const releaseAmount = session.releaseAmountText || payAmount;

        if (session.releaseMethodType === 'crypto') {
          if (!session.payoutSuccess && !session.sellerCryptoAddress) {
            // 暗号資産: 売り手のアドレス入力待ち
            const conversionNote = session.isConvertedRelease ? '\n*※ 両替手数料・送金手数料が控除されています。*' : '';
            const embed = new EmbedBuilder()
              .setTitle('🎉 売り手への暗号資産送金 (Turn 5)')
              .setDescription(
                `受取方法として **${releaseMethod}** が選択されました！\n\n` +
                `売り手 ${sellerMention} 様、下の**「送金先アドレスを入力」**ボタンを押して、受取用の ${session.releaseMethod} アドレスを入力してください。${conversionNote}`
              )
              .addFields(
                { name: '📤 買い手支払内容', value: `${payAmount} (${buyerPayMethod})`, inline: true },
                { name: '📥 売り手受取予定額', value: `**${releaseAmount}** (${releaseMethod})`, inline: true },
                { name: '​', value: '​', inline: true },
                { name: '👤 売り手 (送金先)', value: sellerMention, inline: true }
              )
              .setColor('#00ff99')
              .setFooter({ text: 'Turn 5 / 5: 売り手アドレス入力待ち (OxaPay Payout)' })
              .setTimestamp();

            const inputAddressBtn = new ButtonBuilder()
              .setCustomId('mm_btn_seller_input_address')
              .setLabel(`送金先アドレスを入力 (${sellerLabel})`)
              .setStyle(ButtonStyle.Primary)
              .setEmoji('📌');

            const resetMethodBtn = new ButtonBuilder()
              .setCustomId('mm_btn_reset_release_method')
              .setLabel(`受取方法を変更 (${sellerLabel})`)
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('✏️');

            const closeBtn = new ButtonBuilder()
              .setCustomId('close_ticket')
              .setLabel('チケットを閉じる')
              .setStyle(ButtonStyle.Danger)
              .setEmoji('🔒');

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(inputAddressBtn, resetMethodBtn, closeBtn);
            embeds.push(embed);
            components.push(row);
          } else {
            // 暗号資産: 送金完了
            const embed = new EmbedBuilder()
              .setTitle('🎉 お取引がすべて完了しました！ (Turn 5)')
              .setDescription(
                `指定のアドレスへの暗号資産送金（OxaPay Payout）が完了しました！\n\n` +
                `ご利用いただき誠にありがとうございました。\n` +
                `取引が終了したら、下のボタンからチケットを閉じてください。`
              )
              .addFields(
                { name: '💰 買い手', value: buyerMention, inline: true },
                { name: '📦 売り手', value: sellerMention, inline: true },
                { name: '💴 送金額', value: `**${releaseAmount}** (${releaseMethod})`, inline: true },
                { name: '📌 送金先アドレス', value: `\`${session.sellerCryptoAddress || '送金完了'}\``, inline: false }
              )
              .setColor('#00ff00')
              .setFooter({ text: 'Turn 5 / 5: 取引完了・送金完了' })
              .setTimestamp();

            const closeBtn = new ButtonBuilder()
              .setCustomId('close_ticket')
              .setLabel('チケットを閉じる')
              .setStyle(ButtonStyle.Danger)
              .setEmoji('🔒');

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(closeBtn);
            embeds.push(embed);
            components.push(row);
          }
        } else {
          // Fiat（PayPay / 楽天Pay / Kyash）の場合: スタッフへポチ袋リクエスト送信済み
          const conversionNote = session.isConvertedRelease ? '\n*※ 両替手数料・送金手数料が控除されています。*' : '';
          const embed = new EmbedBuilder()
            .setTitle('🎉 お取引が完了しました！ (Turn 5: ポチ袋送金手配中)')
            .setDescription(
              `受取方法として **${releaseMethod}** が選択されました！\n\n` +
              `🛡️ **スタッフより売り手 ${sellerMention} 様へ代金 【${releaseAmount} (${releaseMethod})】 のポチ袋送金を手配しております。**\n` +
              `送金が完了次第、売り手の方へポチ袋（DMまたは専用受取チャンネル）が届きます。${conversionNote}\n\n` +
              `ご利用いただき誠にありがとうございました。`
            )
            .addFields(
              { name: '📤 買い手支払内容', value: `${payAmount} (${buyerPayMethod})`, inline: true },
              { name: '📥 売り手受取額', value: `**${releaseAmount}** (${releaseMethod})`, inline: true },
              { name: '​', value: '​', inline: true },
              { name: '📦 売り手 (受取人)', value: sellerMention, inline: true }
            )
            .setColor('#00ff00')
            .setFooter({ text: 'Turn 5 / 5: 取引完了・ポチ袋手配中' })
            .setTimestamp();

          const resetMethodBtn = new ButtonBuilder()
            .setCustomId('mm_btn_reset_release_method')
            .setLabel(`受取方法を変更 (${sellerLabel})`)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('✏️');

          const closeBtn = new ButtonBuilder()
            .setCustomId('close_ticket')
            .setLabel('チケットを閉じる')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔒');

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(resetMethodBtn, closeBtn);
          embeds.push(embed);
          components.push(row);
        }
      }
      break;
    }
  }

  return { content, embeds, components };
}

/**
 * メインメッセージを更新（Edit）する共通ヘルパー
 */
export async function updateOrSendTurnMessage(
  channel: TextChannel,
  session: MMSession,
  interaction?: any
) {
  // 1. 先にディスク（disk）へ同期書き込みして状態を確定
  saveMMSessions();

  const payload = buildTurnPayload(session);

  // 2. その後にDiscordへ反映（Edit / 送信）
  if (interaction && typeof interaction.update === 'function' && !interaction.replied && !interaction.deferred) {
    await interaction.update(payload);
    if (interaction.message && interaction.message.id) {
      session.mainMessageId = interaction.message.id;
      saveMMSessions();
    }
    return;
  }

  if (session.mainMessageId) {
    try {
      const mainMsg = await channel.messages.fetch(session.mainMessageId).catch(() => null);
      if (mainMsg) {
        await mainMsg.edit(payload);
        return;
      }
    } catch (err) {
      console.error('Failed to edit existing MM main message:', err);
    }
  }

  const newMsg = await channel.send(payload);
  session.mainMessageId = newMsg.id;
  saveMMSessions();
}

/**
 * Turn 3 (代金預かり) へ進行し、Crypto の場合は OxaPay インボイスを発行する
 */
export async function proceedToTurn3(channel: TextChannel, session: MMSession, interaction?: any) {
  session.currentTurn = 3;

  const isFiat = session.payMethodType === 'fiat' ||
    (!session.payMethod?.toLowerCase().includes('usdt') &&
     !session.payMethod?.toLowerCase().includes('btc') &&
     !session.payMethod?.toLowerCase().includes('ltc') &&
     !session.payMethod?.toLowerCase().includes('eth') &&
     !session.payMethod?.toLowerCase().includes('sol') &&
     !session.payMethod?.toLowerCase().includes('xmr') &&
     !session.payMethod?.toLowerCase().includes('crypto'));

  // 暗号資産かつインボイス未発行なら OxaPay API でインボイス発行
  if (!isFiat && !session.oxapayPayLink) {
    const merchantKey = process.env.OXAPAY_MERCHANT_KEY;
    if (merchantKey) {
      try {
        const paySymbol = getCryptoSymbolFromLabel(session.payMethod || 'USDT');
        const cleanAmount = (session.payAmountText || '').replace(/\(約.*?\)/g, '').trim();
        const parsed = parseUserInputAmount(cleanAmount, paySymbol);

        let usdAmount = 10.0;
        if (parsed) {
          if (parsed.unit === 'USD') {
            usdAmount = parsed.amount;
          } else if (parsed.unit === 'JPY') {
            usdAmount = parsed.amount / (currentUsdJpyRate || 150.0);
          } else if (parsed.unit === 'CRYPTO') {
            const pricesResponse = await requestOxaPay('GET', '/common/prices', null, merchantKey).catch(() => null);
            const prices = pricesResponse?.data || {};
            const coinPrice = prices[paySymbol] || prices[paySymbol.toLowerCase()] || 1;
            usdAmount = parsed.amount * coinPrice;
          }
        }
        usdAmount = Math.max(parseFloat(usdAmount.toFixed(2)), 0.5);

        const webUrl = process.env.WEB_URL;
        const invoiceData: any = {
          amount: usdAmount,
          currency: 'USD',
          lifetime: 60,
          fee_paid_by_payer: 1,
          order_id: channel.id,
          description: `MM Escrow: ${session.itemDescription || 'Item'} (${paySymbol})`,
          pay_currency: paySymbol,
        };
        if (webUrl) {
          invoiceData.callback_url = `${webUrl}/api/oxapay/webhook`;
        }

        const response = await requestOxaPay('POST', '/payment/invoice', invoiceData, merchantKey);
        const payLink = response.payment_url || response.paymentUrl || response.payLink || response.pay_link || response.data?.payment_url || response.data?.payLink;
        const trackId = response.trackId || response.track_id || response.data?.trackId || response.data?.track_id;

        if (payLink && trackId) {
          session.oxapayPayLink = payLink;
          session.oxapayTrackId = trackId;
          session.oxapayUsdAmount = usdAmount;
        }
      } catch (oxErr) {
        console.error('Failed to create OxaPay invoice for MM:', oxErr);
      }
    }
  }

  await updateOrSendTurnMessage(channel, session, interaction);
}

/**
 * Webhook または手動確認により OxaPay 着金が確認されたときの処理 (Turn 3 -> Turn 4)
 */
export async function handleMMOxaPayPaymentSuccess(channel: TextChannel, trackId?: string): Promise<boolean> {
  const session = getOrCreateMMSession(channel.id);
  if (session.currentTurn >= 4) {
    return true; // すでにTurn 4以降に進んでいる
  }

  session.escrowConfirmed = true;
  session.currentTurn = 4; // Turn 4 (商品引き渡し) へ進行

  await updateOrSendTurnMessage(channel, session);

  const buyerMention = session.buyerId ? `<@${session.buyerId}>` : '買い手';
  const sellerMention = session.sellerId ? `<@${session.sellerId}>` : '売り手';
  await channel.send({
    content: `🎉 ${buyerMention} 様の暗号資産の着金が確認されました！\n${sellerMention} 様、商品の引き渡しを行ってください。`,
  });

  return true;
}

/**
 * 買い手/スタッフが「支払状況を確認する」ボタンを押したときのハンドラ (OxaPay)
 */
export async function handleMMCheckOxaPayButton(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const trackId = session.oxapayTrackId;

  if (!trackId) {
    await interaction.reply({ content: '⚠️ 支払い情報が見つかりません。', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const merchantKey = process.env.OXAPAY_MERCHANT_KEY;
    if (!merchantKey) {
      await interaction.editReply({ content: 'OxaPay APIキーが設定されていません。' });
      return;
    }

    const statusResponse = await requestOxaPay('GET', `/payment/${trackId}`, null, merchantKey);
    const dataObj = statusResponse.data || {};
    const txStatus = (Array.isArray(dataObj.txs) && dataObj.txs.length > 0) ? dataObj.txs[0].status : null;
    const rawStatus = dataObj.status || txStatus || statusResponse.pay_status || statusResponse.payStatus || 'Unknown';

    const lowerStatus = String(rawStatus).toLowerCase();
    const isPaid = lowerStatus === 'paid' || lowerStatus === 'confirmed' || lowerStatus === 'complete' || lowerStatus === 'completed' || statusResponse.result === 100 || statusResponse.result === 1;

    if (isPaid) {
      await handleMMOxaPayPaymentSuccess(channel, trackId);
      await interaction.editReply({ content: '✅ お支払いが確認されました！商品の引き渡しステップへ進みます。' });
      return;
    }

    await interaction.editReply({
      content: `⏳ 現在のステータス: \`${rawStatus}\`\nまだ着金が確認できていません。1分間隔で自動監視中ですので、お支払い完了後しばらくお待ちください。`,
    });
  } catch (err: any) {
    console.error('Error checking MM OxaPay status:', err);
    await interaction.editReply({ content: `エラーが発生しました: ${err.message || 'Unknown error'}` });
  }
}

/**
 * MMチケット作成時の初期メッセージ（Turn 1: 相手選択）を送信
 */
export async function setupMiddlemanInitialMessage(channel: TextChannel, creatorId: string) {
  const session = getOrCreateMMSession(channel.id, creatorId);
  session.currentTurn = 1;
  session.creatorId = creatorId;

  try {
    const creatorUser = await channel.client.users.fetch(creatorId).catch(() => null);
    if (creatorUser) {
      session.creatorName = creatorUser.displayName || creatorUser.username;
    }
  } catch (e) {}

  const payload = buildTurnPayload(session);
  const msg = await channel.send(payload);
  session.mainMessageId = msg.id;
}

/**
 * 相手ユーザー選択時のハンドラ (Turn 1: 相手選択 -> 役割選択)
 */
export async function handleMMSelectPartner(interaction: UserSelectMenuInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const partnerId = interaction.values[0];
  const creatorId = interaction.user.id;

  if (partnerId === creatorId) {
    await interaction.reply({ content: '自分自身を取引相手として選択することはできません。', ephemeral: true });
    return;
  }

  const selectedUser = interaction.users.get(partnerId) || await interaction.client.users.fetch(partnerId).catch(() => null);
  if (selectedUser && selectedUser.bot) {
    await interaction.reply({
      content: '⚠️ Bot / アプリケーション（APP）を取引相手として選択することはできません。取引相手となる一般ユーザーを選択してください。',
      ephemeral: true,
    });
    return;
  }

  const session = getOrCreateMMSession(channel.id, creatorId);
  session.partnerId = partnerId;
  session.creatorId = creatorId;
  session.creatorName = interaction.user.displayName || interaction.user.username;
  session.partnerName = selectedUser ? (selectedUser.displayName || selectedUser.username) : undefined;
  session.creatorRoleChosen = undefined;
  session.creatorRoleConfirmed = false;
  session.partnerRoleConfirmed = false;

  try {
    await channel.permissionOverwrites.edit(partnerId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
  } catch (err) {
    console.error('Failed to add permissions for MM partner:', err);
  }

  await updateOrSendTurnMessage(channel, session, interaction);
}

/**
 * 作成者が役割（買い手/売り手）ボタンを押したときのハンドラ
 */
export async function handleMMRoleChoice(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const role = interaction.customId.split(':')[1] as 'buyer' | 'seller';
  const userId = interaction.user.id;

  const session = getOrCreateMMSession(channel.id, userId);

  if (session.creatorId && userId !== session.creatorId) {
    await interaction.reply({ content: '役割の初期選択はチケット作成者のみが行えます。', ephemeral: true });
    return;
  }

  session.creatorRoleChosen = role;
  session.creatorRoleConfirmed = true;
  session.partnerRoleConfirmed = false;

  if (role === 'buyer') {
    session.buyerId = session.creatorId;
    session.buyerName = session.creatorName;
    session.sellerId = session.partnerId;
    session.sellerName = session.partnerName;
  } else {
    session.sellerId = session.creatorId;
    session.sellerName = session.creatorName;
    session.buyerId = session.partnerId;
    session.buyerName = session.partnerName;
  }

  await updateOrSendTurnMessage(channel, session, interaction);
}

/**
 * 役割を確認・同意するボタン押下ハンドラ (Turn 1: 双方が押したらTurn 2へ)
 */
export async function handleMMConfirmRoleButton(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const userId = interaction.user.id;
  const session = getOrCreateMMSession(channel.id, userId);

  if (userId === session.creatorId) {
    session.creatorRoleConfirmed = true;
  } else if (userId === session.partnerId) {
    session.partnerRoleConfirmed = true;
  } else {
    if (!session.creatorRoleConfirmed) session.creatorRoleConfirmed = true;
    else session.partnerRoleConfirmed = true;
  }

  if (session.creatorRoleConfirmed && session.partnerRoleConfirmed) {
    session.currentTurn = 2;
  }

  await updateOrSendTurnMessage(channel, session, interaction);
}

/**
 * 役割を選び直すボタン押下ハンドラ (Turn 1)
 */
export async function handleMMResetRoleButton(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const userId = interaction.user.id;
  const session = getOrCreateMMSession(channel.id, userId);

  session.creatorRoleChosen = undefined;
  session.creatorRoleConfirmed = false;
  session.partnerRoleConfirmed = false;
  session.buyerId = undefined;
  session.sellerId = undefined;

  await updateOrSendTurnMessage(channel, session, interaction);
}

/**
 * 売り手用モーダル（商品・金額）を開く
 */
export async function showMMSellerItemModal(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const userId = interaction.user.id;

  if (session.sellerId && userId !== session.sellerId && userId === session.buyerId) {
    await interaction.reply({
      content: '⚠️ この設定は「商品を渡す側（売り手）」専用です。売り手の方が入力してください。',
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId('mm_modal_seller_item_submit')
    .setTitle('引き渡す商品と金額の設定 (売り手)');

  const itemInput = new TextInputBuilder()
    .setCustomId('mm_item_description')
    .setLabel('引き渡す物 (アカウント、アイテム等)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('例: 〇〇ゲームのアカウント情報 など')
    .setValue(session.itemDescription || '')
    .setRequired(true);

  const payAmountInput = new TextInputBuilder()
    .setCustomId('mm_pay_amount')
    .setLabel('取引金額 (例: 5000円, 50 USDT 等)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('5,000円')
    .setValue(session.payAmountText || '')
    .setRequired(true);

  const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(itemInput);
  const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(payAmountInput);

  modal.addComponents(row1, row2);
  await interaction.showModal(modal);
}

/**
 * ユーザーが入力した金額文字列（例: "200", "10$", "0.5 LTC", "100 USDT" 等）を
 * 日本円換算付きのわかりやすい表示形式（例: "200 円", "10$ (約 1,500 円)", "0.5 LTC (約 7,500 円)"）にフォーマットする
 */
export async function formatMMAmountDisplay(rawInput: string): Promise<string> {
  const parsed = parseUserInputAmount(rawInput, 'JPY');
  if (!parsed) {
    const num = parseFloat(rawInput.replace(/[^0-9.]/g, ''));
    if (!isNaN(num) && num > 0) {
      return `${Math.round(num).toLocaleString()} 円`;
    }
    return rawInput;
  }

  if (parsed.unit === 'JPY') {
    return `${Math.round(parsed.amount).toLocaleString()} 円`;
  }

  if (parsed.unit === 'USD') {
    const usdFormatted = parsed.amount.toLocaleString('en-US', { maximumFractionDigits: 4 });
    const jpyVal = Math.round(parsed.amount * (currentUsdJpyRate || 150.0));
    return `${usdFormatted}$ (約 ${jpyVal.toLocaleString()} 円)`;
  }

  if (parsed.unit === 'CRYPTO') {
    const sym = (parsed.symbol || 'CRYPTO').toUpperCase();
    let jpyText = '';
    const merchantKey = process.env.OXAPAY_MERCHANT_KEY;
    if (merchantKey) {
      try {
        let coinPrice = (sym === 'USDT' || sym === 'DAI') ? 1.0 : 0;
        if (!coinPrice) {
          const pricesResponse = await requestOxaPay('GET', '/common/prices', null, merchantKey).catch(() => null);
          const prices = pricesResponse?.data || {};
          coinPrice = prices[sym] || prices[sym.toLowerCase()] || 0;
        }
        if (coinPrice > 0) {
          const usdVal = parsed.amount * coinPrice;
          const jpyVal = Math.round(usdVal * (currentUsdJpyRate || 150.0));
          jpyText = ` (約 ${jpyVal.toLocaleString()} 円)`;
        }
      } catch (e) {}
    }
    return `${parsed.amount} ${sym}${jpyText}`;
  }

  return rawInput;
}

/**
 * 売り手用モーダル送信ハンドラ
 */
export async function handleMMSellerItemSubmit(interaction: ModalSubmitInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  session.itemDescription = interaction.fields.getTextInputValue('mm_item_description');

  const rawAmount = interaction.fields.getTextInputValue('mm_pay_amount');
  session.payAmountText = await formatMMAmountDisplay(rawAmount);

  session.buyerAgreed = false;
  session.sellerAgreed = false;

  await interaction.deferUpdate();
  await updateOrSendTurnMessage(channel, session);
}

/**
 * 買い手による支払方法選択メニューのハンドラ (Step 2-2)
 */
export async function handleMMPayMethodSelect(interaction: StringSelectMenuInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const userId = interaction.user.id;

  if (session.buyerId && userId !== session.buyerId && userId === session.sellerId) {
    await interaction.reply({
      content: '⚠️ この設定は「お金を支払う側（買い手）」専用です。買い手の方が選択してください。',
      ephemeral: true,
    });
    return;
  }

  const selectedVal = interaction.values[0];
  const parts = selectedVal.split(':');
  const type = parts[0] as 'fiat' | 'crypto';
  const rawSymbol = parts[1];
  const label = parts.slice(2).join(':') || parts[1];

  session.payMethodType = type;
  session.payMethodRaw = rawSymbol;
  session.payMethod = label;
  session.oxapayPayLink = undefined;
  session.oxapayTrackId = undefined;
  session.buyerAgreed = false;
  session.sellerAgreed = false;

  await interaction.deferUpdate();
  await updateOrSendTurnMessage(channel, session);
}

/**
 * 買い手による支払方法リセット（再選択）ハンドラ
 */
export async function handleMMResetPayButton(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const userId = interaction.user.id;

  if (session.buyerId && userId !== session.buyerId && userId === session.sellerId) {
    await interaction.reply({
      content: '⚠️ この設定は「お金を支払う側（買い手）」専用です。買い手の方が操作してください。',
      ephemeral: true,
    });
    return;
  }

  session.payMethod = undefined;
  session.oxapayPayLink = undefined;
  session.oxapayTrackId = undefined;
  session.buyerAgreed = false;
  session.sellerAgreed = false;

  await updateOrSendTurnMessage(channel, session, interaction);
}

/**
 * 取引内容に同意するボタン押下ハンドラ (Turn 2: 双方が押したらTurn 3へ)
 */
export async function handleMMAgreeButton(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const userId = interaction.user.id;

  if (!session.itemDescription || !session.payAmountText) {
    await interaction.reply({
      content: '⚠️ まだ売り手による「商品・金額」の設定が完了していません。',
      ephemeral: true,
    });
    return;
  }

  if (!session.payMethod) {
    await interaction.reply({
      content: '⚠️ まだ買い手による「支払方法」の設定が完了していません。',
      ephemeral: true,
    });
    return;
  }

  if (userId === session.buyerId) {
    session.buyerAgreed = true;
  } else if (userId === session.sellerId) {
    session.sellerAgreed = true;
  } else {
    if (!session.buyerAgreed) session.buyerAgreed = true;
    else session.sellerAgreed = true;
  }

  if (session.buyerAgreed && session.sellerAgreed) {
    await proceedToTurn3(channel, session, interaction);
    return;
  }

  await updateOrSendTurnMessage(channel, session, interaction);
}

/**
 * 買い手が「支払いを完了した」を押したときのハンドラ (Turn 3: Fiat)
 */
export async function handleMMBuyerPaidButton(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  session.buyerPaid = true;

  await updateOrSendTurnMessage(channel, session, interaction);
}

/**
 * スタッフ/売り手が「代金預かりを確認」を押したときのハンドラ (Turn 3 -> Turn 4へ)
 */
export async function handleMMCheckEscrow(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  session.escrowConfirmed = true;
  session.currentTurn = 4;

  await updateOrSendTurnMessage(channel, session, interaction);
}

/**
 * 買い手が「受取完了」を押したときのハンドラ (Turn 4 -> Turn 5: 売り手受取方法選択へ)
 */
export async function handleMMItemReceived(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const userId = interaction.user.id;

  // 買い手本人（または作成者/スタッフ）のみ
  if (session.buyerId && userId !== session.buyerId && userId === session.sellerId) {
    await interaction.reply({
      content: '⚠️ この操作は「商品を受け取る側（買い手）」専用です。買い手の方が押してください。',
      ephemeral: true,
    });
    return;
  }

  session.buyerReceivedItem = true;
  session.currentTurn = 5;
  session.releaseMethod = undefined;
  session.released = false;

  await updateOrSendTurnMessage(channel, session, interaction);
}

/**
 * 売り手が「返金」を押したときのハンドラ (Turn 4 -> 返金キャンセル処理)
 */
export async function handleMMSellerRefundButton(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const userId = interaction.user.id;

  // 売り手本人（または作成者/スタッフ）のみ
  if (session.sellerId && userId !== session.sellerId && userId === session.buyerId) {
    await interaction.reply({
      content: '⚠️ この操作は「商品を渡す側（売り手）」専用です。売り手の方が押してください。',
      ephemeral: true,
    });
    return;
  }

  const buyerMention = session.buyerId ? `<@${session.buyerId}>` : '買い手';
  const sellerMention = session.sellerId ? `<@${session.sellerId}>` : '売り手';
  const payMethod = session.payMethod ? formatWithEmoji(session.payMethod) : 'Fiat / 暗号資産';
  const payAmount = session.payAmountText || '指定金額';

  // 返金リクエストをスタッフチャンネルへ通知
  const sendReqChannelId = process.env.FIAT_SEND_REQUEST_CHANNEL_ID;
  if (sendReqChannelId && channel.client) {
    try {
      const reqChannel = await channel.client.channels.fetch(sendReqChannelId);
      if (reqChannel && 'send' in reqChannel) {
        const refundRequestData = {
          userMention: buyerMention,
          userId: session.buyerId,
          ticketChannelId: channel.id,
          paySymbolUpper: payMethod,
          takeLabel: payMethod,
          payText: payAmount,
          isRefund: true,
        };

        const refundReqEmbed = new EmbedBuilder()
          .setTitle('🚨 【取引仲介 MM】キャンセルに伴う買い手への返金リクエスト')
          .setDescription(`売り手より取引キャンセルの申し出がありました。\nお預かりしている代金を買い手へ返金してください。`)
          .addFields(
            { name: '🎫 対象チケット', value: `<#${channel.id}>`, inline: true },
            { name: '👤 買い手 (返金先)', value: buyerMention, inline: true },
            { name: '👤 売り手 (キャンセル者)', value: sellerMention, inline: true },
            { name: '💴 返金金額', value: `${payAmount} (${payMethod})`, inline: true }
          )
          .setColor('#ff3333')
          .setFooter({ text: `RequestData: ${JSON.stringify(refundRequestData)}` })
          .setTimestamp();

        const linkButton = new ButtonBuilder()
          .setCustomId(`fiat_send_link:${channel.id}`)
          .setLabel('Linkを入力 (返金用)')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔗');

        const passButton = new ButtonBuilder()
          .setCustomId(`fiat_send_pass:${channel.id}`)
          .setLabel('Passwordを入力')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🔑');

        const completeButton = new ButtonBuilder()
          .setCustomId(`fiat_send_complete:${channel.id}`)
          .setLabel('返金完了')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('✅');

        const reqRow = new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton, passButton, completeButton);
        const supportRoleId = process.env.SUPPORT_ROLE_ID;
        const mentionContent = supportRoleId ? `<@&${supportRoleId}>` : '@Support';

        await (reqChannel as TextChannel).send({
          content: `${mentionContent} 取引仲介の返金リクエストが発生しました。`,
          embeds: [refundReqEmbed],
          components: [reqRow],
        });
      }
    } catch (err) {
      console.error('Failed to send MM refund request:', err);
    }
  }

  // チケットチャンネルのメッセージを返金案内に更新
  const refundEmbed = new EmbedBuilder()
    .setTitle('↩️ 取引キャンセル・返金処理中')
    .setDescription(
      `売り手 ${sellerMention} 様より取引キャンセルの申し出がありました。\n\n` +
      `🛡️ **お預かりしていた代金 【${payAmount} (${payMethod})】 を買い手 ${buyerMention} 様へ返金いたします。**\n` +
      `スタッフによる返金手続きが完了するまでしばらくお待ちください。`
    )
    .addFields(
      { name: '💰 買い手 (返金先)', value: buyerMention, inline: true },
      { name: '📦 売り手', value: sellerMention, inline: true },
      { name: '💴 返金額', value: `${payAmount} (${payMethod})`, inline: true }
    )
    .setColor('#ff3333')
    .setFooter({ text: '取引キャンセル・返金対応' })
    .setTimestamp();

  const closeBtn = new ButtonBuilder()
    .setCustomId('close_ticket')
    .setLabel('チケットを閉じる')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('🔒');

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(closeBtn);

  if (interaction.message) {
    await interaction.message.edit({
      embeds: [refundEmbed],
      components: [row]
    }).catch(() => {});
  }

  await interaction.reply({
    content: `↩️ <@${userId}> により取引キャンセル・返金手続きが申請されました。スタッフが買い手への返金手配を行います。`,
  });
}

/**
 * 売り手による代金受取方法選択メニューのハンドラ (Turn 5)
 */
export async function handleMMReleaseMethodSelect(interaction: StringSelectMenuInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const userId = interaction.user.id;

  // 売り手本人（または作成者/スタッフ）のみ
  if (session.sellerId && userId !== session.sellerId && userId === session.buyerId) {
    await interaction.reply({
      content: '⚠️ この設定は「代金を受け取る側（売り手）」専用です。売り手の方が選択してください。',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();

  const selectedVal = interaction.values[0];
  const parts = selectedVal.split(':');
  const type = parts[0] as 'fiat' | 'crypto';
  const rawSymbol = parts[1];
  const label = parts.slice(2).join(':') || parts[1];

  session.releaseMethodType = type;
  session.releaseSymbolRaw = rawSymbol;
  session.releaseMethod = label;
  session.sellerCryptoAddress = undefined;
  session.payoutSuccess = false;

  const buyerPayRaw = (session.payMethodRaw || getCryptoSymbolFromLabel(session.payMethod || '')).toLowerCase();
  const isSame = buyerPayRaw === rawSymbol.toLowerCase() ||
                 (buyerPayRaw === 'usdt' && rawSymbol.toLowerCase() === 'usdt');

  if (isSame) {
    session.isConvertedRelease = false;
    session.releaseAmountText = session.payAmountText;
    if (type === 'crypto') {
      const cleanAmount = (session.payAmountText || '').replace(/\(約.*?\)/g, '').trim();
      const parsed = parseUserInputAmount(cleanAmount, rawSymbol.toUpperCase());
      session.releaseFinalCryptoAmount = parsed?.amount || 0;
      session.releaseUsdAmount = parsed?.amount || 0;
    }
  } else {
    session.isConvertedRelease = true;
    try {
      const paySymbol = session.payMethodRaw || getCryptoSymbolFromLabel(session.payMethod || 'USDT');
      const cleanAmount = (session.payAmountText || '').replace(/\(約.*?\)/g, '').trim();
      const parsed = parseUserInputAmount(cleanAmount, paySymbol);

      let jpyAmount = 1000;
      if (parsed) {
        if (parsed.unit === 'JPY') {
          jpyAmount = parsed.amount;
        } else if (parsed.unit === 'USD') {
          jpyAmount = parsed.amount * (currentUsdJpyRate || 150.0);
        } else if (parsed.unit === 'CRYPTO') {
          const pricesResponse = await requestOxaPay('GET', '/common/prices', null, process.env.OXAPAY_MERCHANT_KEY || '').catch(() => null);
          const prices = pricesResponse?.data || {};
          const coinPrice = prices[paySymbol.toUpperCase()] || prices[paySymbol.toLowerCase()] || 1;
          jpyAmount = parsed.amount * coinPrice * (currentUsdJpyRate || 150.0);
        }
      }

      const quote = await calculateExchangeQuote(paySymbol, rawSymbol, jpyAmount, 'pay');
      if (type === 'crypto') {
        session.releaseFinalCryptoAmount = quote.finalTakeAmount;
        session.releaseUsdAmount = quote.takeUsdValue;
        session.releaseAmountText = `約 ${quote.finalTakeAmount.toFixed(6)} ${quote.takeSymbol} (約 ${Math.round(quote.takeJpyValue).toLocaleString()} 円)`;
      } else {
        session.releaseJpyAmount = Math.round(quote.takeJpyValue);
        session.releaseUsdAmount = quote.takeUsdValue;
        session.releaseAmountText = `${Math.round(quote.takeJpyValue).toLocaleString()} 円`;
      }
    } catch (calcErr: any) {
      console.error('Failed to calculate release exchange quote:', calcErr);
      session.releaseAmountText = session.payAmountText;
    }
  }

  // Fiatの場合は即座にスタッフ通知をトリガー
  if (type === 'fiat') {
    await triggerMMReleaseFiatRequest(channel, session);
  }

  await updateOrSendTurnMessage(channel, session);
}

/**
 * 売り手による代金受取方法リセット（再選択）ハンドラ (Turn 5)
 */
export async function handleMMResetReleaseMethodButton(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const userId = interaction.user.id;

  if (session.sellerId && userId !== session.sellerId && userId === session.buyerId) {
    await interaction.reply({
      content: '⚠️ この操作は「代金を受け取る側（売り手）」専用です。売り手の方が操作してください。',
      ephemeral: true,
    });
    return;
  }

  if (session.payoutSuccess) {
    await interaction.reply({
      content: '⚠️ 既に送金処理が完了しているため、受取方法を変更することはできません。',
      ephemeral: true,
    });
    return;
  }

  session.releaseMethod = undefined;
  session.releaseMethodType = undefined;
  session.releaseSymbolRaw = undefined;
  session.releaseAmountText = undefined;
  session.releaseFinalCryptoAmount = undefined;
  session.sellerCryptoAddress = undefined;

  await updateOrSendTurnMessage(channel, session, interaction);
}

/**
 * Fiat受取時のスタッフ送金リクエスト通知
 */
async function triggerMMReleaseFiatRequest(channel: TextChannel, session: MMSession) {
  const sellerMention = session.sellerId ? `<@${session.sellerId}>` : '売り手';
  const payMethod = session.payMethod ? formatWithEmoji(session.payMethod) : 'Fiat / 暗号資産';
  const receiveMethod = session.releaseMethod ? formatWithEmoji(session.releaseMethod) : payMethod;
  const payAmount = session.payAmountText || '指定金額';
  const releaseAmount = session.releaseAmountText || payAmount;

  const sendReqChannelId = process.env.FIAT_SEND_REQUEST_CHANNEL_ID;
  if (sendReqChannelId && channel.client) {
    try {
      const reqChannel = await channel.client.channels.fetch(sendReqChannelId);
      if (reqChannel && 'send' in reqChannel) {
        const releaseRequestData = {
          userMention: sellerMention,
          userId: session.sellerId,
          ticketChannelId: channel.id,
          paySymbolUpper: session.payMethod || 'FIAT',
          takeLabel: session.releaseMethod || 'Fiat',
          payText: releaseAmount,
          isRelease: true,
        };

        const sendEmbed = new EmbedBuilder()
          .setTitle('🚨 【取引仲介 MM】売り手への代金リリース（送金）リクエスト')
          .setDescription(
            `取引仲介が完了しました。売り手への代金送金手配を行ってください。\n\n` +
            (session.isConvertedRelease ? `⚠️ **両替適用**: 買い手支払 [${payAmount} (${payMethod})] ➔ 売り手受取 [**${releaseAmount} (${receiveMethod})**]` : '')
          )
          .addFields(
            { name: '🎫 対象チケット', value: `<#${channel.id}>`, inline: true },
            { name: '👤 売り手 (送金先)', value: sellerMention, inline: true },
            { name: '💴 送金金額', value: `**${releaseAmount} (${receiveMethod})**`, inline: true }
          )
          .setColor('#00ff99')
          .setFooter({ text: `RequestData: ${JSON.stringify(releaseRequestData)}` })
          .setTimestamp();

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

        await (reqChannel as TextChannel).send({
          content: `${mentionContent} 取引仲介の代金送金リクエストが発生しました。`,
          embeds: [sendEmbed],
          components: [reqRow],
        });
      }
    } catch (err) {
      console.error('Failed to send MM fiat send request:', err);
    }
  }

  saveTransactionRecord({
    userId: session.buyerId || session.creatorId || 'unknown',
    exchangeType: 'middleman' as any,
    pairLabel: `MM: ${payAmount} (${session.payMethod || 'PAY'}) ➔ ${releaseAmount} (${session.releaseMethod || 'REC'})`,
    payAmount: 0,
    payCurrency: session.payMethod || 'UNKNOWN',
    takeAmount: 0,
    takeCurrency: session.releaseMethod || 'UNKNOWN',
    usdValue: session.releaseUsdAmount || 0,
    timestamp: new Date().toISOString(),
    privacy: 'pending',
  });
}

/**
 * 売り手用暗号資産送金先アドレス入力モーダルを開く
 */
export async function showMMSellerAddressModal(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const userId = interaction.user.id;

  // 売り手本人（または作成者/スタッフ）のみ
  if (session.sellerId && userId !== session.sellerId && userId === session.buyerId) {
    await interaction.reply({
      content: '⚠️ この操作は「代金を受け取る側（売り手）」専用です。売り手の方が入力してください。',
      ephemeral: true,
    });
    return;
  }

  const paySymbol = getCryptoSymbolFromLabel(session.payMethod || 'USDT');
  const modal = new ModalBuilder()
    .setCustomId('mm_modal_seller_address_submit')
    .setTitle(`受取アドレスの入力 (${paySymbol})`);

  const addressInput = new TextInputBuilder()
    .setCustomId('mm_seller_address')
    .setLabel(`あなたの ${paySymbol} 受取用アドレス`)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(`正しい ${paySymbol} アドレスを入力してください`)
    .setValue(session.sellerCryptoAddress || '')
    .setRequired(true);

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(addressInput);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

/**
 * 売り手用送金先アドレス Modal 送信時の処理 (OxaPay Payout 実行)
 */
export async function handleMMSellerAddressSubmit(interaction: ModalSubmitInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const userAddress = interaction.fields.getTextInputValue('mm_seller_address').trim();
  const paySymbol = getCryptoSymbolFromLabel(session.payMethod || 'USDT');

  if (!isValidCryptoAddress(userAddress, paySymbol)) {
    await interaction.reply({
      content: `⚠️ 入力された送金先アドレス（\`${userAddress}\`）は正しい ${paySymbol} のアドレス形式ではありません。\n再度正しいアドレスを入力してください。`,
      ephemeral: true,
    });
    return;
  }

  session.sellerCryptoAddress = userAddress;
  await interaction.deferReply();

  try {
    const paySymbolUpper = paySymbol.toUpperCase();
    const cleanAmount = (session.payAmountText || '').replace(/\(約.*?\)/g, '').trim();
    const parsed = parseUserInputAmount(cleanAmount, paySymbolUpper);
    let finalAmount = 10.0;
    let usdAmount = 10.0;
    let jpyAmount = 0;

    if (parsed) {
      if (parsed.unit === 'CRYPTO') {
        finalAmount = parsed.amount;
        usdAmount = parsed.amount;
      } else if (parsed.unit === 'USD') {
        usdAmount = parsed.amount;
        finalAmount = parsed.amount;
      } else if (parsed.unit === 'JPY') {
        jpyAmount = parsed.amount;
        usdAmount = parsed.amount / (currentUsdJpyRate || 150.0);
        finalAmount = usdAmount;
      }
    }

    const { executeCryptoPayout } = await import('./payment');
    const sellerMention = session.sellerId ? `<@${session.sellerId}>` : `<@${interaction.user.id}>`;

    await channel.send({ content: `🚀 指定アドレス（\`${userAddress}\`）へ ${paySymbolUpper} の自動送金(Payout)処理を開始します...` });

    const success = await executeCryptoPayout(
      channel,
      paySymbolUpper,
      finalAmount,
      userAddress,
      sellerMention,
      jpyAmount,
      usdAmount,
      paySymbolUpper,
      session.sellerId || interaction.user.id,
      interaction.client
    );

    if (success) {
      session.payoutSuccess = true;
      await updateOrSendTurnMessage(channel, session);
      await interaction.editReply({ content: `🎉 送金処理が完了しました！` });
    } else {
      await interaction.editReply({ content: '⚠️ 送金処理中にエラーが発生しました。ログを確認してください。' });
    }
  } catch (err: any) {
    console.error('MM Payout Error:', err);
    await interaction.editReply({ content: `⚠️ 送金エラー: ${err.message || 'Unknown error'}` });
  }
}

/**
 * Fiat（PayPay等）送金リンク入力モーダルを開く
 */
export async function showMMFiatInputModal(interaction: ButtonInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  const userId = interaction.user.id;

  // 買い手本人（または作成者/スタッフ）のみ
  if (session.buyerId && userId !== session.buyerId && userId === session.sellerId) {
    await interaction.reply({
      content: '⚠️ この操作は「代金を支払う側（買い手）」専用です。買い手の方が入力してください。',
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId('mm_modal_fiat_submit')
    .setTitle('代金預かり用 送金リンクの入力');

  const linkInput = new TextInputBuilder()
    .setCustomId('mm_fiat_link')
    .setLabel('送金リンク (PayPayポチ袋等 URL)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://paypay.me/...')
    .setRequired(true);

  const passInput = new TextInputBuilder()
    .setCustomId('mm_fiat_pass')
    .setLabel('パスワード (無い場合は「なし」等)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('1234')
    .setRequired(true);

  const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(linkInput);
  const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(passInput);
  modal.addComponents(row1, row2);

  await interaction.showModal(modal);
}

/**
 * Fiat送金リンク入力モーダル送信ハンドラ
 */
export async function handleMMFiatSubmit(interaction: ModalSubmitInteraction) {
  const channel = interaction.channel as TextChannel;
  if (!channel) return;

  const session = getOrCreateMMSession(channel.id, interaction.user.id);
  session.fiatLink = interaction.fields.getTextInputValue('mm_fiat_link');
  session.fiatPass = interaction.fields.getTextInputValue('mm_fiat_pass');
  session.buyerPaid = true;

  await interaction.deferReply({ ephemeral: true });

  const requestChannelId = process.env.FIAT_RECEIVE_REQUEST_CHANNEL_ID;
  if (requestChannelId && channel.client) {
    try {
      const reqChannel = await channel.client.channels.fetch(requestChannelId);
      if (reqChannel && 'send' in reqChannel) {
        const reqEmbed = new EmbedBuilder()
          .setTitle('🚨 【取引仲介 MM】代金預かり・ポチ袋受取リクエスト')
          .setDescription(`取引仲介チケットにて買い手から代金（ポチ袋/リンク）が送信されました。\nスタッフは内容を確認して受け取りを行い、**【✅ 受け取り確認完了】** を押してください。`)
          .addFields(
            { name: '🎫 対象チケット', value: `<#${channel.id}>`, inline: true },
            { name: '👤 買い手', value: `<@${interaction.user.id}>`, inline: true },
            { name: '📦 売り手', value: session.sellerId ? `<@${session.sellerId}>` : '未設定', inline: true },
            { name: '💴 支払金額', value: `${session.payAmountText || '不明'} (${session.payMethod ? formatWithEmoji(session.payMethod) : 'Fiat'})`, inline: true },
            { name: '🔗 送金リンク', value: session.fiatLink || 'なし', inline: false },
            { name: '🔑 パスワード', value: `\`\`\`${session.fiatPass || 'なし'}\`\`\``, inline: false }
          )
          .setColor('#00ff99')
          .setFooter({ text: `MMRequestData: ${JSON.stringify({ channelId: channel.id })}` })
          .setTimestamp();

        const confirmBtn = new ButtonBuilder()
          .setCustomId(`mm_fiat_receive_confirmed:${channel.id}`)
          .setLabel('✅ 受け取り確認完了 (商品の引き渡しへ進む)')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅');

        const rowAction = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn);

        const supportRoleId = process.env.SUPPORT_ROLE_ID;
        const mentionContent = supportRoleId ? `<@&${supportRoleId}>` : '@Support';

        await (reqChannel as TextChannel).send({
          content: `${mentionContent} 取引仲介の代金預かりリクエストです。受取確認をお願いします。`,
          embeds: [reqEmbed],
          components: [rowAction],
        });
      }
    } catch (err) {
      console.error('Failed to send MM fiat receive request:', err);
    }
  }

  await interaction.editReply({
    content: '送金リンク情報を送信しました！スタッフが受取確認を行います。確認が完了次第、自動的に商品の引き渡しステップへ進みます。',
  });

  await updateOrSendTurnMessage(channel, session);
}

/**
 * スタッフが FIAT_RECEIVE_REQUEST_CHANNEL_ID で「受け取り確認完了」ボタンを押したときのハンドラ
 */
export async function handleMMFiatReceiveConfirmed(interaction: ButtonInteraction) {
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
    await interaction.reply({ content: '⚠️ この操作はサポートスタッフ専用です。', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const customId = interaction.customId;
  const parts = customId.split(':');
  const targetChannelId = parts[1];

  const targetChannel = await interaction.client.channels.fetch(targetChannelId).catch(() => null) as TextChannel | null;
  if (!targetChannel) {
    await interaction.editReply({ content: '⚠️ 対象のチケットチャンネルが見つかりませんでした。' });
    return;
  }

  const session = getOrCreateMMSession(targetChannel.id);
  session.escrowConfirmed = true;
  session.currentTurn = 4; // Turn 4 (商品引き渡し) へ進行！

  await updateOrSendTurnMessage(targetChannel, session);

  // スタッフ側メッセージの更新
  if (interaction.message && interaction.message.embeds.length > 0) {
    const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
    originalEmbed.setTitle('✅ 【受取確認済】取引仲介 代金預かり');
    originalEmbed.setColor('#00ff00');
    await interaction.message.edit({ embeds: [originalEmbed], components: [] }).catch(() => {});
  }

  const sellerMention = session.sellerId ? `<@${session.sellerId}>` : '売り手';
  await targetChannel.send({
    content: `🎉 スタッフにより代金（${session.payMethod ? formatWithEmoji(session.payMethod) : '日本円'}）のお預かりが確認されました！\n${sellerMention} 様、商品の引き渡しを行ってください。`,
  });

  await interaction.editReply({ content: '✅ 代金の預かり確認を完了し、チケットを商品の引き渡しステップへ進めました！' });
}

/**
 * 「.next」コマンドまたは「⏩ 次へ進む」ボタンによりターンを進める共通処理
 */
export async function advanceMiddlemanTurn(
  channel: TextChannel,
  initiator: Message | ButtonInteraction
) {
  const isTicketChannel = channel && channel.name.startsWith('mm-');
  if (!isTicketChannel) {
    if (initiator instanceof Message) {
      await initiator.reply('⚠️ `.next` コマンドは取引仲介（`mm-`）チケットでのみ使用できます。');
    } else {
      await initiator.reply({ content: '⚠️ このチャンネルでは使用できません。', ephemeral: true });
    }
    return;
  }

  const session = getOrCreateMMSession(channel.id);

  if (initiator instanceof ButtonInteraction) {
    if (!initiator.replied && !initiator.deferred) {
      await initiator.deferUpdate();
    }
  } else if (initiator instanceof Message) {
    await initiator.delete().catch(() => {});
  }

  const current = session.currentTurn;

  switch (current) {
    case 1:
      if (!session.buyerId || !session.sellerId) {
        session.buyerId = session.creatorId;
        session.sellerId = session.partnerId || '未指定';
      }
      session.creatorRoleConfirmed = true;
      session.partnerRoleConfirmed = true;
      session.currentTurn = 2;
      break;
    case 2:
      session.buyerAgreed = true;
      session.sellerAgreed = true;
      await proceedToTurn3(channel, session);
      return;
    case 3:
      session.buyerPaid = true;
      session.escrowConfirmed = true;
      session.currentTurn = 4;
      break;
    case 4:
      session.sellerSentItem = true;
      session.buyerReceivedItem = true;
      session.currentTurn = 5;
      await triggerMMReleaseFlow(channel, session);
      break;
    case 5:
    default:
      session.currentTurn = 5;
      break;
  }

  await updateOrSendTurnMessage(channel, session);
}
