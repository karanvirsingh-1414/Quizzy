const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// ─── MongoDB Connection & Models ───────────────────────────────────────────────
const mongoURI = process.env.MONGODB_URI;

if (!mongoURI) {
  console.error("❌ CRITICAL: MONGODB_URI is not defined in .env file.");
  console.error("Please add MONGODB_URI to your .env file or Render environment variables.");
} else {
  mongoose.connect(mongoURI, { serverSelectionTimeoutMS: 5000 })
    .then(() => console.log("✅ Successfully connected to MongoDB!"))
    .catch(err => console.error("❌ MongoDB connection error:", err));
}

// Model: Quiz Cache for avoiding re-generating the same PDF
const QuizCacheSchema = new mongoose.Schema({
  contentHash: { type: String, required: true, unique: true },
  questions: { type: Array, default: [] }
});
const QuizCache = mongoose.model('QuizCache', QuizCacheSchema);

// Model: User Session & Quiz Instance
const SessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: String,
  filename: String,
  questions: Array,
  score: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', SessionSchema);

// Model: Activity Logs for tracking completely
const ActivityLogSchema = new mongoose.Schema({
  user: String,
  action: String,
  details: String,
  timestamp: { type: Date, default: Date.now }
});
const ActivityLog = mongoose.model('ActivityLog', ActivityLogSchema);

// ─── Activity Logger ───────────────────────────────────────────────────────────
async function logActivity(user, action, details = '') {
  try {
    const timestampLocal = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    console.log(`[${timestampLocal}] USER: ${user} | ACTION: ${action} | DETAILS: ${details}`);
    
    if (mongoose.connection.readyState === 1) { // 1 = connected
      await ActivityLog.create({ user, action, details });
    }
  } catch (err) {
    console.error("Failed to save log to MongoDB:", err.message);
  }
}

function getContentHash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// ─── Gemini Setup ──────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'no-key-provided');
let isGenerating = false;

// ─── Express Setup ─────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

// ─── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.render('index'));

app.post('/start', async (req, res) => {
  const name = req.body.name;
  if (!name) return res.redirect('/');
  await logActivity(name, 'Logged In');
  res.redirect(`/dashboard/${encodeURIComponent(name)}`);
});

app.get('/dashboard/:name', async (req, res) => {
  try {
    const name = req.params.name;
    const userSessions = await Session.find({ name }).sort({ createdAt: -1 });
    // Regex for case insensitive admin
    const globalQuizzes = await Session.find({ name: { $regex: /^admin$/i } }).sort({ createdAt: -1 });
    
    const formatSessions = (sessionsList) => sessionsList.map(s => ({
      id: s.id,
      name: s.name,
      filename: s.filename,
      questions: s.questions,
      score: s.score,
      createdAt: s.createdAt.toLocaleDateString()
    }));

    res.render('dashboard', { 
      name, 
      quizzes: formatSessions(userSessions), 
      globalQuizzes: formatSessions(globalQuizzes) 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database error on dashboard loading.");
  }
});

app.post('/api/generate', upload.array('pdf', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured.' });
    }
    if (mongoose.connection.readyState !== 1) {
      return res.status(500).json({ error: 'Database is not connected! Ensure MongoDB URI is configured.' });
    }

    // ── Extract text from PDFs ──
    let combinedText = '';
    let filenames = [];
    for (const file of req.files) {
      const dataBuffer = fs.readFileSync(file.path);
      const data = await pdfParse(dataBuffer);
      combinedText += `\n--- Content from ${file.originalname} ---\n` + data.text;
      filenames.push(file.originalname);
      try { fs.unlinkSync(file.path); } catch (e) {}
    }

    const textSlice = combinedText.substring(0, 50000);
    const contentHash = getContentHash(textSlice);
    const userName = req.body.name || 'User';
    const joinedFilenames = filenames.join(' + ');

    // ── Cache check in MongoDB ──
    const existingCache = await QuizCache.findOne({ contentHash });
    if (existingCache) {
      console.log(`[CACHE HIT] hash: ${contentHash}`);
      const sessionId = uuidv4();
      await Session.create({
        id: sessionId,
        filename: joinedFilenames,
        questions: existingCache.questions,
        name: userName,
        score: 0
      });
      await logActivity(userName, 'Started Quiz (Cache Hit)', joinedFilenames);
      return res.json({ sessionId, fromCache: true });
    }

    // ── Block concurrent generation ──
    if (isGenerating) {
      return res.status(429).json({ error: '⏳ Already generating a quiz. Please wait for it to finish.' });
    }
    isGenerating = true;

    console.log(`[API CALL] Generating 50 questions. Hash: ${contentHash}`);

    const prompt = `
      Based on the following extracted PDF text, generate exactly 50 multiple-choice questions.
      Output STRICTLY as a JSON object with a single key "questions" containing an array of objects.
      Each object must have exactly these keys:
      "question": "question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Option A",
      "explanation": "short explanation"

      IMPORTANT: correctAnswer must be the EXACT string of one of the options.

      Text to analyze:
      ${textSlice}
    `;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-lite',
      generationConfig: { responseMimeType: 'application/json' }
    });

    let responseText = '';
    try {
      const response = await model.generateContent(prompt);
      responseText = response.response.text();
    } catch (err) {
      const is429 = err.status === 429 || (err.message && err.message.includes('429'));
      const is503 = err.status === 503 || (err.message && err.message.includes('503'));
      if (is429) {
        const isDaily = err.message && (err.message.includes('daily') || err.message.includes('quota'));
        if (isDaily) throw new Error('⚠️ Daily API quota exhausted. Please try again tomorrow.');
        throw new Error('⚠️ Too many requests. Please wait 1 minute and try again.');
      }
      if (is503) throw new Error('⚠️ AI service temporarily unavailable. Please try again.');
      throw err;
    } finally {
      isGenerating = false;
    }

    let parsedResult;
    try {
      parsedResult = JSON.parse(responseText);
    } catch (err) {
      throw new Error('Quiz generation was cut off. Try uploading a smaller PDF.');
    }

    const questions = parsedResult.questions || [];

    // ── Save Cache & Session to MongoDB ──
    await QuizCache.create({ contentHash, questions });
    console.log(`[CACHE SAVED] ${questions.length} questions → hash: ${contentHash}`);

    const sessionId = uuidv4();
    await Session.create({
      id: sessionId,
      filename: joinedFilenames,
      questions,
      name: userName,
      score: 0
    });

    await logActivity(userName, 'Generated New Quiz (AI)', joinedFilenames);
    res.json({ sessionId });

  } catch (error) {
    console.error('Quiz Generation Error:', error.message);
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
    res.status(500).json({ error: error.message || 'Unknown error occurred.' });
  }
});

app.get('/quiz/:sessionId', async (req, res) => {
  try {
    const session = await Session.findOne({ id: req.params.sessionId });
    if (!session) return res.redirect('/');
    
    res.render('quiz', {
      sessionId: session.id,
      questions: JSON.stringify(session.questions)
    });
  } catch (err) {
    res.redirect('/');
  }
});

app.get('/result/:sessionId', async (req, res) => {
  try {
    const session = await Session.findOne({ id: req.params.sessionId });
    if (!session) return res.redirect('/');
    
    const score = Number(req.query.score) || 0;
    const total = req.query.total !== undefined ? Number(req.query.total) : session.questions.length;
    const userName = req.query.user || session.name;
    
    // Update score in DB
    session.score = score;
    await session.save();

    await logActivity(userName, 'Completed Quiz', `Score: ${score}/${total} | File: ${session.filename}`);
    
    res.render('result', {
      score: score,
      total: total,
      name: userName
    });
  } catch (err) {
    res.redirect('/');
  }
});

app.get('/admin/logs', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.send('<body style="background:#1a1a2e; color:white; font-family:sans-serif; text-align:center; padding:50px;"><h2>MongoDB not connected.</h2></body>');
    }

    const allLogs = await ActivityLog.find().sort({ timestamp: -1 }); // Newest first
    let logsText = "";

    if (allLogs.length === 0) {
      logsText = "No logs yet.";
    } else {
      logsText = allLogs.map(log => {
        const timeStr = new Date(log.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        return `[${timeStr}] USER: ${log.user} | ACTION: ${log.action} | DETAILS: ${log.details}`;
      }).join('\n');
    }

    res.send(`
      <html>
        <head>
          <title>Activity Logs</title>
          <style>
            body { background: #1a1a2e; color: #00ffcc; font-family: monospace; padding: 20px; }
            pre { white-space: pre-wrap; word-wrap: break-word; font-size: 14px; }
          </style>
        </head>
        <body>
          <h2>Live User Activity Logs (MongoDB Cloud)</h2>
          <hr/>
          <pre>${logsText}</pre>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send("Database error fetching logs.");
  }
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
