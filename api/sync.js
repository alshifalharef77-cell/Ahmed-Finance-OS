// Optional Vercel relay for a Google Apps Script Web App or another private sync endpoint.
// Set GOOGLE_SHEETS_WEBHOOK_URL in Vercel Project Settings to enable it.
export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ configured: false });
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!url) return response.status(200).json({ configured: false });
  try {
    const upstream = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body) });
    if (!upstream.ok) throw new Error('upstream failed');
    return response.status(200).json({ configured: true });
  } catch {
    return response.status(502).json({ configured: false });
  }
}
