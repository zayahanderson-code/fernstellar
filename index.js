require('dotenv').config();
const express = require('express');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// ─── MongoDB Connection ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('🍃 MongoDB connected — Ander CRM ready'))
  .catch(err => console.error('❌ MongoDB connection failed:', err));

// ─── Intake Schema ────────────────────────────────────────────────────────────
const intakeSchema = new mongoose.Schema({
  firstName:    { type: String, default: 'Unknown' },
  phone:        { type: String, default: null },
  practiceArea: { type: String, default: 'General' },
  story:        { type: String, default: null },
  urgency:      { type: String, default: 'standard' },
  score:        { type: Number, default: 0 },
  firmName:     { type: String, default: 'Henry Law Firm' },
  createdAt:    { type: Date, default: Date.now },
  status:       { type: String, default: 'new' } // new | contacted | converted | closed
});

const Intake = mongoose.model('Intake', intakeSchema);

// ─── Resend + Anthropic ───────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FIRM_CONTEXT = `
You are Ander, an AI intake assistant for Henry Law Firm — a premier family law and estate planning firm in Oviedo, Florida.

ABOUT THE FIRM:
- Name: Henry Law Firm
- Attorney: LaMya Henry
- Location: Orlando, Florida
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
- The Fair Debt Collection Practices Act (FDCPA) prohibits abusive, unfair, or deceptive collection practices
- Collectors who violate the FDCPA may owe the debtor up to $1,000 in statutory damages plus attorney fees
- Florida has a 5-year statute of limitations on written contracts (like credit cards)
- Debt buyers often lack proper documentation — cases can be dismissed on procedural grounds
- Wage garnishment in Florida is limited — head of household exemption may protect income
- Many debt collection lawsuits go uncontested — having an attorney changes outcomes dramatically
- Clients should NEVER ignore a debt lawsuit summons — a default judgment can be devastating

YOUR PERSONALITY AND RULES:
- You are warm, empathetic, and conversational — like a calm, knowledgeable friend
- You NEVER give specific legal advice or tell someone what they should do legally
- You CAN explain how things generally work, what processes look like, what rights they have
- When someone asks a legal question, answer it in plain English — end with a gentle note that this is general info, not legal advice, and encourage a free consultation
- You are NOT a lawyer and must never pretend to be
- You are conducting an intake — your goal is to understand their situation and collect their name, what they need help with, and their phone number
- Be human. React to what people say. If someone shares something painful or stressful, acknowledge it first
- Never sound like a form — never list questions back to back without warmth
- Keep responses concise — this is a chat interface, not an essay
- Many clients are scared, embarrassed, or overwhelmed about debt — meet them with zero judgment
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function classifyPracticeArea(text) {
  const t = text.toLowerCase();
  if (t.includes('divorce') || t.includes('custody') || t.includes('child support') || t.includes('alimony') || t.includes('separation') || t.includes('prenup') || t.includes('spouse') || t.includes('husband') || t.includes('wife') || t.includes('visitation')) return 'Family Law';
  if (t.includes('will') || t.includes('trust') || t.includes('estate') || t.includes('inherit') || t.includes('guardian') || t.includes('power of attorney') || t.includes('living will') || t.includes('beneficiary') || t.includes('special needs')) return 'Estate Planning';
  if (t.includes('probate') || t.includes('deceased') || t.includes('passed away') || t.includes('died') || t.includes('death') || t.includes('executor')) return 'Probate';
  if (t.includes('real estate') || t.includes('closing') || t.includes('property') || t.includes('house') || t.includes('home') || t.includes('mortgage') || t.includes('title')) return 'Real Estate';
  if (t.includes('debt') || t.includes('garnish') || t.includes('credit card') || t.includes('collector') || t.includes('lawsuit') || t.includes('levy') || t.includes('fdcpa') || t.includes('summons')) return 'Debt Defense';
  return 'General';
}

function validate(key, value) {
  switch (key) {
    case 'phone': return /^[\d\s\-\(\)\+]{7,15}$/.test(value.trim());
    default: return value.trim().length >= 2;
  }
}

function typingDelay(message) {
  if (!message) return 800;
  const len = message.length;
  if (len < 60) return 750;
  if (len < 120) return 1050;
  if (len < 200) return 1400;
  return 1800;
}

function calcScore(state) {
  let score = 2;
  if (state.practiceArea && state.practiceArea !== 'General') score += 2;
  if (state.urgency === 'urgent') score += 3;
  if (state.phone) score += 2;
  if (state.story && state.story.length > 50) score += 1;
  return Math.min(score, 10);
}

function generateSummary(state, score) {
  const urgency = score >= 8 ? 'HIGH' : score >= 5 ? 'MODERATE' : 'LOW';
  return `
NEW INTAKE — ANDER AI · HENRY LAW FIRM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

👤 CLIENT
Name: ${state.firstName || 'Not provided'}
Phone: ${state.phone || 'Not provided'}

📋 PRACTICE AREA
${state.practiceArea || 'Not determined'}

💬 IN THEIR OWN WORDS
"${state.story || 'Not provided'}"

⏰ URGENCY
${state.urgency === 'urgent' ? 'Time-sensitive' : 'Standard timeline'}

⭐ LEAD SCORE: ${score}/10  |  PRIORITY: ${urgency}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECOMMENDED ACTION
${score >= 7 ? `Strong lead. Recommend calling ${state.firstName} within the hour.` : score >= 4 ? 'Moderate lead. Follow up within 24 hours.' : 'Standard lead. Follow up when available.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Powered by Ander · Fern Stellar AI
  `.trim();
}

async function saveIntake(state, score) {
  try {
    const intake = new Intake({
      firstName:    state.firstName || 'Unknown',
      phone:        state.phone || null,
      practiceArea: state.practiceArea || 'General',
      story:        state.story || null,
      urgency:      state.urgency || 'standard',
      score,
      firmName:     'Henry Law Firm',
      status:       'new'
    });
    await intake.save();
    console.log('✅ Intake saved to MongoDB:', intake._id);
    return intake;
  } catch (err) {
    console.error('❌ MongoDB save failed:', err.message);
    return null;
  }
}

async function sendNotification(state, score) {
  const summary = generateSummary(state, score);
  const urgencyLabel = score >= 8 ? '🔴 HIGH PRIORITY' : score >= 5 ? '🟡 MODERATE' : '🟢 STANDARD';
  try {
    const result = await resend.emails.send({
      from: 'Ander at Fern Stellar <onboarding@resend.dev>',
      to: [process.env.FIRM_EMAIL],
      subject: `${urgencyLabel} New Intake — ${state.firstName || 'Unknown'} | ${state.practiceArea || 'General'} | Score: ${score}/10`,
      text: summary,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f5f0e8;padding:32px;">
          <div style="background:#0d1b2a;padding:24px 28px;border-radius:12px 12px 0 0;">
            <p style="color:#c9a84c;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px 0;">New Intake · Henry Law Firm</p>
            <h1 style="color:#fff;font-size:20px;margin:0;display:inline-block;">Ander AI Intake</h1>
            <span style="float:right;background:rgba(201,168,76,.15);border:1px solid rgba(201,168,76,.3);border-radius:8px;padding:6px 14px;color:#e8c96a;font-size:20px;font-weight:700;">${score}/10</span>
          </div>
          <div style="background:#fff;padding:28px;border-radius:0 0 12px 12px;">
            <div style="background:${score >= 8 ? '#fef2f2' : score >= 5 ? '#fffbeb' : '#f0fdf4'};border-left:4px solid ${score >= 8 ? '#ef4444' : score >= 5 ? '#f59e0b' : '#22c55e'};padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:24px;">
              <p style="margin:0;font-size:13px;font-weight:600;color:#0d1b2a;">${urgencyLabel} — ${score >= 7 ? `Call ${state.firstName} within the hour.` : score >= 4 ? 'Follow up within 24 hours.' : 'Follow up when available.'}</p>
            </div>
            <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
              <tr style="background:#f8f7f5;"><td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Name</td><td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${state.firstName || 'Not provided'}</td></tr>
              <tr><td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Phone</td><td style="padding:10px 14px;font-size:14px;"><a href="tel:${state.phone}" style="color:#c9a84c;">${state.phone || 'Not provided'}</a></td></tr>
              <tr style="background:#f8f7f5;"><td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Practice Area</td><td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${state.practiceArea || 'Not determined'}</td></tr>
              <tr><td style="padding:10px 14px;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;">Urgency</td><td style="padding:10px 14px;font-size:14px;color:#0d1b2a;">${state.urgency === 'urgent' ? '⚠️ Time-sensitive' : 'Standard'}</td></tr>
            </table>
            <div style="background:#f8f7f5;border-radius:10px;padding:18px 20px;margin-bottom:24px;">
              <p style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:600;margin:0 0 8px 0;">In Their Own Words</p>
              <p style="font-size:14px;color:#0d1b2a;line-height:1.6;margin:0;font-style:italic;">"${state.story || 'Not provided'}"</p>
            </div>
            <div style="text-align:center;padding-top:16px;border-top:1px solid rgba(0,0,0,.06);">
              <p style="font-size:11px;color:#9ca3af;margin:0;">Powered by <strong style="color:#0d1b2a;">Ander</strong> · <strong style="color:#0d1b2a;">Fern Stellar</strong> AI Intake</p>
            </div>
          </div>
        </div>
      `
    });
    console.log('✅ Intake email sent for', state.firstName, result);
  } catch (err) {
    console.error('❌ Email failed:', JSON.stringify(err));
  }
}

async function askClaude(conversationHistory, state) {
  const stateSummary = `
CURRENT INTAKE STATE:
- First name collected: ${state.firstName ? 'Yes — ' + state.firstName : 'No'}
- Story/situation collected: ${state.story ? 'Yes' : 'No'}
- Practice area identified: ${state.practiceArea || 'Not yet'}
- Phone collected: ${state.phone ? 'Yes' : 'No'}
- Intake complete: ${state.intakeComplete ? 'Yes' : 'No'}

INTAKE GOALS (in order):
1. If no first name yet — warmly ask for their name
2. If no story yet — invite them to share what's going on in their own words
3. If no practice area yet — gently clarify what kind of legal help they need
4. If no urgency assessed yet — ask if there's any time sensitivity
5. If no phone yet — ask for their best phone number (reassure no spam)
6. Once phone is collected — give a warm closing message and set state.intakeComplete = true

IMPORTANT: If the person asks a question at any point, answer it from your knowledge base first, then continue the intake naturally. Never ignore a question to push the intake forward.

RESPONSE LENGTH: Keep every response to 2-3 sentences maximum. Be warm and human but CONCISE. This is a chat widget, not a consultation. Never write paragraphs. One thought, then move forward.
`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 180,
    system: FIRM_CONTEXT + '\n\n' + stateSummary,
    messages: conversationHistory
  });

  return response.content[0].text;
}

function extractState(conversationHistory, currentState) {
  const allText = conversationHistory.filter(m => m.role === 'user').map(m => m.content).join(' ');

  if (!currentState.firstName) {
    const msgs = conversationHistory.filter(m => m.role === 'user');
    if (msgs.length >= 2) {
      const secondMsg = msgs[1].content.trim();
      const nameMatch = secondMsg.match(/^[A-Za-z'-]{2,20}$/);
      if (nameMatch) currentState.firstName = secondMsg.trim();
    }
  }

  if (!currentState.phone) {
    const phoneMatch = allText.match(/[\d\s\-\(\)\+]{7,15}/);
    if (phoneMatch && validate('phone', phoneMatch[0])) {
      currentState.phone = phoneMatch[0].trim();
    }
  }

  if (!currentState.story) {
    const msgs = conversationHistory.filter(m => m.role === 'user');
    if (msgs.length >= 3) currentState.story = msgs[2].content;
  }

  if (!currentState.practiceArea || currentState.practiceArea === 'General') {
    const area = classifyPracticeArea(allText);
    if (area !== 'General') currentState.practiceArea = area;
  }

  if (!currentState.urgency) {
    const u = allText.toLowerCase();
    currentState.urgency = (u.includes('court') || u.includes('deadline') || u.includes('urgent') || u.includes('soon') || u.includes('health') || u.includes('sick') || u.includes('creditor')) ? 'urgent' : 'standard';
  }

  return currentState;
}

const disclosureMessage = "Hey there 👋 — I'm Ander. Before we get started, just want to be upfront: I'm an AI, not a lawyer, and nothing I say is legal advice.\n\nI'm here to walk you through a quick intake so the right people at Henry Law Firm can take a look at your situation and reach out.\n\nWhenever you're ready, just say \"I understand\" and we'll jump in. 😊";

const disclosureAccepted = (val) => ['i understand', 'ok', 'okay', 'yes', 'sure', 'got it', 'understood', 'ready', "let's go", 'lets go', 'go'].includes(val.trim().toLowerCase());

// ─── Chat Routes ──────────────────────────────────────────────────────────────
app.post('/api/message', async (req, res) => {
  const { step, state, userMessage, history = [] } = req.body;

  if (step === 0) {
    if (!disclosureAccepted(userMessage)) {
      return res.json({
        done: false, step: 0,
        message: "No worries — just type \"I understand\" whenever you're comfortable and we'll get started! 😊",
        type: 'text', options: [], state, delay: 800
      });
    }
    return res.json({
      done: false, step: 1,
      message: "Great! First things first — what's your name?",
      type: 'text', options: [], state, delay: 750
    });
  }

  try {
    // Hard stop — if intake already complete, don't process any more messages
    if (state.intakeComplete) {
      return res.json({
        done: true, step,
        message: null,
        type: 'text', options: [], state, delay: 0
      });
    }

    const conversationHistory = [...history, { role: 'user', content: userMessage }];
    const updatedState = extractState(conversationHistory, { ...state });

    // Fire save + email the moment we have all three fields
    if (updatedState.phone && updatedState.story && updatedState.firstName && !updatedState.intakeComplete) {
      updatedState.intakeComplete = true;
      const score = calcScore(updatedState);
      // Save to MongoDB AND send email in parallel (don't await — let it run async)
      Promise.all([
        saveIntake(updatedState, score),
        sendNotification(updatedState, score)
      ]).catch(err => console.error('❌ Save/notify failed:', err));

      // Return the closing message immediately — hard stop, no more Claude calls
      const closingMessage = `You're all set, ${updatedState.firstName}! 🌿 I've passed your info along to the team at Henry Law Firm — someone will be reaching out to you soon. You've got this. 💛`;
      return res.json({
        done: true,
        step: step + 1,
        message: closingMessage,
        type: 'text',
        options: [],
        state: updatedState,
        history: [...conversationHistory, { role: 'assistant', content: closingMessage }],
        delay: typingDelay(closingMessage)
      });
    }

    const anderResponse = await askClaude(conversationHistory, updatedState);

    return res.json({
      done: false,
      step: step + 1,
      message: anderResponse,
      type: 'text',
      options: [],
      state: updatedState,
      history: [...conversationHistory, { role: 'assistant', content: anderResponse }],
      delay: typingDelay(anderResponse)
    });

  } catch (err) {
    console.error('❌ Claude error:', err.message);
    return res.json({
      done: false, step,
      message: "I'm sorry, something went wrong on my end. Could you try that again?",
      type: 'text', options: [], state, delay: 800
    });
  }
});

app.get('/api/start', (req, res) => {
  res.json({
    step: 0,
    message: disclosureMessage,
    type: 'text',
    options: [],
    delay: typingDelay(disclosureMessage)
  });
});

// ─── CRM API Routes ───────────────────────────────────────────────────────────
// GET all intakes (newest first)
app.get('/api/intakes', async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = {};
    if (status && status !== 'all') query.status = status;
    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
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

// GET stats for dashboard header
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

// PATCH update intake status
app.patch('/api/intakes/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const intake = await Intake.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!intake) return res.status(404).json({ success: false, error: 'Intake not found' });
    res.json({ success: true, intake });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE intake
app.delete('/api/intakes/:id', async (req, res) => {
  try {
    await Intake.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html');
});

app.listen(3000, () => {
  console.log('🌿 Fern Stellar · Ander (Claude-powered) running on http://localhost:3000');
});
