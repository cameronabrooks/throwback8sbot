const crypto = require('crypto');
const https = require('https');
const logger = require('./logger');

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : {} });
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const { statusCode, body: respBody } = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);

  if (statusCode >= 400 || !respBody.access_token) {
    throw new Error(`Failed to get Google access token: ${JSON.stringify(respBody)}`);
  }

  cachedToken = respBody.access_token;
  cachedTokenExpiresAt = Date.now() + (respBody.expires_in - 60) * 1000;
  return cachedToken;
}

async function appendRow(spreadsheetId, sheetName, values) {
  const token = await getAccessToken();
  const range = encodeURIComponent(`${sheetName}!A1`);
  const body = JSON.stringify({ values: [values] });

  const { statusCode, body: respBody } = await httpsRequest({
    hostname: 'sheets.googleapis.com',
    path: `/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  if (statusCode >= 400) {
    throw new Error(`Sheets API returned ${statusCode}: ${JSON.stringify(respBody)}`);
  }

  return respBody;
}

async function appendRowSafe(spreadsheetId, sheetName, values) {
  try {
    await appendRow(spreadsheetId, sheetName, values);
    return true;
  } catch (e) {
    logger.error({ err: e.message, spreadsheetId, sheetName, hasEmail: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, hasKey: !!process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY }, 'Failed to append row to Google Sheet');
    return false;
  }
}

module.exports = { appendRow, appendRowSafe };
