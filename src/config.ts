import https from 'https';

// 現在のドル円レート（初期値150、Frankfurter APIから30秒ごとに自動更新）
export let currentUsdJpyRate: number = 150.0;

/**
 * 環境変数 (.env) から各取引タイプの手数料率を取得するヘルパー関数
 * 例: FEE_CRYPTO_TO_CRYPTO=8 または 0.08 -> 0.08 (8%)
 */
export function getSystemFeeRate(type: 'crypto_to_crypto' | 'fiat_to_crypto' | 'crypto_to_fiat'): number {
  let envVal: string | undefined;
  let defaultRate = 0.08;

  if (type === 'crypto_to_crypto') {
    envVal = process.env.FEE_CRYPTO_TO_CRYPTO;
    defaultRate = 0.08;
  } else if (type === 'fiat_to_crypto') {
    envVal = process.env.FEE_FIAT_TO_CRYPTO;
    defaultRate = 0.08;
  } else if (type === 'crypto_to_fiat') {
    envVal = process.env.FEE_CRYPTO_TO_FIAT;
    defaultRate = 0.10;
  }

  if (envVal !== undefined && envVal.trim() !== '') {
    const parsed = parseFloat(envVal.trim());
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed >= 1 ? parsed / 100 : parsed;
    }
  }

  return defaultRate;
}

/**
 * 環境変数に基づく手数料率の表示用ラベル文字列を取得する関数
 */
export function getSystemFeeLabel(type: 'crypto_to_crypto' | 'fiat_to_crypto' | 'crypto_to_fiat'): string {
  const rate = getSystemFeeRate(type);
  return `${(rate * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

// アクティブな自動監視（ポーリング）タイマーの構造と管理
export interface PollingInfo {
  timer: NodeJS.Timeout;
  channelId: string;
}
export const activePollings = new Map<string, PollingInfo>();

/**
 * 特定のチャンネルIDに紐づくすべての自動監視タイマーを停止・クリアする
 */
export function stopPollingForChannel(channelId: string) {
  for (const [trackId, info] of activePollings.entries()) {
    if (info.channelId === channelId) {
      clearInterval(info.timer);
      activePollings.delete(trackId);
      console.log(`[Auto Polling Cleared] Polling timer stopped for Channel: ${channelId} (Track ID: ${trackId})`);
    }
  }
}

// Fiat (日本円 - 支払用：すべて)
export const fiatGiveOptions = [
  { label: 'Paypay', value: 'paypay' },
  { label: '楽天pay', value: 'rakuten_pay' },
  { label: 'Amazon Gift Card (日本円のみ)', value: 'amazon_gift' },
  { label: 'Kyash', value: 'kyash' },
  { label: '銀行振込 (匿名 楽天銀行)', value: 'bank' },
  { label: 'Revolut', value: 'revolut' },
];

// Fiat (日本円 - 受取用：支払のみの項目を除外)
export const fiatTakeOptions = [
  { label: 'Paypay', value: 'paypay' },
  { label: '楽天pay', value: 'rakuten_pay' },
];

// Crypto (暗号通貨) の選択肢一覧 (Tronを削除)
export const cryptoOptions = [
  { label: 'BTC (bitcoin:ビットコイン)', value: 'btc' },
  { label: 'LTC (litecoin:ライトコイン)', value: 'ltc' },
  { label: 'ETH (etherium:イーサリアム)', value: 'eth' },
  { label: 'SOL (solana:ソラナ)', value: 'sol' },
  { label: 'XMR (monero:モネロ)', value: 'xmr' },
  { label: 'Tether (Tether USD)', value: 'tether' },
  { label: 'DAI', value: 'dai' },
];

// 共通オプション（マージ、検索用）
export const exchangeOptions = [...fiatGiveOptions, ...cryptoOptions];

// 取引タイプのラベル変換用
export function getExchangeTypeLabel(type: string): string {
  switch (type) {
    case 'crypto_to_crypto': return 'Crypto To Crypto (暗号通貨 ➔ 暗号通貨)';
    case 'crypto_to_fiat': return 'Crypto To Fiat (暗号通貨 ➔ 日本円)';
    case 'fiat_to_crypto': return 'Fiat To Crypto (日本円 ➔ 暗号通貨)';
    default: return '未設定';
  }
}

// 取引タイプに基づく選択肢の振り分け
export function getFilteredOptions(type: string, isGive: boolean) {
  if (type === 'crypto_to_crypto') {
    return cryptoOptions;
  } else if (type === 'crypto_to_fiat') {
    return isGive ? cryptoOptions : fiatTakeOptions;
  } else if (type === 'fiat_to_crypto') {
    return isGive ? fiatGiveOptions : cryptoOptions;
  }
  return exchangeOptions;
}

// ラベルから大文字の通貨シンボルを取得する関数
export function getCryptoSymbolFromLabel(label: string): string {
  const upper = label.toUpperCase();
  if (upper.includes('TETHER') || upper.includes('USDT')) return 'USDT';
  if (upper.includes('BTC')) return 'BTC';
  if (upper.includes('LTC')) return 'LTC';
  if (upper.includes('ETH')) return 'ETH';
  if (upper.includes('SOL')) return 'SOL';
  if (upper.includes('XMR')) return 'XMR';
  if (upper.includes('DAI')) return 'DAI';
  return 'USDT';
}

/**
 * Frankfurter API から最新のドル円レートを取得して更新する
 */
export function updateUsdJpyRate(): Promise<number> {
  return new Promise((resolve) => {
    const url = 'https://api.frankfurter.dev/v1/latest?from=USD&to=JPY';
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.rates && typeof parsed.rates.JPY === 'number') {
            currentUsdJpyRate = parsed.rates.JPY;
// ログ出力を削除
            resolve(currentUsdJpyRate);
          } else {
            console.error('[Rate Monitor] Invalid response format:', body);
            resolve(currentUsdJpyRate);
          }
        } catch (e) {
          console.error('[Rate Monitor] Failed to parse Frankfurter API response:', e);
          resolve(currentUsdJpyRate);
        }
      });
    }).on('error', (err) => {
      console.error('[Rate Monitor] Request error from Frankfurter API:', err);
      resolve(currentUsdJpyRate);
    });
  });
}

/**
 * 仮想通貨の送金先アドレスのフォーマットおよびチェックサムを検証する
 */
export function isValidCryptoAddress(address: string, symbol: string): boolean {
  symbol = symbol.toUpperCase();
  if (symbol === 'TETHER') symbol = 'USDT';

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WAValidator = require('multicoin-address-validator');
    
    try {
      // USDTなどのマルチチェーン対応トークン向けの厳格なチェックサム検証
      if (symbol === 'USDT') {
        if (/^0x[a-fA-F0-9]{40}$/i.test(address)) {
           return WAValidator.validate(address, 'ETH'); 
        }
        if (address.startsWith('T')) {
           return WAValidator.validate(address, 'TRX');
        }
        return false;
      }

      const isValid = WAValidator.validate(address, symbol);
      if (isValid) return true;
      
      return false;
    } catch (validationError) {
      // WAValidator が対応していない通貨 (Unknown currency) の場合は下の正規表現へフォールバック
    }
  } catch (e: any) {
    // multicoin-address-validator がインストールされていない場合はそのまま下の正規表現へフォールバック
  }

  // multicoin-address-validator 未対応通貨、またはライブラリ未導入時の正規表現フォールバック
  switch (symbol) {
    case 'BTC':
      return /^(1[a-km-zA-HJ-NP-Z1-9]{25,34})|(3[a-km-zA-HJ-NP-Z1-9]{25,34})|(bc1[a-zA-HJ-NP-Z0-9]{39,59})$/.test(address);
    case 'LTC':
      return /^(L[a-km-zA-HJ-NP-Z1-9]{26,33})|([LM3][a-km-zA-HJ-NP-Z1-9]{26,33})|(ltc1[a-zA-HJ-NP-Z0-9]{39,59})$/.test(address);
    case 'ETH':
    case 'DAI':
      return /^0x[a-fA-F0-9]{40}$/i.test(address);
    case 'USDT':
      if (/^0x[a-fA-F0-9]{40}$/i.test(address)) return true; // ERC20/BEP20
      if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return true; // TRC20 (ライブラリ未導入時の緩いフォールバック)
      return false;
    case 'SOL':
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    case 'XMR':
      return /^[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93,104}$/.test(address);
    default:
      return address.length >= 10; 
  }
}

