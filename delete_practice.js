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

  const result = await Session.deleteMany({
    name: { $regex: /^admin$/i },
    filename: 'Practice_MCQs.pdf'
  });

  console.log(`✅ Deleted ${result.deletedCount} quiz(es) with filename "Practice_MCQs.pdf"`);
  
  const remaining = await Session.find({ name: { $regex: /^admin$/i } }, 'filename');
  console.log('\nRemaining admin quizzes:');
  remaining.forEach(q => console.log(` - ${q.filename}`));
  
  await mongoose.disconnect();
}

deleteQuiz().catch(console.error);
