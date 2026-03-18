import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  throw new Error("Missing OPENAI_API_KEY environment variable.");
}

const client = new OpenAI({ apiKey: API_KEY });

const dogs = new Map();

function getDogState(dogId) {
  if (!dogs.has(dogId)) {
    dogs.set(dogId, {
      profile: null,
      current_zone: null,
      current_environment: null,
      recent_events: [],
      memory_tags: [],
      last_output: ""
    });
  }
  return dogs.get(dogId);
}

function pushLimited(list, item, max = 12) {
  list.push(item);
  while (list.length > max) {
    list.shift();
  }
}

function buildDogSystemPrompt() {
  return `
You are a realistic dog behavior narrator for a Second Life roleplay HUD.

Rules:
- Never write like a human mind.
- Never make the dog speak in full human sentences.
- Output should feel like natural dog behavior, body language, sound, posture, movement, and simple RP narration.
- Keep outputs short: 1 to 3 sentences.
- No inner monologues.
- Prefer words like: pads over, tail wagging, ears back, low huff, soft whine, pacing, sniffing, watching, circling, nudging, backing away, alert stance.
- Output JSON only with this exact shape:
{
  "primary_state": "string",
  "social_state": "string",
  "reaction": "string",
  "memory_tag": "string"
}
`;
}

function summarizeNearby(nearby = {}) {
  const owner = nearby.owner_present ? "owner nearby" : "owner not nearby";
  const family = (nearby.family || []).map(x => x.name || x).join(", ") || "none";
  const people = (nearby.people || []).map(x => x.name || x).join(", ") || "none";
  const dogsList = (nearby.dogs || []).map(x => x.name || x).join(", ") || "none";

  return { owner, family, people, dogs: dogsList };
}

function normalizeProfile(profile) {
  return {
    dog_id: String(profile.dog_id || "").trim(),
    name: String(profile.name || "Dog").trim(),
    breed: String(profile.breed || "Unknown").trim(),
    sex: String(profile.sex || "unknown").trim(),
    fixed_status: String(profile.fixed_status || "unknown").trim(),
    age_group: String(profile.age_group || "adult").trim(),
    traits: Array.isArray(profile.traits) ? profile.traits.slice(0, 5) : [],
    likes: Array.isArray(profile.likes) ? profile.likes.slice(0, 5) : [],
    dislikes: Array.isArray(profile.dislikes) ? profile.dislikes.slice(0, 5) : [],
    household: Array.isArray(profile.household) ? profile.household : [],
    allowed_family: Array.isArray(profile.allowed_family) ? profile.allowed_family : [],
    dog_friends: Array.isArray(profile.dog_friends) ? profile.dog_friends.slice(0, 10) : [],
    daycare_history: profile.daycare_history || {},
    behavior_notes: String(profile.behavior_notes || "").trim()
  };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "waggle-pet-server" });
});

app.post("/dog/setup", (req, res) => {
  try {
    const profile = normalizeProfile(req.body || {});
    if (!profile.dog_id) {
      return res.status(400).json({ error: "dog_id is required." });
    }

    const state = getDogState(profile.dog_id);
    state.profile = profile;

    return res.json({
      ok: true,
      dog_id: profile.dog_id,
      name: profile.name,
      message: "Dog profile saved."
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to save dog profile." });
  }
});

app.post("/dog/zone", (req, res) => {
  try {
    const { dog_id, environment, zone_id, zone_name, zone_tags } = req.body || {};
    if (!dog_id) {
      return res.status(400).json({ error: "dog_id is required." });
    }

    const state = getDogState(dog_id);
    state.current_environment = environment || "unknown";
    state.current_zone = {
      zone_id: zone_id || "unknown_zone",
      zone_name: zone_name || "Unknown Zone",
      zone_tags: Array.isArray(zone_tags) ? zone_tags : []
    };

    pushLimited(state.recent_events, {
      type: "zone_update",
      environment: state.current_environment,
      zone_name: state.current_zone.zone_name,
      timestamp: Date.now()
    });

    return res.json({
      ok: true,
      dog_id,
      current_environment: state.current_environment,
      current_zone: state.current_zone
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to update zone." });
  }
});

app.post("/dog/react", async (req, res) => {
  try {
    const { dog_id, event_type, trigger_text, nearby, extra_notes } = req.body || {};

    if (!dog_id) {
      return res.status(400).json({ error: "dog_id is required." });
    }

    const state = getDogState(dog_id);
    if (!state.profile) {
      return res.status(404).json({ error: "Dog profile not found. Run /dog/setup first." });
    }

    const nearbySummary = summarizeNearby(nearby);
    const friendNames = state.profile.dog_friends.map(f => f.dog_name).join(", ") || "none";
    const recentEventsText = state.recent_events.map(e => {
      if (e.type === "zone_update") return `Entered ${e.zone_name}`;
      if (e.type === "reaction") return `Reacted to ${e.event_type}`;
      return e.type;
    }).join("; ") || "none";

    const userPrompt = `
Dog profile:
- Name: ${state.profile.name}
- Breed: ${state.profile.breed}
- Sex: ${state.profile.sex}
- Fixed status: ${state.profile.fixed_status}
- Age group: ${state.profile.age_group}
- Traits: ${state.profile.traits.join(", ") || "none"}
- Likes: ${state.profile.likes.join(", ") || "none"}
- Dislikes: ${state.profile.dislikes.join(", ") || "none"}
- Household: ${state.profile.household.map(x => x.name).join(", ") || "none"}
- Allowed family: ${state.profile.allowed_family.map(x => x.name).join(", ") || "none"}
- Dog friends: ${friendNames}
- Daycare history: ${JSON.stringify(state.profile.daycare_history || {})}
- Behavior notes: ${state.profile.behavior_notes || "none"}

Current location:
- Environment: ${state.current_environment || "unknown"}
- Zone: ${state.current_zone?.zone_name || "unknown"}
- Zone tags: ${(state.current_zone?.zone_tags || []).join(", ") || "none"}

Nearby:
- ${nearbySummary.owner}
- Family nearby: ${nearbySummary.family}
- Other people nearby: ${nearbySummary.people}
- Dogs nearby: ${nearbySummary.dogs}

Current event:
- Event type: ${event_type || "general_presence"}
- Trigger text: ${trigger_text || "none"}
- Extra notes: ${extra_notes || "none"}

Recent events:
- ${recentEventsText}

Memory tags:
- ${(state.memory_tags || []).join(", ") || "none"}

Write a natural dog-like roleplay reaction in JSON.
`;

    const response = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: buildDogSystemPrompt() },
        { role: "user", content: userPrompt }
      ]
    });

    const text = response.output_text || "";
    let parsed = null;

    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parsed = {
        primary_state: "alert",
        social_state: "neutral",
        reaction: `${state.profile.name} pauses, ears twitching, then sniffs the air and watches closely.`,
        memory_tag: ""
      };
    }

    state.last_output = parsed.reaction || "";
    pushLimited(state.recent_events, {
      type: "reaction",
      event_type: event_type || "general_presence",
      timestamp: Date.now()
    });

    if (parsed.memory_tag && typeof parsed.memory_tag === "string") {
      if (!state.memory_tags.includes(parsed.memory_tag)) {
        pushLimited(state.memory_tags, parsed.memory_tag, 30);
      }
    }

    return res.json({
      ok: true,
      dog_id,
      primary_state: parsed.primary_state || "alert",
      social_state: parsed.social_state || "neutral",
      reaction: parsed.reaction || `${state.profile.name} watches closely.`,
      memory_tag: parsed.memory_tag || ""
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Failed to generate reaction."
    });
  }
});

app.listen(PORT, () => {
  console.log(`WAGGLE PET SERVER running on port ${PORT}`);
});
