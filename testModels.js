const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const modelsToTry = [
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-pro",
    "gemini-1.0-pro"
  ];

  for (const modelName of modelsToTry) {
    try {
      console.log(`Trying ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent("Say 'hi'");
      console.log(`\n✅ SUCCESS with ${modelName}`);
      return; 
    } catch (e) {
      console.log(`❌ Failed ${modelName}`);
      if (e.message.includes("429")) {
         console.log("   Reason: RATE LIMIT EXCEEDED (429)");
      } else {
         console.log("   Reason:", e.message.split('\n')[0]);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}
run();
