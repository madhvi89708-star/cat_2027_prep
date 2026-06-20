import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { google } from "googleapis";
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || "cat-prep-secret-key";

// --- Google Sheets Configuration ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const MOCK_SPREADSHEET_ID = process.env.MOCK_SPREADSHEET_ID;
const GOOGLE_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

const auth = new google.auth.JWT({
  email: GOOGLE_EMAIL,
  key: GOOGLE_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// Log configuration status on startup
if (SPREADSHEET_ID && GOOGLE_EMAIL && GOOGLE_KEY) {
  console.log("✅ Google Sheets credentials detected.");
  console.log(`- Spreadsheet ID: ${SPREADSHEET_ID}`);
  console.log(`- Service Account: ${GOOGLE_EMAIL}`);
  
  // Attempt a test read
  fetchSheetData("Students").then(data => {
    if (data) {
      console.log("🚀 Connection Test: SUCCESS. Can read 'Students' sheet.");
    } else {
      console.warn("⚠️ Connection Test: FAILED. Check backend logs for specific errors above.");
    }
  });
} else {
  console.warn("⚠️ Google Sheets NOT fully configured. Checking missing keys:");
  if (!SPREADSHEET_ID) console.warn("  - Missing SPREADSHEET_ID");
  if (!GOOGLE_EMAIL) console.warn("  - Missing GOOGLE_SERVICE_ACCOUNT_EMAIL");
  if (!GOOGLE_KEY) console.warn("  - Missing GOOGLE_PRIVATE_KEY");
}
if (MOCK_SPREADSHEET_ID) {
  console.log(`- Mock Test Spreadsheet ID: ${MOCK_SPREADSHEET_ID}`);
} else {
  console.warn("⚠️ MOCK_SPREADSHEET_ID not set — Mock Test feature will use local fallback only.");
}
 
/**
 * Maps sheet names to column structures for automated serialization
 */
const SHEET_CONFIG: Record<string, string[]> = {
  Students: ["id", "email", "password", "name", "phone", "registrationDate", "status", "role"],
  CourseMaterials: ["id", "topicName", "section", "googleSheetLink", "googleDriveLink", "description", "dateAdded"],
  VideoLectures: ["id", "topicName", "section", "googleSheetLink", "googleDriveLink", "duration", "instructorName", "dateUploaded"],
  UnverifiedQuestions: ["id", "section", "questionText", "options", "correctAnswer", "explanation", "difficulty"],
  ApprovedQuestions: ["id", "section", "questionText", "options", "correctAnswer", "explanation", "difficulty", "approvedDate"],
  DailyTests: ["id", "testDate", "questionIds"],
  TestResults: ["id", "studentId", "testDate", "testId", "totalScore", "correctAnswers", "wrongAnswers", "skippedQuestions", "timeSpent", "sectionScores", "studentAnswers"],
   SectionalTests:   ["id", "name", "section", "durationMinutes", "questionIds", "passageIds", "targetExam", "publishedDate"],
  SectionalQuestions: ["id", "section", "questionText", "questionType", "options", "correctAnswer", "answerTolerance", "explanation", "difficulty", "passageId", "targetExam"],
  SectionalPassages:  ["id", "title", "text", "targetExam"],
  SectionalResults:   ["id", "studentId", "testId", "section", "totalScore", "correctAnswers", "wrongAnswers", "wrongTITA", "skippedQuestions", "timeSpent", "studentAnswers", "scaledScore", "submittedAt"],
   MockTests:      ["id", "name", "totalDurationMinutes", "sectionDurationMinutes", "questionIds", "passageIds", "targetExam", "publishedDate", "studentsAttempted"],
  MockQuestions:  ["id", "section", "questionText", "questionType", "options", "correctAnswer", "answerTolerance", "explanation", "difficulty", "passageId", "targetExam"],
  MockPassages:   ["id", "title", "text", "targetExam"],
  MockResults:    ["id", "studentId", "testId", "totalScore", "overallScaledScore", "percentile", "sectionResults", "studentAnswers", "timeSpent", "submittedAt"],
  Announcements: ["id", "title", "content", "createdDate", "createdBy"]
  
};

/**
 * Utility to fetch data from a Google Sheet
 * Robust version: uses row 1 as headers to map data correctly regardless of column order
 */
async function fetchSheetData(range: string, spreadsheetId: string | undefined = SPREADSHEET_ID) {
  if (!spreadsheetId || !GOOGLE_EMAIL || !GOOGLE_KEY) {
    console.log(`Skipping Sheet read for [${range}]: Google Sheets not configured for this spreadsheet.`);
    return null;
  }
 
  try {
    console.log(`Fetching data from sheet: ${range} (spreadsheet: ${spreadsheetId})...`);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${range}!A1:Z`,
    });
 
    const allRows = response.data.values || [];
    if (allRows.length < 2) {
      console.log(`Sheet [${range}] is empty or only has headers.`);
      return [];
    }
 
    const headers = allRows[0].map((h: string) => h.toLowerCase().trim());
    const dataRows = allRows.slice(1);
    const expectedKeys = SHEET_CONFIG[range];
 
    console.log(`✅ Mapping ${dataRows.length} rows from ${range} using headers: [${headers.join(", ")}]`);
 
    const jsonFields = ["options", "questionIds", "passageIds", "sectionScores", "studentAnswers", "sectionResults"];
    const numericFields = ["answerTolerance"];
 
    return dataRows.map(row => {
      const obj: any = {};
      expectedKeys.forEach(key => {
        const index = headers.indexOf(key.toLowerCase());
        if (index !== -1) {
          let val = row[index] || "";
          if (jsonFields.includes(key)) {
            if (typeof val === "string" && (val.startsWith("[") || val.startsWith("{"))) {
              try { val = JSON.parse(val); } catch (e) { val = []; }
            } else if (val === "") {
              val = [];
            }
          } else if (numericFields.includes(key) && val !== "") {
            const n = Number(val);
            val = isNaN(n) ? undefined : n;
          }
          obj[key] = val;
        } else {
          obj[key] = jsonFields.includes(key) ? [] : "";
        }
      });
      return obj;
    });
  } catch (err: any) {
    console.error(`❌ Error fetching sheet ${range} (spreadsheet ${spreadsheetId}):`, err.message);
    return null;
  }
}
/**
 * Utility to append data to a Google Sheet
 * Header-aware: writes to columns based on the header row names
 */
async function appendSheetData(range: string, data: any, spreadsheetId: string | undefined = SPREADSHEET_ID) {
  if (!spreadsheetId || !GOOGLE_EMAIL || !GOOGLE_KEY) {
    console.log(`Skipping Sheet append for [${range}]: Google Sheets not configured for this spreadsheet.`);
    return;
  }
 
  try {
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${range}!A1:Z1`,
    });
 
    const headers = (headerRes.data.values?.[0] || []).map((h: string) => h.toLowerCase().trim());
 
    if (headers.length === 0) {
      console.warn(`⚠️ Sheet [${range}] appears to have no headers. Appending in default order.`);
      const keys = SHEET_CONFIG[range];
      const row = keys.map(key => {
        let val = data[key];
        if (typeof val === "object") val = JSON.stringify(val);
        return val || "";
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${range}!A:A`,
        valueInputOption: "RAW",
        requestBody: { values: [row] },
      });
      return;
    }
 
    const expectedKeys = SHEET_CONFIG[range];
    const row = headers.map(header => {
      const key = expectedKeys.find(k => k.toLowerCase() === header);
      if (!key) return "";
      let val = data[key];
      if (typeof val === "object") val = JSON.stringify(val);
      return val || "";
    });
 
    console.log(`Attempting to append row to sheet: ${range} (spreadsheet ${spreadsheetId})...`);
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${range}!A:A`,
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
    console.log(`✅ Successfully appended to ${range}. Updated Cells: ${res.data.updates?.updatedCells}`);
  } catch (err: any) {
    console.error(`❌ FAILED to append to sheet [${range}] (spreadsheet ${spreadsheetId}): ${err.message}`);
  }
}
// Simple JSON-based storage for local fallback
const DB_PATH = path.join(__dirname, "db.json");

interface DB {
  students: any[];
  courseMaterials: any[];
  videoLectures: any[];
  unverifiedQuestions: any[];
  approvedQuestions: any[];
  dailyTests: any[];
  testResults: any[];
  assignedTests: any[];
  announcements: any[];
  sectionalTests: any[];
sectionalQuestions: any[];
sectionalPassages: any[];
sectionalResults: any[];
  mockTests: any[];
mockQuestions: any[];
mockPassages: any[];
mockResults: any[];
}

const initialDB: DB = {
  students: [
    {
      id: "S001",
      email: "student@example.com",
      password: bcrypt.hashSync("password123", 10),
      name: "Demo Student",
      phone: "1234567890",
      registrationDate: new Date().toISOString(),
      status: "Active",
      role: "student"
    },
    {
      id: "A001",
      email: "admin@example.com",
      password: bcrypt.hashSync("admin123", 10),
      name: "Admin User",
      phone: "0987654321",
      registrationDate: new Date().toISOString(),
      status: "Active",
      role: "admin"
    }
  ],
  courseMaterials: [
    {
      id: "CM001",
      topicName: "Number Systems",
      section: "Quantitative",
      googleSheetLink: "#",
      googleDriveLink: "#",
      description: "Basics of Number Systems for CAT.",
      dateAdded: new Date().toISOString()
    }
  ],
  videoLectures: [
    {
      id: "VL001",
      topicName: "Arithmetic Basics",
      section: "Quantitative",
      googleSheetLink: "#",
      googleDriveLink: "#",
      duration: 45,
      instructorName: "Expert Tutor",
      dateUploaded: new Date().toISOString()
    }
  ],
  unverifiedQuestions: [],
  approvedQuestions: [],
  dailyTests: [],
  testResults: [],
  assignedTests: [],
  sectionalTests: [],
sectionalQuestions: [],
sectionalPassages: [],
sectionalResults: [],
  mockTests: [],
mockQuestions: [],
mockPassages: [],
mockResults: [],
  announcements: [
    {
      id: "AN001",
      title: "Welcome to CAT Prep Pro",
      content: "Good luck with your preparation!",
      createdDate: new Date().toISOString(),
      createdBy: "Admin"
    }
  ]
};

function getLocalDB(): DB {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(initialDB, null, 2));
    return initialDB;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveLocalDB(db: DB) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // Auth Middleware
  const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) return res.sendStatus(403);
      req.user = user;
      next();
    });
  };
// Gemini AI Proxy Route
  app.post("/api/chat", authenticateToken, async (req: any, res) => {
    try {
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
      res.json({ reply: result.response.text() });
    } catch (err: any) {
      console.error("Gemini API error:", err.message);
      res.status(500).json({ error: "AI request failed" });
    }
  });
  app.post("/api/generate-questions", authenticateToken, async (req: any, res) => {
  if (req.user.role !== 'admin') return res.sendStatus(403);
  
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    
    const prompt = `Generate 20 MCQ questions for CAT exam preparation.
    Distribution:
    - 7 Quantitative Aptitude (Medium-Hard difficulty)
    - 7 DILR (Data Interpretation & Logical Reasoning)
    - 6 VARC (Verbal Ability & Reading Comprehension)
    Return exactly 20 questions in JSON format.
    Each question must have:
    - section: "Quantitative" | "DILR" | "VARC"
    - questionText: string
    - options: string[] (exactly 4)
    - correctAnswer: string (one of the options)
    - explanation: string
    - difficulty: "Medium" | "Hard"`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              section: { type: Type.STRING },
              questionText: { type: Type.STRING },
              options: { type: Type.ARRAY, items: { type: Type.STRING } },
              correctAnswer: { type: Type.STRING },
              explanation: { type: Type.STRING },
              difficulty: { type: Type.STRING }
            },
            required: ["section", "questionText", "options", "correctAnswer", "explanation", "difficulty"]
          }
        }
      }
    });

    const questions = JSON.parse(response.text);
    res.json(questions);
  } catch (err: any) {
    console.error("Gemini error:", err.message);
    res.status(500).json({ error: "Failed to generate questions" });
  }
});
  // API Routes
  app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;
    
    let students = await fetchSheetData("Students");
    
    // Fallback to local DB if sheet fetch failed OR is empty (common for new setups)
    if (!students || students.length === 0) {
      console.log("Using local Students database (Sheet was empty or fetch failed).");
      students = getLocalDB().students;
    }

    const user = students.find(s => s.email === email);

    if (!user) {
      console.warn(`Login attempt for non-existent user: ${email}`);
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Robust password matching: support both bcrypt hashes and plaintext (for easy sheet editing)
    let isMatch = false;
    try {
      if (user.password.startsWith("$2a$") || user.password.startsWith("$2b$")) {
        isMatch = bcrypt.compareSync(password, user.password);
      } else {
        isMatch = password === user.password;
      }
    } catch (e) {
      isMatch = password === user.password;
    }

    if (isMatch) {
      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role, name: user.name }, 
        JWT_SECRET, 
        { expiresIn: '24h' }
      );
      res.json({ 
        token, 
        user: { id: user.id, email: user.email, role: user.role, name: user.name } 
      });
    } else {
      console.warn(`Login failed: Incorrect password for ${email}`);
      res.status(401).json({ message: "Invalid email or password" });
    }
  });

  app.get("/api/profile", authenticateToken, async (req: any, res) => {
    const students = await fetchSheetData("Students") || getLocalDB().students;
    const user = students.find(s => s.id === req.user.id);
    if (user) {
      const { password, ...userWithoutPassword } = user;
      res.json(userWithoutPassword);
    } else {
      res.status(404).json({ message: "User not found" });
    }
  });

  app.get("/api/course-materials", authenticateToken, async (req, res) => {
    res.json(await fetchSheetData("CourseMaterials") || getLocalDB().courseMaterials);
  });

  app.get("/api/video-lectures", authenticateToken, async (req, res) => {
    res.json(await fetchSheetData("VideoLectures") || getLocalDB().videoLectures);
  });

  app.post("/api/course-materials", authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    await appendSheetData("CourseMaterials", req.body);
    
    // Update local for immediate feedback
    const db = getLocalDB();
    db.courseMaterials.push(req.body);
    saveLocalDB(db);
    
    res.json({ success: true });
  });

  app.post("/api/video-lectures", authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    await appendSheetData("VideoLectures", req.body);
    
    // Update local for immediate feedback
    const db = getLocalDB();
    db.videoLectures.push(req.body);
    saveLocalDB(db);
    
    res.json({ success: true });
  });

  app.get("/api/announcements", authenticateToken, async (req, res) => {
    res.json(await fetchSheetData("Announcements") || getLocalDB().announcements);
  });

  app.post("/api/daily-test/publish", authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { testDate, questionIds } = req.body; // testDate format: YYYY-MM-DD
    
    if (!testDate || !questionIds || !Array.isArray(questionIds) || questionIds.length === 0) {
      return res.status(400).json({ message: "Invalid test data" });
    }

    const testId = `DT${Date.now()}`;
    const newTest = { id: testId, testDate, questionIds };
    
    await appendSheetData("DailyTests", newTest);
    
    // Sync local 
    const db = getLocalDB();
    db.dailyTests.push(newTest);
    saveLocalDB(db);
    
    res.json({ success: true, testId });
  });

  // Question Management
  app.get("/api/unverified-questions", authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    res.json(await fetchSheetData("UnverifiedQuestions") || getLocalDB().unverifiedQuestions);
  });

  app.get("/api/approved-questions", authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    res.json(await fetchSheetData("ApprovedQuestions") || getLocalDB().approvedQuestions);
  });

  app.post("/api/questions/verify", authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { questionIds, action } = req.body;
    
    // For verification, we still use local DB for logic then sync if needed, 
    // but here is a simple implementation:
    const unverified = await fetchSheetData("UnverifiedQuestions") || getLocalDB().unverifiedQuestions;
    
    if (action === 'approve') {
      const approved = unverified.filter(q => questionIds.includes(q.id));
      for (const q of approved) {
        await appendSheetData("ApprovedQuestions", { ...q, approvedDate: new Date().toISOString() });
      }
    }
    
    // Note: Deleting from Sheets is complex (requires batchUpdate). 
    // For now, we update local fallback.
    const db = getLocalDB();
    db.unverifiedQuestions = db.unverifiedQuestions.filter(q => !questionIds.includes(q.id));
    saveLocalDB(db);
    
    res.json({ success: true });
  });

  app.post("/api/questions/save-unverified", authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { questions } = req.body;
    
    for (const q of questions) {
      const newQ = { ...q, id: `UQ${Date.now()}${Math.random().toString(36).substr(2, 5)}` };
      await appendSheetData("UnverifiedQuestions", newQ);
      
      // Fallback update
      const db = getLocalDB();
      db.unverifiedQuestions.push(newQ);
      saveLocalDB(db);
    }
    
    res.json({ success: true });
  });

  app.get("/api/daily-tests", authenticateToken, async (req, res) => {
    const dailyTests = await fetchSheetData("DailyTests") || getLocalDB().dailyTests;
    // Return all tests sorted by date (latest first)
    const sortedTests = [...dailyTests].sort((a, b) => b.testDate.localeCompare(a.testDate));
    res.json(sortedTests);
  });

  app.get("/api/daily-test/:id", authenticateToken, async (req, res) => {
    const { id } = req.params;
    const dailyTests = await fetchSheetData("DailyTests") || getLocalDB().dailyTests;
    const test = dailyTests.find(t => t.id === id);
    
    if (test) {
      const approved = await fetchSheetData("ApprovedQuestions") || getLocalDB().approvedQuestions;
      const questions = approved.filter(q => test.questionIds.includes(q.id));
      res.json({ ...test, questions });
    } else {
      res.status(404).json({ message: "Test not found." });
    }
  });

  app.get("/api/daily-test", authenticateToken, async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const dailyTests = await fetchSheetData("DailyTests") || getLocalDB().dailyTests;
    const test = dailyTests.find(t => t.testDate === today);
    
    if (test) {
      const approved = await fetchSheetData("ApprovedQuestions") || getLocalDB().approvedQuestions;
      const questions = approved.filter(q => test.questionIds.includes(q.id));
      res.json({ ...test, questions });
    } else {
      res.status(404).json({ message: "No test available for today." });
    }
  });

  app.post("/api/test-results", authenticateToken, async (req: any, res) => {
    const { testId } = req.body;

    // Check for existing attempt
    const allResults = await fetchSheetData("TestResults") || getLocalDB().testResults;
    const existingResult = allResults.find(r => r.studentId === req.user.id && r.testId === testId);

    if (existingResult) {
      return res.status(400).json({ message: "You have already attempted this test." });
    }

    const result = {
      ...req.body,
      id: `TR${Date.now()}`,
      studentId: req.user.id,
      testDate: new Date().toISOString()
    };
    
    await appendSheetData("TestResults", result);
    
    const db = getLocalDB();
    db.testResults.push(result);
    saveLocalDB(db);
    
    res.json(result);
  });
app.get("/api/sectional-tests", authenticateToken, async (req: any, res) => {
  try {
    let tests = await fetchSheetData("SectionalTests") || getLocalDB().sectionalTests;
 
    // Students only see tests matching their exam (or "ALL")
 
    // Attach question count without sending full questions
    const questions =
      await fetchSheetData("SectionalQuestions") || getLocalDB().sectionalQuestions;
 
    const enriched = tests.map((t: any) => {
      const qIds: string[] = Array.isArray(t.questionIds) ? t.questionIds : [];
      return {
        ...t,
        questions: questions
          .filter((q: any) => qIds.includes(q.id))
          .map((q: any) => ({ id: q.id, section: q.section })), // minimal for list view
      };
    });
 
    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ message: "Failed to load sectional tests" });
  }
});
 // ─── GET /api/mock-tests  ── list of mock tests for this student's exam ──────
app.get("/api/mock-tests", authenticateToken, async (req: any, res) => {
  try {
    let tests =
      (await fetchSheetData("MockTests", MOCK_SPREADSHEET_ID)) || getLocalDB().mockTests;
 
 
    const questions =
      (await fetchSheetData("MockQuestions", MOCK_SPREADSHEET_ID)) || getLocalDB().mockQuestions;
 
    const enriched = tests.map((t: any) => {
      const qIds: string[] = Array.isArray(t.questionIds) ? t.questionIds : [];
      return {
        ...t,
        studentsAttempted: Number(t.studentsAttempted),
        questions: questions
          .filter((q: any) => qIds.includes(q.id))
          .map((q: any) => ({ id: q.id, section: q.section })), // minimal for list view
      };
    });
 
    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ message: "Failed to load mock tests" });
  }
});
 
// ─── GET /api/mock-test/:id  ── full test with all questions + passages ──────
app.get("/api/mock-test/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const tests =
      (await fetchSheetData("MockTests", MOCK_SPREADSHEET_ID)) || getLocalDB().mockTests;
    const test = tests.find((t: any) => t.id === id);
 
    if (!test) return res.status(404).json({ message: "Mock test not found" });
 
    const allQuestions =
      (await fetchSheetData("MockQuestions", MOCK_SPREADSHEET_ID)) || getLocalDB().mockQuestions;
    const allPassages =
      (await fetchSheetData("MockPassages", MOCK_SPREADSHEET_ID)) || getLocalDB().mockPassages;
 
    const qIds: string[] = Array.isArray(test.questionIds) ? test.questionIds : [];
    const pIds: string[] = Array.isArray(test.passageIds) ? test.passageIds : [];
 
    const questions = allQuestions.filter((q: any) => qIds.includes(q.id));
    const passages = allPassages.filter((p: any) => pIds.includes(p.id));
 
    res.json({ ...test, questions, passages });
  } catch (err: any) {
    res.status(500).json({ message: "Failed to load mock test" });
  }
});
 
// ─── GET /api/mock-results  ── this student's past mock attempts ─────────────
app.get("/api/mock-results", authenticateToken, async (req: any, res) => {
  try {
    const results =
      (await fetchSheetData("MockResults", MOCK_SPREADSHEET_ID)) || getLocalDB().mockResults;
    res.json(results.filter((r: any) => r.studentId === req.user.id));
  } catch (err: any) {
    res.status(500).json({ message: "Failed to load mock results" });
  }
});
 
// ─── POST /api/mock-results  ── save a completed mock attempt ────────────────
app.post("/api/mock-results", authenticateToken, async (req: any, res) => {
  try {
    const { testId } = req.body;
 
    const allResults =
      (await fetchSheetData("MockResults", MOCK_SPREADSHEET_ID)) || getLocalDB().mockResults;
    const existing = allResults.find(
      (r: any) => r.studentId === req.user.id && r.testId === testId
    );
    if (existing) {
      return res.status(400).json({ message: "Already attempted this mock test." });
    }
 
    const result = {
      ...req.body,
      id: `MR${Date.now()}`,
      studentId: req.user.id,
      submittedAt: new Date().toISOString(),
    };
 
    await appendSheetData("MockResults", result, MOCK_SPREADSHEET_ID);
 
    const db = getLocalDB();
    db.mockResults.push(result);
    saveLocalDB(db);
 
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: "Failed to save mock result" });
  }
});
 
// ─── Admin: POST /api/mock-tests  ── publish a new full-length mock test ─────
app.post("/api/mock-tests", authenticateToken, async (req: any, res) => {
  if (req.user.role !== "admin") return res.sendStatus(403);
  try {
    const {
      name,
      totalDurationMinutes,
      sectionDurationMinutes,
      questionIds,
      passageIds,
      targetExam,
    } = req.body;
 
    if (!name || !questionIds?.length) {
      return res.status(400).json({ message: "name and questionIds are required" });
    }
 
    const newTest = {
      id: `MT${Date.now()}`,
      name,
      totalDurationMinutes: totalDurationMinutes || 120,
      sectionDurationMinutes: sectionDurationMinutes || 40,
      questionIds,
      passageIds: passageIds || [],
      targetExam: targetExam || "CAT",
      publishedDate: new Date().toISOString(),
    };
 
    await appendSheetData("MockTests", newTest, MOCK_SPREADSHEET_ID);
 
    const db = getLocalDB();
    db.mockTests.push(newTest);
    saveLocalDB(db);
 
    res.json({ success: true, testId: newTest.id });
  } catch (err: any) {
    res.status(500).json({ message: "Failed to publish mock test" });
  }
});
 
// ─── Admin: POST /api/mock-questions  ── add questions ────────────────────────
app.post("/api/mock-questions", authenticateToken, async (req: any, res) => {
  if (req.user.role !== "admin") return res.sendStatus(403);
  try {
    const questions: any[] = req.body.questions;
    for (const q of questions) {
      const newQ = {
        ...q,
        id: q.id || `MQ${Date.now()}${Math.random().toString(36).substr(2, 4)}`,
        questionType: q.questionType === "TITA" ? "TITA" : "MCQ",
        options: q.questionType === "TITA" ? [] : (q.options || []),
      };
      await appendSheetData("MockQuestions", newQ, MOCK_SPREADSHEET_ID);
      const db = getLocalDB();
      db.mockQuestions.push(newQ);
      saveLocalDB(db);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ message: "Failed to add mock questions" });
  }
});
 
// ─── Admin: POST /api/mock-passages  ── add RC passages ───────────────────────
app.post("/api/mock-passages", authenticateToken, async (req: any, res) => {
  if (req.user.role !== "admin") return res.sendStatus(403);
  try {
    const passage = { ...req.body, id: req.body.id || `MP${Date.now()}` };
    await appendSheetData("MockPassages", passage, MOCK_SPREADSHEET_ID);
    const db = getLocalDB();
    db.mockPassages.push(passage);
    saveLocalDB(db);
    res.json({ success: true, passageId: passage.id });
  } catch (err: any) {
    res.status(500).json({ message: "Failed to add mock passage" });
  }
});
 
// ─── Admin: GET /api/mock-questions  ── list all mock questions ───────────────
app.get("/api/mock-questions", authenticateToken, async (req: any, res) => {
  if (req.user.role !== "admin") return res.sendStatus(403);
  const questions =
    (await fetchSheetData("MockQuestions", MOCK_SPREADSHEET_ID)) || getLocalDB().mockQuestions;
  res.json(questions);
});
// ─── GET /api/sectional-test/:id  ── full test with questions + passages ─────
app.get("/api/sectional-test/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const tests =
      await fetchSheetData("SectionalTests") || getLocalDB().sectionalTests;
    const test = tests.find((t: any) => t.id === id);
 
    if (!test) return res.status(404).json({ message: "Test not found" });
 
    const allQuestions =
      await fetchSheetData("SectionalQuestions") || getLocalDB().sectionalQuestions;
    const allPassages =
      await fetchSheetData("SectionalPassages") || getLocalDB().sectionalPassages;
 
    const qIds: string[] = Array.isArray(test.questionIds) ? test.questionIds : [];
    const pIds: string[] = Array.isArray(test.passageIds) ? test.passageIds : [];
 
    const questions = allQuestions.filter((q: any) => qIds.includes(q.id));
    const passages = allPassages.filter((p: any) => pIds.includes(p.id));
 
    res.json({ ...test, questions, passages });
  } catch (err: any) {
    res.status(500).json({ message: "Failed to load test" });
  }
});
 
// ─── GET /api/sectional-results  ── this student's past results ──────────────
app.get("/api/sectional-results", authenticateToken, async (req: any, res) => {
  try {
    const results =
      await fetchSheetData("SectionalResults") || getLocalDB().sectionalResults;
    res.json(results.filter((r: any) => r.studentId === req.user.id));
  } catch (err: any) {
    res.status(500).json({ message: "Failed to load results" });
  }
});
 
// ─── POST /api/sectional-results  ── save a new result ───────────────────────
app.post("/api/sectional-results", authenticateToken, async (req: any, res) => {
  try {
    const { testId } = req.body;
 
    // Prevent double submission
    const allResults =
      await fetchSheetData("SectionalResults") || getLocalDB().sectionalResults;
    const existing = allResults.find(
      (r: any) => r.studentId === req.user.id && r.testId === testId
    );
    if (existing) {
      return res.status(400).json({ message: "Already attempted this test." });
    }
 
    const result = {
      ...req.body,
      id: `SR${Date.now()}`,
      studentId: req.user.id,
      submittedAt: new Date().toISOString(),
    };
 
    await appendSheetData("SectionalResults", result);
 
    const db = getLocalDB();
    db.sectionalResults.push(result);
    saveLocalDB(db);
 
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: "Failed to save result" });
  }
});
 
// ─── Admin: POST /api/sectional-tests  ── publish a new sectional test ───────
app.post("/api/sectional-tests", authenticateToken, async (req: any, res) => {
  if (req.user.role !== "admin") return res.sendStatus(403);
  try {
    const { name, section, durationMinutes, questionIds, passageIds, targetExam } = req.body;
 
    if (!name || !section || !questionIds?.length) {
      return res.status(400).json({ message: "name, section, and questionIds are required" });
    }
 
    const newTest = {
      id: `ST${Date.now()}`,
      name,
      section,
      durationMinutes: durationMinutes || 40,
      questionIds,
      passageIds: passageIds || [],
      targetExam: targetExam || "CAT",
      publishedDate: new Date().toISOString(),
    };
 
    await appendSheetData("SectionalTests", newTest);
 
    const db = getLocalDB();
    db.sectionalTests.push(newTest);
    saveLocalDB(db);
 
    res.json({ success: true, testId: newTest.id });
  } catch (err: any) {
    res.status(500).json({ message: "Failed to publish test" });
  }
});
 
// ─── Admin: POST /api/sectional-questions  ── add questions ──────────────────
app.post("/api/sectional-questions", authenticateToken, async (req: any, res) => {
  if (req.user.role !== "admin") return res.sendStatus(403);
  try {
    const questions: any[] = req.body.questions;
    for (const q of questions) {
      const newQ = {
        ...q,
        id: q.id || `SQ${Date.now()}${Math.random().toString(36).substr(2, 4)}`,
        questionType: q.questionType === "TITA" ? "TITA" : "MCQ",
        options: q.questionType === "TITA" ? [] : (q.options || []),
      };
      await appendSheetData("SectionalQuestions", newQ);
      const db = getLocalDB();
      db.sectionalQuestions.push(newQ);
      saveLocalDB(db);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ message: "Failed to add questions" });
  }
});
 
// ─── Admin: POST /api/sectional-passages  ── add RC passages ─────────────────
app.post("/api/sectional-passages", authenticateToken, async (req: any, res) => {
  if (req.user.role !== "admin") return res.sendStatus(403);
  try {
    const passage = {
      ...req.body,
      id: req.body.id || `SP${Date.now()}`,
    };
    await appendSheetData("SectionalPassages", passage);
    const db = getLocalDB();
    db.sectionalPassages.push(passage);
    saveLocalDB(db);
    res.json({ success: true, passageId: passage.id });
  } catch (err: any) {
    res.status(500).json({ message: "Failed to add passage" });
  }
});
 
// ─── Admin: GET /api/sectional-questions  ── list all questions ───────────────
app.get("/api/sectional-questions", authenticateToken, async (req: any, res) => {
  if (req.user.role !== "admin") return res.sendStatus(403);
  const questions =
    await fetchSheetData("SectionalQuestions") || getLocalDB().sectionalQuestions;
  res.json(questions);
});
  app.get("/api/performance", authenticateToken, async (req: any, res) => {
    const results = await fetchSheetData("TestResults") || getLocalDB().testResults;
    res.json(results.filter(r => r.studentId === req.user.id));
  });

  // Vite middleware for development or fallback
  const isProd = process.env.NODE_ENV === "production";
  const distPath = path.join(process.cwd(), "dist");
  const hasDist = fs.existsSync(distPath);

  if (!isProd || !hasDist) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
