const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// ─── Persistent Storage (database.json) ───────────────────────────────────────
// Structure: { sessions: {...}, quizCache: {...} }
// quizCache maps content-hash → questions[]
// This persists across Render restarts (unlike a file-system cache folder)
const dbPath = path.join(__dirname, 'database.json');
let db = { sessions: {}, quizCache: {} };

if (fs.existsSync(dbPath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    // Support old format (flat sessions object) and new format
    if (raw.sessions) {
      db = raw;
    } else {
      db.sessions = raw; // migrate old flat format
    }
  } catch (e) {
    console.error('Error reading database.json', e);
  }
}

function saveDB() {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

// ─── Activity Logger ───────────────────────────────────────────────────────────
function logActivity(user, action, details = '') {
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const logEntry = `[${timestamp}] USER: ${user} | ACTION: ${action} | DETAILS: ${details}\n`;
  const logFile = path.join(__dirname, 'activity.log');
  fs.appendFileSync(logFile, logEntry);
  console.log(logEntry.trim());
}

// Convenience aliases
const sessions = db.sessions;
const quizCache = db.quizCache;

function getContentHash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// ─── Gemini Setup ──────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'no-key-provided');

// Prevent concurrent API calls burning quota
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

app.post('/start', (req, res) => {
  const name = req.body.name;
  if (!name) return res.redirect('/');
  logActivity(name, 'Logged In');
  res.redirect(`/dashboard/${encodeURIComponent(name)}`);
});

app.get('/dashboard/:name', (req, res) => {
  const name = req.params.name;
  const userSessions = Object.values(sessions).filter(s => s.name === name);
  const globalQuizzes = Object.values(sessions).filter(s => s.name.toLowerCase() === 'admin');
  res.render('dashboard', { name, quizzes: userSessions, globalQuizzes });
});

app.post('/api/generate', upload.array('pdf', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured.' });
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

    // ── Cache check (stored in database.json — survives Render restarts) ──
    if (quizCache[contentHash]) {
      console.log(`[CACHE HIT] hash: ${contentHash}`);
      const sessionId = uuidv4();
      sessions[sessionId] = {
        id: sessionId,
        filename: filenames.join(' + '),
        createdAt: new Date().toLocaleDateString(),
        questions: quizCache[contentHash],
        name: req.body.name || 'User',
        score: 0,
        fromCache: true
      };
      saveDB();
      logActivity(req.body.name || 'User', 'Started Quiz (Cache Hit)', filenames.join(' + '));
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
      model: 'gemini-2.0-flash-lite',  // 1500 RPD free tier — highest quota
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
        // Check if it's daily limit or per-minute limit
        const isDaily = err.message && (err.message.includes('daily') || err.message.includes('quota'));
        if (isDaily) {
          throw new Error('⚠️ Daily API quota exhausted. Please try again tomorrow, or contact the admin.');
        }
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
      console.error('JSON parse error. Snippet:', responseText.slice(-200));
      throw new Error('Quiz generation was cut off. Try uploading a smaller PDF.');
    }

    const questions = parsedResult.questions || [];

    // ── Save to cache in database.json (persists! ✅) ──
    quizCache[contentHash] = questions;
    console.log(`[CACHE SAVED] ${questions.length} questions → hash: ${contentHash}`);

    const sessionId = uuidv4();
    sessions[sessionId] = {
      id: sessionId,
      filename: filenames.join(' + '),
      createdAt: new Date().toLocaleDateString(),
      questions,
      name: req.body.name || 'User',
      score: 0
    };

    saveDB();
    logActivity(req.body.name || 'User', 'Generated New Quiz (AI)', filenames.join(' + '));
    res.json({ sessionId });

  } catch (error) {
    console.error('Quiz Generation Error:', error.message);
    if (req.files) {
      req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
    }
    res.status(500).json({ error: error.message || 'Unknown error occurred.' });
  }
});

app.get('/quiz/:sessionId', (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.redirect('/');
  res.render('quiz', {
    sessionId: req.params.sessionId,
    questions: JSON.stringify(session.questions)
  });
});

app.get('/result/:sessionId', (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.redirect('/');
  
  const score = req.query.score || 0;
  const total = req.query.total !== undefined ? req.query.total : session.questions.length;
  const userName = req.query.user || session.name;
  
  logActivity(userName, 'Completed Quiz', `Score: ${score}/${total} | File: ${session.filename}`);
  
  res.render('result', {
    score: score,
    total: total,
    name: userName
  });
});

app.get('/admin/logs', (req, res) => {
  const logFile = path.join(__dirname, 'activity.log');
  if (fs.existsSync(logFile)) {
    const logs = fs.readFileSync(logFile, 'utf8');
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
          <h2>Live User Activity Logs</h2>
          <hr/>
          <pre>${logs}</pre>
        </body>
      </html>
    `);
  } else {
    res.send('<body style="background:#1a1a2e; color:white; font-family:sans-serif; text-align:center; padding:50px;"><h2>No activity logs found yet.</h2></body>');
  }
});

app.listen(port, () => {
  console.log(`✅ Quiz Server running at http://localhost:${port}`);
  console.log(`📦 Cache entries loaded: ${Object.keys(quizCache).length}`);
});
