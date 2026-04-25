require('dotenv').config();
const mongoose = require('mongoose');

const QuizCacheSchema = new mongoose.Schema({
  contentHash: { type: String, required: true, unique: true },
  questions: { type: Array, default: [] }
});
const QuizCache = mongoose.model('QuizCache', QuizCacheSchema);

async function clearCache() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const result = await QuizCache.deleteMany({});
  console.log(`✅ Cleared all ${result.deletedCount} items from QuizCache.`);
  
  await mongoose.disconnect();
}

clearCache().catch(console.error);
