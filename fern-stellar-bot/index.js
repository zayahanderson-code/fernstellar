'use strict';
require('dotenv').config();
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { Resend } = require('resend');
const Anthropic  = require('@anthropic-ai/sdk');
const mongoose   = require('mongoose');
const crypto     = require('crypto');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
// Centralise every magic number and config value here so there is one place
// to change them before the demo or going live.
const CONFIG = Object.freeze({
  PORT:                    process.env.PORT || 3000,
  HOST:                    '0.0.0.0',
  MAX_MESSAGE_LENGTH:      500,
  MAX_FILE_SIZE_BYTES:     10 * 1024 * 1024,          // 10 MB
  ALLOWED_EXTENSIONS:      ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.webp'],
  SESSION_TTL_MS:          60 * 60 * 1000,            // 1 hour idle TTL
  SESSION_CLEANUP_MS:      30 * 60 * 1000,            // run cleanup every 30 min
  MAX_SESSIONS:            10_000,
  CLAUDE_MODEL:            'claude-sonnet-4-20250514',
  CLAUDE_MAX_TOKENS:       200,
  CLAUDE_TIMEOUT_MS:       30_000,
  CALENDLY_LINK:           'https://calendly.com/lhenry-lawfirm',
  FIRM_NAME:               'The Henry Law Firm',
  FIRM_PHONE:              '(407) 205-8576',
  MSECS_PER_DAY:           86_400_000,
  OFF_TOPIC_THRESHOLD:     3,
  POST_INTAKE_MAX:         3,
});

// Words that should never be captured as a first name.
// FIX: prevents "yes", "ok", "sure", "go" etc. from becoming session.firstName
const NON_NAME_WORDS = new Set([
  'yes', 'no', 'ok', 'okay', 'sure', 'help', 'hi', 'hello', 'hey',
  'ready', 'go', 'start', 'stop', 'done', 'great', 'good', 'fine',
  'listo', 'lista', 'si', 'entiendo', 'hola', 'i', 'it',
]);

// FIX: Set for O(1) lookup; removed the duplicated 'ok' entry from the original
const DISCLOSURE_ACCEPTED = new Set([
  'i understand', 'ok', 'okay', 'yes', 'sure', 'got it', 'understood',
  'ready', "let's go", 'lets go', 'go', 'entiendo', 'si', 'sí',
  'listo', 'lista', 'de acuerdo',
]);

// ─── APP SETUP ────────────────────────────────────────────────────────────────
const app = express();

// FIX: body size limit prevents oversized JSON payload attacks
app.use(express.json({ limit: '50kb' }));
app.use(express.static('public'));
app.set('trust proxy', 1); // Required for Railway / reverse proxies

// ─── SECURITY HEADERS ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',    'nosniff');
  res.setHeader('X-Frame-Options',           'DENY');
  res.setHeader('X-XSS-Protection',          '1; mode=block');
  res.setHeader('Referrer-Policy',           'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',        'geolocation=(), microphone=(), camera=()');
  next();
});

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             100,
  message:         { success: false, error: 'Too many requests — please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

const chatLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             20,
  message:         { success: false, error: 'Please slow down — too many messages per minute.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      5,
  message:  { success: false, error: 'Too many uploads — please try again later.' },
});

app.use('/api/', apiLimiter);

// ─── DASHBOARD AUTHENTICATION ─────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'change-this-password';

function requireAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma',        'no-cache');
  res.setHeader('Expires',       '0');

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Ander Dashboard"');
    return res.status(401).send('Authentication required');
  }

  const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf-8');
  // Only split on the first colon — passwords can contain colons
  const colonIndex  = credentials.indexOf(':');
  const username    = credentials.slice(0, colonIndex);
  const password    = credentials.slice(colonIndex + 1);

  // FIX: use timing-safe comparison to prevent timing-attack credential brute-force
  const expected = Buffer.from(DASHBOARD_PASSWORD);
  const provided  = Buffer.from(password);
  const match     = expected.length === provided.length &&
                    crypto.timingSafeEqual(expected, provided);

  // FIX: req.connection is deprecated in Node 13+; use req.socket
  const ip        = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  if (match) {
    console.log(`🔐 LOGIN OK  | ${username} | ${ip} | ${timestamp} | ${req.path}`);
    next();
  } else {
    console.warn(`❌ LOGIN FAIL | ${username} | ${ip} | ${timestamp}`);
    res.setHeader('WWW-Authenticate', 'Basic realm="Ander Dashboard"');
    return res.status(401).send('Invalid credentials');
  }
}

// ─── HTML ESCAPE HELPER ───────────────────────────────────────────────────────
// FIX: all user-supplied values must be escaped before embedding in HTML emails.
// A user who types </td><script>... in their story would break the email layout.
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

// ─── FILE UPLOAD ──────────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'secure-uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename:    (_req, file,  cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits:     { fileSize: CONFIG.MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (CONFIG.ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error('File type not allowed'), false);
  },
});

// ─── MONGODB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS:          45000,
})
  .then(() => console.log('🍃 MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection failed:', err));

mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected'));
mongoose.connection.on('reconnected',  () => console.log('✅ MongoDB reconnected'));
mongoose.connection.on('error',        err => console.error('❌ MongoDB error:', err));

// ─── SCHEMA ───────────────────────────────────────────────────────────────────
const intakeSchema = new mongoose.Schema({
  sessionId:      { type: String,   required: true, unique: true },
  firstName:      { type: String,   default: 'Unknown' },
  email:          { type: String,   default: null },
  phone:          { type: String,   default: null },
  practiceArea:   { type: String,   default: 'General' },
  story:          { type: String,   default: null },
  urgency:        { type: String,   default: 'standard' },
  score:          { type: Number,   default: 0 },
  scoreBreakdown: { type: Object,   default: {} },
  debtAmount:     { type: Number,   default: null },
  debtAmountRaw:  { type: String,   default: null },
  courtDate:      { type: Date,     default: null },
  courtDateRaw:   { type: String,   default: null },
  caseNumber:     { type: String,   default: null },
  county:         { type: String,   default: null },
  hasCourtCase:   { type: Boolean,  default: false },
  hasGarnishment: { type: Boolean,  default: false },
  daysUntilCourt: { type: Number,   default: null },
  sentimentFlags: { type: [String], default: [] },
  documentUrls:   { type: [String], default: [] },
  firmName:       { type: String,   default: CONFIG.FIRM_NAME },
  transcript:     { type: Array,    default: [] },
  notes:          { type: String,   default: '' },
  followUpDate:   { type: Date,     default: null },
  createdAt:      { type: Date,     default: Date.now },
  completedAt:    { type: Date,     default: null },
  status:         { type: String,   default: 'new' },
  language:       { type: String,   default: 'en' },
  crmId:          { type: String,   default: null },
  crmSyncedAt:    { type: Date,     default: null },
  crmProvider:    { type: String,   default: null },
  source:         { type: String,   default: 'widget' },
  referrer:       { type: String,   default: null },
  utmSource:      { type: String,   default: null },
  utmCampaign:    { type: String,   default: null },
});

const Intake = mongoose.model('Intake', intakeSchema);

// ─── SESSION MANAGEMENT ───────────────────────────────────────────────────────
const sessions          = new Map();
const sessionTimestamps = new Map(); // last-active time for TTL cleanup

function getSession(sessionId) {
  sessionTimestamps.set(sessionId, Date.now());

  if (!sessions.has(sessionId)) {
    // Evict oldest 10% when at capacity
    if (sessions.size >= CONFIG.MAX_SESSIONS) {
      console.warn(`⚠️  Session limit reached — evicting oldest 10%`);
      const sorted   = [...sessionTimestamps.entries()].sort((a, b) => a[1] - b[1]);
      const toRemove = Math.floor(CONFIG.MAX_SESSIONS * 0.1);
      sorted.slice(0, toRemove).forEach(([id]) => {
        sessions.delete(id);
        sessionTimestamps.delete(id);
      });
    }

    sessions.set(sessionId, {
      sessionId,
      firstName: null, email: null, phone: null,
      practiceArea: null, story: null, urgency: null,
      debtAmount: null, debtAmountRaw: null,
      courtDate: null, courtDateRaw: null,
      caseNumber: null, county: null,
      hasCourtCase: false, hasGarnishment: false,
      sentimentFlags: [], documentUrls: [],
      intakeComplete: false, offTopicCount: 0,
      postIntakeQuestionCount: 0,
      history: [], language: 'en',
    });
  }

  return sessions.get(sessionId);
}

// Periodic session cleanup
setInterval(() => {
  const cutoff = Date.now() - CONFIG.SESSION_TTL_MS;
  let pruned   = 0;
  for (const [id, ts] of sessionTimestamps.entries()) {
    if (ts < cutoff) {
      sessions.delete(id);
      sessionTimestamps.delete(id);
      pruned++;
    }
  }
  if (pruned > 0) console.log(`🧹 Pruned ${pruned} expired sessions`);
  console.log(`📊 Active sessions: ${sessions.size}/${CONFIG.MAX_SESSIONS}`);
}, CONFIG.SESSION_CLEANUP_MS);

// ─── API CLIENTS ──────────────────────────────────────────────────────────────
const resend    = new Resend(process.env.RESEND_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── SYSTEM PROMPTS ───────────────────────────────────────────────────────────
const FIRM_CONTEXT = `
You are Ander, an AI intake assistant for The Henry Law Firm in Orlando, Florida.

ABOUT THE FIRM:
- Attorney: LaMya Henry — 25 years of legal experience
- Practice focus: Consumer debt defense — helping Floridians regain peace after financial setbacks
- Free consultations available (typically 10 minutes)
- Phone: ${CONFIG.FIRM_PHONE}

WHAT THEY HANDLE:
1. Credit Card Debt — sued for unpaid balances, negotiating or fighting in court
2. Auto Loan Debt & Car Repossession — protecting clients when vehicles are at risk
3. Personal Loans — defending against aggressive collection
4. Medical Bills — negotiating and defending medical debt lawsuits
5. Wage Garnishments — stopping or reducing paycheck garnishments using Florida exemptions
6. Default Judgments — helping clients who missed their court date fight back
7. Judgment Liens — protecting property from creditor claims

KEY LEGAL FACTS (Florida — share as general info, not legal advice):
- The FDCPA prohibits abusive, unfair, or deceptive collection practices
- Collectors who violate the FDCPA may owe up to $1,000 in statutory damages plus attorney fees
- Florida has a 5-year statute of limitations on written contracts like credit cards
- Debt buyers often lack proper documentation — cases can be dismissed on procedural grounds
- Florida's head of household exemption may protect wages from garnishment
- Many debt lawsuits go uncontested — having an attorney dramatically changes outcomes
- NEVER ignore a debt lawsuit summons — a default judgment can be devastating

YOUR PERSONALITY AND RULES:
- Warm, empathetic, conversational — like a calm, knowledgeable friend who cares
- You CAN explain how things generally work — end with "this is general info, not legal advice"
- You are NOT a lawyer and never pretend to be
- React to emotions FIRST — acknowledge feelings before moving forward
- Never list questions back-to-back — one thing at a time with warmth
- Keep responses to 2-3 sentences MAX — this is a chat widget, not an essay
- Zero judgment about debt situations — debt happens to good people
- You've already introduced yourself — do NOT repeat the intro or disclosure
- You're a TEXT assistant — use "I understand", never "I hear you" or "sounds like"
- Do NOT assume emotions before they've shared their situation
- If off-topic, ONE short sentence redirect — warmly
- After 3 consecutive off-topic messages, gracefully close
- When someone has a COURT CASE or GARNISHMENT, ask for the case number and Florida county
`;

const FIRM_CONTEXT_ES = `
Eres Ander, un asistente de admisión de IA para The Henry Law Firm en Orlando, Florida.

SOBRE EL BUFETE:
- Abogada: LaMya Henry — 25 años de experiencia legal
- Enfoque: Defensa de deudas del consumidor
- Consultas gratuitas disponibles (típicamente 10 minutos)
- Teléfono: ${CONFIG.FIRM_PHONE}

LO QUE MANEJAN:
1. Deuda de tarjeta de crédito
2. Deuda de préstamo de auto y reposesión
3. Préstamos personales
4. Facturas médicas
5. Embargos de salario
6. Sentencias por defecto
7. Gravámenes judiciales

TU PERSONALIDAD Y REGLAS:
- Cálido, empático, conversacional
- PUEDES explicar cómo funcionan las cosas — termina con "esta es información general, no asesoría legal"
- NO eres abogado y nunca pretendas serlo
- Reacciona a las emociones PRIMERO
- Respuestas de 2-3 oraciones MÁXIMO
- Cero juicio sobre situaciones de deuda
- Cuando alguien tiene un CASO EN CORTE o EMBARGO, pregunta por el número de caso y condado de Florida
`;

// ─── VALIDATION ───────────────────────────────────────────────────────────────
function validateEmail(email) {
  if (!email || typeof email !== 'string' || email.length > 254) return false;
  if (email.includes('..') || email.startsWith('.') || email.endsWith('.')) return false;
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
}

function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  const fakePatterns = ['0000000000', '1111111111', '1234567890'];
  return !fakePatterns.includes(digits);
}

// ─── PRACTICE AREA CLASSIFICATION ────────────────────────────────────────────
function classifyPracticeArea(text) {
  const t = text.toLowerCase();
  if (/garnish|paycheck|wages|salary/.test(t))                           return 'Wage Garnishment';
  if (/repo|repossess|car|auto|vehicle/.test(t))                         return 'Auto Loan / Repossession';
  if (/medical|hospital|doctor|health/.test(t))                          return 'Medical Bills';
  if (/credit card|creditcard|capital one|discover|chase/.test(t))       return 'Credit Card Debt';
  if (/judgment|default|missed court/.test(t))                           return 'Default Judgment';
  if (/lien|property/.test(t))                                           return 'Judgment Lien';
  if (/debt|collector|collection|lawsuit|sued|summons|court|owe|creditor/.test(t)) return 'Debt Collection Defense';
  if (/personal loan|loan/.test(t))                                      return 'Personal Loan';
  return 'General';
}

// ─── DEBT AMOUNT NORMALIZATION ────────────────────────────────────────────────
function normalizeDebtAmount(text) {
  if (!text) return null;
  const t = text.toLowerCase().replace(/,/g, '');

  const patterns = [
    /(?:owe|debt|balance|amount)(?:\s+is|\s+of)?\s*(?:about|around|roughly|maybe|like)?\s*\$?([\d.]+)\s*k\b/i,
    /\$?([\d.]+)\s*k\b/i,
    /(?:owe|debt|balance|amount)(?:\s+is|\s+of)?\s*(?:about|around|roughly|maybe|like)?\s*\$?([\d]+(?:\.\d{2})?)/i,
    /\$?([\d]+(?:\.\d{2})?)/,
    /(?:about|around|roughly|maybe|like)\s*\$?([\d]+)/i,
  ];

  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (!match) continue;

    let amount = parseFloat(match[1]);
    if (isNaN(amount) || amount < 50 || amount > 10_000_000) continue;

    // FIX: check the *matched text* for the 'k' suffix, not the entire
    // conversation string. The original `t.includes('k')` would multiply
    // $500 → $500,000 any time the word "think", "bank", or "ok" appeared
    // anywhere in the chat history.
    if (/\d\s*k\b/i.test(match[0]) && amount < 1000) {
      amount *= 1000;
    }

    return Math.round(amount * 100); // store in cents
  }
  return null;
}

function formatDebtAmount(cents) {
  if (!cents) return null;
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ─── COURT DATE DETECTION ─────────────────────────────────────────────────────
function detectCourtDate(text) {
  if (!text) return null;
  const t    = text.toLowerCase();
  const now  = new Date();
  const year = now.getFullYear();

  // Relative patterns
  const relativePatterns = [
    { re: /(?:court|hearing|trial|deadline)\s*(?:is\s*)?(?:in\s*)?(\d+)\s*days?/i,                                     type: 'days'    },
    { re: /(?:court|hearing|trial)\s*(?:is\s*)?(?:next|this)\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i, type: 'weekday' },
    { re: /(?:court|hearing|trial)\s*(?:is\s*)?tomorrow/i,                                                              type: 'tomorrow'},
    { re: /(?:court|hearing|trial)\s*(?:is\s*)?(?:next|this)\s*week/i,                                                  type: 'nextweek'},
  ];

  for (const { re, type } of relativePatterns) {
    const m = t.match(re);
    if (!m) continue;
    const d = new Date();
    if      (type === 'days')    { d.setDate(d.getDate() + parseInt(m[1])); return d; }
    else if (type === 'tomorrow'){ d.setDate(d.getDate() + 1); return d; }
    else if (type === 'nextweek'){ d.setDate(d.getDate() + 7); return d; }
    else if (type === 'weekday') {
      const DAYS     = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const target   = DAYS.indexOf(m[1].toLowerCase());
      let   daysLeft = target - d.getDay();
      if (daysLeft <= 0) daysLeft += 7;
      d.setDate(d.getDate() + daysLeft);
      return d;
    }
  }

  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

  // FIX: handle "12th of March" (day first) and "March 12th" (month first) separately
  // so the group indices are unambiguous. The original code combined both patterns
  // with || and then tried to guess which group held the day vs. the month.

  // Pattern A — day first: "court on the 12th of March" / "hearing 12 March"
  const mA = t.match(/(?:court|hearing|trial|deadline)[^.!?]*?(?:the\s*)?(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s*)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i);
  if (mA) {
    const day   = parseInt(mA[1]);
    const month = MONTHS.indexOf(mA[2].toLowerCase().substring(0, 3));
    if (month !== -1 && day >= 1 && day <= 31) {
      const d = new Date(year, month, day);
      if (d < now) d.setFullYear(year + 1);
      return d;
    }
  }

  // Pattern B — month first: "court March 12th" / "hearing on May 5"
  const mB = t.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(\d{1,2})(?:st|nd|rd|th)?/i);
  if (mB) {
    const month = MONTHS.indexOf(mB[1].toLowerCase().substring(0, 3));
    const day   = parseInt(mB[2]);
    if (month !== -1 && day >= 1 && day <= 31) {
      const d = new Date(year, month, day);
      if (d < now) d.setFullYear(year + 1);
      return d;
    }
  }

  // Pattern C — numeric MM/DD or MM/DD/YYYY
  const mC = t.match(/(?:court|hearing|trial|deadline)[^.!?]*?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i);
  if (mC) {
    const month = parseInt(mC[1]) - 1;
    const day   = parseInt(mC[2]);
    let   yr    = mC[3] ? parseInt(mC[3]) : year;
    if (yr < 100) yr += 2000;
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      const d = new Date(yr, month, day);
      if (d < now && !mC[3]) d.setFullYear(year + 1);
      return d;
    }
  }

  return null;
}

function daysUntil(date) {
  if (!date) return null;
  const now    = new Date(); now.setHours(0, 0, 0, 0);
  const target = new Date(date); target.setHours(0, 0, 0, 0);
  return Math.ceil((target - now) / CONFIG.MSECS_PER_DAY);
}

// ─── FLORIDA COUNTY DETECTION ─────────────────────────────────────────────────
const FLORIDA_COUNTIES = [
  'alachua','baker','bay','bradford','brevard','broward','calhoun','charlotte',
  'citrus','clay','collier','columbia','desoto','dixie','duval','escambia',
  'flagler','franklin','gadsden','gilchrist','glades','gulf','hamilton','hardee',
  'hendry','hernando','highlands','hillsborough','holmes','indian river','jackson',
  'jefferson','lafayette','lake','lee','leon','levy','liberty','madison','manatee',
  'marion','martin','miami-dade','miami dade','monroe','nassau','okaloosa',
  'okeechobee','orange','osceola','palm beach','pasco','pinellas','polk','putnam',
  'santa rosa','sarasota','seminole','st. johns','st johns','st. lucie','st lucie',
  'sumter','suwannee','taylor','union','volusia','wakulla','walton','washington',
];

function detectCounty(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const county of FLORIDA_COUNTIES) {
    if (t.includes(county)) {
      return county.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }
  return null;
}

// ─── CASE NUMBER DETECTION ────────────────────────────────────────────────────
function detectCaseNumber(text) {
  if (!text) return null;
  const patterns = [
    /\b(\d{2,4}[-\s]?[A-Z]{2,3}[-\s]?\d{4,8})\b/i,
    /\bcase\s*#?\s*(\d{4,}[A-Z\-\d]*)/i,
    /\b([A-Z]{2,3}[-\s]?\d{2,4}[-\s]?\d{4,8})\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toUpperCase().replace(/\s/g, '-');
  }
  return null;
}

// ─── TYPING DELAY ─────────────────────────────────────────────────────────────
function typingDelay(msg) {
  if (!msg) return 800;
  const l = msg.length;
  if (l < 60)  return 750;
  if (l < 120) return 1050;
  if (l < 200) return 1400;
  return 1800;
}

// ─── LEAD SCORING ─────────────────────────────────────────────────────────────
function calcScore(session) {
  let score    = 0;
  const breakdown = {};
  const story  = (session.story || '').toLowerCase();

  score += 2; breakdown.completedIntake = 2;

  if (session.practiceArea && session.practiceArea !== 'General') {
    score += 2; breakdown.knownPracticeArea = 2;
  }

  if (session.courtDate) {
    const days = daysUntil(session.courtDate);
    if      (days !== null && days <= 3)  { score += 3; breakdown.urgentCourtDate   = 3; }
    else if (days !== null && days <= 7)  { score += 2; breakdown.upcomingCourtDate = 2; }
    else if (days !== null && days <= 14) { score += 1; breakdown.courtDateSet      = 1; }
  }

  if (session.urgency === 'urgent') { score += 1; breakdown.urgencySignals = 1; }
  if (session.phone)                { score += 1; breakdown.phoneProvided  = 1; }
  if (session.email)                { score += 1; breakdown.emailProvided  = 1; }

  if (/court|summons|lawsuit|sued|judgment|served/.test(story)) {
    score += 2; breakdown.legalActionMentioned = 2;
  }

  if (session.hasGarnishment || /garnish|paycheck|wages/.test(story)) {
    score += 2; breakdown.garnishmentMentioned = 2;
  }

  if (session.debtAmount && session.debtAmount >= 100_000) {
    score += 1; breakdown.significantDebtAmount = 1;
  }

  if (session.caseNumber)                          { score += 1; breakdown.caseNumberProvided = 1; }
  if (session.story?.length > 100)                 { score += 1; breakdown.detailedStory      = 1; }
  if (session.documentUrls?.length > 0)            { score += 1; breakdown.documentUploaded   = 1; }

  return { score: Math.min(score, 10), breakdown };
}

// ─── FIELD EXTRACTION ─────────────────────────────────────────────────────────
function extractFields(session) {
  const userMsgs  = session.history.filter(m => m.role === 'user');
  const allText   = userMsgs.map(m => m.content).join(' ');
  const latestMsg = userMsgs.at(-1)?.content ?? '';

  // First name
  // FIX: exclude common single-word responses from being captured as a name
  if (!session.firstName) {
    const trimmed = latestMsg.trim();
    if (
      trimmed.length >= 2 &&
      /^[A-Za-z'-]{2,25}$/.test(trimmed) &&
      !NON_NAME_WORDS.has(trimmed.toLowerCase())
    ) {
      session.firstName = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
    } else {
      for (const msg of userMsgs) {
        const nm = msg.content.match(/(?:my name is|i['']?m|it['']?s|call me|this is)\s+([A-Za-z'-]{2,25})/i);
        if (nm) {
          session.firstName = nm[1].charAt(0).toUpperCase() + nm[1].slice(1).toLowerCase();
          break;
        }
      }
    }
  }

  // Email
  if (!session.email) {
    const em = allText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (em && validateEmail(em[0])) session.email = em[0].toLowerCase();
  }

  // Phone
  if (!session.phone) {
    for (const msg of userMsgs) {
      if (validatePhone(msg.content.trim())) {
        session.phone = msg.content.trim();
        break;
      }
    }
  }

  // Story
  if (!session.story) {
    const storyMsg = userMsgs.find(m => m.content.trim().length > 30);
    if (storyMsg) session.story = storyMsg.content.trim();
  }

  // Debt amount
  if (!session.debtAmount) {
    const amount = normalizeDebtAmount(allText);
    if (amount) {
      session.debtAmount    = amount;
      session.debtAmountRaw = allText.match(/\$?[\d,]+(?:\.\d{2})?k?/i)?.[0] ?? null;
      console.log(`💰 Debt detected: ${formatDebtAmount(amount)}`);
    }
  }

  // Court date
  if (!session.courtDate) {
    const courtDate = detectCourtDate(allText);
    if (courtDate) {
      session.courtDate    = courtDate;
      session.courtDateRaw = allText.match(/(?:court|hearing|trial|deadline)[^.!?]*/i)?.[0] ?? null;
    }
  }

  // Case number (check latest message only to avoid stale matches)
  if (!session.caseNumber) {
    const cn = detectCaseNumber(latestMsg);
    if (cn) session.caseNumber = cn;
  }

  // County
  if (!session.county) {
    const county = detectCounty(allText);
    if (county) session.county = county;
  }

  // Legal flags
  session.hasCourtCase   = /\b(court|lawsuit|sued|summons|served|case|hearing|trial|judgment)\b/i.test(allText);
  session.hasGarnishment = /\b(garnish|garnishment|wages|paycheck|salary)\b/i.test(allText);

  // Sentiment
  const sentimentMap = {
    scared:      ['scared','afraid','terrified','fear','frightened','nervous','worried'],
    embarrassed: ['embarrassed','ashamed','humiliated','embarrassing'],
    stressed:    ['stressed','overwhelmed','anxious','anxiety','stress','panic','panicking'],
    desperate:   ['desperate','hopeless','no way out',"don't know what to do"],
    angry:       ['angry','furious','mad','frustrated','unfair','ridiculous','harassment'],
    confused:    ['confused','confusing',"don't understand",'unclear'],
    hopeful:     ['hopeful','hope','optimistic','believe','confident'],
  };

  const lower = allText.toLowerCase();
  for (const [flag, words] of Object.entries(sentimentMap)) {
    if (!session.sentimentFlags.includes(flag) && words.some(w => lower.includes(w))) {
      session.sentimentFlags.push(flag);
    }
  }

  // Practice area
  if (!session.practiceArea || session.practiceArea === 'General') {
    const area = classifyPracticeArea(allText);
    if (area !== 'General') session.practiceArea = area;
  }

  // Urgency
  if (!session.urgency || session.urgency === 'standard') {
    const hasUrgency = /court|deadline|urgent|garnish|lawsuit|summons|repo|levy|tomorrow|next week|few days/.test(lower);
    session.urgency = hasUrgency ? 'urgent' : 'standard';
  }

  console.log('📊 SESSION:', JSON.stringify({
    firstName: session.firstName, email: session.email, phone: session.phone,
    debtAmount: formatDebtAmount(session.debtAmount), courtDate: session.courtDate,
    caseNumber: session.caseNumber, county: session.county,
    hasCourtCase: session.hasCourtCase, hasGarnishment: session.hasGarnishment,
    sentimentFlags: session.sentimentFlags, practiceArea: session.practiceArea,
    intakeComplete: session.intakeComplete,
  }));
}

// ─── STATE SUMMARY FOR CLAUDE ─────────────────────────────────────────────────
function buildStateSummary(session) {
  const needsCaseInfo = (session.hasCourtCase || session.hasGarnishment) &&
                        (!session.caseNumber || !session.county);

  return [
    'CURRENT INTAKE STATE:',
    `- First name:      ${session.firstName ? 'YES — ' + session.firstName : 'NOT YET'}`,
    `- Story/situation: ${session.story     ? 'YES'                        : 'NOT YET'}`,
    `- Email:           ${session.email     ? 'YES — ' + session.email     : 'NOT YET'}`,
    `- Phone:           ${session.phone     ? 'YES'                        : 'NOT YET'}`,
    `- Practice area:   ${session.practiceArea || 'NOT YET'}`,
    `- Debt amount:     ${session.debtAmount ? formatDebtAmount(session.debtAmount) : 'NOT MENTIONED'}`,
    `- Court date:      ${session.courtDate
        ? `${session.courtDate.toLocaleDateString()} (${daysUntil(session.courtDate)} days away)`
        : 'NONE'}`,
    `- Court/garnishment: ${session.hasCourtCase || session.hasGarnishment ? 'YES' : 'NO'}`,
    `- Case number:     ${session.caseNumber || 'NOT YET'}`,
    `- Florida county:  ${session.county    || 'NOT YET'}`,
    `- Sentiment:       ${session.sentimentFlags.join(', ') || 'none'}`,
    '',
    'INTAKE COLLECTION ORDER:',
    '1. Name (if not collected)',
    '2. Their situation in their own words (if no story yet)',
    needsCaseInfo
      ? '3. IMPORTANT: Ask for court case number and Florida county before email/phone'
      : '3. Case info collected or not applicable',
    '4. Email — "just so the team can follow up with you by email too"',
    '5. Phone — "no spam, LaMya will call you directly"',
    '6. Once phone collected → DO NOT say goodbye. System handles closing.',
    '',
    'RULES:',
    '- NEVER ask for info already collected',
    '- Answer legal questions in 2 sentences then continue intake',
    '- 2-3 sentences MAX per response',
    '- Acknowledge sentiment in ONE sentence before continuing',
    session.courtDate && (daysUntil(session.courtDate) ?? 99) <= 7
      ? '- ⚠️ URGENT: Court date is within 7 days — acknowledge this clearly'
      : '',
  ].filter(Boolean).join('\n');
}

// ─── CLAUDE ───────────────────────────────────────────────────────────────────
async function askClaude(session) {
  const context = session.language === 'es' ? FIRM_CONTEXT_ES : FIRM_CONTEXT;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Anthropic API timed out')), CONFIG.CLAUDE_TIMEOUT_MS)
  );

  const apiPromise = anthropic.messages.create({
    model:      CONFIG.CLAUDE_MODEL,
    max_tokens: CONFIG.CLAUDE_MAX_TOKENS,
    system:     `${context}\n\n${buildStateSummary(session)}`,
    messages:   session.history,
  });

  const response = await Promise.race([apiPromise, timeoutPromise]);
  return response.content[0].text;
}

// ─── EMAIL HELPERS ────────────────────────────────────────────────────────────
// Shared outer shell so both emails have consistent branding
function emailShell({ preheader, headline, body }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;background:#f5f0e8;padding:32px;">
      <div style="background:#0d1b2a;padding:24px 28px;border-radius:12px 12px 0 0;">
        <p style="color:#c9a84c;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px 0;">${escHtml(preheader)}</p>
        <h1 style="color:#fff;font-size:20px;margin:0;">${escHtml(headline)}</h1>
      </div>
      <div style="background:#fff;padding:28px;border-radius:0 0 12px 12px;">
        ${body}
        <div style="text-align:center;padding-top:16px;border-top:1px solid rgba(0,0,0,.06);margin-top:16px;">
          <p style="font-size:11px;color:#9ca3af;margin:0;">Powered by <strong style="color:#0d1b2a;">Ander</strong> · <strong style="color:#0d1b2a;">Fern Stellar</strong></p>
        </div>
      </div>
    </div>`;
}

async function sendFirmNotification(session, score, breakdown) {
  const urgencyLabel = score >= 8 ? '🔴 HIGH PRIORITY' : score >= 5 ? '🟡 MODERATE' : '🟢 STANDARD';
  const urgencyColor = score >= 8 ? '#ef4444' : score >= 5 ? '#f59e0b' : '#22c55e';
  const urgencyBg    = score >= 8 ? '#fef2f2' : score >= 5 ? '#fffbeb' : '#f0fdf4';
  const followUpMsg  = score >= 7 ? `Call ${escHtml(session.firstName)} within the hour.`
                     : score >= 4 ? 'Follow up within 24 hours.'
                     :              'Follow up when available.';

  // FIX: all user data passed through escHtml before embedding in HTML
  const courtBanner = session.courtDate ? `
    <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:16px;">
      <p style="margin:0;font-size:13px;font-weight:600;color:#ef4444;">
        ⚠️ COURT DATE: ${escHtml(session.courtDate.toLocaleDateString())} (${daysUntil(session.courtDate)} days)
      </p>
    </div>` : '';

  const tableRow = (label, value, shaded = false) => `
    <tr style="${shaded ? 'background:#f8f7f5;' : ''}">
      <td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;width:130px;">${escHtml(label)}</td>
      <td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${value}</td>
    </tr>`;

  const caseRows = (session.caseNumber || session.county) ? `
    ${tableRow('Case Number', escHtml(session.caseNumber || 'Not provided'), true)}
    ${tableRow('County',      escHtml(session.county     || 'Not provided'))}` : '';

  const scoreRows = Object.entries(breakdown).map(([k, v]) => `
    <tr>
      <td style="padding:4px 10px;font-size:12px;color:#6b7280;">${escHtml(k)}</td>
      <td style="padding:4px 10px;font-size:12px;font-weight:600;color:#0d1b2a;">+${v}</td>
    </tr>`).join('');

  // FIX: transcript content escaped — a user typing HTML breaks the email layout
  const transcriptHtml = session.history.map(m => `
    <div style="margin-bottom:12px;">
      <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:${m.role === 'user' ? '#1d4ed8' : '#166534'};">
        ${m.role === 'user' ? escHtml(session.firstName || 'Client') : 'Ander'}
      </span>
      <p style="margin:3px 0 0;font-size:13px;color:#0d1b2a;line-height:1.5;">${escHtml(m.content)}</p>
    </div>`).join('');

  const sentimentHtml = session.sentimentFlags.length > 0 ? `
    <div style="background:#fffbeb;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
      <p style="font-size:11px;color:#92400e;text-transform:uppercase;font-weight:600;margin:0 0 6px 0;">Sentiment Flags</p>
      <p style="font-size:13px;color:#0d1b2a;margin:0;">${escHtml(session.sentimentFlags.join(', '))}</p>
    </div>` : '';

  const body = `
    ${courtBanner}
    <div style="background:${urgencyBg};border-left:4px solid ${urgencyColor};padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:24px;">
      <p style="margin:0;font-size:13px;font-weight:600;color:#0d1b2a;">${escHtml(urgencyLabel)} — ${followUpMsg}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      ${tableRow('Name',         escHtml(session.firstName || 'Not provided'), true)}
      ${tableRow('Phone',        session.phone
          ? `<a href="tel:${escHtml(session.phone)}" style="color:#c9a84c;">${escHtml(session.phone)}</a>`
          : 'Not provided')}
      ${tableRow('Email',        session.email
          ? `<a href="mailto:${escHtml(session.email)}" style="color:#c9a84c;">${escHtml(session.email)}</a>`
          : 'Not provided', true)}
      ${tableRow('Practice Area', escHtml(session.practiceArea || 'General'))}
      ${tableRow('Debt Amount',   escHtml(formatDebtAmount(session.debtAmount) || 'Not mentioned'), true)}
      ${tableRow('Urgency',       session.urgency === 'urgent' ? '⚠️ Time-sensitive' : 'Standard')}
      ${caseRows}
    </table>
    ${sentimentHtml}
    <div style="background:#f8f7f5;border-radius:10px;padding:18px 20px;margin-bottom:20px;">
      <p style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:600;margin:0 0 8px 0;">In Their Own Words</p>
      <p style="font-size:14px;color:#0d1b2a;line-height:1.6;margin:0;font-style:italic;">"${escHtml(session.story || 'Not provided')}"</p>
    </div>
    <div style="background:#f8f7f5;border-radius:10px;padding:18px 20px;margin-bottom:20px;">
      <p style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:600;margin:0 0 10px 0;">
        Score Breakdown
        <span style="float:right;background:rgba(201,168,76,.15);border:1px solid rgba(201,168,76,.3);border-radius:8px;padding:2px 10px;color:#c9a84c;font-weight:700;">${score}/10</span>
      </p>
      <table style="width:100%;border-collapse:collapse;">${scoreRows}</table>
    </div>
    <div style="background:#f0fdf4;border-radius:10px;padding:18px 20px;">
      <p style="font-size:11px;color:#166534;text-transform:uppercase;font-weight:600;margin:0 0 12px 0;">Full Conversation Transcript</p>
      ${transcriptHtml}
    </div>`;

  try {
    await resend.emails.send({
      from:    'Ander at Fern Stellar <ander@fernstellar.com>',
      to:      [process.env.FIRM_EMAIL],
      subject: `${urgencyLabel} New Intake — ${session.firstName || 'Unknown'} | ${session.practiceArea || 'General'} | Score: ${score}/10`,
      html:    emailShell({ preheader: `New Intake · ${CONFIG.FIRM_NAME}`, headline: 'Ander AI Intake', body }),
    });
    console.log('✅ Firm notification sent for', session.firstName);
  } catch (err) {
    console.error('❌ Firm email failed:', err.message ?? err);
  }
}

async function sendClientConfirmation(session) {
  if (!session.email) return;

  const body = `
    <p style="font-size:15px;color:#0d1b2a;line-height:1.7;">Hi ${escHtml(session.firstName)},</p>
    <p style="font-size:15px;color:#0d1b2a;line-height:1.7;">
      Thank you for reaching out to ${escHtml(CONFIG.FIRM_NAME)}.
      Your intake has been received and LaMya will be in touch within 24 hours.
    </p>
    <p style="font-size:15px;color:#0d1b2a;line-height:1.7;">
      If you'd like to lock in a time right now, you can schedule a free 10-minute consultation here:
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${CONFIG.CALENDLY_LINK}" style="background:#0d1b2a;color:#e8c96a;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">
        📅 Schedule a Free Consultation
      </a>
    </div>
    <p style="font-size:13px;color:#6b7280;line-height:1.6;">
      This message was sent on behalf of ${escHtml(CONFIG.FIRM_NAME)} by Ander, an AI intake assistant.
      Nothing in this email constitutes legal advice.
    </p>`;

  try {
    await resend.emails.send({
      from:    `${CONFIG.FIRM_NAME} via Ander <ander@fernstellar.com>`,
      to:      [session.email],
      subject: `${session.firstName}, we received your information — ${CONFIG.FIRM_NAME}`,
      html:    emailShell({ preheader: `${CONFIG.FIRM_NAME} · Orlando, FL`, headline: "We've received your information", body }),
    });
    console.log('✅ Client confirmation sent to', session.email);
  } catch (err) {
    console.error('❌ Client email failed:', err.message ?? err);
  }
}

// ─── SAVE INTAKE ──────────────────────────────────────────────────────────────
async function saveIntake(session, score, breakdown) {
  try {
    const intake = await Intake.create({
      sessionId:      session.sessionId,
      firstName:      session.firstName   || 'Unknown',
      email:          session.email       || null,
      phone:          session.phone       || null,
      practiceArea:   session.practiceArea || 'General',
      story:          session.story       || null,
      urgency:        session.urgency     || 'standard',
      score,
      scoreBreakdown: breakdown,
      debtAmount:     session.debtAmount  || null,
      debtAmountRaw:  session.debtAmountRaw || null,
      courtDate:      session.courtDate   || null,
      courtDateRaw:   session.courtDateRaw || null,
      caseNumber:     session.caseNumber  || null,
      county:         session.county      || null,
      hasCourtCase:   session.hasCourtCase  || false,
      hasGarnishment: session.hasGarnishment || false,
      daysUntilCourt: session.courtDate ? daysUntil(session.courtDate) : null,
      sentimentFlags: session.sentimentFlags || [],
      documentUrls:   session.documentUrls   || [],
      firmName:       CONFIG.FIRM_NAME,
      transcript:     session.history,
      language:       session.language || 'en',
      completedAt:    new Date(),
      status:         'new',
    });
    console.log('✅ Intake saved:', intake._id);
    return intake;
  } catch (err) {
    console.error('❌ MongoDB save failed:', err.message);
    return null;
  }
}

// ─── SHARED ID VALIDATION ─────────────────────────────────────────────────────
// FIX: calling findById() with an invalid string throws a Mongoose CastError
// (500 with a stack trace). Validate first and return a clean 400 instead.
function validateObjectId(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ success: false, error: 'Invalid ID format' });
    return false;
  }
  return true;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
const disclosureMessage   = "Hey there 👋 — I'm Ander. Before we get started, just want to be upfront: I'm an AI, not a lawyer, and nothing I say is legal advice.\n\nI'm here to walk you through a quick intake so the right people at The Henry Law Firm can take a look at your situation and reach out.\n\nWhenever you're ready, just say \"I understand\" and we'll jump in. 😊";
const disclosureMessageES = "Hola 👋 — Soy Ander. Antes de comenzar, quiero ser claro: soy una IA, no un abogado, y nada de lo que digo es asesoría legal.\n\nEstoy aquí para guiarte a través de una breve admisión para que el equipo de The Henry Law Firm pueda revisar tu situación.\n\nCuando estés listo, solo di \"Entiendo\" y comenzamos. 😊";

// FIX: use Set defined at top — duplicate 'ok' removed
const disclosureAccepted = (val) => DISCLOSURE_ACCEPTED.has(val.trim().toLowerCase());

app.get('/api/start', (req, res) => {
  const sid  = crypto.randomUUID();
  const lang = req.query.lang === 'es' ? 'es' : 'en';
  const msg  = lang === 'es' ? disclosureMessageES : disclosureMessage;
  res.json({ step: 0, sessionId: sid, message: msg, type: 'text', options: [], delay: typingDelay(msg), language: lang });
});

app.post('/api/message', chatLimiter, async (req, res) => {
  const { step, userMessage, sessionId, language } = req.body;

  // Input validation
  if (!userMessage || typeof userMessage !== 'string') {
    return res.status(400).json({ success: false, error: 'Message is required' });
  }
  if (userMessage.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Message cannot be empty' });
  }
  if (userMessage.length > CONFIG.MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ success: false, error: `Message must be ${CONFIG.MAX_MESSAGE_LENGTH} characters or less` });
  }
  if (language !== undefined && !['en', 'es'].includes(language)) {
    return res.status(400).json({ success: false, error: 'Invalid language' });
  }

  const sid     = (typeof sessionId === 'string' && sessionId) ? sessionId : crypto.randomUUID();
  const session = getSession(sid);
  if (language) session.language = language;

  // ── Step 0: disclosure ───────────────────────────────────────────────────
  if (step === 0) {
    if (!disclosureAccepted(userMessage)) {
      const msg = session.language === 'es'
        ? 'No hay problema — solo escribe "Entiendo" cuando te sientas cómodo. 😊'
        : 'No worries — just type "I understand" whenever you\'re comfortable! 😊';
      return res.json({ done: false, step: 0, sessionId: sid, message: msg, type: 'text', options: [], delay: 800 });
    }
    const msg = session.language === 'es' ? '¡Perfecto! — ¿cómo te llamas?' : "Great! First things first — what's your name?";
    return res.json({ done: false, step: 1, sessionId: sid, message: msg, type: 'text', options: [], delay: 750 });
  }

  // ── Step 1: name ─────────────────────────────────────────────────────────
  if (step === 1) {
    const trimmed = userMessage.trim();
    const words   = trimmed.split(/\s+/);
    const first   = words[0];

    // Accept if it looks like a real name and isn't a common non-name word
    if (first.length >= 2 && /^[A-Za-z'-]+$/.test(first) && !NON_NAME_WORDS.has(first.toLowerCase())) {
      session.firstName = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    } else {
      // Fallback: use raw input truncated so the conversation can continue
      session.firstName = trimmed.slice(0, 25) || 'there';
    }

    const practiceOptions = session.language === 'es'
      ? ['Deuda de Tarjeta','Facturas Médicas','Embargo Salarial','Reposesión de Auto','Demanda/Corte','Otro Problema']
      : ['Credit Card Debt','Medical Bills','Wage Garnishment','Auto Repossession','Lawsuit/Court','Other Debt Issue'];

    const msg = session.language === 'es'
      ? `Gracias, ${session.firstName}. ¿Qué te trae a The Henry Law Firm hoy?`
      : `Thanks, ${session.firstName}. What brings you to The Henry Law Firm today?`;

    return res.json({ done: false, step: 2, sessionId: sid, message: msg, type: 'options', options: practiceOptions, delay: 800, progress: { name: true } });
  }

  // ── Step 2: practice area ────────────────────────────────────────────────
  if (step === 2) {
    const practiceAreaMap = {
      'Credit Card Debt':   'Credit Card Debt',    'Deuda de Tarjeta':   'Credit Card Debt',
      'Medical Bills':      'Medical Bills',        'Facturas Médicas':   'Medical Bills',
      'Wage Garnishment':   'Wage Garnishment',     'Embargo Salarial':   'Wage Garnishment',
      'Auto Repossession':  'Auto Loan / Repossession', 'Reposesión de Auto': 'Auto Loan / Repossession',
      'Lawsuit/Court':      'Debt Collection Defense',  'Demanda/Corte':      'Debt Collection Defense',
      'Other Debt Issue':   'Debt Collection Defense',  'Otro Problema':      'Debt Collection Defense',
    };
    session.practiceArea = practiceAreaMap[userMessage] || 'Debt Collection Defense';

    const msg = session.language === 'es'
      ? `Entiendo. Cuéntame qué está pasando...`
      : `Got it. Tell me what's going on...`;

    return res.json({ done: false, step: 3, sessionId: sid, message: msg, type: 'text', options: [], delay: 600, progress: { name: true } });
  }

  // ── Post-intake follow-up ─────────────────────────────────────────────────
  if (session.intakeComplete) {
    session.postIntakeQuestionCount = (session.postIntakeQuestionCount || 0) + 1;

    if (session.postIntakeQuestionCount > CONFIG.POST_INTAKE_MAX) {
      const redirectMsg = session.language === 'es'
        ? `${session.firstName}, LaMya puede responder esto mejor en persona. ¿Por qué no reservas 10 minutos con ella? 😊`
        : `${session.firstName}, LaMya can answer this best in your consultation. Why not book 10 minutes with her? 😊`;
      session.history.push({ role: 'user', content: userMessage });
      session.history.push({ role: 'assistant', content: redirectMsg });
      return res.json({ done: true, step, sessionId: sid, message: redirectMsg, calendlyLink: CONFIG.CALENDLY_LINK, type: 'text', options: [], delay: 800 });
    }

    // FIX: wrap askClaude in try/catch — the original had no error handling here
    try {
      session.history.push({ role: 'user', content: userMessage });
      const anderResponse = await askClaude(session);
      const reminder = session.postIntakeQuestionCount === CONFIG.POST_INTAKE_MAX
        ? (session.language === 'es'
            ? '\n\nRecuerda: LaMya puede profundizar durante tu consulta gratuita. ¡Reserva tu tiempo ahora!'
            : '\n\nRemember: LaMya can dive deeper during your free consultation. Book your time now!')
        : '';
      const fullResponse = anderResponse + reminder;
      session.history.push({ role: 'assistant', content: fullResponse });
      return res.json({
        done:         session.postIntakeQuestionCount >= CONFIG.POST_INTAKE_MAX,
        step,         sessionId: sid,   message: fullResponse,
        calendlyLink: session.postIntakeQuestionCount >= CONFIG.POST_INTAKE_MAX ? CONFIG.CALENDLY_LINK : null,
        type:         'text',           options: [],
        delay:        typingDelay(fullResponse),
      });
    } catch (err) {
      console.error('❌ Post-intake Claude error:', err.message);
      const errMsg = session.language === 'es'
        ? 'Lo siento, algo salió mal. ¿Podrías intentarlo de nuevo?'
        : "I'm sorry, something went wrong. Could you try that again?";
      return res.json({ done: false, step, sessionId: sid, message: errMsg, type: 'text', options: [], delay: 800 });
    }
  }

  // ── Step 3+: AI-driven intake ─────────────────────────────────────────────
  try {
    session.history.push({ role: 'user', content: userMessage });
    extractFields(session);

    // Off-topic guard
    const DEBT_KEYWORDS = ['debt','garnish','credit','collector','lawsuit','levy','fdcpa','summons',
      'repo','medical','lien','judgment','lawyer','attorney','court','bank','loan','owe','payment',
      'balance','sue','help','problem','issue','situation','money','bill','creditor','collection',
      'deuda','embargo','abogado','corte','demanda'];
    const hasDebtIntent = DEBT_KEYWORDS.some(k => userMessage.toLowerCase().includes(k));
    if (!hasDebtIntent && !session.story) session.offTopicCount = (session.offTopicCount || 0) + 1;
    else session.offTopicCount = 0;

    if (session.offTopicCount >= CONFIG.OFF_TOPIC_THRESHOLD) {
      session.intakeComplete = true;
      const closeMsg = session.language === 'es'
        ? "Parece que no soy la mejor opción para lo que necesitas. Vuelve si tienes preguntas sobre deudas — The Henry Law Firm está aquí. 🌿"
        : "It looks like I might not be the right fit right now. Feel free to come back if you ever have a debt question — The Henry Law Firm is here. 🌿";
      session.history.push({ role: 'assistant', content: closeMsg });
      return res.json({ done: true, step: step + 1, sessionId: sid, message: closeMsg, type: 'text', options: [], delay: 800 });
    }

    const needsCaseInfo  = (session.hasCourtCase || session.hasGarnishment) && (!session.caseNumber || !session.county);
    const coreComplete   = session.phone && session.story && session.firstName;

    if (coreComplete && !needsCaseInfo && !session.intakeComplete) {
      session.intakeComplete = true;
      const { score, breakdown } = calcScore(session);

      Promise.all([
        saveIntake(session, score, breakdown),
        sendFirmNotification(session, score, breakdown),
        sendClientConfirmation(session),
      ]).catch(err => console.error('❌ Post-intake async error:', err));

      const closingMessage = session.language === 'es'
        ? `¡Todo listo, ${session.firstName}! 🌿 He enviado tu información al equipo — LaMya se pondrá en contacto dentro de 24 horas.\n\nSi prefieres reservar un horario ahora, puedes hacerlo abajo.\n\n¡Tú puedes! 💛`
        : `You're all set, ${session.firstName}! 🌿 I've passed everything along to The Henry Law Firm — LaMya will be reaching out within 24 hours.\n\nIf you'd like to lock in a time right now, you can book a free 10-minute consultation below.\n\nYou've got this. 💛`;

      session.history.push({ role: 'assistant', content: closingMessage });
      return res.json({ done: true, step: step + 1, sessionId: sid, message: closingMessage, calendlyLink: CONFIG.CALENDLY_LINK, type: 'text', options: [], delay: typingDelay(closingMessage) });
    }

    const progress = {
      name:     !!session.firstName,
      story:    !!session.story,
      caseInfo: !needsCaseInfo,
      email:    !!session.email,
      phone:    !!session.phone,
    };

    const anderResponse = await askClaude(session);
    session.history.push({ role: 'assistant', content: anderResponse });

    return res.json({ done: false, step: step + 1, sessionId: sid, message: anderResponse, progress, type: 'text', options: [], delay: typingDelay(anderResponse) });

  } catch (err) {
    console.error('❌ /api/message error:', err.message);
    const errMsg = session.language === 'es'
      ? 'Lo siento, algo salió mal. ¿Podrías intentarlo de nuevo?'
      : "I'm sorry, something went wrong on my end. Could you try that again?";
    return res.json({ done: false, step, sessionId: sid, message: errMsg, type: 'text', options: [], delay: 800 });
  }
});

// Document upload
app.post('/api/upload', uploadLimiter, upload.single('document'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

  // FIX: verify resolved path is still inside uploadDir (path traversal guard)
  const resolved = path.resolve(uploadDir, req.file.filename);
  if (!resolved.startsWith(path.resolve(uploadDir))) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: 'Invalid file path' });
  }

  const { sessionId } = req.body;
  if (typeof sessionId === 'string' && sessionId) {
    getSession(sessionId).documentUrls.push(`/secure-uploads/${req.file.filename}`);
  }

  res.json({ success: true, filename: req.file.filename, message: 'Document uploaded securely. This will help LaMya prepare for your consultation.' });
});

// Multer error handler
// eslint-disable-next-line no-unused-vars
app.use('/api/upload', (err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message === 'File type not allowed') {
    return res.status(400).json({ success: false, error: err.message });
  }
  res.status(500).json({ success: false, error: 'Upload failed' });
});

// ─── DASHBOARD ROUTES (all require auth) ─────────────────────────────────────
app.get('/dashboard', requireAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('/api/intakes', requireAuth, async (req, res) => {
  try {
    const { status, search, urgency } = req.query;
const query = {};

    if (status && status !== 'all') query.status = status;
    if (urgency === 'court')         query.courtDate = { $ne: null };
    if (urgency === 'urgent')        query.urgency   = 'urgent';

    if (search && typeof search === 'string') {
      // FIX: escape regex metacharacters to prevent ReDoS attacks
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { firstName:    { $regex: safe, $options: 'i' } },
        { phone:        { $regex: safe, $options: 'i' } },
        { email:        { $regex: safe, $options: 'i' } },
        { practiceArea: { $regex: safe, $options: 'i' } },
        { story:        { $regex: safe, $options: 'i' } },
        { caseNumber:   { $regex: safe, $options: 'i' } },
        { county:       { $regex: safe, $options: 'i' } },
      ];
    }

    const intakes = await Intake.find(query).sort({ createdAt: -1 });
    res.json({ success: true, intakes, total: intakes.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// FIX: run all nine countDocuments calls in parallel with Promise.all
// instead of sequentially — cuts response time to the slowest single query
app.get('/api/intakes/stats', requireAuth, async (req, res) => {
  try {
    const today      = new Date(); today.setHours(0, 0, 0, 0);
    const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [
      total, newLeads, highPriority, converted,
      contacted, closed, todayCount, upcomingCourt, overdueFollowUps,
    ] = await Promise.all([
      Intake.countDocuments(),
      Intake.countDocuments({ status: 'new' }),
      Intake.countDocuments({ score: { $gte: 8 } }),
      Intake.countDocuments({ status: 'converted' }),
      Intake.countDocuments({ status: 'contacted' }),
      Intake.countDocuments({ status: 'closed' }),
      Intake.countDocuments({ createdAt: { $gte: today } }),
      Intake.countDocuments({
        courtDate: { $gte: new Date(), $lte: sevenDaysOut },
        status:    { $nin: ['converted', 'closed'] },
      }),
      Intake.countDocuments({
        followUpDate: { $lte: new Date() },
        status:       { $nin: ['converted', 'closed'] },
      }),
    ]);

    res.json({
      success: true,
      stats: { total, newLeads, highPriority, converted, todayCount, overdueFollowUps, upcomingCourt },
      funnel: {
        total, new: newLeads, contacted, converted, closed,
        conversionRate: total > 0 ? Math.round((converted / total) * 100) : 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/intakes/export/csv', requireAuth, async (req, res) => {
  try {
    const intakes = await Intake.find().sort({ createdAt: -1 });
    const HEADERS = [
      'Date','Name','Phone','Email','Practice Area','Score','Urgency',
      'Debt Amount','Court Date','Case Number','County','Sentiment',
      'Status','Notes','Story',
    ];

    const rows = intakes.map(i => [
      new Date(i.createdAt).toLocaleDateString(),
      i.firstName    || '',
      i.phone        || '',
      i.email        || '',
      i.practiceArea || '',
      i.score        ?? 0,
      i.urgency      || '',
      i.debtAmount   ? (i.debtAmount / 100).toFixed(0) : '',
      i.courtDate    ? new Date(i.courtDate).toLocaleDateString() : '',
      i.caseNumber   || '',
      i.county       || '',
      (i.sentimentFlags || []).join('; '),
      i.status       || '',
      (i.notes       || '').replace(/\n/g, ' '),
      (i.story       || '').replace(/\n/g, ' '),
    ]);

    // FIX: escape double-quotes inside values per RFC 4180 (replace " with "")
    // The original wrapped in quotes but didn't escape internal quotes,
    // producing malformed CSV if a user's story contained a quotation mark.
    const csv = [HEADERS, ...rows]
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type',        'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ander-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// FIX: validateObjectId added to all /:id routes — prevents Mongoose CastError
// 500s when the dashboard sends a malformed or missing ID
app.get('/api/intakes/:id', requireAuth, async (req, res) => {
  if (!validateObjectId(req, res)) return;
  try {
    const intake = await Intake.findById(req.params.id);
    if (!intake) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, intake });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/intakes/:id', requireAuth, async (req, res) => {
  if (!validateObjectId(req, res)) return;
  try {
    // Allowlist the fields the dashboard is allowed to update —
    // prevents accidental or malicious overwrite of score, transcript, etc.
    const UPDATABLE = ['status', 'notes', 'followUpDate'];
    const update    = {};
    for (const field of UPDATABLE) {
      if (req.body[field] !== undefined) {
        update[field] = field === 'followUpDate' && req.body[field]
          ? new Date(req.body[field])
          : req.body[field];
      }
    }

    const intake = await Intake.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!intake) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, intake });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/intakes/:id', requireAuth, async (req, res) => {
  if (!validateObjectId(req, res)) return;
  try {
    const deleted = await Intake.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── CRM INTEGRATION STUBS ────────────────────────────────────────────────────
async function syncToClio(_intake)            { return null; } // TODO: CLIO_ACCESS_TOKEN
async function syncToMyCase(_intake)          { return null; } // TODO: MYCASE_API_KEY
async function syncToPracticePanther(_intake) { return null; } // TODO: PP_API_KEY

async function syncToCRM(intake, provider) {
  const handlers = { clio: syncToClio, mycase: syncToMyCase, practicepanther: syncToPracticePanther };
  const handler  = handlers[provider];
  if (!handler) throw new Error(`Unknown CRM provider: ${provider}`);
  return handler(intake);
}

app.post('/api/intakes/:id/sync-crm', requireAuth, async (req, res) => {
  if (!validateObjectId(req, res)) return;
  const { provider } = req.body;
  if (!provider || typeof provider !== 'string') {
    return res.status(400).json({ success: false, error: 'CRM provider is required' });
  }
  try {
    const intake = await Intake.findById(req.params.id);
    if (!intake) return res.status(404).json({ success: false, error: 'Not found' });

    const crmId = await syncToCRM(intake, provider);
    if (crmId) {
      intake.crmId       = crmId;
      intake.crmProvider = provider;
      intake.crmSyncedAt = new Date();
      await intake.save();
    }
    res.json({ success: true, crmId, synced: !!crmId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 404 HANDLER ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
// Catches any unhandled synchronous errors thrown inside route handlers
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('❌ Unhandled error:', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`🌿 Ander running on port ${CONFIG.PORT}`);
  console.log(`📊 Dashboard:  /dashboard`);
  // FIX: original said /api/chat — the actual route is /api/message
  console.log(`💬 Chat API:   /api/message`);
  console.log(`🍃 MongoDB:    ${process.env.MONGODB_URI ? 'configured' : '⚠️  NOT CONFIGURED'}`);
  console.log(`📧 Resend:     ${process.env.RESEND_API_KEY ? 'configured' : '⚠️  NOT CONFIGURED'}`);
  console.log(`🤖 Anthropic:  ${process.env.ANTHROPIC_API_KEY ? 'configured' : '⚠️  NOT CONFIGURED'}`);
  console.log(`📬 Firm email: ${process.env.FIRM_EMAIL || '⚠️  NOT CONFIGURED'}`);
});
