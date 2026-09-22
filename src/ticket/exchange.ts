import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
} from 'discord.js';
import {
  currentUsdJpyRate,
  getSystemFeeRate,
  fiatTakeOptions,
  fiatGiveOptions,
  exchangeOptions,
  getExchangeTypeLabel,
  getFilteredOptions,
  getCryptoSymbolFromLabel,
  isValidCryptoAddress,
  formatWithEmoji,
  getEmojiPrefix
} from '../config';
import { requestOxaPay } from '../oxapay';

/**
 * 取引タイプ（Crypto To Crypto 等）選択時の処理
 */
export async function handleExchangeTypeSelect(interaction: StringSelectMenuInteraction) {
  const message = interaction.message;
  const embedInfo = message.embeds[0];
  const selectedType = interaction.values[0];
  const typeLabel = getExchangeTypeLabel(selectedType);

  const embedForm = new EmbedBuilder()
    .setTitle('交換内容の選択')
    .setDescription('下のメニューから、**【支払うもの】**と**【受け取りたいもの】**を選択してください。')
    .addFields(
      { name: '📋 取引タイプ', value: typeLabel, inline: false },
      { name: '📤 支払うもの', value: '未選択', inline: true },
      { name: '📥 受け取りたいもの', value: '未選択', inline: true }
    )
    .setColor('#00ff99');

  const giveOptions = getFilteredOptions(selectedType, true);
  const takeOptions = getFilteredOptions(selectedType, false);

  const giveMenu = new StringSelectMenuBuilder()
    .setCustomId(`exchange_give:${selectedType}`)
    .setPlaceholder('支払うものを選択してください')
    .addOptions(giveOptions);

  const takeMenu = new StringSelectMenuBuilder()
    .setCustomId(`exchange_take:${selectedType}`)
    .setPlaceholder('受け取りたいものを選択してください')
    .addOptions(takeOptions);

  const closeButton = new ButtonBuilder()
    .setCustomId('close_ticket')
    .setLabel('チケットを閉じる')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('🔒');

  const rowGive = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(giveMenu);
  const rowTake = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(takeMenu);
  const rowClose = new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton);

  await interaction.update({
    embeds: [embedInfo, embedForm],
    components: [rowGive, rowTake, rowClose],
  });
}

/**
 * セレクトメニュー選択時の処理 (支払・受取の決定)
 */
export async function handleExchangeSelect(interaction: StringSelectMenuInteraction) {
  const message = interaction.message;
  const embedInfo = message.embeds[0];
  const embedForm = EmbedBuilder.from(message.embeds[1]);
  
  const customId = interaction.customId;
  const parts = customId.split(':');
  const menuName = parts[0];
  const exchangeType = parts[1] || 'crypto_to_crypto';
  
  const selectedValue = interaction.values[0];
  const selectedOption = exchangeOptions.find(opt => opt.value === selectedValue);
  let selectedLabel = selectedOption ? selectedOption.label : selectedValue;
  if (selectedOption && (selectedOption as any).emoji) {
    const emoji = (selectedOption as any).emoji;
    selectedLabel = `<:${emoji.name}:${emoji.id}> ${selectedLabel}`;
  }

  const fields = embedForm.data.fields || [];
  if (fields.length >= 3) {
    if (menuName === 'exchange_give') {
      fields[1].value = selectedLabel;
    } else if (menuName === 'exchange_take') {
      fields[2].value = selectedLabel;
    }
  }

  embedForm.setFields(fields);

  const giveVal = fields[1] ? fields[1].value.replace(/<:[^:]+:\d+>\s*/, '') : '未選択';
  const takeVal = fields[2] ? fields[2].value.replace(/<:[^:]+:\d+>\s*/, '') : '未選択';

  const isGiveSelected = giveVal !== '未選択';
  const isTakeSelected = takeVal !== '未選択';

  if (isGiveSelected && isTakeSelected) {
    if (exchangeType === 'crypto_to_crypto' || exchangeType === 'crypto_to_fiat' || exchangeType === 'fiat_to_crypto') {
      embedForm.setDescription(`${interaction.user} 様、交換内容の選択が完了しました。\n次に、基準とする金額の指定方法（**【支払う額】** または **【受け取りたい額】**）を選択してください。`);

      const payAmountButton = new ButtonBuilder()
        .setCustomId(`input_crypto_amount:pay:${exchangeType}`)
        .setLabel('💵 支払う額（日本円）を指定')
        .setStyle(ButtonStyle.Primary);

      const takeAmountButton = new ButtonBuilder()
        .setCustomId(`input_crypto_amount:take:${exchangeType}`)
        .setLabel('📥 受け取りたい額（日本円）を指定')
        .setStyle(ButtonStyle.Success);

      const closeButton = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('チケットを閉じる')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒');

      const rowAction = new ActionRowBuilder<ButtonBuilder>().addComponents(payAmountButton, takeAmountButton, closeButton);

      await interaction.update({
        embeds: [embedInfo, embedForm],
        components: [rowAction],
      });
    } else {
      embedForm.setDescription(`${interaction.user} 様、交換内容の選択が完了しました。\nサポートが対応するまでしばらくお待ちください。`);
      
      const closeButton = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('チケットを閉じる')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒');
      const rowClose = new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton);

      await interaction.update({
        embeds: [embedInfo, embedForm],
        components: [rowClose],
      });

      const supportRoleId = process.env.SUPPORT_ROLE_ID;
      const channel = interaction.channel;
      if (channel && 'send' in channel) {
        const mentionContent = supportRoleId ? `<@&${supportRoleId}>` : '@Support';
        await channel.send({
          content: `${mentionContent} 新しい交換リクエストの準備が完了しました。対応をお願いします。`,
        });
      }
    }
  } else {
    let giveSourceOptions = getFilteredOptions(exchangeType, true);
    let takeSourceOptions = getFilteredOptions(exchangeType, false);

    if (takeVal !== '未選択') {
      giveSourceOptions = giveSourceOptions.filter(opt => opt.label !== takeVal);
    }
    if (giveVal !== '未選択') {
      takeSourceOptions = takeSourceOptions.filter(opt => opt.label !== giveVal);
    }

    const giveOptions = giveSourceOptions.map(opt => ({
      label: opt.label,
      value: opt.value,
      emoji: (opt as any).emoji,
      default: opt.label === giveVal,
    }));

    const takeOptions = takeSourceOptions.map(opt => ({
      label: opt.label,
      value: opt.value,
      emoji: (opt as any).emoji,
      default: opt.label === takeVal,
    }));

    const giveMenu = new StringSelectMenuBuilder()
      .setCustomId(`exchange_give:${exchangeType}`)
      .setPlaceholder(giveVal !== '未選択' ? giveVal : '支払うものを選択してください')
      .addOptions(giveOptions);

    const takeMenu = new StringSelectMenuBuilder()
      .setCustomId(`exchange_take:${exchangeType}`)
      .setPlaceholder(takeVal !== '未選択' ? takeVal : '受け取りたいものを選択してください')
      .addOptions(takeOptions);

    const closeButton = new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('チケットを閉じる')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒');

    const rowGive = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(giveMenu);
    const rowTake = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(takeMenu);
    const rowClose = new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton);

    await interaction.update({
      embeds: [embedInfo, embedForm],
      components: [rowGive, rowTake, rowClose],
    });
  }
}

/**
 * 見積もりやり直し（戻るボタン押下時）の処理
 */
export async function handleResetAmountChoice(interaction: ButtonInteraction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  const paySymbol = parts[1];
  const takeSymbol = parts[2];

  const isTakeFiat = takeSymbol.toLowerCase() === 'paypay' || takeSymbol.toLowerCase() === 'rakuten_pay';
  const exchangeType = isTakeFiat ? 'crypto_to_fiat' : 'crypto_to_crypto';

  const message = interaction.message;
  if (!message || message.embeds.length < 2) {
    await interaction.reply({ content: '画面の更新に失敗しました。', ephemeral: true });
    return;
  }

  const embedInfo = message.embeds[0];
  const embedForm = EmbedBuilder.from(message.embeds[message.embeds.length - 1]);

  embedForm.setTitle('交換内容の選択');
  embedForm.setDescription(`${interaction.user} 様、交換内容の選択が完了しました。\n次に、基準とする金額の指定方法（**【支払う額】** または **【受け取りたい額】**）を選択してください。`);

  const payAmountButton = new ButtonBuilder()
    .setCustomId(`input_crypto_amount:pay:${exchangeType}`)
    .setLabel('💵 支払う額（日本円）を指定')
    .setStyle(ButtonStyle.Primary);

  const takeAmountButton = new ButtonBuilder()
    .setCustomId(`input_crypto_amount:take:${exchangeType}`)
    .setLabel('📥 受け取りたい額（日本円）を指定')
    .setStyle(ButtonStyle.Success);

  const closeButton = new ButtonBuilder()
    .setCustomId('close_ticket')
    .setLabel('チケットを閉じる')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('🔒');

  const rowAction = new ActionRowBuilder<ButtonBuilder>().addComponents(payAmountButton, takeAmountButton, closeButton);

  await interaction.update({
    embeds: [embedInfo, embedForm],
    components: [rowAction]
  });
}

/**
 * 日本円金額入力ダイアログ (Modal) を表示する
 */
export async function showCryptoAmountModal(interaction: ButtonInteraction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  const mode = parts[1] || 'pay';

  const message = interaction.message;
  const embedForm = message.embeds[1];
  const fields = embedForm.fields;

  const payCurrencyLabel = fields[1] ? fields[1].value.replace(/<:[^:]+:\d+>\s*/, '') : '未選択';
  const takeCurrencyLabel = fields[2] ? fields[2].value.replace(/<:[^:]+:\d+>\s*/, '') : '未選択';

  const payOption = exchangeOptions.find(opt => opt.label === payCurrencyLabel);
  const paySymbol = payOption ? payOption.value : getCryptoSymbolFromLabel(payCurrencyLabel);
  
  const takeOption = exchangeOptions.find(opt => opt.label === takeCurrencyLabel);
  const takeSymbol = takeOption ? takeOption.value : getCryptoSymbolFromLabel(takeCurrencyLabel);

  const isPayMode = mode === 'pay';
  const modalTitle = isPayMode ? '支払う金額（日本円）の入力' : '受け取りたい金額（日本円）の入力';
  const inputLabel = isPayMode ? '支払う金額 (日本円で入力してください)' : '受け取りたい金額 (日本円で入力してください)';

  const modal = new ModalBuilder()
    .setCustomId(`crypto_amount_modal_submit:${mode}:${paySymbol}:${takeSymbol}`)
    .setTitle(modalTitle);

  const amountInput = new TextInputBuilder()
    .setCustomId('crypto_jpy_amount')
    .setLabel(inputLabel)
    .setPlaceholder('例: 10000')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const rowAmount = new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput);
  modal.addComponents(rowAmount);

  await interaction.showModal(modal);
}

/**
 * 日本円金額 Modal 送信時の処理 (見積もり計算と提示)
 */
export async function handleAmountModalSubmit(interaction: ModalSubmitInteraction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  const mode = parts[1] || 'pay';
  let paySymbol = parts[2].toUpperCase();
  if (paySymbol === 'TETHER') paySymbol = 'USDT';
  let takeSymbol = parts[3];
  if (takeSymbol.toUpperCase() === 'TETHER') takeSymbol = 'USDT';

  const jpyAmountStr = interaction.fields.getTextInputValue('crypto_jpy_amount');
  const jpyAmount = parseFloat(jpyAmountStr);

  if (isNaN(jpyAmount) || jpyAmount <= 0) {
    await interaction.reply({ content: '無効な金額が入力されました。数値で入力してください。', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const merchantKey = process.env.OXAPAY_MERCHANT_KEY;
  const generalKey = process.env.OXAPAY_GENERAL_KEY;

  if (!merchantKey || !generalKey) {
    await interaction.editReply({ content: 'システムエラー: OxaPay設定が不足しています。管理者に問い合わせてください。' });
    return;
  }

  try {
    const usdJpyRate = currentUsdJpyRate;
    const isTakeFiat = takeSymbol === 'paypay' || takeSymbol === 'rakuten_pay';

    if (isTakeFiat) {
      const pricesResponse = await requestOxaPay('GET', '/common/prices', null, merchantKey);
      if (pricesResponse.status !== 200) {
        throw new Error(pricesResponse.message || 'Failed to fetch coin prices');
      }
      const prices = pricesResponse.data || {};
      const payPrice = prices[paySymbol] || prices[paySymbol.toLowerCase()];

      if (!payPrice) {
        throw new Error(`Price not found for ${paySymbol}`);
      }

      const fiatFeeRate = getSystemFeeRate('crypto_to_fiat');
      const minSystemFeeUsd = 1.0;

      let payJpyAmount = 0;
      let takeJpyValue = 0;
      let usdAmount = 0;
      let payAmount = 0;

      if (mode === 'pay') {
        payJpyAmount = jpyAmount;
        usdAmount = payJpyAmount / usdJpyRate;
        payAmount = usdAmount / payPrice;
        
        const systemFeeUsd = Math.max(usdAmount * fiatFeeRate, minSystemFeeUsd);
        const afterSystemFeeUsd = usdAmount - systemFeeUsd;
        takeJpyValue = afterSystemFeeUsd * usdJpyRate;
      } else {
        takeJpyValue = jpyAmount;
        const takeUsdValue = takeJpyValue / usdJpyRate;
        
        let calculatedUsdAmount = takeUsdValue / (1.0 - fiatFeeRate);
        if (calculatedUsdAmount * fiatFeeRate < minSystemFeeUsd) {
          calculatedUsdAmount = takeUsdValue + minSystemFeeUsd;
        }
        
        usdAmount = calculatedUsdAmount;
        payJpyAmount = usdAmount * usdJpyRate;
        payAmount = usdAmount / payPrice;
      }

      const takeOption = fiatTakeOptions.find(opt => opt.value === takeSymbol);
      const takeLabel = takeOption ? takeOption.label : takeSymbol;

      if (takeJpyValue < 300) {
        await interaction.editReply({
          content: `⚠️ 金額が少なすぎます。\n**受け取る額が最低でも 300 円以上**になるように指定してください。`
        });
        return;
      }

      const embedInfo = interaction.message?.embeds[0];
      const specifiedModeLabel = mode === 'pay' ? '（支払う額を指定）' : '（受け取りたい額を指定）';

      const embedForm = new EmbedBuilder()
        .setTitle(`📊 交換のお見積もり内容 ${specifiedModeLabel}`)
        .setDescription(`暗号通貨（${formatWithEmoji(paySymbol)}）から日本円（${formatWithEmoji(takeLabel)}）へのお見積もりです。\n内容に間違いがなければ、下のボタンを押してお支払いリンクを発行してください。`)
        .addFields(
          { 
            name: '📤 支払う額', 
            value: `${Math.round(payJpyAmount).toLocaleString()} 円, $${usdAmount.toFixed(2)}\n${payAmount.toFixed(6)} ${formatWithEmoji(paySymbol)}`, 
            inline: true 
          },
          { 
            name: '📥 受け取る額', 
            value: `${Math.round(takeJpyValue).toLocaleString()} 円 (${formatWithEmoji(takeLabel)})`, 
            inline: true 
          }
        )
        .setColor('#ffaa00');

      const backButton = new ButtonBuilder()
        .setCustomId(`reset_amount_choice:${paySymbol}:${takeSymbol}`)
        .setLabel('◀️ 戻る（金額再入力）')
        .setStyle(ButtonStyle.Secondary);

      const proceedButton = new ButtonBuilder()
        .setCustomId(`proceed_fiat_invoice:${paySymbol}:${takeSymbol}:${Math.round(payJpyAmount)}:${usdAmount.toFixed(2)}:${payAmount.toFixed(8)}:${Math.round(takeJpyValue)}`)
        .setLabel('この内容で進む（お支払いリンク発行）')
        .setStyle(ButtonStyle.Success)
        .setEmoji('➡️');

      const closeButton = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('チケットを閉じる')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒');

      const rateEmbed = new EmbedBuilder()
        .setTitle('📈 適用レート情報')
        .addFields(
          { name: '🇺🇸 USD/JPY', value: `${usdJpyRate.toFixed(2)} 円 / 1$`, inline: true },
          { name: `${getEmojiPrefix(paySymbol) || '🪙 '}${paySymbol}/USD`, value: `${Math.round(payPrice * usdJpyRate).toLocaleString()} 円 ($${payPrice.toFixed(2)}) / 1 ${paySymbol}`, inline: true }
        )
        .setColor('#0099ff');

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(backButton, proceedButton, closeButton);

      if (interaction.message) {
        await interaction.message.edit({
          embeds: [embedInfo!, rateEmbed, embedForm],
          components: [row]
        });
      }

      await interaction.editReply({ content: '見積もりの算出が完了しました。チャンネルをご確認ください。' });
      return;
    }

    const isPayFiat = fiatGiveOptions.some(opt => opt.value === paySymbol.toLowerCase() || opt.value === paySymbol);

    if (isPayFiat) {
      const takeSymbolUpper = takeSymbol.toUpperCase();
      const pricesResponse = await requestOxaPay('GET', '/common/prices', null, merchantKey);
      if (pricesResponse.status !== 200) {
        throw new Error(pricesResponse.message || 'Failed to fetch coin prices');
      }
      const prices = pricesResponse.data || {};
      const takePrice = prices[takeSymbolUpper] || prices[takeSymbol.toLowerCase()];

      if (!takePrice) {
        throw new Error(`Price not found for ${takeSymbolUpper}`);
      }

      const currenciesResponse = await requestOxaPay('GET', '/common/currencies', null, merchantKey);
      if (currenciesResponse.status !== 200) {
        throw new Error(currenciesResponse.message || 'Failed to fetch coin configurations');
      }
      const currencyData = currenciesResponse.data || {};
      
      let withdrawFee = 0;
      const takeCoinInfo = currencyData[takeSymbolUpper] || currencyData[takeSymbol.toLowerCase()];
      if (takeCoinInfo && takeCoinInfo.networks) {
        let networkKey = Object.keys(takeCoinInfo.networks)[0];
        if (takeSymbolUpper === 'USDT' && takeCoinInfo.networks['Ethereum']) {
          networkKey = 'Ethereum';
        }
        const netInfo = takeCoinInfo.networks[networkKey];
        if (netInfo) {
          withdrawFee = parseFloat(netInfo.withdraw_fee) || 0;
        }
      }

      const fiatFeeRate = getSystemFeeRate('fiat_to_crypto');
      const minSystemFeeUsd = 1.0;

      let usdAmount = 0;
      let payJpyAmount = 0;
      let finalTakeAmount = 0;
      let takeUsdValue = 0;

      if (mode === 'pay') {
        payJpyAmount = jpyAmount;
        usdAmount = payJpyAmount / usdJpyRate;
        
        const systemFeeUsd = Math.max(usdAmount * fiatFeeRate, minSystemFeeUsd);
        const afterSystemFeeUsd = usdAmount - systemFeeUsd;
        const afterSystemFeeCrypto = afterSystemFeeUsd / takePrice;
        finalTakeAmount = afterSystemFeeCrypto - withdrawFee;

        if (finalTakeAmount <= 0) {
          const withdrawFeeInUsd = withdrawFee * takePrice;
          const minRequiredUsd = 1.0 + withdrawFeeInUsd;
          const minRequiredJpy = minRequiredUsd * usdJpyRate;

          await interaction.editReply({
            content: `⚠️ 金額が少なすぎます。\n入力された金額は、システム手数料（最小1.00$ / 約150円）、および送金手数料（${withdrawFee} ${takeSymbolUpper} = 約$${withdrawFeeInUsd.toFixed(2)}）を支払える金額（約 ${Math.ceil(minRequiredJpy).toLocaleString()} 円以上）である必要があります。`
          });
          return;
        }
        takeUsdValue = finalTakeAmount * takePrice;
      } else {
        const takeJpyValue = jpyAmount;
        takeUsdValue = takeJpyValue / usdJpyRate;
        finalTakeAmount = takeUsdValue / takePrice;

        const afterSystemFeeCrypto = finalTakeAmount + withdrawFee;
        const afterSystemFeeUsd = afterSystemFeeCrypto * takePrice;

        let payUsdAmount = afterSystemFeeUsd / (1.0 - fiatFeeRate);
        if (payUsdAmount * fiatFeeRate < minSystemFeeUsd) {
          payUsdAmount = afterSystemFeeUsd + minSystemFeeUsd;
        }

        usdAmount = payUsdAmount;
        payJpyAmount = usdAmount * usdJpyRate;
      }

      const takeJpyValueCheck = takeUsdValue * usdJpyRate;

      if (takeJpyValueCheck < 300) {
        await interaction.editReply({
          content: `⚠️ 金額が少なすぎます。\n**受け取る額が最低でも 300 円以上**になるように指定してください。`
        });
        return;
      }

      const payOption = fiatGiveOptions.find(opt => opt.value === paySymbol.toLowerCase());
      const payLabel = payOption ? payOption.label : paySymbol;

      const embedInfo = interaction.message?.embeds[0];
      const specifiedModeLabel = mode === 'pay' ? '（支払う額を指定）' : '（受け取りたい額を指定）';

      const embedForm = new EmbedBuilder()
        .setTitle(`📊 交換のお見積もり内容 ${specifiedModeLabel}`)
        .setDescription('システム手数料、および送金手数料（ブロックチェーン手数料）を考慮した見積もりです。\n内容に間違いがなければ、下のボタンを押して「送金先アドレス」を入力してください。')
        .addFields(
          { 
            name: '📤 支払う額', 
            value: `${Math.round(payJpyAmount).toLocaleString()} 円 (${formatWithEmoji(payLabel)})\n$${usdAmount.toFixed(2)} 相当`, 
            inline: true 
          },
          { 
            name: '📥 受け取る額', 
            value: `約 ${Math.round(takeUsdValue * usdJpyRate).toLocaleString()} 円, $${takeUsdValue.toFixed(2)}\n約 ${finalTakeAmount.toFixed(6)} ${formatWithEmoji(takeSymbolUpper)}\n*※この数値はあくまで予想であるため、実際の受取数量は多少上下する可能性があります。*`, 
            inline: true 
          }
        )
        .setColor('#ffaa00');

      const backButton = new ButtonBuilder()
        .setCustomId(`reset_amount_choice:${paySymbol.toLowerCase()}:${takeSymbolUpper}`)
        .setLabel('◀️ 戻る（金額再入力）')
        .setStyle(ButtonStyle.Secondary);

      const proceedButton = new ButtonBuilder()
        .setCustomId(`proceed_address:${paySymbol.toLowerCase()}:${takeSymbolUpper}:${Math.round(payJpyAmount)}:${usdAmount.toFixed(2)}:0:${finalTakeAmount.toFixed(8)}`)
        .setLabel('この内容で進む（アドレス入力）')
        .setStyle(ButtonStyle.Success)
        .setEmoji('➡️');

      const closeButton = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('チケットを閉じる')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒');

      const rateEmbed = new EmbedBuilder()
        .setTitle('📈 適用レート情報')
        .addFields(
          { name: '🇺🇸 USD/JPY', value: `${usdJpyRate.toFixed(2)} 円 / 1$`, inline: true },
          { name: `${getEmojiPrefix(takeSymbolUpper) || '🪙 '}${takeSymbolUpper}/USD`, value: `${Math.round(takePrice * usdJpyRate).toLocaleString()} 円 ($${takePrice.toFixed(2)}) / 1 ${takeSymbolUpper}`, inline: true }
        )
        .setColor('#0099ff');

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(backButton, proceedButton, closeButton);

      if (interaction.message) {
        await interaction.message.edit({
          embeds: [embedInfo!, rateEmbed, embedForm],
          components: [row]
        });
      }

      await interaction.editReply({ content: '見積もりの算出が完了しました。チャンネルをご確認ください。' });
      return;
    }

    const takeSymbolUpper = takeSymbol.toUpperCase();

    const pricesResponse = await requestOxaPay('GET', '/common/prices', null, merchantKey);
    if (pricesResponse.status !== 200) {
      throw new Error(pricesResponse.message || 'Failed to fetch coin prices');
    }
    const prices = pricesResponse.data || {};
    const payPrice = prices[paySymbol] || prices[paySymbol.toLowerCase()];
    const takePrice = prices[takeSymbolUpper] || prices[takeSymbol.toLowerCase()];

    if (!payPrice || !takePrice) {
      throw new Error(`Price not found for ${paySymbol} or ${takeSymbol}`);
    }

    const currenciesResponse = await requestOxaPay('GET', '/common/currencies', null, merchantKey);
    if (currenciesResponse.status !== 200) {
      throw new Error(currenciesResponse.message || 'Failed to fetch coin configurations');
    }
    const currencyData = currenciesResponse.data || {};
    
    let withdrawFee = 0;
    const takeCoinInfo = currencyData[takeSymbolUpper] || currencyData[takeSymbol.toLowerCase()];
    if (takeCoinInfo && takeCoinInfo.networks) {
      let networkKey = Object.keys(takeCoinInfo.networks)[0];
      if (takeSymbolUpper === 'USDT' && takeCoinInfo.networks['Ethereum']) {
        networkKey = 'Ethereum';
      }
      const netInfo = takeCoinInfo.networks[networkKey];
      if (netInfo) {
        withdrawFee = parseFloat(netInfo.withdraw_fee) || 0;
      }
    }

    const systemFeeRate = getSystemFeeRate('crypto_to_crypto');
    const minSystemFeeUsd = 1.0;

    let usdAmount = 0;
    let payJpyAmount = 0;
    let payAmount = 0;
    let finalTakeAmount = 0;
    let takeUsdValue = 0;
    let takeJpyValue = 0;

    if (mode === 'pay') {
      payJpyAmount = jpyAmount;
      usdAmount = payJpyAmount / usdJpyRate;
      payAmount = usdAmount / payPrice;

      let swapAmount = usdAmount / takePrice;
      if (takeSymbolUpper !== 'USDT') {
        const calculateData = {
          from_currency: 'USDT',
          to_currency: takeSymbolUpper,
          amount: usdAmount
        };
        const swapCalcResponse = await requestOxaPay('POST', '/general/swap/calculate', calculateData, generalKey);
        if (swapCalcResponse.result === 100 || swapCalcResponse.result === 1 || swapCalcResponse.status === 200) {
          const calcToAmount = swapCalcResponse.to_amount || swapCalcResponse.data?.to_amount;
          if (calcToAmount) {
            swapAmount = parseFloat(calcToAmount);
          }
        }
      } else {
        swapAmount = usdAmount; // USDT を受け取る場合はスワップ不要 (1 USD = 1 USDT)
      }

      const swapAmountInUsd = swapAmount * takePrice;
      const systemFeeUsd = Math.max(swapAmountInUsd * systemFeeRate, minSystemFeeUsd);
      const afterSystemFeeUsd = swapAmountInUsd - systemFeeUsd;
      const afterSystemFee = afterSystemFeeUsd / takePrice;
      finalTakeAmount = afterSystemFee - withdrawFee;

      if (finalTakeAmount <= 0) {
        const withdrawFeeInUsd = withdrawFee * takePrice;
        const minRequiredUsd = 1.0 + withdrawFeeInUsd;
        const minRequiredJpy = minRequiredUsd * usdJpyRate;

        await interaction.editReply({
          content: `⚠️ 金額が少なすぎます。\n入力された金額は、システム手数料（最小1.00$ / 約150円）、および送金手数料（${withdrawFee} ${takeSymbolUpper} = 約$${withdrawFeeInUsd.toFixed(2)}）を支払える金額（約 ${Math.ceil(minRequiredJpy).toLocaleString()} 円以上）である必要があります。`
        });
        return;
      }

      takeUsdValue = finalTakeAmount * takePrice;
      takeJpyValue = takeUsdValue * usdJpyRate;

    } else {
      takeJpyValue = jpyAmount;
      takeUsdValue = takeJpyValue / usdJpyRate;
      finalTakeAmount = takeUsdValue / takePrice;

      const afterSystemFeeCrypto = finalTakeAmount + withdrawFee;
      const afterSystemFeeUsd = afterSystemFeeCrypto * takePrice;

      let swapAmountInUsd = afterSystemFeeUsd / (1.0 - systemFeeRate);
      if (swapAmountInUsd * systemFeeRate < minSystemFeeUsd) {
        swapAmountInUsd = afterSystemFeeUsd + minSystemFeeUsd;
      }

      const swapAmountCrypto = swapAmountInUsd / takePrice;
      payAmount = swapAmountInUsd / payPrice;

      if (takeSymbolUpper !== 'USDT') {
        const calculateData = {
          from_currency: 'USDT',
          to_currency: takeSymbolUpper,
          amount: swapAmountInUsd
        };
        const swapCalcResponse = await requestOxaPay('POST', '/general/swap/calculate', calculateData, generalKey);
        if (swapCalcResponse.result === 100 || swapCalcResponse.result === 1 || swapCalcResponse.status === 200) {
          const calcToAmount = parseFloat(swapCalcResponse.to_amount || swapCalcResponse.data?.to_amount || '0');
          if (calcToAmount > 0) {
            const ratio = swapAmountCrypto / calcToAmount;
            payAmount = payAmount * ratio;
          }
        }
      }

      usdAmount = payAmount * payPrice;
      payJpyAmount = usdAmount * usdJpyRate;
    }

    if (takeJpyValue < 300) {
      await interaction.editReply({
        content: `⚠️ 金額が少なすぎます。\n**受け取る額が最低でも 300 円以上**になるように指定してください。`
      });
      return;
    }

    const embedInfo = interaction.message?.embeds[0];
    const specifiedModeLabel = mode === 'pay' ? '（支払う額を指定）' : '（受け取りたい額を指定）';

    const embedForm = new EmbedBuilder()
      .setTitle(`📊 交換のお見積もり内容 ${specifiedModeLabel}`)
      .setDescription('スワップ手数料、システム手数料、および送金手数料（ブロックチェーン手数料）を考慮した見積もりです。\n内容に間違いがなければ、下のボタンを押して「送金先アドレス」を入力してください。')
      .addFields(
        { 
          name: '📤 支払う額', 
          value: `${Math.round(payJpyAmount).toLocaleString()} 円, $${usdAmount.toFixed(2)}\n${payAmount.toFixed(6)} ${formatWithEmoji(paySymbol)}`, 
          inline: true 
        },
        { 
          name: '📥 受け取る額', 
          value: `約 ${Math.round(takeJpyValue).toLocaleString()} 円, $${takeUsdValue.toFixed(2)}\n約 ${finalTakeAmount.toFixed(6)} ${formatWithEmoji(takeSymbolUpper)}\n*※この数値はあくまで予想であるため、実際の受取数量は多少上下する可能性があります。*`, 
          inline: true 
        }
      )
      .setColor('#ffaa00');

    const backButton = new ButtonBuilder()
      .setCustomId(`reset_amount_choice:${paySymbol}:${takeSymbolUpper}`)
      .setLabel('◀️ 戻る（金額再入力）')
      .setStyle(ButtonStyle.Secondary);

    const proceedButton = new ButtonBuilder()
      .setCustomId(`proceed_address:${paySymbol}:${takeSymbolUpper}:${Math.round(payJpyAmount)}:${usdAmount.toFixed(2)}:${payAmount.toFixed(8)}:${finalTakeAmount.toFixed(8)}`)
      .setLabel('この内容で進む（アドレス入力）')
      .setStyle(ButtonStyle.Success)
      .setEmoji('➡️');

    const closeButton = new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('チケットを閉じる')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒');

    const rateEmbed = new EmbedBuilder()
      .setTitle('📈 適用レート情報')
      .addFields(
        { name: '🇺🇸 USD/JPY', value: `${usdJpyRate.toFixed(2)} 円 / 1$`, inline: true },
        { name: `${getEmojiPrefix(paySymbol) || '🪙 '}${paySymbol}/USD`, value: `${Math.round(payPrice * usdJpyRate).toLocaleString()} 円 ($${payPrice.toFixed(2)}) / 1 ${paySymbol}`, inline: true },
        { name: `${getEmojiPrefix(takeSymbolUpper) || '🪙 '}${takeSymbolUpper}/USD`, value: `${Math.round(takePrice * usdJpyRate).toLocaleString()} 円 ($${takePrice.toFixed(2)}) / 1 ${takeSymbolUpper}`, inline: true }
      )
      .setColor('#0099ff');

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(backButton, proceedButton, closeButton);

    if (interaction.message) {
      await interaction.message.edit({
        embeds: [embedInfo!, rateEmbed, embedForm],
        components: [row]
      });
    }

    await interaction.editReply({ content: '手数料を考慮した見積もりの算出が完了しました。チャンネルをご確認ください。' });

  } catch (error: any) {
    console.error('Swap calculation failed:', error);
    await interaction.editReply({ content: `お見積もりの算出中にエラーが発生しました。\nエラー詳細: ${error.message || 'Unknown error'}` });
  }
}

/**
 * Crypto To Fiat 用の支払いリンク直接発行処理 (受取アカウント入力不要・ポチ袋送金用)
 */
export async function handleProceedFiatInvoiceSubmit(interaction: ButtonInteraction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  const paySymbol = parts[1].toUpperCase();
  const takeSymbol = parts[2];
  const payJpyAmount = parseFloat(parts[3]);
  const usdAmount = parseFloat(parts[4]);
  const payAmount = parseFloat(parts[5]);
  const takeJpyValue = parseFloat(parts[6]);

  await interaction.deferReply();

  const merchantKey = process.env.OXAPAY_MERCHANT_KEY;
  if (!merchantKey) {
    await interaction.editReply({ content: 'システムエラー: OxaPay設定（OXAPAY_MERCHANT_KEY）が不足しています。管理者に問い合わせてください。' });
    return;
  }

  try {
    const invoiceData: any = {
      amount: usdAmount,
      currency: 'USD',
      lifetime: 30,
      fee_paid_by_payer: 1,
      order_id: interaction.channelId,
      description: `Exchange Crypto to Fiat: ${paySymbol} to ${takeSymbol}`
    };

    if (paySymbol) {
      invoiceData.pay_currency = paySymbol;
    }

    const response = await requestOxaPay('POST', '/payment/invoice', invoiceData, merchantKey);

    const isSuccess = response.result === 100 || response.result === 1 || response.status === 200 || !!response.payLink || !!response.pay_link || !!response.payment_url || !!response.data?.payment_url;

    if (!isSuccess) {
      throw new Error(response.message || 'OxaPay API error');
    }

    const payLink = response.payment_url || response.paymentUrl || response.payLink || response.pay_link || response.data?.payment_url || response.data?.payLink;
    const trackId = response.trackId || response.track_id || response.data?.trackId || response.data?.track_id;

    if (!payLink || !trackId) {
      throw new Error(`Failed to retrieve payLink or trackId from OxaPay response.`);
    }

    const takeOption = fiatTakeOptions.find(opt => opt.value === takeSymbol);
    const takeLabel = takeOption ? takeOption.label : takeSymbol;

      const paymentData = {
        trackId,
        paySymbol,
        takeSymbol,
        takeJpyValue: Math.round(takeJpyValue),
        payJpyAmount: Math.round(payJpyAmount),
        usdAmount: parseFloat(usdAmount.toFixed(2)),
        payAmount: parseFloat(payAmount.toFixed(6))
      };

      const embedInfo = interaction.message?.embeds[0];
      const embedForm = new EmbedBuilder()
        .setTitle('お支払いリンクが発行されました')
        .setDescription(`以下のボタンから支払い画面を開き、お支払いを行ってください。\nお支払いが確認され次第、スタッフが **${takeLabel}（ポチ袋/送金リンク）** をこのチャンネル内に送信します。`)
        .addFields(
          { 
            name: '📤 支払う額', 
            value: `${payJpyAmount.toLocaleString()} 円, $${usdAmount.toFixed(2)}\n${payAmount.toFixed(6)} ${paySymbol}`, 
            inline: true 
          },
          { 
            name: '📥 受け取る額', 
            value: `${Math.round(takeJpyValue).toLocaleString()} 円 (${takeLabel})`, 
            inline: true 
          }
        )
        .setColor('#ffaa00')
        .setFooter({ text: `PaymentData: ${JSON.stringify(paymentData)}` });

      const payButton = new ButtonBuilder()
        .setLabel('お支払い画面を開く')
        .setURL(payLink)
        .setStyle(ButtonStyle.Link);

      const checkButton = new ButtonBuilder()
        .setCustomId(`check_fiat_payment:${trackId}`)
      .setLabel('支払い完了')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅');

    const closeButton = new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('チケットを閉じる')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒');

    const rowAction = new ActionRowBuilder<ButtonBuilder>().addComponents(payButton, checkButton, closeButton);

    if (interaction.message) {
      await interaction.message.edit({
        embeds: [embedInfo!, embedForm],
        components: [rowAction]
      });
    }

    await interaction.editReply({ content: 'お支払いリンクの発行が完了しました。チャンネルをご確認ください。' });

  } catch (error: any) {
    console.error('OxaPay fiat invoice creation failed:', error);
    await interaction.editReply({ content: `お支払いリンクの作成中にエラーが発生しました。\nエラー詳細: ${error.message || 'Unknown error'}` });
  }
}

/**
 * 送金先アドレス入力ダイアログ (Modal) を表示する
 */
export async function showCryptoAddressModal(interaction: ButtonInteraction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  let paySymbol = parts[1].toUpperCase();
  if (paySymbol === 'TETHER') paySymbol = 'USDT';
  let takeSymbol = parts[2].toUpperCase();
  if (takeSymbol === 'TETHER') takeSymbol = 'USDT';
  const jpyAmount = parts[3];
  const usdAmount = parts[4];
  const payAmount = parts[5];
  const finalTakeAmount = parts[6];

  const modal = new ModalBuilder()
    .setCustomId(`crypto_address_modal_submit:${paySymbol}:${takeSymbol}:${jpyAmount}:${usdAmount}:${payAmount}:${finalTakeAmount}`)
    .setTitle('送金先アドレスの入力');

  const addressInput = new TextInputBuilder()
    .setCustomId('crypto_address')
    .setLabel(`送金先のアドレス (${takeSymbol}アドレス)`)
    .setPlaceholder(`あなたの${takeSymbol}受取用アドレス`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const rowAddress = new ActionRowBuilder<TextInputBuilder>().addComponents(addressInput);
  modal.addComponents(rowAddress);

  await interaction.showModal(modal);
}

/**
 * 送金先アドレス Modal 送信時の処理（OxaPayでの支払いリンク作成）
 */
export async function handleAddressModalSubmit(interaction: ModalSubmitInteraction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  let paySymbol = parts[1].toUpperCase();
  if (paySymbol === 'TETHER') paySymbol = 'USDT';
  let takeSymbol = parts[2].toUpperCase();
  if (takeSymbol === 'TETHER') takeSymbol = 'USDT';
  const jpyAmount = parseFloat(parts[3]);
  const usdAmount = parseFloat(parts[4]);
  const payAmount = parseFloat(parts[5]);
  const finalTakeAmount = parseFloat(parts[6]);

  const userAddress = interaction.fields.getTextInputValue('crypto_address');

  if (!isValidCryptoAddress(userAddress, takeSymbol)) {
    await interaction.reply({
      content: `⚠️ 入力された送金先アドレス（${userAddress}）は正しい ${takeSymbol} のアドレス形式ではありません。\n再度正しいアドレスを入力してください。`,
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply();

  const merchantKey = process.env.OXAPAY_MERCHANT_KEY;
  if (!merchantKey) {
    await interaction.editReply({ content: 'システムエラー: OxaPay設定（OXAPAY_MERCHANT_KEY）が不足しています。管理者に問い合わせてください。' });
    return;
  }

  try {
    const pricesResponse = await requestOxaPay('GET', '/common/prices', null, merchantKey);
    let takePrice = 0;
    if (pricesResponse.status === 200) {
      const prices = pricesResponse.data || {};
      takePrice = prices[takeSymbol] || prices[takeSymbol.toLowerCase()] || 0;
    }
    const takeUsdValue = finalTakeAmount * takePrice;
    const takeJpyValue = takeUsdValue * currentUsdJpyRate;

    const isPayFiat = fiatGiveOptions.some(opt => opt.value === paySymbol.toLowerCase() || opt.value === paySymbol);

    if (isPayFiat) {
      const paymentData = {
        paySymbol,
        takeSymbol,
        finalTakeAmount: parseFloat(finalTakeAmount.toFixed(8)),
        userAddress,
        jpyAmount: Math.round(jpyAmount),
        usdAmount: parseFloat(usdAmount.toFixed(2)),
        payAmount: 0,
        userId: interaction.user.id
      };

      const embedInfo = interaction.message?.embeds[0];
      const payOption = fiatGiveOptions.find(opt => opt.value === paySymbol.toLowerCase());
      const payLabel = payOption ? payOption.label : paySymbol;

      const isLinkNeeded = paySymbol.toLowerCase() === 'paypay' || paySymbol.toLowerCase() === 'rakuten_pay';

      const embedForm = new EmbedBuilder()
        .setTitle('送金手続きへ進みます')
        .setDescription(isLinkNeeded ? `以下のボタンから、${payLabel}の「ポチ袋 / 送金リンク」と「パスワード」を入力してください。` : `スタッフが指定する口座・支払い先等への案内をお待ちください。\n\n支払いが完了しましたら、スタッフが入金確認後、指定のアドレスへ自動送金が行われます。`)
        .addFields(
          { 
            name: '📤 支払う額', 
            value: `${Math.round(jpyAmount).toLocaleString()} 円 (${payLabel})`, 
            inline: true 
          },
          { 
            name: '📥 受け取る額', 
            value: `約 ${Math.round(takeJpyValue).toLocaleString()} 円, $${takeUsdValue.toFixed(2)}\n約 ${finalTakeAmount.toFixed(6)} ${takeSymbol}\n*※この数値はあくまで予想であるため、実際の受取数量は多少上下する可能性があります。*`, 
            inline: true 
          },
          { 
            name: '📌 送金先アドレス', 
            value: `\`${userAddress}\``, 
            inline: false 
          }
        )
        .setColor('#ffaa00')
        .setFooter({ text: `PaymentData: ${JSON.stringify(paymentData)}` });

      const buttons: ButtonBuilder[] = [];

      if (isLinkNeeded) {
        buttons.push(
          new ButtonBuilder()
            .setCustomId('fiat_receive_input_link')
            .setLabel('ポチ袋/送金情報を入力する')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🔗')
        );
      } else {
        buttons.push(
          new ButtonBuilder()
            .setCustomId(`fiat_receive_staff_confirm`)
            .setLabel('✅ 支払い完了 (サポート専用)')
            .setStyle(ButtonStyle.Success)
        );
      }

      const closeButton = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('チケットを閉じる')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒');

      buttons.push(closeButton);

      const rowAction = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

      if (interaction.message) {
        await interaction.message.edit({
          embeds: [embedInfo!, embedForm],
          components: [rowAction]
        });
      }

      await interaction.editReply({ content: 'アドレスを保存しました。画面の案内に従って支払い手続きを進めてください。' });
      return;
    }

    const invoiceData: any = {
      amount: usdAmount,
      currency: 'USD',
      lifetime: 30,
      fee_paid_by_payer: 1,
      order_id: interaction.channelId,
      description: `Exchange Crypto: ${paySymbol} to ${takeSymbol}`
    };

    if (paySymbol) {
      invoiceData.pay_currency = paySymbol;
    }

    const response = await requestOxaPay('POST', '/payment/invoice', invoiceData, merchantKey);

    const isSuccess = response.result === 100 || response.result === 1 || response.status === 200 || !!response.payLink || !!response.pay_link || !!response.payment_url || !!response.data?.payment_url || !!response.data?.payLink || !!response.data?.pay_link;

    if (!isSuccess) {
      throw new Error(response.message || 'OxaPay API error');
    }

    const payLink = response.payment_url || 
                    response.paymentUrl || 
                    response.payLink || 
                    response.pay_link || 
                    response.payUrl || 
                    response.pay_url || 
                    response.data?.payment_url || 
                    response.data?.paymentUrl || 
                    response.data?.payLink || 
                    response.data?.pay_link || 
                    response.data?.payUrl || 
                    response.data?.pay_url;

    const trackId = response.trackId || 
                    response.track_id || 
                    response.data?.trackId || 
                    response.data?.track_id;

    if (!payLink || !trackId) {
      throw new Error(`Failed to retrieve payLink or trackId from OxaPay response. Raw response: ${JSON.stringify(response)}`);
    }

    const paymentData = {
      trackId,
      paySymbol,
      takeSymbol,
      finalTakeAmount: parseFloat(finalTakeAmount.toFixed(8)),
      userAddress,
      jpyAmount: Math.round(jpyAmount),
      usdAmount: parseFloat(usdAmount.toFixed(2)),
      payAmount: parseFloat(payAmount.toFixed(6))
    };

    const embedInfo = interaction.message?.embeds[0];
    const embedForm = new EmbedBuilder()
      .setTitle('お支払いリンクが発行されました')
      .setDescription(`以下のボタンから支払い画面を開き、お支払いを行ってください。\nお支払い完了後、**【支払い完了】**ボタンを押すと自動的に ${takeSymbol} へ両替・送金処理が実行されます（お支払いがまだの場合は1分ごとに自動監視します）。`)
      .addFields(
        { 
          name: '📤 支払う額', 
          value: `${jpyAmount.toLocaleString()} 円, $${usdAmount.toFixed(2)}\n${payAmount.toFixed(6)} ${paySymbol}`, 
          inline: true 
        },
        { 
          name: '📥 受け取る額', 
          value: `約 ${Math.round(takeJpyValue).toLocaleString()} 円, $${takeUsdValue.toFixed(2)}\n約 ${finalTakeAmount.toFixed(6)} ${takeSymbol}\n*※この数値はあくまで予想であるため、実際の受取数量は多少上下する可能性があります。*`, 
          inline: true 
        },
        { 
          name: '📌 送金先アドレス', 
          value: `\`${userAddress}\``, 
          inline: false 
        }
      )
      .setColor('#ffaa00')
      .setFooter({ text: `PaymentData: ${JSON.stringify(paymentData)}` });

    const payButton = new ButtonBuilder()
      .setLabel('お支払い画面を開く')
      .setURL(payLink)
      .setStyle(ButtonStyle.Link);

    const checkButton = new ButtonBuilder()
      .setCustomId(`check_payment:${trackId}`)
      .setLabel('支払い完了')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅');

    const closeButton = new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('チケットを閉じる')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒');

    const rowAction = new ActionRowBuilder<ButtonBuilder>().addComponents(payButton, checkButton, closeButton);

    if (interaction.message) {
      await interaction.message.edit({
        embeds: [embedInfo!, embedForm],
        components: [rowAction]
      });
    }

    await interaction.editReply({ content: 'お支払いリンクの発行が完了しました。チャンネルをご確認ください。' });

  } catch (error: any) {
    console.error('OxaPay invoice creation failed:', error);
    await interaction.editReply({ content: `お支払いリンクの作成中にエラーが発生しました。\nエラー詳細: ${error.message || 'Unknown error'}` });
  }
}
