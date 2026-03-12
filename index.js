require('dotenv').config();
const express = require('express');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');
const mongoose = require('mongoose');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// ─── MongoDB Connection ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('🍃 MongoDB connected — Ander CRM ready'))
  .catch(err => console.error('❌ MongoDB connection failed:', err));

// ─── Intake Schema ────────────────────────────────────────────────────────────
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
  firmName:       { type: String, default: 'Henry Law Firm' },
  transcript:     { type: Array, default: [] },
  createdAt:      { type: Date, default: Date.now },
  completedAt:    { type: Date, default: null },
  status:         { type: String, default: 'new' }
});

const Intake = mongoose.model('Intake', intakeSchema);

// ─── Server-side session store ────────────────────────────────────────────────
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      firstName: null,
      email: null,
      phone: null,
      practiceArea: null,
      story: null,
      urgency: null,
      intakeComplete: false,
      history: []
    });
  }
  return sessions.get(sessionId);
}

// ─── Clients ──────────────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CALENDLY_LINK = 'https://calendly.com/lhenry-lawfirm';

// ─── Firm Context ─────────────────────────────────────────────────────────────
const FIRM_CONTEXT = `
You are Ander, an AI intake assistant for Henry Law Firm in Orlando, Florida.

ABOUT THE FIRM:
- Attorney: LaMya Henry — 22 years experience, former prosecutor
- Practice focus: Consumer debt defense
- Free consultations available

PRACTICE AREAS:
1. Debt Collection Defense — defending clients sued by debt collectors
2. FDCPA Violations — pursuing compensation when collectors break the law
3. Credit Card Lawsuits — negotiating settlements or fighting in court
4. Wage Garnishment — stopping or reducing garnishments on paychecks
5. Debt Negotiation — negotiating directly with creditors to reduce balances
6. Bank Levy Defense — responding fast to protect client funds from levies

KEY LEGAL FACTS (Florida debt defense):
- The FDCPA prohibits abusive, unfair, or deceptive collection practices
- Collectors who violate the FDCPA may owe the debtor up to $1,000 in statutory damages plus attorney fees
- Florida has a 5-year statute of limitations on written contracts like credit cards
- Debt buyers often lack proper documentation — cases can be dismissed on procedural grounds
- Wage garnishment in Florida is limited — head of household exemption may protect income
- Many debt collection lawsuits go uncontested — having an attorney changes outcomes dramatically
- Clients should NEVER ignore a debt lawsuit summons — a default judgment can be devastating

YOUR PERSONALITY AND RULES:
- Warm, empathetic, conversational — like a calm knowledgeable friend
- NEVER give specific legal advice
- CAN explain how things generally work and what rights they have — always end with "this is general info, not legal advice"
- NOT a lawyer, never pretend to be
- React to emotions first — acknowledge before moving forward
- Never list questions back to back — one thing at a time with warmth
- Keep responses to 2-3 sentences MAX — this is a chat widget, not an essay
- Zero judgment about debt situations
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function classifyPracticeArea(text) {
  const t = text.toLowerCase();
  if (t.includes('divorce') || t.includes('custody') || t.includes('child support') || t.includes('alimony') || t.includes('spouse') || t.includes('husband') || t.includes('wife')) return 'Family Law';
  if (t.includes('will') || t.includes('trust') || t.includes('estate') || t.includes('inherit') || t.includes('guardian') || t.includes('power of attorney')) return 'Estate Planning';
  if (t.includes('probate') || t.includes('deceased') || t.includes('passed away') || t.includes('died') || t.includes('executor')) return 'Probate';
  if (t.includes('real estate') || t.includes('closing') || t.includes('mortgage') || t.includes('title')) return 'Real Estate';
  if (t.includes('debt') || t.includes('garnish') || t.includes('credit card') || t.includes('collector') || t.includes('lawsuit') || t.includes('levy') || t.includes('fdcpa') || t.includes('summons') || t.includes('repo') || t.includes('medical bill') || t.includes('lien') || t.includes('judgment')) return 'Debt Defense';
  return 'General';
}

function typingDelay(message) {
  if (!message) return 800;
  const len = message.length;
  if (len < 60) return 750;
  if (len < 120) return 1050;
  if (len < 200) return 1400;
  return 1800;
}

function calcScore(session) {
  let score = 0;
  const breakdown = {};
  const story = (session.story || '').toLowerCase();

  score += 2; breakdown.completedIntake = 2;
  if (session.practiceArea && session.practiceArea !== 'General') { score += 2; breakdown.knownPracticeArea = 2; }
  if (session.urgency === 'urgent') { score += 2; breakdown.urgency = 2; }
  if (session.phone) { score += 1; breakdown.phoneProvided = 1; }
  if (session.email) { score += 1; breakdown.emailProvided = 1; }
  if (story.includes('court') || story.includes('summons') || story.includes('lawsuit') || story.includes('sued') || story.includes('judgment')) { score += 2; breakdown.legalActionMentioned = 2; }
  if (story.includes('garnish') || story.includes('paycheck') || story.includes('wages')) { score += 2; breakdown.garnishmentMentioned = 2; }
  if (/\$[\d,]+|\d+k|\d+,\d{3}/.test(story)) { score += 1; breakdown.amountMentioned = 1; }
  if (session.story && session.story.length > 100) { score += 1; breakdown.detailedStory = 1; }

  return { score: Math.min(score, 10), breakdown };
}

function extractFields(session) {
  const userMsgs = session.history.filter(m => m.role === 'user');
  const allText = userMsgs.map(m => m.content).join(' ');

  // NAME
  if (!session.firstName) {
    for (const msg of userMsgs) {
      const t = msg.content.trim();
      if (/^[A-Za-z'-]{2,25}$/.test(t)) { session.firstName = t; break; }
      const nameMatch = t.match(/(?:my name is|i['']?m|it['']?s|call me)\s+([A-Za-z'-]{2,25})/i);
      if (nameMatch) { session.firstName = nameMatch[1]; break; }
    }
  }

  // EMAIL
  if (!session.email) {
    const emailMatch = allText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) session.email = emailMatch[0].toLowerCase();
  }

  // PHONE — strict 10 or 11 digits only
  if (!session.phone) {
    for (const msg of userMsgs) {
      const digits = msg.content.replace(/\D/g, '');
      if (digits.length === 10 || digits.length === 11) {
        session.phone = msg.content.trim();
        break;
      }
    }
  }

  // STORY — first message longer than 30 chars
  if (!session.story) {
    for (const msg of userMsgs) {
      if (msg.content.trim().length > 30) {
        session.story = msg.content.trim();
        break;
      }
    }
  }

  // PRACTICE AREA
  if (!session.practiceArea || session.practiceArea === 'General') {
    const area = classifyPracticeArea(allText);
    if (area !== 'General') session.practiceArea = area;
  }

  // URGENCY
  if (!session.urgency) {
    const u = allText.toLowerCase();
    session.urgency = (u.includes('court') || u.includes('deadline') || u.includes('urgent') || u.includes('garnish') || u.includes('creditor') || u.includes('lawsuit') || u.includes('summons') || u.includes('repo') || u.includes('levy')) ? 'urgent' : 'standard';
  }

  console.log('📊 SESSION:', JSON.stringify({
    firstName: session.firstName,
    email: session.email,
    phone: session.phone,
    story: session.story ? session.story.substring(0, 40) + '...' : null,
    practiceArea: session.practiceArea,
    intakeComplete: session.intakeComplete
  }));
}

function buildStateSummary(session) {
  return `
CURRENT INTAKE STATE:
- First name: ${session.firstName ? 'YES — ' + session.firstName : 'NOT YET'}
- Story/situation: ${session.story ? 'YES' : 'NOT YET'}
- Email: ${session.email ? 'YES — ' + session.email : 'NOT YET'}
- Phone: ${session.phone ? 'YES' : 'NOT YET'}
- Practice area: ${session.practiceArea || 'NOT YET'}

INTAKE COLLECTION ORDER:
1. Name (if not collected)
2. Their situation in their own words (if no story yet)
3. Email address — say "just so the team can follow up with you by email too" (if no email)
4. Phone number — say "no spam, LaMya will call you directly" (if no phone)
5. Once phone is collected → DO NOT say goodbye or wrap up. The system handles the closing. Just warmly confirm their phone number.

RULES:
- NEVER ask for info already collected — check the state above
- If they ask a legal question, answer it briefly (2 sentences) then continue the intake
- 2-3 sentences MAX per response
`;
}

async function askClaude(session) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 180,
    system: FIRM_CONTEXT + '\n\n' + buildStateSummary(session),
    messages: session.history
  });
  return response.content[0].text;
}

// ─── Firm Notification Email ──────────────────────────────────────────────────
async function sendFirmNotification(session, score, breakdown) {
  const urgencyLabel = score >= 8 ? '🔴 HIGH PRIORITY' : score >= 5 ? '🟡 MODERATE' : '🟢 STANDARD';
  const transcriptHtml = session.history.map(m => `
    <div style="margin-bottom:12px;">
      <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:${m.role === 'user' ? '#1d4ed8' : '#166534'};">
        ${m.role === 'user' ? (session.firstName || 'Client') : 'Ander'}
      </span>
      <p style="margin:3px 0 0;font-size:13px;color:#0d1b2a;line-height:1.5;">${m.content}</p>
    </div>`).join('');

  const scoreRows = Object.entries(breakdown).map(([k, v]) =>
    `<tr><td style="padding:4px 10px;font-size:12px;color:#6b7280;">${k}</td><td style="padding:4px 10px;font-size:12px;font-weight:600;color:#0d1b2a;">+${v}</td></tr>`
  ).join('');

  try {
    await resend.emails.send({
      from: 'Ander at Fern Stellar <onboarding@resend.dev>',
      to: [process.env.FIRM_EMAIL],
      subject: `${urgencyLabel} New Intake — ${session.firstName || 'Unknown'} | ${session.practiceArea || 'General'} | Score: ${score}/10`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;background:#f5f0e8;padding:32px;">
          <div style="background:#0d1b2a;padding:24px 28px;border-radius:12px 12px 0 0;">
            <p style="color:#c9a84c;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px 0;">New Intake · Henry Law Firm</p>
            <h1 style="color:#fff;font-size:20px;margin:0;display:inline-block;">Ander AI Intake</h1>
            <span style="float:right;background:rgba(201,168,76,.15);border:1px solid rgba(201,168,76,.3);border-radius:8px;padding:6px 14px;color:#e8c96a;font-size:20px;font-weight:700;">${score}/10</span>
          </div>
          <div style="background:#fff;padding:28px;border-radius:0 0 12px 12px;">
            <div style="background:${score >= 8 ? '#fef2f2' : score >= 5 ? '#fffbeb' : '#f0fdf4'};border-left:4px solid ${score >= 8 ? '#ef4444' : score >= 5 ? '#f59e0b' : '#22c55e'};padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:24px;">
              <p style="margin:0;font-size:13px;font-weight:600;color:#0d1b2a;">${urgencyLabel} — ${score >= 7 ? `Call ${session.firstName} within the hour.` : score >= 4 ? 'Follow up within 24 hours.' : 'Follow up when available.'}</p>
            </div>
            <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
              <tr style="background:#f8f7f5;"><td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;width:120px;">Name</td><td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${session.firstName || 'Not provided'}</td></tr>
              <tr><td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Phone</td><td style="padding:10px 14px;font-size:14px;"><a href="tel:${session.phone}" style="color:#c9a84c;">${session.phone || 'Not provided'}</a></td></tr>
              <tr style="background:#f8f7f5;"><td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Email</td><td style="padding:10px 14px;font-size:14px;"><a href="mailto:${session.email}" style="color:#c9a84c;">${session.email || 'Not provided'}</a></td></tr>
              <tr><td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Practice Area</td><td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${session.practiceArea || 'General'}</td></tr>
              <tr style="background:#f8f7f5;"><td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Urgency</td><td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${session.urgency === 'urgent' ? '⚠️ Time-sensitive' : 'Standard'}</td></tr>
            </table>
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
              <p style="font-size:11px;color:#9ca3af;margin:0;">Powered by <strong style="color:#0d1b2a;">Ander</strong> · <strong style="color:#0d1b2a;">Fern Stellar</strong> AI Intake</p>
            </div>
          </div>
        </div>`
    });
    console.log('✅ Firm notification sent for', session.firstName);
  } catch (err) {
    console.error('❌ Firm email failed:', JSON.stringify(err));
  }
}

// ─── Client Confirmation Email ────────────────────────────────────────────────
async function sendClientConfirmation(session) {
  if (!session.email) return;
  try {
    await resend.emails.send({
      from: 'Henry Law Firm via Ander <onboarding@resend.dev>',
      to: [session.email],
      subject: `${session.firstName}, we got your info — Henry Law Firm`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f5f0e8;padding:32px;">
          <div style="background:#0d1b2a;padding:24px 28px;border-radius:12px 12px 0 0;">
            <p style="color:#c9a84c;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px 0;">Henry Law Firm · Orlando, FL</p>
            <h1 style="color:#fff;font-size:20px;margin:0;">We've received your information</h1>
          </div>
          <div style="background:#fff;padding:28px;border-radius:0 0 12px 12px;">
            <p style="font-size:15px;color:#0d1b2a;line-height:1.7;">Hi ${session.firstName},</p>
            <p style="font-size:15px;color:#0d1b2a;line-height:1.7;">Thank you for reaching out to Henry Law Firm. Your intake has been received and LaMya will be in touch with you soon.</p>
            <p style="font-size:15px;color:#0d1b2a;line-height:1.7;">If you'd like to lock in a time right now rather than waiting, you can schedule a free consultation directly here:</p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${CALENDLY_LINK}" style="background:#0d1b2a;color:#e8c96a;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">📅 Schedule a Free Consultation</a>
            </div>
            <p style="font-size:13px;color:#6b7280;line-height:1.6;">This message was sent on behalf of Henry Law Firm by Ander, an AI intake assistant. Nothing in this email constitutes legal advice.</p>
            <div style="text-align:center;padding-top:16px;border-top:1px solid rgba(0,0,0,.06);margin-top:16px;">
              <p style="font-size:11px;color:#9ca3af;margin:0;">Powered by <strong style="color:#0d1b2a;">Ander</strong> · <strong style="color:#0d1b2a;">Fern Stellar</strong></p>
            </div>
          </div>
        </div>`
    });
    console.log('✅ Client confirmation sent to', session.email);
  } catch (err) {
    console.error('❌ Client email failed:', JSON.stringify(err));
  }
}

// ─── Save to MongoDB ──────────────────────────────────────────────────────────
async function saveIntake(session, score, breakdown) {
  try {
    const intake = new Intake({
      sessionId:      session.sessionId,
      firstName:      session.firstName || 'Unknown',
      email:          session.email || null,
      phone:          session.phone || null,
      practiceArea:   session.practiceArea || 'General',
      story:          session.story || null,
      urgency:        session.urgency || 'standard',
      score,
      scoreBreakdown: breakdown,
      firmName:       'Henry Law Firm',
      transcript:     session.history,
      completedAt:    new Date(),
      status:         'new'
    });
    await intake.save();
    console.log('✅ Intake saved to MongoDB:', intake._id);
    return intake;
  } catch (err) {
    console.error('❌ MongoDB save failed:', err.message);
    return null;
  }
}

// ─── Disclosure ───────────────────────────────────────────────────────────────
const disclosureMessage = "Hey there 👋 — I'm Ander. Before we get started, just want to be upfront: I'm an AI, not a lawyer, and nothing I say is legal advice.\n\nI'm here to walk you through a quick intake so the right people at Henry Law Firm can take a look at your situation and reach out.\n\nWhenever you're ready, just say \"I understand\" and we'll jump in. 😊";

const disclosureAccepted = (val) => ['i understand', 'ok', 'okay', 'yes', 'sure', 'got it', 'understood', 'ready', "let's go", 'lets go', 'go'].includes(val.trim().toLowerCase());

// ─── Chat Route ───────────────────────────────────────────────────────────────
app.post('/api/message', async (req, res) => {
  const { step, userMessage, sessionId } = req.body;

  const sid = sessionId || crypto.randomUUID();
  const session = getSession(sid);

  if (step === 0) {
    if (!disclosureAccepted(userMessage)) {
      return res.json({
        done: false, step: 0, sessionId: sid,
        message: "No worries — just type \"I understand\" whenever you're comfortable and we'll get started! 😊",
        type: 'text', options: [], delay: 800
      });
    }
    return res.json({
      done: false, step: 1, sessionId: sid,
      message: "Great! First things first — what's your name?",
      type: 'text', options: [], delay: 750
    });
  }

  // Hard stop
  if (session.intakeComplete) {
    return res.json({ done: true, step, sessionId: sid, message: null, type: 'text', options: [], delay: 0 });
  }

  try {
    session.history.push({ role: 'user', content: userMessage });
    extractFields(session);

    // Complete when we have name + story + phone
    if (session.phone && session.story && session.firstName && !session.intakeComplete) {
      session.intakeComplete = true;
      const { score, breakdown } = calcScore(session);

      Promise.all([
        saveIntake(session, score, breakdown),
        sendFirmNotification(session, score, breakdown),
        sendClientConfirmation(session)
      ]).catch(err => console.error('❌ Post-intake failed:', err));

      const closingMessage = `You're all set, ${session.firstName}! 🌿 I've passed everything along to the Henry Law Firm team — LaMya will be reaching out to you soon.\n\nIf you'd like to lock in a time right now, here's her calendar: ${CALENDLY_LINK}\n\nYou've got this. 💛`;
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

    const anderResponse = await askClaude(session);
    session.history.push({ role: 'assistant', content: anderResponse });

    return res.json({
      done: false,
      step: step + 1,
      sessionId: sid,
      message: anderResponse,
      type: 'text',
      options: [],
      delay: typingDelay(anderResponse)
    });

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.json({
      done: false, step, sessionId: sid,
      message: "I'm sorry, something went wrong on my end. Could you try that again?",
      type: 'text', options: [], delay: 800
    });
  }
});

app.get('/api/start', (req, res) => {
  const sessionId = crypto.randomUUID();
  res.json({
    step: 0,
    sessionId,
    message: disclosureMessage,
    type: 'text',
    options: [],
    delay: typingDelay(disclosureMessage)
  });
});

// ─── CRM API Routes ───────────────────────────────────────────────────────────
app.get('/api/intakes', async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = {};
    if (status && status !== 'all') query.status = status;
    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { practiceArea: { $regex: search, $options: 'i' } },
        { story: { $regex: search, $options: 'i' } }
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = await Intake.countDocuments({ createdAt: { $gte: today } });
    res.json({ success: true, stats: { total, newLeads, highPriority, converted, todayCount } });
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
    const { status } = req.body;
    const intake = await Intake.findByIdAndUpdate(req.params.id, { status }, { new: true });
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

app.listen(3000, () => {
  console.log('🌿 Fern Stellar · Ander running on http://localhost:3000');
});

