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

// Permanent JSON storage
const dbPath = path.join(__dirname, 'database.json');
let sessions = {};
if (fs.existsSync(dbPath)) {
  try {
    sessions = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (e) {
    console.error('Error reading database.json', e);
  }
}

function saveDB() {
  fs.writeFileSync(dbPath, JSON.stringify(sessions, null, 2));
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'no-key-provided');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Cache directory — stores generated quizzes by PDF content hash
// Added to .gitignore so large files don't get committed
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir);
}

function getContentHash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function getCachedQuiz(hash) {
  const cachePath = path.join(cacheDir, `${hash}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (e) {
      return null;
    }
  }
  return null;
}

function saveToCache(hash, questions) {
  const cachePath = path.join(cacheDir, `${hash}.json`);
  fs.writeFileSync(cachePath, JSON.stringify(questions, null, 2));
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname)
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if(file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

app.post('/start', (req, res) => {
  const name = req.body.name;
  if (!name) return res.redirect('/');
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
    
    // Safety check for API key
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured in .env file.' });
    }

    let combinedText = '';
    let filenames = [];
    for (const file of req.files) {
      const dataBuffer = fs.readFileSync(file.path);
      const data = await pdfParse(dataBuffer);
      combinedText += `\n--- Content from ${file.originalname} ---\n` + data.text;
      filenames.push(file.originalname);
      // Auto-cleanup
      fs.unlinkSync(file.path);
    }

    // Check cache first — same PDF content = instant response, zero API call
    const contentHash = getContentHash(combinedText.substring(0, 50000));
    const cachedQuestions = getCachedQuiz(contentHash);
    if (cachedQuestions) {
      console.log(`[CACHE HIT] Serving quiz from cache for hash: ${contentHash}`);
      const sessionId = uuidv4();
      sessions[sessionId] = {
        id: sessionId,
        filename: filenames.join(' + '),
        createdAt: new Date().toLocaleDateString(),
        questions: cachedQuestions,
        name: req.body.name || 'User',
        score: 0,
        fromCache: true
      };
      saveDB();
      return res.json({ sessionId, fromCache: true });
    }

    console.log(`[API CALL] Generating fresh quiz for hash: ${contentHash}`);
    const prompt = `
      Based on the following extracted PDF text, generate exactly 100 multiple-choice questions.
      Output STRICTLY as a JSON object with a single key "questions" containing an array of objects.
      Each object must have exactly these keys:
      "question": "question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Option A", // IMPORTANT: Must be the EXACT string of one of the options above.
      "explanation": "short explanation"

      Text to analyze:
      ${combinedText.substring(0, 50000)}
    `;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      },
      // Disable thinking for faster response on free tier
      ...({
        generationConfig: {
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    });

    let responseText = "";
    try {
      const response = await model.generateContent(prompt);
      responseText = response.response.text();
    } catch (err) {
      const is429 = err.status === 429 || (err.message && err.message.includes('429'));
      const is503 = err.status === 503 || (err.message && err.message.includes('503'));
      if (is429) {
        throw new Error('⚠️ Server is busy right now. Please wait 30 seconds and try again.');
      }
      if (is503) {
        throw new Error('⚠️ AI service is temporarily unavailable. Please try again in a moment.');
      }
      throw err;
    }
    
    let parsedResult;
    try {
      parsedResult = JSON.parse(responseText);
    } catch (err) {
      console.error("AI truncated output snippet:", responseText.slice(-150));
      throw new Error("Quiz generation was cut off. Try uploading a smaller PDF.");
    }

    const questions = parsedResult.questions || [];

    // Save to cache so next upload of same PDF is instant
    saveToCache(contentHash, questions);
    console.log(`[CACHE SAVED] ${questions.length} questions cached for hash: ${contentHash}`);
    
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

    res.json({ sessionId });
  } catch (error) {
    console.error('Quiz Generation Error Details:', error);
    
    if (req.files) {
      req.files.forEach(f => {
        try { fs.unlinkSync(f.path); } catch(e){}
      });
    }

    res.status(500).json({ error: error.message || 'Unknown error occurred during generation.' });
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
  
  res.render('result', {
    score: req.query.score || 0,
    total: req.query.total !== undefined ? req.query.total : session.questions.length,
    name: req.query.user || session.name
  });
});

app.listen(port, () => {
  console.log(`✅ Quiz Server running at http://localhost:${port}`);
});
