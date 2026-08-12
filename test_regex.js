function isValidCryptoAddress(address, symbol) {
  symbol = symbol.toUpperCase();
  switch (symbol) {
    case 'BTC':
      return /^(1[a-km-zA-HJ-NP-Z1-9]{25,34})|(3[a-km-zA-HJ-NP-Z1-9]{25,34})|(bc1[a-zA-HJ-NP-Z0-9]{39,59})$/.test(address);
    case 'LTC':
      return /^(L[a-km-zA-HJ-NP-Z1-9]{26,33})|([LM3][a-km-zA-HJ-NP-Z1-9]{26,33})|(ltc1[a-zA-HJ-NP-Z0-9]{39,59})$/.test(address);
    case 'ETH':
    case 'DAI':
      return /^0x[a-fA-F0-9]{40}$/i.test(address);
    case 'USDT':
      if (/^T[A-Za-z1-9]{33}$/.test(address)) return true;
      if (/^0x[a-fA-F0-9]{40}$/i.test(address)) return true;
      return false;
    case 'SOL':
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    case 'XMR':
      return /^[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93,104}$/.test(address);
    default:
      return address.length > 10; 
  }
}

console.log('BTC:', isValidCryptoAddress('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'BTC'));
console.log('LTC:', isValidCryptoAddress('ltc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'LTC'));
console.log('ETH:', isValidCryptoAddress('0x71C7656EC7ab88b098defB751B7401B5f6d8976F', 'ETH'));
console.log('USDT(TRC20):', isValidCryptoAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'USDT'));
console.log('USDT(ERC20):', isValidCryptoAddress('0x71C7656EC7ab88b098defB751B7401B5f6d8976F', 'USDT'));
console.log('SOL:', isValidCryptoAddress('HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH', 'SOL'));
console.log('XMR:', isValidCryptoAddress('44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A', 'XMR'));
console.log('Invalid BTC:', isValidCryptoAddress('0x71C7656EC7ab88b098defB751B7401B5f6d8976F', 'BTC'));
