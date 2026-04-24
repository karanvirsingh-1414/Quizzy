const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
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

    const prompt = `
      Based on the following extracted PDF text from multiple sources, generate a MAXIMUM of 100 multiple-choice questions. 
      Output STRICTLY as a JSON object with a single key "questions" containing an array of objects.
      Each object must have exactly:
      "question": "question text",
      "options": ["Option 1 text", "Option 2 text", "Option 3 text", "Option 4 text"],
      "correctAnswer": "Option 1 text", // IMPORTANT: Must be the EXACT string of one of the options above.
      "explanation": "short explanation"

      Text to analyze:
      ${combinedText.substring(0, 100000)} // Ensure we stay under context limits
    `;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    let responseText = "";
    let retryCount = 0;
    while (retryCount < 4) {
      try {
        const response = await model.generateContent(prompt);
        responseText = response.response.text();
        break;
      } catch (err) {
        if (err.status === 503 && retryCount < 3) {
          console.log(`503 Server Busy... Auto retrying in 4s (${retryCount+1}/3)`);
          await new Promise(r => setTimeout(r, 4000));
          retryCount++;
        } else {
          throw err;
        }
      }
    }
    
    let parsedResult;
    try {
      parsedResult = JSON.parse(responseText);
    } catch (err) {
      console.error("AI truncated output snippet:", responseText.slice(-150));
      throw new Error("The AI tried to generate too many questions and got cut off (token limit). Please try uploading fewer PDFs together or we can reduce the 100 question limit.");
    }
    
    const sessionId = uuidv4();
    sessions[sessionId] = {
      id: sessionId,
      filename: filenames.join(' + '),
      createdAt: new Date().toLocaleDateString(),
      questions: parsedResult.questions || [],
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
