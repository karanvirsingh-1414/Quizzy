require('dotenv').config();
const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  id: String, name: String, filename: String,
  questions: Array, score: Number, createdAt: Date
});
const Session = mongoose.model('Session', SessionSchema);

async function deleteQuiz() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // List all admin quizzes first
  const adminQuizzes = await Session.find({ name: { $regex: /^admin$/i } }, 'id filename createdAt');
  console.log('\n📋 All admin (static) quizzes:');
  adminQuizzes.forEach((q, i) => console.log(`  [${i}] ${q.filename} | ${q.createdAt}`));

  // Delete specifically the Practice_MCQs one
  const result = await Session.deleteMany({
    name: { $regex: /^admin$/i },
    filename: { $regex: /practice/i }
  });

  console.log(`\n✅ Deleted ${result.deletedCount} quiz(es) matching "Practice MCQ"`);
  await mongoose.disconnect();
}

deleteQuiz().catch(console.error);
