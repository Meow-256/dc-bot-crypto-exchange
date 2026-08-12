import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';
import {
  setupTicketPanel,
  createTicketChannel,
  closeTicketChannel,
  handleConfirmCloseTicket,
  handleCancelCloseTicket,
  handleForceCloseCommand,
  handleExchangeSelect,
  handleExchangeTypeSelect,
  showCryptoAmountModal,
  handleAmountModalSubmit,
  handleResetAmountChoice,
  showCryptoAddressModal,
  handleAddressModalSubmit,
  handleCheckPayment,
  handleProceedFiatInvoiceSubmit,
  handleCheckFiatPayment,
  handleMarkAsCompletedCommand,
  handlePrivacyChoice,
  updateUsdJpyRate
} from './ticket';

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token) {
  console.error('Error: DISCORD_TOKEN is not defined in the environment variables.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function registerCommands() {
  if (!clientId) {
    console.log('Skipping command registration: CLIENT_ID is not defined.');
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('setup-ticket')
      .setDescription('チケット作成用パネルをこのチャンネルに設置します。')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('close')
      .setDescription('このチケットを強制的に閉じます。（サポート専用）')
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(token!);

  try {
    console.log('Started refreshing application (/) commands.');

    if (guildId) {
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );
      console.log(`Successfully reloaded application (/) commands for guild: ${guildId}`);
    } else {
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log('Successfully reloaded application (/) commands globally.');
    }
  } catch (error) {
    console.error('Error registering application commands:', error);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}!`);

  try {
    await updateUsdJpyRate();
    setInterval(async () => {
      try {
        await updateUsdJpyRate();
      } catch (err) {
        console.error('Error in scheduled updateUsdJpyRate:', err);
      }
    }, 30000);
  } catch (err) {
    console.error('Failed to initialize USD_JPY rate:', err);
  }

  await registerCommands();
});

// メッセージイベント受信 (.mark as completed 用)
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim().toLowerCase();
  if (content === '.mark as completed') {
    try {
      await handleMarkAsCompletedCommand(message);
    } catch (error) {
      console.error('Error handling mark as completed command:', error);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'setup-ticket') {
      try {
        await setupTicketPanel(interaction);
      } catch (error) {
        console.error('Error executing setup-ticket:', error);
      }
    } else if (interaction.commandName === 'close') {
      try {
        await handleForceCloseCommand(interaction);
      } catch (error) {
        console.error('Error executing close command:', error);
      }
    }
  } else if (interaction.isButton()) {
    if (interaction.customId.startsWith('privacy_choice')) {
      try {
        await handlePrivacyChoice(interaction);
      } catch (error) {
        console.error('Error processing privacy choice button:', error);
      }
    } else if (interaction.customId.startsWith('create_ticket_')) {
      try {
        await createTicketChannel(interaction);
      } catch (error) {
        console.error('Error processing create_ticket button:', error);
      }
    } else if (interaction.customId === 'close_ticket') {
      try {
        await closeTicketChannel(interaction);
      } catch (error) {
        console.error('Error processing close_ticket button:', error);
      }
    } else if (interaction.customId === 'confirm_close_ticket') {
      try {
        await handleConfirmCloseTicket(interaction);
      } catch (error) {
        console.error('Error processing confirm_close_ticket button:', error);
      }
    } else if (interaction.customId === 'cancel_close_ticket') {
      try {
        await handleCancelCloseTicket(interaction);
      } catch (error) {
        console.error('Error processing cancel_close_ticket button:', error);
      }
    } else if (interaction.customId.startsWith('input_crypto_amount')) {
      try {
        await showCryptoAmountModal(interaction);
      } catch (error) {
        console.error('Error opening crypto amount modal:', error);
      }
    } else if (interaction.customId.startsWith('reset_amount_choice')) {
      try {
        await handleResetAmountChoice(interaction);
      } catch (error) {
        console.error('Error resetting amount choice:', error);
      }
    } else if (interaction.customId.startsWith('proceed_address')) {
      try {
        await showCryptoAddressModal(interaction);
      } catch (error) {
        console.error('Error opening crypto address modal:', error);
      }
    } else if (interaction.customId.startsWith('proceed_fiat_invoice')) {
      try {
        await handleProceedFiatInvoiceSubmit(interaction);
      } catch (error) {
        console.error('Error proceeding fiat invoice:', error);
      }
    } else if (interaction.customId.startsWith('check_payment')) {
      try {
        await handleCheckPayment(interaction);
      } catch (error) {
        console.error('Error checking OxaPay payment status:', error);
      }
    } else if (interaction.customId.startsWith('check_fiat_payment')) {
      try {
        await handleCheckFiatPayment(interaction);
      } catch (error) {
        console.error('Error checking OxaPay fiat payment status:', error);
      }
    }
  } else if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'exchange_type') {
      try {
        await handleExchangeTypeSelect(interaction);
      } catch (error) {
        console.error('Error processing exchange type select menu:', error);
      }
    } else if (interaction.customId.startsWith('exchange_give') || interaction.customId.startsWith('exchange_take')) {
      try {
        await handleExchangeSelect(interaction);
      } catch (error) {
        console.error('Error processing exchange select menu:', error);
      }
    }
  } else if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('crypto_amount_modal_submit')) {
      try {
        await handleAmountModalSubmit(interaction);
      } catch (error) {
        console.error('Error processing crypto amount modal submit:', error);
      }
    } else if (interaction.customId.startsWith('crypto_address_modal_submit')) {
      try {
        await handleAddressModalSubmit(interaction);
      } catch (error) {
        console.error('Error processing crypto address modal submit:', error);
      }
    }
  }
});

client.login(token).catch((error) => {
  console.error('Failed to login to Discord:', error);
});
