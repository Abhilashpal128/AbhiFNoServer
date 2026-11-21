import { MongoClient } from 'mongodb';
let connection;
export async function collection() {
  if (!process.env.MONGODB_URI) throw new Error('Database is not configured');
  if (!connection) {
    const client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 5,
      minPoolSize: 0,
      maxIdleTimeMS: 60000,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      socketTimeoutMS: 15000,
    });
    connection = client.connect().catch(error => {
      connection = undefined;
      throw error;
    });
  }
  const client = await connection;
  // Deterministic _id provides uniqueness without an asynchronous index migration.
  return client
    .db(process.env.MONGODB_DB || 'stocksapp')
    .collection('weekly_reports');
}
