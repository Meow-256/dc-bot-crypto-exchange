import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getTotalUsdVolume, getTotalJpyVolume } from '../transactions';
import { currentUsdJpyRate, getSystemFeeRate } from '../config';

export function startWebServer() {
  const app = express();
  const port = process.env.WEB_PORT || 4000;
  const logsDir = path.join(process.cwd(), 'logs');
  const publicDir = path.join(process.cwd(), 'public');
  const frontendOutDir = path.join(process.cwd(), 'frontend', 'out');
  const staticDir = fs.existsSync(publicDir) ? publicDir : frontendOutDir;

  // JSON Body Parser & CORS
  app.use(express.json());
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  // Ticket logs endpoint
  app.use('/logs', express.static(logsDir));

  // Dynamic API for stats, rates, and fees
  app.get('/api/stats', (req: Request, res: Response) => {
    try {
      const totalUsd = getTotalUsdVolume();
      const totalJpy = getTotalJpyVolume(currentUsdJpyRate);

      res.json({
        success: true,
        data: {
          totalUsd,
          totalJpy: Math.round(totalJpy),
          currentUsdJpyRate,
          fees: {
            cryptoToCrypto: getSystemFeeRate('crypto_to_crypto'),
            fiatToCrypto: getSystemFeeRate('fiat_to_crypto'),
            cryptoToFiat: getSystemFeeRate('crypto_to_fiat'),
          },
          updatedAt: new Date().toISOString()
        }
      });
    } catch (err: any) {
      console.error('[API /api/stats] Error:', err);
      res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  });

  // Serve static export of React/Next.js frontend
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.use((req: Request, res: Response) => {
      const indexPath = path.join(staticDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Not Found');
      }
    });
  } else {
    // If not built yet
    app.get('/', (req: Request, res: Response) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Crypto Exchange Web</title><meta charset="utf-8"/></head>
        <body style="background:#090d16;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
          <div style="text-align:center;">
            <h1>Crypto & Fiat Exchange</h1>
            <p>フロントエンドのビルドを実行中または未完了です。(Run npm run build:web)</p>
          </div>
        </body>
        </html>
      `);
    });
  }

  app.listen(port, () => {
    console.log(`Web server listening on port ${port} (Logs: http://localhost:${port}/logs, Web: http://localhost:${port})`);
  });
}

