import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME;

if (!uri) {
  throw new Error("MONGO_URI is not set in environment");
}

const client = new MongoClient(uri);
let dbInstance;

export async function connectDB() {
  if (!dbInstance) {
    await client.connect();
    dbInstance = client.db(dbName); // 👈 use DB_NAME from .env
    console.log("Connected to MongoDB →", dbName);
  }
  return dbInstance;
}

export let db;

const init = async () => {
  db = await connectDB();
};

await init();
