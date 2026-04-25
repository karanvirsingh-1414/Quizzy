const fs = require('fs');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const mongoURI = process.env.MONGODB_URI;

if (!mongoURI) {
  console.error("No MONGODB_URI found in .env");
  process.exit(1);
}

const SessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: String,
  filename: String,
  questions: Array,
  score: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', SessionSchema);

async function migrate() {
  try {
    await mongoose.connect(mongoURI);
    console.log("✅ Connected to MongoDB.");

    if (!fs.existsSync('database.json')) {
      console.log("No database.json file found locally.");
      process.exit(1);
    }
    
    const rawData = fs.readFileSync('database.json', 'utf8');
    let data = JSON.parse(rawData);

    // Support old and new format
    let sessions = data.sessions ? data.sessions : data;

    let count = 0;
    for (const key in sessions) {
      const session = sessions[key];
      // Search for any admin quizzes
      if (session.name && session.name.toLowerCase() === 'admin') {
        const exists = await Session.findOne({ id: session.id });
        if (!exists) {
          // Add to Live MongoDB Database
          await Session.create({
            id: session.id,
            name: session.name,
            filename: session.filename,
            questions: session.questions,
            score: session.score,
            createdAt: session.createdAt ? new Date(session.createdAt) : new Date()
          });
          console.log(`Migrated Admin Quiz: ${session.filename}`);
          count++;
        } else {
          console.log(`Skipped (already exists): ${session.filename}`);
        }
      }
    }

    console.log(`\n🎉 Migration fixed! Total old admin quizzes added back: ${count}`);
    mongoose.connection.close();

  } catch (err) {
    console.error("Error migrating:", err);
    mongoose.connection.close();
  }
}

migrate();
