"use client";

import React, { useState, useEffect } from "react";

// Supported Assets Configuration
interface Asset {
  id: string;
  name: string;
  symbol: string;
  type: "crypto" | "fiat";
  canGive: boolean; // ユーザーが支払いに使えるか
  canTake: boolean; // ユーザーが受取に使えるか
  image: string;
  badge?: string;
}

const ALL_ASSETS: Asset[] = [
  // Crypto (支払・受取 両方可能)
  { id: "btc", name: "Bitcoin", symbol: "BTC", type: "crypto", canGive: true, canTake: true, image: "/assets/currencies/btc.png", badge: "王道・主要通貨" },
  { id: "ltc", name: "Litecoin", symbol: "LTC", type: "crypto", canGive: true, canTake: true, image: "/assets/currencies/ltc.png", badge: "低手数料・おすすめ" },
  { id: "eth", name: "Ethereum", symbol: "ETH", type: "crypto", canGive: true, canTake: true, image: "/assets/currencies/eth.png", badge: "主要暗号資産" },
  { id: "sol", name: "Solana", symbol: "SOL", type: "crypto", canGive: true, canTake: true, image: "/assets/currencies/sol.png", badge: "高速決済" },
  { id: "xmr", name: "Monero", symbol: "XMR", type: "crypto", canGive: true, canTake: true, image: "/assets/currencies/xmr.png", badge: "完全匿名" },
  { id: "usdt", name: "Tether USD", symbol: "USDT", type: "crypto", canGive: true, canTake: true, image: "/assets/currencies/usdt.png", badge: "米ドルステーブル" },
  { id: "dai", name: "Dai Stablecoin", symbol: "DAI", type: "crypto", canGive: true, canTake: true, image: "/assets/currencies/dai.png", badge: "分散型ステーブル" },
  
  // Fiat (支払用: 6種類 / 受取用: PayPay・楽天ペイのみ)
  { id: "paypay", name: "PayPay", symbol: "PayPay", type: "fiat", canGive: true, canTake: true, image: "/assets/currencies/paypay.png", badge: "受取・支払対応" },
  { id: "rakuten_pay", name: "楽天ペイ", symbol: "楽天ペイ", type: "fiat", canGive: true, canTake: true, image: "/assets/currencies/rakuten_pay.avif", badge: "受取・支払対応" },
  { id: "bank", name: "銀行振込 (楽天銀行)", symbol: "銀行振込", type: "fiat", canGive: true, canTake: false, image: "/assets/currencies/bank.jpeg", badge: "支払のみ対応" },
  { id: "kyash", name: "Kyash", symbol: "Kyash", type: "fiat", canGive: true, canTake: false, image: "/assets/currencies/kyash.png", badge: "支払のみ対応" },
  { id: "revolut", name: "Revolut", symbol: "Revolut", type: "fiat", canGive: true, canTake: false, image: "/assets/currencies/Revolut.png", badge: "支払のみ対応" },
  { id: "amazon_gift", name: "Amazonギフトカード", symbol: "アマギフ", type: "fiat", canGive: true, canTake: false, image: "/assets/currencies/amazon.webp", badge: "支払のみ対応" },
];

export default function LandingPage() {
  // Live stats from API
  const [stats, setStats] = useState<{
    totalUsd: number;
    totalJpy: number;
    currentUsdJpyRate: number;
    fees: { cryptoToCrypto: number; fiatToCrypto: number; cryptoToFiat: number };
  }>({
    totalUsd: 0,
    totalJpy: 0,
    currentUsdJpyRate: 155.0,
    fees: { cryptoToCrypto: 0.07, fiatToCrypto: 0.07, cryptoToFiat: 0.08 },
  });

  // Simulator State
  const [simPayAsset, setSimPayAsset] = useState<string>("ltc");
  const [simTakeAsset, setSimTakeAsset] = useState<string>("paypay");
  const [simPayAmount, setSimPayAmount] = useState<string>("10000");

  // FAQ Accordion State
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  // Fetch Live Stats
  useEffect(() => {
    async function loadStats() {
      try {
        const res = await fetch("/api/stats");
        if (res.ok) {
          const json = await res.json();
          if (json.success && json.data) {
            setStats(json.data);
          }
        }
      } catch {
        // Fallback gracefully
      }
    }
    loadStats();
    const timer = setInterval(loadStats, 30000);
    return () => clearInterval(timer);
  }, []);

  // Filter available Pay and Take assets
  const availablePayAssets = ALL_ASSETS.filter((a) => a.canGive);
  const selectedPay = ALL_ASSETS.find((a) => a.id === simPayAsset) || ALL_ASSETS[1];

  // If Pay is Fiat, Take can only be Crypto. If Pay is Crypto, Take can be Crypto or Take-enabled Fiat (PayPay, 楽天ペイ)
  const availableTakeAssets = ALL_ASSETS.filter((a) => {
    if (!a.canTake) return false;
    if (a.id === selectedPay.id) return false; // cannot exchange to same asset
    if (selectedPay.type === "fiat") {
      return a.type === "crypto"; // Fiat -> Crypto only
    }
    return true; // Crypto -> Crypto or Crypto -> Fiat
  });

  // Ensure selectedTake is valid when pay asset changes
  useEffect(() => {
    const isCurrentTakeValid = availableTakeAssets.some((a) => a.id === simTakeAsset);
    if (!isCurrentTakeValid && availableTakeAssets.length > 0) {
      setSimTakeAsset(availableTakeAssets[0].id);
    }
  }, [simPayAsset, availableTakeAssets, simTakeAsset]);

  const selectedTake = ALL_ASSETS.find((a) => a.id === simTakeAsset) || availableTakeAssets[0] || ALL_ASSETS[7];

  // Compute fee rate and type
  let exchangeType: "crypto_to_crypto" | "fiat_to_crypto" | "crypto_to_fiat" = "crypto_to_fiat";
  if (selectedPay.type === "crypto" && selectedTake.type === "crypto") {
    exchangeType = "crypto_to_crypto";
  } else if (selectedPay.type === "fiat" && selectedTake.type === "crypto") {
    exchangeType = "fiat_to_crypto";
  } else {
    exchangeType = "crypto_to_fiat";
  }

  const feeRateMap: Record<string, number> = {
    crypto_to_crypto: stats.fees.cryptoToCrypto ?? 0.07,
    fiat_to_crypto: stats.fees.fiatToCrypto ?? 0.07,
    crypto_to_fiat: stats.fees.cryptoToFiat ?? 0.08,
  };
  const feeRate = feeRateMap[exchangeType] || 0.08;
  const feePercent = (feeRate * 100).toFixed(0);

  // Estimated payout calculation (Input is always JPY: 日本円固定)
  const jpyAmount = parseFloat(simPayAmount) || 0;
  const jpyNet = jpyAmount * (1 - feeRate);
  const usdNet = jpyNet / (stats.currentUsdJpyRate || 155);

  let estimatedTakeDisplay = "";
  let estimatedSubDisplay = "";

  if (exchangeType === "crypto_to_fiat") {
    // 暗号資産 -> 日本円 (PayPay / 楽天ペイ)
    estimatedTakeDisplay = `約 ¥${Math.round(jpyNet).toLocaleString()}`;
    estimatedSubDisplay = `($${usdNet.toFixed(2)} 相当)`;
  } else if (exchangeType === "fiat_to_crypto") {
    // 日本円 -> 暗号資産
    estimatedTakeDisplay = `約 ¥${Math.round(jpyNet).toLocaleString()} 相当 (${selectedTake.symbol})`;
    estimatedSubDisplay = `($${usdNet.toFixed(2)} 相当)`;
  } else {
    // 暗号資産 -> 暗号資産
    estimatedTakeDisplay = `約 ¥${Math.round(jpyNet).toLocaleString()} 相当 (${selectedTake.symbol})`;
    estimatedSubDisplay = `($${usdNet.toFixed(2)} 相当)`;
  }

  return (
    <div className="relative min-h-screen bg-[#07090e] text-slate-100 selection:bg-blue-600/30 overflow-hidden">
      {/* Background Wallpaper with overlay */}
      <div 
        className="fixed inset-0 pointer-events-none z-0 opacity-20 bg-center bg-cover bg-no-repeat"
        style={{ backgroundImage: `url('/bk.png')` }}
      />

      {/* Background Ambient Glows */}
      <div className="glow-bg bg-blue-600/15 top-[-100px] left-1/2 -translate-x-1/2" />
      <div className="glow-bg bg-emerald-600/10 top-[800px] right-[-200px]" />
      <div className="glow-bg bg-purple-600/10 top-[1800px] left-[-200px]" />

      {/* Navigation Header */}
      <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-[#07090e]/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl overflow-hidden shadow-lg shadow-blue-500/20 border border-white/10 bg-slate-900/80 flex items-center justify-center p-1">
              <img src="/logo.png" alt="Logo" className="w-full h-full object-contain" />
            </div>
            <div>
              <span className="font-extrabold text-lg tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
                EXCHANGE BOT
              </span>
              <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                Official
              </span>
            </div>
          </div>

          <nav className="hidden md:flex items-center space-x-8 text-sm font-medium text-slate-300">
            <a href="#features" className="hover:text-blue-400 transition-colors">サービス特徴</a>
            <a href="#currencies" className="hover:text-blue-400 transition-colors">対応通貨</a>
            <a href="#simulator" className="hover:text-blue-400 transition-colors">両替シミュレーター</a>
            <a href="#flow" className="hover:text-blue-400 transition-colors">ご利用の流れ</a>
            <a href="#faq" className="hover:text-blue-400 transition-colors">よくある質問</a>
          </nav>

          <div>
            <a
              href="https://discord.gg/YukCNRE56s"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-lg shadow-blue-500/25 hover:from-blue-500 hover:to-blue-600 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.893.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
              </svg>
              Discordで取引開始
            </a>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative pt-16 pb-16 md:pt-24 md:pb-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        {/* Brand Logo Display */}
        <div className="flex justify-center mb-6">
          <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-3xl p-1 bg-gradient-to-tr from-blue-500 via-emerald-500 to-teal-400 shadow-2xl shadow-blue-500/30">
            <div className="w-full h-full bg-[#080c16] rounded-[22px] p-2.5 flex items-center justify-center">
              <img src="/logo.png" alt="Logo" className="w-full h-full object-contain drop-shadow-lg" />
            </div>
          </div>
        </div>

        {/* Top Badge */}
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 text-xs font-semibold mb-8">
          <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block animate-ping" />
          <span>24時間365日 自動稼働中 • KYC不要・匿名取引対応</span>
        </div>

        {/* Hero Title */}
        <h1 className="text-4xl sm:text-6xl lg:text-7xl font-black tracking-tight leading-tight sm:leading-none mb-6">
          <span className="block text-white mb-2">暗号通貨 ⇄ 日本円</span>
          <span className="bg-gradient-to-r from-blue-400 via-emerald-400 to-teal-300 bg-clip-text text-transparent">
            安全・確実な両替サービス
          </span>
        </h1>

        {/* Hero Subtitle */}
        <p className="max-w-3xl mx-auto text-base sm:text-lg text-slate-400 mb-10 leading-relaxed">
          Discordチケットで完結する安全なエクスチェンジサービス。PayPay・楽天ペイ・銀行振込・各種Payと主要暗号資産（BTC, ETH, LTC, SOL, XMR, USDT, DAI）を最短10分で両替。面倒な本人確認は一切不要です。
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
          <a
            href="https://discord.gg/YukCNRE56s"
            target="_blank"
            rel="noreferrer"
            className="w-full sm:w-auto px-8 py-4 rounded-xl bg-gradient-to-r from-blue-600 to-emerald-600 text-white font-bold text-base shadow-xl shadow-blue-500/20 hover:scale-[1.03] transition-all flex items-center justify-center space-x-2"
          >
            <span>今すぐDiscordで両替する</span>
            <span>→</span>
          </a>
          <a
            href="#simulator"
            className="w-full sm:w-auto px-8 py-4 rounded-xl glass-panel text-slate-200 font-semibold text-base hover:bg-white/10 transition-all flex items-center justify-center"
          >
            両替シミュレーターを試す
          </a>
        </div>

        {/* Real-time Counter Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-5xl mx-auto text-left">
          <div className="glass-panel p-5 rounded-2xl border border-white/10 relative overflow-hidden">
            <div className="text-xs font-medium text-slate-400 mb-1">累計取引額 (JPY)</div>
            <div className="text-2xl sm:text-3xl font-black text-white tracking-tight">
              {stats.totalJpy > 0 ? `¥${stats.totalJpy.toLocaleString()}` : "¥1,000,000+"}
            </div>
            <div className="mt-2 text-[11px] text-emerald-400 flex items-center">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5" />
              リアルタイム集計中
            </div>
          </div>

          <div className="glass-panel p-5 rounded-2xl border border-white/10 relative overflow-hidden">
            <div className="text-xs font-medium text-slate-400 mb-1">累計取引額 (USD)</div>
            <div className="text-2xl sm:text-3xl font-black text-blue-400 tracking-tight">
              {stats.totalUsd > 0 ? `$${stats.totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "$10,000+"}
            </div>
            <div className="mt-2 text-[11px] text-slate-400">
              USD換算ボリューム
            </div>
          </div>

          <div className="glass-panel p-5 rounded-2xl border border-white/10 relative overflow-hidden">
            <div className="text-xs font-medium text-slate-400 mb-1">USD/JPY 為替レート</div>
            <div className="text-2xl sm:text-3xl font-black text-slate-100 tracking-tight">
              ¥{(stats.currentUsdJpyRate || 155).toFixed(2)}
            </div>
            <div className="mt-2 text-[11px] text-blue-400">
              為替市場リアルタイム連動
            </div>
          </div>

          <div className="glass-panel p-5 rounded-2xl border border-white/10 relative overflow-hidden">
            <div className="text-xs font-medium text-slate-400 mb-1">平均着金スピード</div>
            <div className="text-2xl sm:text-3xl font-black text-emerald-400 tracking-tight">
              最短 10 分
            </div>
            <div className="mt-2 text-[11px] text-slate-400">
              自動監視システム稼働中
            </div>
          </div>
        </div>
      </section>

      {/* Simulator Section */}
      <section id="simulator" className="py-16 md:py-24 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-xs font-bold uppercase tracking-widest text-blue-400 mb-2">CALCULATOR</h2>
          <p className="text-3xl sm:text-4xl font-extrabold text-white">リアルタイム両替シミュレーター</p>
          <p className="mt-3 text-slate-400 text-sm">現在の市場レート・手数料を反映した受取概算金額をシミュレーションできます</p>
        </div>

        <div className="glass-panel p-6 sm:p-8 rounded-3xl border border-white/10 shadow-2xl relative">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Left: Input */}
            <div className="space-y-6">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  1. 支払う通貨を選択（{availablePayAssets.length}種類）
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1">
                  {availablePayAssets.map((asset) => (
                    <button
                      key={asset.id}
                      onClick={() => setSimPayAsset(asset.id)}
                      className={`p-2.5 rounded-xl border text-left flex items-center space-x-2.5 transition-all ${
                        simPayAsset === asset.id
                          ? "bg-blue-600/20 border-blue-500 text-white shadow-lg shadow-blue-500/10"
                          : "bg-slate-900/50 border-white/5 text-slate-400 hover:border-white/20"
                      }`}
                    >
                      <div className="w-7 h-7 rounded-lg overflow-hidden bg-slate-800/80 border border-white/10 p-0.5 flex-shrink-0 flex items-center justify-center">
                        <img src={asset.image} alt={asset.symbol} className="w-full h-full object-contain" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold truncate leading-tight">{asset.symbol}</div>
                        <div className="text-[10px] text-slate-400 truncate">{asset.name}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  2. 取引金額（日本円）
                </label>
                <div className="relative">
                  <input
                    type="number"
                    value={simPayAmount}
                    onChange={(e) => setSimPayAmount(e.target.value)}
                    placeholder="10000"
                    className="w-full bg-slate-900/90 border border-white/10 rounded-xl px-4 py-3.5 text-lg font-bold text-white focus:outline-none focus:border-blue-500 transition-colors pr-16"
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-300">
                    円 (JPY)
                  </div>
                </div>
                {/* Quick Add Presets */}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {[5000, 10000, 30000, 50000, 100000].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setSimPayAmount(String(amt))}
                      className="text-[11px] px-2.5 py-1 rounded-lg bg-slate-800/80 hover:bg-blue-600/30 text-slate-300 hover:text-white border border-white/5 hover:border-blue-500/40 transition-all font-medium"
                    >
                      ¥{amt.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Right: Output Target */}
            <div className="space-y-6 flex flex-col justify-between">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  3. 受け取りたい通貨を選択（{availableTakeAssets.length}種類）
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1">
                  {availableTakeAssets.map((asset) => (
                    <button
                      key={asset.id}
                      onClick={() => setSimTakeAsset(asset.id)}
                      className={`p-2.5 rounded-xl border text-left flex items-center space-x-2.5 transition-all ${
                        simTakeAsset === asset.id
                          ? "bg-emerald-600/20 border-emerald-500 text-white shadow-lg shadow-emerald-500/10"
                          : "bg-slate-900/50 border-white/5 text-slate-400 hover:border-white/20"
                      }`}
                    >
                      <div className="w-7 h-7 rounded-lg overflow-hidden bg-slate-800/80 border border-white/10 p-0.5 flex-shrink-0 flex items-center justify-center">
                        <img src={asset.image} alt={asset.symbol} className="w-full h-full object-contain" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold truncate leading-tight">{asset.symbol}</div>
                        <div className="text-[10px] text-slate-400 truncate">{asset.name}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Estimate Result Box */}
              <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900 to-[#0c1220] border border-blue-500/30">
                <div className="flex justify-between items-center text-xs text-slate-400 mb-2">
                  <span>適用手数料率: <strong className="text-blue-400">{feePercent}%</strong></span>
                  <span>両替タイプ: <strong className="text-slate-300">{exchangeType.replace(/_/g, ' ')}</strong></span>
                </div>
                <div className="text-xs text-slate-400 mb-1">受取概算予定額:</div>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-2xl sm:text-3xl font-black text-emerald-400 tracking-tight">
                    {estimatedTakeDisplay}
                  </span>
                  {estimatedSubDisplay && (
                    <span className="text-sm font-semibold text-slate-400">
                      {estimatedSubDisplay}
                    </span>
                  )}
                </div>
                <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between">
                  <span className="text-[11px] text-slate-400">※相場レートにより微小に変動します</span>
                  <a
                    href="https://discord.gg/YukCNRE56s"
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-bold text-blue-400 hover:text-blue-300 flex items-center"
                  >
                    この条件で両替する →
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Supported Currencies & Payment Methods */}
      <section id="currencies" className="py-16 md:py-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-xs font-bold uppercase tracking-widest text-emerald-400 mb-2">SUPPORTED ASSETS</h2>
          <p className="text-3xl sm:text-4xl font-extrabold text-white">対応通貨・決済方法一覧</p>
          <p className="mt-3 text-slate-400 text-sm">取引タイプごとの対応決済方法を明確にご案内しています</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Crypto Column */}
          <div className="glass-panel p-6 sm:p-8 rounded-3xl border border-white/10">
            <div className="flex items-center space-x-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold text-lg">
                🪙
              </div>
              <div>
                <h3 className="text-xl font-bold text-white">暗号資産（支払・受取 対応）</h3>
                <p className="text-xs text-slate-400">全7銘柄 • 自動決済システム連携</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {ALL_ASSETS.filter((a) => a.type === "crypto").map((coin) => (
                <div
                  key={coin.id}
                  className="p-4 rounded-2xl bg-slate-900/60 border border-white/5 hover:border-white/20 transition-all flex items-center justify-between"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-xl bg-slate-800/90 border border-white/10 p-1 flex items-center justify-center flex-shrink-0">
                      <img src={coin.image} alt={coin.symbol} className="w-full h-full object-contain" />
                    </div>
                    <div>
                      <div className="font-bold text-sm text-white">{coin.name}</div>
                      <div className="text-xs text-slate-400">{coin.symbol}</div>
                    </div>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                    支払/受取可
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Fiat Column */}
          <div className="glass-panel p-6 sm:p-8 rounded-3xl border border-white/10">
            <div className="flex items-center space-x-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-lg">
                💳
              </div>
              <div>
                <h3 className="text-xl font-bold text-white">日本円決済 (Fiat / Pay)</h3>
                <p className="text-xs text-slate-400">受取対応: PayPay, 楽天ペイ / 支払対応: 全6種</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {ALL_ASSETS.filter((a) => a.type === "fiat").map((fiat) => (
                <div
                  key={fiat.id}
                  className="p-4 rounded-2xl bg-slate-900/60 border border-white/5 hover:border-white/20 transition-all flex items-center justify-between"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-xl bg-slate-800/90 border border-white/10 p-1 flex items-center justify-center flex-shrink-0">
                      <img src={fiat.image} alt={fiat.symbol} className="w-full h-full object-contain" />
                    </div>
                    <div>
                      <div className="font-bold text-sm text-white">{fiat.name}</div>
                      <div className="text-xs text-slate-400">{fiat.symbol}</div>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full border ${
                      fiat.canTake
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                        : "bg-slate-800 text-slate-400 border-white/5"
                    }`}
                  >
                    {fiat.canTake ? "受取・支払可" : "支払のみ対応"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Features / Why Choose Us */}
      <section id="features" className="py-16 md:py-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-xs font-bold uppercase tracking-widest text-blue-400 mb-2">FEATURES</h2>
          <p className="text-3xl sm:text-4xl font-extrabold text-white">選ばれる4つの安心理由</p>
          <p className="mt-3 text-slate-400 text-sm">初心者から大口取引まで安心・快適にご利用いただける仕組み</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="glass-panel p-6 rounded-3xl border border-white/10 hover:border-blue-500/40 transition-all">
            <div className="w-12 h-12 rounded-2xl bg-blue-500/20 text-blue-400 flex items-center justify-center text-2xl mb-5">
              ⚡
            </div>
            <h3 className="text-lg font-bold text-white mb-2">最短10分の高速着金</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              OxaPay自動決済ゲートウェイと連携し、ブロックチェーン承認後、最短10分で指定口座・アドレスへ自動送金されます。
            </p>
          </div>

          <div className="glass-panel p-6 rounded-3xl border border-white/10 hover:border-emerald-500/40 transition-all">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-2xl mb-5">
              🛡️
            </div>
            <h3 className="text-lg font-bold text-white mb-2">KYC（本人確認）不要</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              面倒な身分証明書の提出は不要。Discordアカウント1つですぐに両替取引をスタートできます。
            </p>
          </div>

          <div className="glass-panel p-6 rounded-3xl border border-white/10 hover:border-purple-500/40 transition-all">
            <div className="w-12 h-12 rounded-2xl bg-purple-500/20 text-purple-400 flex items-center justify-center text-2xl mb-5">
              🔒
            </div>
            <h3 className="text-lg font-bold text-white mb-2">プライバシー・匿名保護</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              個別チケットチャンネルで取引が完結。完了ログの公開/匿名もユーザー側で自由に選択可能です。
            </p>
          </div>

          <div className="glass-panel p-6 rounded-3xl border border-white/10 hover:border-amber-500/40 transition-all">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/20 text-amber-400 flex items-center justify-center text-2xl mb-5">
              💎
            </div>
            <h3 className="text-lg font-bold text-white mb-2">明朗な手数料</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              隠れコストや不当なスプレッドは一切なし。シミュレーターに表示された金額がそのまま受取予定額になります。
            </p>
          </div>
        </div>
      </section>

      {/* How it Works (Flow) */}
      <section id="flow" className="py-16 md:py-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-xs font-bold uppercase tracking-widest text-emerald-400 mb-2">HOW IT WORKS</h2>
          <p className="text-3xl sm:text-4xl font-extrabold text-white">ご利用の流れ（4ステップ）</p>
          <p className="mt-3 text-slate-400 text-sm">Discord内でチケットを作成するだけのシンプルな手順</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 relative">
          <div className="glass-panel p-6 rounded-3xl border border-white/10 relative">
            <div className="text-4xl font-black text-blue-500/30 mb-3">01</div>
            <h3 className="text-lg font-bold text-white mb-2">Discordに参加</h3>
            <p className="text-sm text-slate-400">
              公式Discordサーバーに参加します。登録手続き等は一切不要です。
            </p>
          </div>

          <div className="glass-panel p-6 rounded-3xl border border-white/10 relative">
            <div className="text-4xl font-black text-blue-500/30 mb-3">02</div>
            <h3 className="text-lg font-bold text-white mb-2">チケット作成</h3>
            <p className="text-sm text-slate-400">
              チケットパネルの「チケットを作成」ボタンを押すと、専用の非公開チャンネルが即座に開きます。
            </p>
          </div>

          <div className="glass-panel p-6 rounded-3xl border border-white/10 relative">
            <div className="text-4xl font-black text-blue-500/30 mb-3">03</div>
            <h3 className="text-lg font-bold text-white mb-2">通貨と金額を選択</h3>
            <p className="text-sm text-slate-400">
              画面の案内に従って、支払う通貨・受取方法・金額を選択します。送金先情報が自動提示されます。
            </p>
          </div>

          <div className="glass-panel p-6 rounded-3xl border border-white/10 relative">
            <div className="text-4xl font-black text-emerald-500/40 mb-3">04</div>
            <h3 className="text-lg font-bold text-emerald-400 mb-2">着金完了</h3>
            <p className="text-sm text-slate-400">
              送金確認後、指定アドレスまたは口座へ最短10分で送金され、チケットが完了します。
            </p>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section id="faq" className="py-16 md:py-24 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-xs font-bold uppercase tracking-widest text-blue-400 mb-2">FAQ</h2>
          <p className="text-3xl sm:text-4xl font-extrabold text-white">よくある質問</p>
        </div>

        <div className="space-y-4">
          {[
            {
              q: "本人確認（KYC）は必要ですか？",
              a: "不要です。身分証明書の提出や個人情報の登録なしで、Discordアカウントのみですぐにご利用いただけます。",
            },
            {
              q: "取引完了までどのくらい時間がかかりますか？",
              a: "暗号通貨のブロックチェーン承認後、最短10分程度で送金が完了します。",
            },
            {
              q: "日本円の受取に対応している決済方法は何ですか？",
              a: "暗号通貨からの日本円受取は「PayPay」および「楽天ペイ」に対応しています。支払いの際は銀行振込やRevolut、Kyash、アマギフ等もご利用いただけます。",
            },
            {
              q: "取引内容は他の人に見られますか？",
              a: "取引はあなた専用の非公開チケットチャンネル内で行われます。また、完了ログも「匿名」を選択すればあなたのユーザー名は一切公開されません。",
            },
            {
              q: "最低取引金額・上限金額はありますか？",
              a: "最低約500円ほどから少額でもお気軽にご利用いただけます。高額取引の場合は事前にチケット内でお気軽にご相談ください。",
            },
          ].map((item, idx) => (
            <div
              key={idx}
              className={`glass-panel rounded-2xl border transition-all duration-300 overflow-hidden ${
                openFaq === idx ? "border-blue-500/40 shadow-lg shadow-blue-500/10 bg-slate-900/90" : "border-white/10"
              }`}
            >
              <button
                onClick={() => setOpenFaq(openFaq === idx ? null : idx)}
                className="w-full px-6 py-5 text-left font-bold text-slate-200 flex justify-between items-center hover:text-blue-400 transition-colors"
              >
                <span className="pr-4">{item.q}</span>
                <span
                  className={`text-xl text-slate-400 font-light transition-transform duration-300 flex-shrink-0 ${
                    openFaq === idx ? "rotate-45 text-blue-400" : ""
                  }`}
                >
                  +
                </span>
              </button>
              <div
                className={`grid transition-all duration-300 ease-in-out ${
                  openFaq === idx ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                }`}
              >
                <div className="overflow-hidden">
                  <div className="px-6 pb-5 text-sm text-slate-400 leading-relaxed border-t border-white/5 pt-4">
                    {item.a}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Final CTA Banner */}
      <section className="py-16 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="rounded-3xl bg-gradient-to-r from-blue-900/60 via-slate-900 to-emerald-900/60 border border-blue-500/30 p-8 sm:p-12 text-center relative overflow-hidden shadow-2xl">
          <div className="relative z-10 max-w-3xl mx-auto">
            <h2 className="text-3xl sm:text-5xl font-black text-white mb-4">
              今すぐDiscordで両替を始めましょう
            </h2>
            <p className="text-slate-300 text-sm sm:text-base mb-8">
              面倒な登録なし・24時間いつでも即座にチケットを作成して取引が可能です。
            </p>
            <a
              href="https://discord.gg/YukCNRE56s"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center px-8 py-4 rounded-xl bg-white text-slate-950 font-black text-base shadow-xl hover:bg-slate-100 transition-all hover:scale-105"
            >
              Discordサーバーに参加する
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 py-12 text-center text-xs text-slate-400">
        <div className="max-w-7xl mx-auto px-4 space-y-4">
          <p className="font-semibold text-slate-400">
            © {new Date().getFullYear()} Crypto & Fiat Exchange Bot. All rights reserved.
          </p>
          <p className="max-w-2xl mx-auto text-[11px] leading-relaxed text-slate-400">
            当サービスは安全な取引を第一に運営されています。暗号資産の価格変動リスクにご留意の上、余裕を持った取引をお願いいたします。
          </p>
        </div>
      </footer>
    </div>
  );
}
