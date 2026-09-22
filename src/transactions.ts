import fs from 'fs';
import path from 'path';

export interface TransactionRecord {
  userId: string;
  exchangeType: string;
  pairLabel: string;
  payAmount: number;
  payCurrency: string;
  takeAmount: number;
  takeCurrency: string;
  usdValue: number;
  timestamp: string;
  privacy?: 'public' | 'anonymous' | 'pending';
}

const dataDir = path.join(process.cwd(), 'data');
const transactionsFile = path.join(dataDir, 'transactions.json');

export function saveTransactionRecord(record: TransactionRecord) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  let transactions: TransactionRecord[] = [];
  if (fs.existsSync(transactionsFile)) {
    try {
      const content = fs.readFileSync(transactionsFile, 'utf8');
      const parsed = JSON.parse(content);
      transactions = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error('Failed to parse transactions.json', err);
    }
  }

  transactions.push(record);
  fs.writeFileSync(transactionsFile, JSON.stringify(transactions, null, 2), 'utf8');
  console.log(`[Transaction DB] Saved transaction for user ${record.userId}`);
}

export function updateTransactionPrivacy(userId: string, privacy: 'public' | 'anonymous') {
  if (fs.existsSync(transactionsFile)) {
    try {
      const content = fs.readFileSync(transactionsFile, 'utf8');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) return;
      const transactions: TransactionRecord[] = parsed;
      const tx = transactions.slice().reverse().find(t => t.userId === userId && t.privacy === 'pending');
      if (tx) {
        tx.privacy = privacy;
        fs.writeFileSync(transactionsFile, JSON.stringify(transactions, null, 2), 'utf8');
        console.log(`[Transaction DB] Updated privacy for user ${userId} to ${privacy}`);
      }
    } catch (err) {
      console.error('Failed to update transaction privacy', err);
    }
  }
}

export function getTotalUsdVolume(): number {
  if (!fs.existsSync(transactionsFile)) {
    return 0;
  }
  try {
    const content = fs.readFileSync(transactionsFile, 'utf8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return 0;
    const transactions: TransactionRecord[] = parsed;
    return transactions.reduce((acc, tx) => acc + (tx.usdValue || 0), 0);
  } catch (err) {
    console.error('Failed to calculate total USD volume', err);
    return 0;
  }
}

export function getTotalJpyVolume(currentRate: number): number {
  if (!fs.existsSync(transactionsFile)) {
    return 0;
  }
  try {
    const content = fs.readFileSync(transactionsFile, 'utf8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return 0;
    const transactions: TransactionRecord[] = parsed;
    
    return transactions.reduce((acc, tx) => {
      if (tx.takeCurrency === 'JPY') {
        return acc + (tx.takeAmount || 0);
      } else if (tx.payCurrency === 'JPY') {
        return acc + (tx.payAmount || 0);
      } else {
        return acc + ((tx.usdValue || 0) * currentRate);
      }
    }, 0);
  } catch (err) {
    console.error('Failed to calculate total JPY volume', err);
    return 0;
  }
}
