require('dotenv').config();
const express = require('express');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');
const mongoose = require('mongoose');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// ─── SECURE DOCUMENT UPLOAD SETUP ───────────────────────────────────────────
const uploadDir = path.join(__dirname, 'secure-uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueId = crypto.randomUUID();
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueId}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('File type not allowed'), false);
  }
});

// ─── MONGODB CONNECTION ─────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('🍃 MongoDB connected — Ander CRM ready'))
  .catch(err => console.error('❌ MongoDB connection failed:', err));

// ─── ENHANCED INTAKE SCHEMA ─────────────────────────────────────────────────
const intakeSchema = new mongoose.Schema({
  sessionId:      { type: String, required: true, unique: true },
  firstName:      { type: String, default: 'Unknown' },
  email:          { type: String, default: null },
  phone:          { type: String, default: null },
  practiceArea:   { type: String, default: 'General' },
  story:          { type: String, default: null },
  urgency:        { type: String, default: 'standard' },
  score:          { type: Number, default: 0 },
  scoreBreakdown: { type: Object, default: {} },
  
  // Enhanced fields
  debtAmount:       { type: Number, default: null },       // Normalized to cents
  debtAmountRaw:    { type: String, default: null },       // Original text
  courtDate:        { type: Date, default: null },         // Detected court/hearing date
  courtDateRaw:     { type: String, default: null },       // Original text
  caseNumber:       { type: String, default: null },       // For garnishment/court cases
  county:           { type: String, default: null },       // Florida county
  hasCourtCase:     { type: Boolean, default: false },     // Needs case # collection
  hasGarnishment:   { type: Boolean, default: false },     // Needs case # collection
  daysUntilCourt:   { type: Number, default: null },       // Auto-calculated
  
  sentimentFlags:   { type: [String], default: [] },
  documentUrls:     { type: [String], default: [] },       // Uploaded documents
  firmName:         { type: String, default: 'Henry Law Firm' },
  transcript:       { type: Array, default: [] },
  notes:            { type: String, default: '' },
  followUpDate:     { type: Date, default: null },
  createdAt:        { type: Date, default: Date.now },
  completedAt:      { type: Date, default: null },
  status:           { type: String, default: 'new' },
  language:         { type: String, default: 'en' },
  
  // CRM Integration hooks (ready when needed)
  crmId:            { type: String, default: null },       // External CRM ID
  crmSyncedAt:      { type: Date, default: null },
  crmProvider:      { type: String, default: null },       // 'clio', 'mycase', 'practicepanther', etc.
  
  // Source tracking
  source:           { type: String, default: 'widget' },   // 'widget', 'landing', 'referral'
  referrer:         { type: String, default: null },
  utmSource:        { type: String, default: null },
  utmCampaign:      { type: String, default: null }
});

const Intake = mongoose.model('Intake', intakeSchema);

// ─── SESSION MANAGEMENT ─────────────────────────────────────────────────────
const sessions = new Map();
function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
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
      history: [], language: 'en',
      awaitingCaseNumber: false, awaitingCounty: false
    });
  }
  return sessions.get(sessionId);
}

// ─── API CLIENTS ────────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CALENDLY_LINK = 'https://calendly.com/lhenry-lawfirm';

// ─── FIRM CONTEXT (Updated for LaMya's actual practice) ────────────────────
const FIRM_CONTEXT = `
You are Ander, an AI intake assistant for The Henry Law Firm in Orlando, Florida.

ABOUT THE FIRM:
- Attorney: LaMya Henry — 25 years of legal experience
- Practice focus: Consumer debt defense — helping Floridians regain peace after financial setbacks
- Free consultations available (typically 10 minutes)
- Phone: (407) 205-8576

WHAT THEY HANDLE:
1. Credit Card Debt — sued for unpaid balances, negotiating or fighting in court
2. Auto Loan Debt & Car Repossession — protecting clients when vehicles are at risk
3. Personal Loans — defending against aggressive collection
4. Medical Bills — negotiating and defending medical debt lawsuits
5. Wage Garnishments — stopping or reducing paycheck garnishments using Florida exemptions
6. Default Judgments — helping clients who missed their court date fight back
7. Judgment Liens — protecting property from creditor claims

KEY LEGAL FACTS (Florida debt defense — you can share these as general info, not legal advice):
- The FDCPA prohibits abusive, unfair, or deceptive collection practices
- Collectors who violate the FDCPA may owe up to $1,000 in statutory damages plus attorney fees
- Florida has a 5-year statute of limitations on written contracts like credit cards
- Debt buyers often lack proper documentation — cases can be dismissed on procedural grounds
- Florida's head of household exemption may protect wages from garnishment
- Many debt lawsuits go uncontested — having an attorney dramatically changes outcomes
- NEVER ignore a debt lawsuit summons — a default judgment can be devastating

YOUR PERSONALITY AND RULES:
- Warm, empathetic, conversational — like a calm, knowledgeable friend who cares
- You CAN explain how things generally work and what rights people have — end with "this is general info, not legal advice"
- You are NOT a lawyer and never pretend to be — you guide like a helpful paralegal
- React to emotions FIRST — acknowledge their feelings before moving forward
- Never list questions back-to-back — one thing at a time with warmth
- Keep responses to 2-3 sentences MAX — this is a chat widget, not an essay
- Zero judgment about debt situations — debt happens to good people
- You've already introduced yourself — do NOT repeat the intro or disclosure again
- You're a TEXT chat assistant — use "I understand", "it seems like", never "I hear you" or "sounds like"
- Do NOT assume emotions before they've shared their situation
- If off-topic, ONE short sentence redirect — warmly
- After 3 consecutive off-topic messages, gracefully close
- If sentiment flags detected (scared, stressed, etc.), acknowledge in ONE sentence before continuing
- When someone has a COURT CASE or GARNISHMENT, ask for the case number and Florida county — LaMya needs this for the consultation
`;

// ─── SPANISH CONTEXT ────────────────────────────────────────────────────────
const FIRM_CONTEXT_ES = `
Eres Ander, un asistente de admisión de IA para The Henry Law Firm en Orlando, Florida.

SOBRE EL BUFETE:
- Abogada: LaMya Henry — 25 años de experiencia legal
- Enfoque: Defensa de deudas del consumidor — ayudando a los floridanos a recuperar la paz después de dificultades financieras
- Consultas gratuitas disponibles (típicamente 10 minutos)
- Teléfono: (407) 205-8576

LO QUE MANEJAN:
1. Deuda de tarjeta de crédito
2. Deuda de préstamo de auto y reposesión
3. Préstamos personales
4. Facturas médicas
5. Embargos de salario — deteniendo o reduciendo embargos usando exenciones de Florida
6. Sentencias por defecto
7. Gravámenes judiciales

TU PERSONALIDAD Y REGLAS:
- Cálido, empático, conversacional — como un amigo tranquilo y conocedor
- PUEDES explicar cómo funcionan las cosas en general — termina con "esta es información general, no asesoría legal"
- NO eres abogado y nunca pretendas serlo
- Reacciona a las emociones PRIMERO
- Respuestas de 2-3 oraciones MÁXIMO
- Cero juicio sobre situaciones de deuda
- Cuando alguien tiene un CASO EN CORTE o EMBARGO, pregunta por el número de caso y el condado de Florida
`;

// ─── PRACTICE AREA CLASSIFICATION ───────────────────────────────────────────
function classifyPracticeArea(text) {
  const t = text.toLowerCase();
  if (t.includes('garnish') || t.includes('paycheck') || t.includes('wages') || t.includes('salary')) return 'Wage Garnishment';
  if (t.includes('repo') || t.includes('repossess') || t.includes('car') || t.includes('auto') || t.includes('vehicle')) return 'Auto Loan / Repossession';
  if (t.includes('medical') || t.includes('hospital') || t.includes('doctor') || t.includes('health')) return 'Medical Bills';
  if (t.includes('credit card') || t.includes('creditcard') || t.includes('capital one') || t.includes('discover') || t.includes('chase')) return 'Credit Card Debt';
  if (t.includes('judgment') || t.includes('default') || t.includes('missed court')) return 'Default Judgment';
  if (t.includes('lien') || t.includes('property')) return 'Judgment Lien';
  if (t.includes('debt') || t.includes('collector') || t.includes('collection') || t.includes('lawsuit') || t.includes('sued') || t.includes('summons') || t.includes('court') || t.includes('owe') || t.includes('creditor')) return 'Debt Collection Defense';
  if (t.includes('personal loan') || t.includes('loan')) return 'Personal Loan';
  return 'General';
}

// ─── DEBT AMOUNT NORMALIZATION ──────────────────────────────────────────────
function normalizeDebtAmount(text) {
  if (!text) return null;
  const t = text.toLowerCase().replace(/,/g, '');
  
  // Match patterns like "$12,000", "12k", "12000", "about 5000", "around $3k"
  const patterns = [
    /\$?([\d.]+)\s*k\b/i,                    // "12k" or "$12k"
    /\$?([\d,]+(?:\.\d{2})?)/,               // "$12,000" or "12000"
    /(?:about|around|roughly|maybe|like)\s*\$?([\d,]+)/i  // "about 5000"
  ];
  
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match) {
      let amount = parseFloat(match[1].replace(/,/g, ''));
      if (t.includes('k') && amount < 1000) amount *= 1000;
      return Math.round(amount * 100); // Store in cents
    }
  }
  return null;
}

function formatDebtAmount(cents) {
  if (!cents) return null;
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ─── COURT DATE DETECTION ───────────────────────────────────────────────────
function detectCourtDate(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const now = new Date();
  const currentYear = now.getFullYear();
  
  // Relative dates
  const relativePatterns = [
    { pattern: /(?:court|hearing|trial|deadline)\s*(?:is\s*)?(?:in\s*)?(\d+)\s*days?/i, type: 'days' },
    { pattern: /(?:court|hearing|trial)\s*(?:is\s*)?(?:next|this)\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i, type: 'weekday' },
    { pattern: /(?:court|hearing|trial)\s*(?:is\s*)?tomorrow/i, type: 'tomorrow' },
    { pattern: /(?:court|hearing|trial)\s*(?:is\s*)?(?:next|this)\s*week/i, type: 'nextweek' },
  ];
  
  // Absolute dates
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const absolutePattern = /(?:court|hearing|trial|deadline).*?(?:on\s*)?(?:the\s*)?(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s*)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i;
  const absolutePattern2 = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(\d{1,2})(?:st|nd|rd|th)?/i;
  const numericPattern = /(?:court|hearing|trial|deadline).*?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i;
  
  for (const { pattern, type } of relativePatterns) {
    const match = t.match(pattern);
    if (match) {
      const date = new Date();
      if (type === 'days') {
        date.setDate(date.getDate() + parseInt(match[1]));
        return date;
      } else if (type === 'tomorrow') {
        date.setDate(date.getDate() + 1);
        return date;
      } else if (type === 'nextweek') {
        date.setDate(date.getDate() + 7);
        return date;
      } else if (type === 'weekday') {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const targetDay = days.indexOf(match[1].toLowerCase());
        const currentDay = date.getDay();
        let daysUntil = targetDay - currentDay;
        if (daysUntil <= 0) daysUntil += 7;
        date.setDate(date.getDate() + daysUntil);
        return date;
      }
    }
  }
  
  // Try absolute patterns
  let match = t.match(absolutePattern) || t.match(absolutePattern2);
  if (match) {
    const day = parseInt(match[1]) || parseInt(match[2]);
    const monthStr = (match[2] || match[1]).toLowerCase().substring(0, 3);
    const month = monthNames.indexOf(monthStr);
    if (month !== -1 && day >= 1 && day <= 31) {
      const date = new Date(currentYear, month, day);
      if (date < now) date.setFullYear(currentYear + 1);
      return date;
    }
  }
  
  // Try numeric pattern (MM/DD or MM/DD/YYYY)
  match = t.match(numericPattern);
  if (match) {
    const month = parseInt(match[1]) - 1;
    const day = parseInt(match[2]);
    let year = match[3] ? parseInt(match[3]) : currentYear;
    if (year < 100) year += 2000;
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      const date = new Date(year, month, day);
      if (date < now && !match[3]) date.setFullYear(currentYear + 1);
      return date;
    }
  }
  
  return null;
}

function daysUntil(date) {
  if (!date) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

// ─── FLORIDA COUNTY DETECTION ───────────────────────────────────────────────
const FLORIDA_COUNTIES = [
  'alachua', 'baker', 'bay', 'bradford', 'brevard', 'broward', 'calhoun', 'charlotte',
  'citrus', 'clay', 'collier', 'columbia', 'desoto', 'dixie', 'duval', 'escambia',
  'flagler', 'franklin', 'gadsden', 'gilchrist', 'glades', 'gulf', 'hamilton', 'hardee',
  'hendry', 'hernando', 'highlands', 'hillsborough', 'holmes', 'indian river', 'jackson',
  'jefferson', 'lafayette', 'lake', 'lee', 'leon', 'levy', 'liberty', 'madison', 'manatee',
  'marion', 'martin', 'miami-dade', 'miami dade', 'monroe', 'nassau', 'okaloosa', 'okeechobee',
  'orange', 'osceola', 'palm beach', 'pasco', 'pinellas', 'polk', 'putnam', 'santa rosa',
  'sarasota', 'seminole', 'st. johns', 'st johns', 'st. lucie', 'st lucie', 'sumter', 'suwannee',
  'taylor', 'union', 'volusia', 'wakulla', 'walton', 'washington'
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

// ─── CASE NUMBER DETECTION ──────────────────────────────────────────────────
function detectCaseNumber(text) {
  if (!text) return null;
  // Florida case numbers typically look like: 2024-CC-001234, 24-SC-12345, etc.
  const patterns = [
    /\b(\d{2,4}[-\s]?[A-Z]{2,3}[-\s]?\d{4,8})\b/i,
    /\bcase\s*#?\s*(\d{4,}[A-Z\-\d]*)/i,
    /\b([A-Z]{2,3}[-\s]?\d{2,4}[-\s]?\d{4,8})\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toUpperCase().replace(/\s/g, '-');
  }
  return null;
}

// ─── TYPING DELAY CALCULATION ───────────────────────────────────────────────
function typingDelay(msg) {
  if (!msg) return 800;
  const l = msg.length;
  if (l < 60) return 750;
  if (l < 120) return 1050;
  if (l < 200) return 1400;
  return 1800;
}

// ─── ENHANCED SCORING ───────────────────────────────────────────────────────
function calcScore(session) {
  let score = 0;
  const breakdown = {};
  const story = (session.story || '').toLowerCase();
  
  // Base completion
  score += 2; breakdown.completedIntake = 2;
  
  // Practice area identified
  if (session.practiceArea && session.practiceArea !== 'General') {
    score += 2; breakdown.knownPracticeArea = 2;
  }
  
  // Court date urgency (highest priority)
  if (session.courtDate) {
    const days = daysUntil(session.courtDate);
    if (days !== null && days <= 3) { score += 3; breakdown.urgentCourtDate = 3; }
    else if (days !== null && days <= 7) { score += 2; breakdown.upcomingCourtDate = 2; }
    else if (days !== null && days <= 14) { score += 1; breakdown.courtDateSet = 1; }
  }
  
  // General urgency signals
  if (session.urgency === 'urgent') { score += 1; breakdown.urgencySignals = 1; }
  
  // Contact info
  if (session.phone) { score += 1; breakdown.phoneProvided = 1; }
  if (session.email) { score += 1; breakdown.emailProvided = 1; }
  
  // Legal action mentioned
  if (story.includes('court') || story.includes('summons') || story.includes('lawsuit') || 
      story.includes('sued') || story.includes('judgment') || story.includes('served')) {
    score += 2; breakdown.legalActionMentioned = 2;
  }
  
  // Garnishment (high urgency)
  if (session.hasGarnishment || story.includes('garnish') || story.includes('paycheck') || story.includes('wages')) {
    score += 2; breakdown.garnishmentMentioned = 2;
  }
  
  // Debt amount known
  if (session.debtAmount && session.debtAmount >= 100000) { // $1000+ in cents
    score += 1; breakdown.significantDebtAmount = 1;
  }
  
  // Case number provided (shows they're organized/ready)
  if (session.caseNumber) { score += 1; breakdown.caseNumberProvided = 1; }
  
  // Detailed story
  if (session.story && session.story.length > 100) { score += 1; breakdown.detailedStory = 1; }
  
  // Document uploaded (shows commitment)
  if (session.documentUrls && session.documentUrls.length > 0) {
    score += 1; breakdown.documentUploaded = 1;
  }
  
  return { score: Math.min(score, 10), breakdown };
}

// ─── FIELD EXTRACTION FROM CONVERSATION ─────────────────────────────────────
function extractFields(session) {
  const userMsgs = session.history.filter(m => m.role === 'user');
  const allText = userMsgs.map(m => m.content).join(' ');
  const latestMsg = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1].content : '';
  
  // First name
  if (!session.firstName) {
    for (const msg of userMsgs) {
      const t = msg.content.trim();
      if (/^[A-Za-z'-]{2,25}$/.test(t)) { session.firstName = t; break; }
      const nm = t.match(/(?:my name is|i['']?m|it['']?s|call me|this is)\s+([A-Za-z'-]{2,25})/i);
      if (nm) { session.firstName = nm[1]; break; }
    }
  }
  
  // Email
  if (!session.email) {
    const em = allText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (em) session.email = em[0].toLowerCase();
  }
  
  // Phone
  if (!session.phone) {
    for (const msg of userMsgs) {
      const d = msg.content.replace(/\D/g, '');
      if (d.length === 10 || d.length === 11) {
        session.phone = msg.content.trim();
        break;
      }
    }
  }
  
  // Story
  if (!session.story) {
    for (const msg of userMsgs) {
      if (msg.content.trim().length > 30) {
        session.story = msg.content.trim();
        break;
      }
    }
  }
  
  // Debt amount (normalized)
  if (!session.debtAmount) {
    const amount = normalizeDebtAmount(allText);
    if (amount) {
      session.debtAmount = amount;
      session.debtAmountRaw = allText.match(/\$?[\d,]+(?:\.\d{2})?k?/i)?.[0] || null;
    }
  }
  
  // Court date detection
  if (!session.courtDate) {
    const courtDate = detectCourtDate(allText);
    if (courtDate) {
      session.courtDate = courtDate;
      session.courtDateRaw = allText.match(/(?:court|hearing|trial|deadline)[^.!?]*/i)?.[0] || null;
    }
  }
  
  // Case number (if awaiting or detected)
  if (!session.caseNumber) {
    const caseNum = detectCaseNumber(latestMsg);
    if (caseNum) session.caseNumber = caseNum;
  }
  
  // County
  if (!session.county) {
    const county = detectCounty(allText);
    if (county) session.county = county;
  }
  
  // Detect if this is a court case or garnishment (needs case #)
  const hasLegalAction = /\b(court|lawsuit|sued|summons|served|case|hearing|trial|judgment)\b/i.test(allText);
  const hasGarnishment = /\b(garnish|garnishment|wages|paycheck|salary)\b/i.test(allText);
  session.hasCourtCase = hasLegalAction;
  session.hasGarnishment = hasGarnishment;
  
  // Sentiment detection (expanded)
  const sentimentMap = {
    scared: ['scared', 'afraid', 'terrified', 'fear', 'frightened', 'nervous', 'worried'],
    embarrassed: ['embarrassed', 'ashamed', 'humiliated', 'embarrassing'],
    stressed: ['stressed', 'overwhelmed', 'anxious', 'anxiety', 'stress', 'panic', 'panicking'],
    desperate: ['desperate', 'hopeless', 'no way out', 'lost', "don't know what to do"],
    angry: ['angry', 'furious', 'mad', 'frustrated', 'unfair', 'ridiculous', 'harassment'],
    confused: ['confused', 'confusing', "don't understand", 'lost', 'unclear'],
    hopeful: ['hopeful', 'hope', 'optimistic', 'believe', 'confident']
  };
  
  const lower = allText.toLowerCase();
  for (const [flag, words] of Object.entries(sentimentMap)) {
    if (!session.sentimentFlags.includes(flag) && words.some(w => lower.includes(w))) {
      session.sentimentFlags.push(flag);
    }
  }
  
  // Practice area classification
  if (!session.practiceArea || session.practiceArea === 'General') {
    const area = classifyPracticeArea(allText);
    if (area !== 'General') session.practiceArea = area;
  }
  
  // Urgency detection
  if (!session.urgency || session.urgency === 'standard') {
    const u = allText.toLowerCase();
    const hasUrgency = u.includes('court') || u.includes('deadline') || u.includes('urgent') ||
      u.includes('garnish') || u.includes('lawsuit') || u.includes('summons') ||
      u.includes('repo') || u.includes('levy') || u.includes('tomorrow') ||
      u.includes('next week') || u.includes('few days');
    session.urgency = hasUrgency ? 'urgent' : 'standard';
  }
  
  console.log('📊 SESSION:', JSON.stringify({
    firstName: session.firstName, email: session.email, phone: session.phone,
    debtAmount: formatDebtAmount(session.debtAmount), courtDate: session.courtDate,
    caseNumber: session.caseNumber, county: session.county,
    hasCourtCase: session.hasCourtCase, hasGarnishment: session.hasGarnishment,
    sentimentFlags: session.sentimentFlags, practiceArea: session.practiceArea,
    intakeComplete: session.intakeComplete
  }));
}

// ─── STATE SUMMARY FOR CLAUDE ───────────────────────────────────────────────
function buildStateSummary(session) {
  const needsCaseInfo = (session.hasCourtCase || session.hasGarnishment) && (!session.caseNumber || !session.county);
  
  return `
CURRENT INTAKE STATE:
- First name: ${session.firstName ? 'YES — ' + session.firstName : 'NOT YET'}
- Story/situation: ${session.story ? 'YES' : 'NOT YET'}
- Email: ${session.email ? 'YES — ' + session.email : 'NOT YET'}
- Phone: ${session.phone ? 'YES' : 'NOT YET'}
- Practice area: ${session.practiceArea || 'NOT YET'}
- Debt amount: ${session.debtAmount ? formatDebtAmount(session.debtAmount) : 'NOT MENTIONED'}
- Court date detected: ${session.courtDate ? session.courtDate.toLocaleDateString() + ' (' + daysUntil(session.courtDate) + ' days away)' : 'NONE'}
- Has court case or garnishment: ${session.hasCourtCase || session.hasGarnishment ? 'YES' : 'NO'}
- Case number: ${session.caseNumber || 'NOT YET'}
- Florida county: ${session.county || 'NOT YET'}
- Sentiment detected: ${session.sentimentFlags.length > 0 ? session.sentimentFlags.join(', ') : 'none'}

INTAKE COLLECTION ORDER:
1. Name (if not collected)
2. Their situation in their own words (if no story yet)
3. IF they have a court case or garnishment AND missing case number or county: ask for the court case number and which Florida county the case is in — LaMya needs this for the 10-minute consultation
4. Email address — say "just so the team can follow up with you by email too" (if no email)
5. Phone number — say "no spam, LaMya will call you directly" (if no phone)
6. Once phone is collected → DO NOT say goodbye. System handles closing. Just warmly confirm their phone.

${needsCaseInfo ? 'IMPORTANT: This person has a court case or garnishment. Before asking for email/phone, ask: "Can you share the court case number and which Florida county the case is in? LaMya will need that for your consultation."' : ''}

RULES:
- NEVER ask for info already collected
- Answer legal questions briefly (2 sentences) then continue intake — end with "this is general info, not legal advice"
- 2-3 sentences MAX per response
- If sentiment flags present, acknowledge in ONE sentence before continuing
- If court date is very soon (within 7 days), acknowledge the urgency
`;
}

// ─── CLAUDE CONVERSATION ────────────────────────────────────────────────────
async function askClaude(session) {
  const context = session.language === 'es' ? FIRM_CONTEXT_ES : FIRM_CONTEXT;
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    system: context + '\n\n' + buildStateSummary(session),
    messages: session.history
  });
  return response.content[0].text;
}

// ─── EMAIL NOTIFICATIONS ────────────────────────────────────────────────────
async function sendFirmNotification(session, score, breakdown) {
  const urgencyLabel = score >= 8 ? '🔴 HIGH PRIORITY' : score >= 5 ? '🟡 MODERATE' : '🟢 STANDARD';
  const courtDateHtml = session.courtDate ? `
    <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:16px;">
      <p style="margin:0;font-size:13px;font-weight:600;color:#ef4444;">⚠️ COURT DATE: ${session.courtDate.toLocaleDateString()} (${daysUntil(session.courtDate)} days)</p>
    </div>` : '';
  
  const transcriptHtml = session.history.map(m => `
    <div style="margin-bottom:12px;">
      <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:${m.role === 'user' ? '#1d4ed8' : '#166534'};">
        ${m.role === 'user' ? (session.firstName || 'Client') : 'Ander'}
      </span>
      <p style="margin:3px 0 0;font-size:13px;color:#0d1b2a;line-height:1.5;">${m.content}</p>
    </div>
  `).join('');
  
  const scoreRows = Object.entries(breakdown).map(([k, v]) => `
    <tr>
      <td style="padding:4px 10px;font-size:12px;color:#6b7280;">${k}</td>
      <td style="padding:4px 10px;font-size:12px;font-weight:600;color:#0d1b2a;">+${v}</td>
    </tr>
  `).join('');
  
  const sentimentHtml = session.sentimentFlags.length > 0 ? `
    <div style="background:#fffbeb;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
      <p style="font-size:11px;color:#92400e;text-transform:uppercase;font-weight:600;margin:0 0 6px 0;">Sentiment Flags</p>
      <p style="font-size:13px;color:#0d1b2a;margin:0;">${session.sentimentFlags.join(', ')}</p>
    </div>` : '';

  const caseInfoHtml = (session.caseNumber || session.county) ? `
    <tr style="background:#f8f7f5;">
      <td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Case Number</td>
      <td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${session.caseNumber || 'Not provided'}</td>
    </tr>
    <tr>
      <td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">County</td>
      <td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${session.county || 'Not provided'}</td>
    </tr>` : '';
  
  try {
    await resend.emails.send({
      from: 'Ander at Fern Stellar <ander@fernstellar.com>',
      to: [process.env.FIRM_EMAIL],
      subject: `${urgencyLabel} New Intake — ${session.firstName || 'Unknown'} | ${session.practiceArea || 'General'} | Score: ${score}/10`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;background:#f5f0e8;padding:32px;">
          <div style="background:#0d1b2a;padding:24px 28px;border-radius:12px 12px 0 0;">
            <p style="color:#c9a84c;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px 0;">New Intake · The Henry Law Firm</p>
            <h1 style="color:#fff;font-size:20px;margin:0;display:inline-block;">Ander AI Intake</h1>
            <span style="float:right;background:rgba(201,168,76,.15);border:1px solid rgba(201,168,76,.3);border-radius:8px;padding:6px 14px;color:#e8c96a;font-size:20px;font-weight:700;">${score}/10</span>
          </div>
          <div style="background:#fff;padding:28px;border-radius:0 0 12px 12px;">
            ${courtDateHtml}
            <div style="background:${score >= 8 ? '#fef2f2' : score >= 5 ? '#fffbeb' : '#f0fdf4'};border-left:4px solid ${score >= 8 ? '#ef4444' : score >= 5 ? '#f59e0b' : '#22c55e'};padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:24px;">
              <p style="margin:0;font-size:13px;font-weight:600;color:#0d1b2a;">${urgencyLabel} — ${score >= 7 ? `Call ${session.firstName} within the hour.` : score >= 4 ? 'Follow up within 24 hours.' : 'Follow up when available.'}</p>
            </div>
            <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
              <tr style="background:#f8f7f5;">
                <td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;width:120px;">Name</td>
                <td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${session.firstName || 'Not provided'}</td>
              </tr>
              <tr>
                <td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Phone</td>
                <td style="padding:10px 14px;font-size:14px;"><a href="tel:${session.phone}" style="color:#c9a84c;">${session.phone || 'Not provided'}</a></td>
              </tr>
              <tr style="background:#f8f7f5;">
                <td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Email</td>
                <td style="padding:10px 14px;font-size:14px;"><a href="mailto:${session.email}" style="color:#c9a84c;">${session.email || 'Not provided'}</a></td>
              </tr>
              <tr>
                <td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Practice Area</td>
                <td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${session.practiceArea || 'General'}</td>
              </tr>
              <tr style="background:#f8f7f5;">
                <td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Debt Amount</td>
                <td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${formatDebtAmount(session.debtAmount) || 'Not mentioned'}</td>
              </tr>
              <tr>
                <td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Urgency</td>
                <td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${session.urgency === 'urgent' ? '⚠️ Time-sensitive' : 'Standard'}</td>
              </tr>
              ${caseInfoHtml}
            </table>
            ${sentimentHtml}
            <div style="background:#f8f7f5;border-radius:10px;padding:18px 20px;margin-bottom:20px;">
              <p style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:600;margin:0 0 8px 0;">In Their Own Words</p>
              <p style="font-size:14px;color:#0d1b2a;line-height:1.6;margin:0;font-style:italic;">"${session.story || 'Not provided'}"</p>
            </div>
            <div style="background:#f8f7f5;border-radius:10px;padding:18px 20px;margin-bottom:20px;">
              <p style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:600;margin:0 0 10px 0;">Score Breakdown</p>
              <table style="width:100%;border-collapse:collapse;">${scoreRows}</table>
            </div>
            <div style="background:#f0fdf4;border-radius:10px;padding:18px 20px;margin-bottom:20px;">
              <p style="font-size:11px;color:#166534;text-transform:uppercase;font-weight:600;margin:0 0 12px 0;">Full Conversation Transcript</p>
              ${transcriptHtml}
            </div>
            <div style="text-align:center;padding-top:16px;border-top:1px solid rgba(0,0,0,.06);">
              <p style="font-size:11px;color:#9ca3af;margin:0;">Powered by <strong style="color:#0d1b2a;">Ander</strong> · <strong style="color:#0d1b2a;">Fern Stellar</strong></p>
            </div>
          </div>
        </div>
      `
    });
    console.log('✅ Firm notification sent for', session.firstName);
  } catch (err) {
    console.error('❌ Firm email failed:', JSON.stringify(err));
  }
}

async function sendClientConfirmation(session) {
  if (!session.email) return;
  try {
    await resend.emails.send({
      from: 'The Henry Law Firm via Ander <ander@fernstellar.com>',
      to: [session.email],
      subject: `${session.firstName}, we received your information — The Henry Law Firm`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f5f0e8;padding:32px;">
          <div style="background:#0d1b2a;padding:24px 28px;border-radius:12px 12px 0 0;">
            <p style="color:#c9a84c;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px 0;">The Henry Law Firm · Orlando, FL</p>
            <h1 style="color:#fff;font-size:20px;margin:0;">We've received your information</h1>
          </div>
          <div style="background:#fff;padding:28px;border-radius:0 0 12px 12px;">
            <p style="font-size:15px;color:#0d1b2a;line-height:1.7;">Hi ${session.firstName},</p>
            <p style="font-size:15px;color:#0d1b2a;line-height:1.7;">Thank you for reaching out to The Henry Law Firm. Your intake has been received and LaMya will be in touch within 24 hours.</p>
            <p style="font-size:15px;color:#0d1b2a;line-height:1.7;">If you'd like to lock in a time right now, you can schedule a free 10-minute consultation here:</p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${CALENDLY_LINK}" style="background:#0d1b2a;color:#e8c96a;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">📅 Schedule a Free Consultation</a>
            </div>
            <p style="font-size:13px;color:#6b7280;line-height:1.6;">This message was sent on behalf of The Henry Law Firm by Ander, an AI intake assistant. Nothing in this email constitutes legal advice.</p>
            <div style="text-align:center;padding-top:16px;border-top:1px solid rgba(0,0,0,.06);margin-top:16px;">
              <p style="font-size:11px;color:#9ca3af;margin:0;">Powered by <strong style="color:#0d1b2a;">Ander</strong> · <strong style="color:#0d1b2a;">Fern Stellar</strong></p>
            </div>
          </div>
        </div>
      `
    });
    console.log('✅ Client confirmation sent to', session.email);
  } catch (err) {
    console.error('❌ Client email failed:', JSON.stringify(err));
  }
}

// ─── SAVE INTAKE TO DATABASE ────────────────────────────────────────────────
async function saveIntake(session, score, breakdown) {
  try {
    const intake = new Intake({
      sessionId: session.sessionId,
      firstName: session.firstName || 'Unknown',
      email: session.email || null,
      phone: session.phone || null,
      practiceArea: session.practiceArea || 'General',
      story: session.story || null,
      urgency: session.urgency || 'standard',
      score,
      scoreBreakdown: breakdown,
      debtAmount: session.debtAmount || null,
      debtAmountRaw: session.debtAmountRaw || null,
      courtDate: session.courtDate || null,
      courtDateRaw: session.courtDateRaw || null,
      caseNumber: session.caseNumber || null,
      county: session.county || null,
      hasCourtCase: session.hasCourtCase || false,
      hasGarnishment: session.hasGarnishment || false,
      daysUntilCourt: session.courtDate ? daysUntil(session.courtDate) : null,
      sentimentFlags: session.sentimentFlags || [],
      documentUrls: session.documentUrls || [],
      firmName: 'The Henry Law Firm',
      transcript: session.history,
      language: session.language || 'en',
      completedAt: new Date(),
      status: 'new'
    });
    await intake.save();
    console.log('✅ Intake saved to MongoDB:', intake._id);
    return intake;
  } catch (err) {
    console.error('❌ MongoDB save failed:', err.message);
    return null;
  }
}

// ─── API ROUTES ─────────────────────────────────────────────────────────────

const disclosureMessage = "Hey there 👋 — I'm Ander. Before we get started, just want to be upfront: I'm an AI, not a lawyer, and nothing I say is legal advice.\n\nI'm here to walk you through a quick intake so the right people at The Henry Law Firm can take a look at your situation and reach out.\n\nWhenever you're ready, just say \"I understand\" and we'll jump in. 😊";
const disclosureMessageES = "Hola 👋 — Soy Ander. Antes de comenzar, quiero ser claro: soy una IA, no un abogado, y nada de lo que digo es asesoría legal.\n\nEstoy aquí para guiarte a través de una breve admisión para que el equipo de The Henry Law Firm pueda revisar tu situación.\n\nCuando estés listo, solo di \"Entiendo\" y comenzamos. 😊";

const disclosureAccepted = (val) => {
  const v = val.trim().toLowerCase();
  return ['i understand', 'ok', 'okay', 'yes', 'sure', 'got it', 'understood', 'ready', "let's go", 'lets go', 'go', 'entiendo', 'si', 'sí', 'listo', 'lista', 'ok', 'de acuerdo'].includes(v);
};

app.get('/api/start', (req, res) => {
  const sessionId = crypto.randomUUID();
  const lang = req.query.lang === 'es' ? 'es' : 'en';
  const message = lang === 'es' ? disclosureMessageES : disclosureMessage;
  res.json({ step: 0, sessionId, message, type: 'text', options: [], delay: typingDelay(message), language: lang });
});

app.post('/api/message', async (req, res) => {
  const { step, userMessage, sessionId, language } = req.body;
  const sid = sessionId || crypto.randomUUID();
  const session = getSession(sid);
  if (language) session.language = language;

  // Step 0: Disclosure acceptance
  if (step === 0) {
    if (!disclosureAccepted(userMessage)) {
      const msg = session.language === 'es'
        ? 'No hay problema — solo escribe "Entiendo" cuando te sientas cómodo y comenzamos. 😊'
        : 'No worries — just type "I understand" whenever you\'re comfortable and we\'ll get started! 😊';
      return res.json({ done: false, step: 0, sessionId: sid, message: msg, type: 'text', options: [], delay: 800 });
    }
    const msg = session.language === 'es'
      ? '¡Perfecto! Primero — ¿cómo te llamas?'
      : "Great! First things first — what's your name?";
    return res.json({ done: false, step: 1, sessionId: sid, message: msg, type: 'text', options: [], delay: 750 });
  }

  // Already complete
  if (session.intakeComplete) {
    return res.json({ done: true, step, sessionId: sid, message: null, type: 'text', options: [], delay: 0 });
  }

  try {
    session.history.push({ role: 'user', content: userMessage });
    extractFields(session);

    // Off-topic detection
    const debtKeywords = ['debt', 'garnish', 'credit', 'collector', 'lawsuit', 'levy', 'fdcpa', 'summons', 'repo', 'medical', 'lien', 'judgment', 'lawyer', 'attorney', 'court', 'bank', 'loan', 'owe', 'payment', 'balance', 'sue', 'help', 'problem', 'issue', 'situation', 'money', 'bill', 'creditor', 'collection', 'deuda', 'embargo', 'abogado', 'corte', 'demanda'];
    const hasDebtIntent = debtKeywords.some(k => userMessage.toLowerCase().includes(k));
    if (!hasDebtIntent && !session.story) {
      session.offTopicCount = (session.offTopicCount || 0) + 1;
    } else {
      session.offTopicCount = 0;
    }

    // Close after 3 off-topic
    if (session.offTopicCount >= 3) {
      session.intakeComplete = true;
      const closeMsg = session.language === 'es'
        ? "Parece que no soy la mejor opción para lo que necesitas ahora. No dudes en volver si tienes alguna pregunta sobre deudas — The Henry Law Firm está aquí. 🌿"
        : "It looks like I might not be the right fit for what you need right now. Feel free to come back if you ever have a debt question — The Henry Law Firm is here. 🌿";
      session.history.push({ role: 'assistant', content: closeMsg });
      return res.json({ done: true, step: step + 1, sessionId: sid, message: closeMsg, type: 'text', options: [], delay: 800 });
    }

    // Check if intake complete (needs case info for garnishment/court cases)
    const needsCaseInfo = (session.hasCourtCase || session.hasGarnishment) && (!session.caseNumber || !session.county);
    const coreComplete = session.phone && session.story && session.firstName;
    
    if (coreComplete && !needsCaseInfo && !session.intakeComplete) {
      session.intakeComplete = true;
      const { score, breakdown } = calcScore(session);
      
      // Async notifications
      Promise.all([
        saveIntake(session, score, breakdown),
        sendFirmNotification(session, score, breakdown),
        sendClientConfirmation(session)
      ]).catch(err => console.error('❌ Post-intake failed:', err));

      const closingMessage = session.language === 'es'
        ? `¡Todo listo, ${session.firstName}! 🌿 He enviado tu información al equipo de The Henry Law Firm — LaMya se pondrá en contacto contigo dentro de 24 horas.\n\nSi prefieres reservar un horario ahora, aquí está su calendario:\n\n¡Tú puedes! 💛`
        : `You're all set, ${session.firstName}! 🌿 I've passed everything along to The Henry Law Firm team — LaMya will be reaching out to you within 24 hours.\n\nIf you'd like to lock in a time right now, you can book a free 10-minute consultation below.\n\nYou've got this. 💛`;
      
      session.history.push({ role: 'assistant', content: closingMessage });
      
      return res.json({
        done: true,
        step: step + 1,
        sessionId: sid,
        message: closingMessage,
        calendlyLink: CALENDLY_LINK,
        type: 'text',
        options: [],
        delay: typingDelay(closingMessage)
      });
    }

    // Build progress
    const progress = {
      name: !!session.firstName,
      story: !!session.story,
      caseInfo: !needsCaseInfo,
      email: !!session.email,
      phone: !!session.phone
    };

    // Get Claude response
    const anderResponse = await askClaude(session);
    session.history.push({ role: 'assistant', content: anderResponse });

    return res.json({
      done: false,
      step: step + 1,
      sessionId: sid,
      message: anderResponse,
      progress,
      type: 'text',
      options: [],
      delay: typingDelay(anderResponse)
    });

  } catch (err) {
    console.error('❌ Error:', err.message);
    const errorMsg = session.language === 'es'
      ? 'Lo siento, algo salió mal. ¿Podrías intentarlo de nuevo?'
      : "I'm sorry, something went wrong on my end. Could you try that again?";
    return res.json({ done: false, step, sessionId: sid, message: errorMsg, type: 'text', options: [], delay: 800 });
  }
});

// Document upload endpoint
app.post('/api/upload', upload.single('document'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }
  
  const sessionId = req.body.sessionId;
  if (sessionId) {
    const session = getSession(sessionId);
    session.documentUrls.push(`/secure-uploads/${req.file.filename}`);
  }
  
  res.json({
    success: true,
    filename: req.file.filename,
    message: "Document uploaded securely. This will help LaMya prepare for your consultation."
  });
});

// ─── CRM INTEGRATION HOOKS (Ready to deploy) ────────────────────────────────
// These are placeholder functions ready to implement when CRM is known

async function syncToCRM(intake, provider) {
  // Supported providers: 'clio', 'mycase', 'practicepanther', 'lawmatics'
  console.log(`🔄 CRM sync requested for ${intake._id} to ${provider}`);
  
  switch (provider) {
    case 'clio':
      return await syncToClio(intake);
    case 'mycase':
      return await syncToMyCase(intake);
    case 'practicepanther':
      return await syncToPracticePanther(intake);
    default:
      console.log('❓ Unknown CRM provider:', provider);
      return null;
  }
}

async function syncToClio(intake) {
  // Placeholder for Clio API integration
  // Requires CLIO_CLIENT_ID, CLIO_CLIENT_SECRET, CLIO_ACCESS_TOKEN
  console.log('📤 Clio sync placeholder for:', intake.firstName);
  return null;
}

async function syncToMyCase(intake) {
  // Placeholder for MyCase API integration
  console.log('📤 MyCase sync placeholder for:', intake.firstName);
  return null;
}

async function syncToPracticePanther(intake) {
  // Placeholder for PracticePanther API integration
  console.log('📤 PracticePanther sync placeholder for:', intake.firstName);
  return null;
}

// Manual CRM sync endpoint (for dashboard)
app.post('/api/intakes/:id/sync-crm', async (req, res) => {
  const { provider } = req.body;
  if (!provider) {
    return res.status(400).json({ success: false, error: 'CRM provider required' });
  }
  
  try {
    const intake = await Intake.findById(req.params.id);
    if (!intake) return res.status(404).json({ success: false, error: 'Not found' });
    
    const crmId = await syncToCRM(intake, provider);
    if (crmId) {
      intake.crmId = crmId;
      intake.crmProvider = provider;
      intake.crmSyncedAt = new Date();
      await intake.save();
    }
    
    res.json({ success: true, crmId, synced: !!crmId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DASHBOARD API ROUTES ───────────────────────────────────────────────────

app.get('/api/intakes', async (req, res) => {
  try {
    const { status, search, urgency } = req.query;
    let query = {};
    
    if (status && status !== 'all') query.status = status;
    if (urgency === 'court') query.courtDate = { $ne: null };
    if (urgency === 'urgent') query.urgency = 'urgent';
    
    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { practiceArea: { $regex: search, $options: 'i' } },
        { story: { $regex: search, $options: 'i' } },
        { caseNumber: { $regex: search, $options: 'i' } },
        { county: { $regex: search, $options: 'i' } }
      ];
    }
    
    const intakes = await Intake.find(query).sort({ createdAt: -1 });
    res.json({ success: true, intakes, total: intakes.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/intakes/stats', async (req, res) => {
  try {
    const total = await Intake.countDocuments();
    const newLeads = await Intake.countDocuments({ status: 'new' });
    const highPriority = await Intake.countDocuments({ score: { $gte: 8 } });
    const converted = await Intake.countDocuments({ status: 'converted' });
    const contacted = await Intake.countDocuments({ status: 'contacted' });
    const closed = await Intake.countDocuments({ status: 'closed' });
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = await Intake.countDocuments({ createdAt: { $gte: today } });
    
    // Upcoming court dates
    const upcomingCourt = await Intake.countDocuments({
      courtDate: { $gte: new Date(), $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      status: { $nin: ['converted', 'closed'] }
    });
    
    const overdueFollowUps = await Intake.countDocuments({
      followUpDate: { $lte: new Date() },
      status: { $nin: ['converted', 'closed'] }
    });
    
    // Conversion funnel
    const funnel = {
      total,
      new: newLeads,
      contacted,
      converted,
      closed,
      conversionRate: total > 0 ? Math.round((converted / total) * 100) : 0
    };
    
    res.json({
      success: true,
      stats: { total, newLeads, highPriority, converted, todayCount, overdueFollowUps, upcomingCourt },
      funnel
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/intakes/export/csv', async (req, res) => {
  try {
    const intakes = await Intake.find().sort({ createdAt: -1 });
    const headers = ['Date', 'Name', 'Phone', 'Email', 'Practice Area', 'Score', 'Urgency', 'Debt Amount', 'Court Date', 'Case Number', 'County', 'Sentiment', 'Status', 'Notes', 'Story'];
    const rows = intakes.map(i => [
      new Date(i.createdAt).toLocaleDateString(),
      i.firstName || '',
      i.phone || '',
      i.email || '',
      i.practiceArea || '',
      i.score || 0,
      i.urgency || '',
      i.debtAmount ? (i.debtAmount / 100).toFixed(0) : '',
      i.courtDate ? new Date(i.courtDate).toLocaleDateString() : '',
      i.caseNumber || '',
      i.county || '',
      (i.sentimentFlags || []).join('; '),
      i.status || '',
      (i.notes || '').replace(/,/g, ';'),
      (i.story || '').replace(/,/g, ';').replace(/\n/g, ' ')
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="ander-leads.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/intakes/:id', async (req, res) => {
  try {
    const intake = await Intake.findById(req.params.id);
    if (!intake) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, intake });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/intakes/:id', async (req, res) => {
  try {
    const { status, notes, followUpDate } = req.body;
    const update = {};
    if (status !== undefined) update.status = status;
    if (notes !== undefined) update.notes = notes;
    if (followUpDate !== undefined) update.followUpDate = followUpDate ? new Date(followUpDate) : null;
    
    const intake = await Intake.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!intake) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, intake });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/intakes/:id', async (req, res) => {
  try {
    await Intake.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html');
});

// ─── SERVER START ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 Fern Stellar · Ander v2 running on http://localhost:${PORT}`);
});
