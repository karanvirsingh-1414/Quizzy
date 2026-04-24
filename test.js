const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');

dotenv.config();

async function run() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const dataBuffer = fs.readFileSync(path.join(__dirname, 'uploads', '1777038602635-LEGAL APTITUDE.pdf'));
    const data = await pdfParse(dataBuffer);

    const prompt = `Based on the following extracted PDF text, generate a MAXIMUM of 40 multiple-choice questions. 
Output STRICTLY as a JSON object with a single key "questions" containing an array of objects.
Each object must have exactly:
"question": "question text",
"options": ["Option 1 text", "Option 2 text", "Option 3 text", "Option 4 text"],
"correctAnswer": "Option 1 text", // IMPORTANT: Must be the EXACT string of one of the options above.
"explanation": "short explanation"

Text to analyze:
${data.text.substring(0, 50000)}`;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { responseMimeType: "application/json" }
    });

    const response = await model.generateContent(prompt);
    console.log("Success! Result length:", response.response.text().length);
  } catch (error) {
    console.error("\n--- TEST ERROR ---\n");
    console.error(error.message || error);
    if(error.status) console.error("Status:", error.status);
  }
}
run();
