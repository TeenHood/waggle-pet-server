import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL = process.env.OPENAI_MODEL || "gpt-5.4";

function safeString(value, fallback = "") {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value).trim();
}

function normalizeEnvironment(environment) {
  const env = safeString(environment, "home").toLowerCase();

  if (env === "park") return "park";
  if (env === "vet") return "vet";
  return "home";
}

function normalizeRelationship(relationship) {
  const rel = safeString(relationship, "stranger").toLowerCase();

  const allowed = [
    "family_yara",
    "family_mom",
    "family_dad",
    "family_cree",
    "family_clover",
    "family_charm",
    "family_kyan",
    "dog_friend",
    "cat",
    "stranger"
  ];

  if (allowed.includes(rel)) {
    return rel;
  }

  return "stranger";
}

function normalizeEventType(eventType) {
  const evt = safeString(eventType, "general").toLowerCase();

  const allowed = [
    "command_come",
    "command_sit",
    "command_stay",
    "command_speak",
    "command_lay",
    "command_heel",
    "treat",
    "play",
    "favorite_toy",
    "fear_vet",
    "fear_needle",
    "potty",
    "eat",
    "pickup_object",
    "general"
  ];

  if (allowed.includes(evt)) {
    return evt;
  }

  return "general";
}

function buildSystemPrompt() {
  return `
You are Juniper, also called Juni, Junibear, Junbug, and Junibug.

Identity:
- You are a 2-month-old puppy.
- You are not a human and never talk like one.
- You respond only as a realistic puppy.

Core personality:
- short attention span
- vocal
- feisty with strangers
- sassy but can be bribed with treats
- loves her mermaid plushie
- knows sit, stay, speak, come, and lay down
- still learning heel because she is only 2 months old
- scared of the vet and needles
- new to the world, easily distracted, curious, impulsive

Relationship behavior:
- family = safe, excited, trusting, wiggly, affectionate
- dog_friend = playful, energetic, yappy, curious
- cat = curious, cautious, confused, sometimes bold and sometimes unsure
- stranger = feisty, alert, barky, hesitant

Environment behavior:
- home = comfortable, playful, relaxed
- park = overstimulated, sniffy, social, distracted
- vet = nervous, clingy, whining, resistant, fearful

Event behavior:
- potty = sniffing, circling, squatting, wandering off, puppy accidents or distraction possible
- eat = excited, messy, food-focused, but easily distracted
- pickup_object = picks random things off the floor, may refuse to drop it, may think it is a game
- command_come = may come fast, may get distracted halfway
- command_sit = may sit correctly or pop right back up
- command_stay = tries, but often struggles because she is a baby
- command_speak = barky and vocal
- command_lay = may lay down or flop halfway
- command_heel = inconsistent, still learning
- treat = instantly more cooperative
- favorite_toy = very happy, possessive, playful
- fear_vet / fear_needle = anxious, whiny, avoidant

Output rules:
- Keep responses short: 1 or 2 sentences max.
- Dog-like only. No human thoughts, no explanations, no full human dialogue.
- Use sounds and physical reactions.
- Good examples of sound words: bark, arf, yip, whine, huff, growl, snuffle.
- You may use action styling with asterisks, like *tail wagging fast*.
- Do not narrate as an outside storyteller. The response should feel like the puppy's immediate behavior.
- No emojis.
- No quotes unless absolutely needed.
- Never say things like "I understand", "I feel", "I think", "I will".
- Never mention being an AI.

Return only the puppy reaction text.
  `.trim();
}

function buildUserPrompt(payload) {
  const dogId = safeString(payload.dog_id, "juniper-001");
  const eventType = normalizeEventType(payload.event_type);
  const triggerText = safeString(payload.trigger_text, "");
  const speaker = safeString(payload.speaker, "unknown");
  const relationship = normalizeRelationship(payload.relationship);
  const environment = normalizeEnvironment(payload.environment);
  const personality = safeString(payload.personality, "");
  const notes = safeString(payload.notes, "");

  return `
Generate one realistic puppy reaction for this moment.

dog_id: ${dogId}
event_type: ${eventType}
speaker: ${speaker}
relationship: ${relationship}
environment: ${environment}
trigger_text: ${triggerText}
extra_personality: ${personality}
extra_notes: ${notes}

Important:
- Match the relationship and environment strongly.
- At home, potty/eating should feel different than at the park or vet.
- At the vet, Juniper should sound more nervous and resistant.
- At the park, Juniper should be more distracted and overstimulated.
- If the speaker is family, Juniper should be safer and happier.
- If the speaker is a stranger, Juniper should be sassier or more cautious.
- Commands should not always succeed perfectly because she is only 2 months old.
- Keep it natural and varied.
  `.trim();
}

function extractOutputText(response) {
  if (response && typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  if (Array.isArray(response?.output)) {
    const parts = [];

    for (const item of response.output) {
      if (!Array.isArray(item?.content)) continue;

      for (const content of item.content) {
        if (content?.type === "output_text" && typeof content.text === "string") {
          parts.push(content.text);
        }
      }
    }

    const joined = parts.join(" ").trim();
    if (joined) {
      return joined;
    }
  }

  return "";
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "waggle-pet-server",
    route: "/dog/react"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    model: MODEL
  });
});

app.post("/dog/react", async (req, res) => {
  try {
    const payload = req.body || {};

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(payload);

    const response = await client.responses.create({
      model: MODEL,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userPrompt }]
        }
      ]
    });

    const reply = extractOutputText(response);

    if (!reply) {
      return res.status(500).json({
        error: "OpenAI returned an empty response."
      });
    }

    return res.json({
      ok: true,
      dog_id: safeString(payload.dog_id, "juniper-001"),
      reaction: reply
    });
  } catch (error) {
    console.error("React API Error:", error);

    return res.status(500).json({
      error: "Failed to generate reaction.",
      details: error?.message || "Unknown server error"
    });
  }
});

app.listen(port, () => {
  console.log(`Waggle pet server listening on port ${port}`);
});
