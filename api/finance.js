import { neon } from '@neondatabase/serverless';

const collections = ['expenses', 'income', 'uber', 'fuel', 'investments', 'maintenance', 'budgets', 'goals', 'settings', 'metadata', 'backups', 'categories', 'wallets', 'dues', 'favorites'];

function authorized(request) {
  return Boolean(process.env.APP_PIN) && request.headers['x-finance-pin'] === process.env.APP_PIN;
}

async function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing.');
  const sql = neon(process.env.DATABASE_URL);
  await sql`CREATE TABLE IF NOT EXISTS finance_records (
    id TEXT PRIMARY KEY,
    collection TEXT NOT NULL,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  return sql;
}

export default async function handler(request, response) {
  if (request.method === 'OPTIONS') return response.status(204).end();
  if (!authorized(request)) return response.status(process.env.APP_PIN ? 401 : 503).json({ error: process.env.APP_PIN ? 'PIN required.' : 'APP_PIN is not configured.' });

  try {
    const sql = await database();
    if (request.method === 'GET') {
      const records = await sql`SELECT collection, data FROM finance_records ORDER BY updated_at ASC`;
      const data = Object.fromEntries(collections.map(collection => [collection, []]));
      records.forEach(row => { if (data[row.collection]) data[row.collection].push(row.data); });
      return response.status(200).json({ version: 2, data });
    }

    if (request.method === 'PUT') {
      const data = request.body?.data || {};
      for (const collection of collections) {
        for (const record of data[collection] || []) {
          if (!record?.id) continue;
          await sql`INSERT INTO finance_records (id, collection, data, updated_at)
            VALUES (${record.id}, ${collection}, ${JSON.stringify(record)}, ${record.updatedAt || new Date().toISOString()})
            ON CONFLICT (id) DO UPDATE SET
              collection = EXCLUDED.collection,
              data = EXCLUDED.data,
              updated_at = EXCLUDED.updated_at
            WHERE finance_records.updated_at <= EXCLUDED.updated_at`;
        }
      }
      return response.status(200).json({ synced: true });
    }

    return response.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    return response.status(500).json({ error: error.message || 'Database request failed.' });
  }
}
