import https from 'https';

/**
 * OxaPay API への HTTP リクエスト送信ヘルパー (生レスポンスログおよびCloudflareエラー対策)
 */
export function requestOxaPay(method: 'GET' | 'POST', path: string, data: any, apiKey: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = `https://api.oxapay.com/v1${path}`;
    const parsedUrl = new URL(url);

    const options: https.RequestOptions = {
      method: method,
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'merchant_api_key': apiKey,
        'payout_api_key': apiKey,
        'general_api_key': apiKey,
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        console.log(`[OxaPay API Response] ${method} ${path} - StatusCode: ${res.statusCode}`);
        console.log(`[OxaPay Raw Body]:`, body);

        try {
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch (e) {
          if (body.includes('error code: 1015') || body.includes('Cloudflare')) {
            reject(new Error(`Cloudflare Rate Limit (error 1015): 短時間にリクエストが集中したため一時的にOxaPayの保護制限がかかりました。数分置いて再試行してください。\nRaw Output: ${body}`));
          } else {
            reject(new Error(`Failed to parse response body (StatusCode: ${res.statusCode}): ${body}`));
          }
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[OxaPay API Request Error] ${method} ${path}:`, err);
      reject(err);
    });

    if (method === 'POST' && data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}
