import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY environment variable.");
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

/*
  In-memory only for now.
  On free Render, local memory/files are not durable across restarts/spin-downs.
  Move this to Supabase/Postgres later.
*/
const dogs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function clampString(value, fallback = "") {
  return String(value || fallback).trim();
}

function clampArray(value, max = 20) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max);
}

function getDogState(dogId) {
  if (!dogs.has(dogId)) {
    dogs.set(dogId, {
      profile: null,
      setup_complete: false,
      current_location: "Unknown",
      home_name: "None",
      home_key: "",
      in_daycare: false,
      memories: [],
      recent_events: [],
      last_reaction: "",
      ticks: 0,
      created_at: nowIso(),
      updated_at: nowIso()
    });
  }
  return dogs.get(dogId);
}

function pushLimited(list, item, max = 30) {
  list.push(item);
  while (list.length > max) {
    list.shift();
  }
}

function normalizeProfile(body = {}) {
  return {
    dog_id: clampString(body.dog_id),
    name: clampString(body.name, "Dog"),
    breed: clampString(body.breed, ""),
    age_group: clampString(body.age_group, "Adult"),
    sex: clampString(body.sex, "Unknown"),
    fixed_status: clampString(body.fixed_status, "Unknown"),
    traits: clampArray(body.traits, 5),
    likes: clampArray(body.likes, 5),
    dislikes: clampArray(body.dislikes, 5),
    household_names: clampArray(body.household_names, 20),
    friend_names: clampArray(body.friend_names, 20),
    owner_contact: clampString(body.owner_contact, ""),
    vet_info: clampString(body.vet_info, ""),
    shot_records: clampString(body.shot_records, ""),
    allergies: clampString(body.allergies, ""),
    daycare_history: clampString(body.daycare_history, ""),
    behavior_notes: clampString(body.behavior_notes, "")
  };
}

function detectIntent(text = "", dogName = "") {
  const t = String(text || "").toLowerCase();
  const name = String(dogName || "").toLowerCase();

  const groups = [
    {
      intent: "come",
      words: ["come here", "come", "c'mere", "here", "over here", "with me", "let's go", "puppies come", "pups come"]
    },
    {
      intent: "praise",
      words: ["good boy", "good girl", "good pup", "good job", "nice job", "sweet baby", "proud of you"]
    },
    {
      intent: "scold",
      words: ["no", "ah-ah", "leave it", "stop", "off", "back up", "behave", "gentle", "calm down", "enough"]
    },
    {
      intent: "treat",
      words: ["treat", "cookie", "biscuit", "snack", "bone", "chew", "dinner", "breakfast", "food"]
    },
    {
      intent: "play",
      words: ["play", "wanna play", "toy", "ball", "fetch", "tug", "get it", "go play"]
    },
    {
      intent: "rest",
      words: ["bed", "crate", "settle", "lay down", "nap", "bedtime", "rest"]
    },
    {
      intent: "outside",
      words: ["outside", "potty", "go potty", "walk", "leash", "harness"]
    },
    {
      intent: "groom",
      words: ["bath", "brush", "groom", "nail trim", "dryer"]
    },
    {
      intent: "affection",
      words: ["cuddle", "snuggle", "hug", "love", "kisses"]
    }
  ];

  let found = "none";
  let i = 0;
  while (i < groups.length) {
    let j = 0;
    while (j < groups[i].words.length) {
      if (t.indexOf(groups[i].words[j]) !== -1) {
        found = groups[i].intent;
        j = groups[i].words.length;
        i = groups.length;
      }
      j += 1;
    }
    i += 1;
  }

  if (found === "none" && name !== "" && t.indexOf(name) !== -1) {
    found = "attention";
  }

  return found;
}

function nextNeedHint(state, profile) {
  const trait = (profile.traits[0] || "").toLowerCase();
  const like = (profile.likes[0] || "").toLowerCase();
  const dislike = (profile.dislikes[0] || "").toLowerCase();
  const loc = String(state.current_location || "").toLowerCase();

  const cycle = [
    "needs water",
    "needs potty",
    "wants play",
    "wants closeness",
    "is getting hungry",
    "wants quiet"
  ];

  let hint = cycle[state.ticks % cycle.length];

  if (loc.indexOf("daycare") !== -1 || loc.indexOf("yard") !== -1 || state.in_daycare) {
    if (state.ticks % 3 === 0) hint = "watches the gate and checks the room";
    if (state.ticks % 5 === 0) hint = "misses home a little";
  }

  if (trait === "clingy") {
    if (state.ticks % 4 === 0) hint = "wants closeness";
  }

  if (trait === "stubborn") {
    if (state.ticks % 6 === 0) hint = "pretends not to listen right away";
  }

  if (dislike === "storms") {
    if (state.ticks % 7 === 0) hint = "seems storm-nervous and keeps checking the room";
  }

  if (like === "outside" && loc.indexOf("yard") !== -1) {
    if (state.ticks % 4 === 1) hint = "looks energized by being outside";
  }

  return hint;
}

function fallbackReaction({ profile, state, eventType, triggerText, intent }) {
  const name = profile.name || "Dog";
  const trait = (profile.traits[0] || "").toLowerCase();
  const like = (profile.likes[0] || "").toLowerCase();
  const dislike = (profile.dislikes[0] || "").toLowerCase();
  const location = state.current_location || "Unknown";

  if (eventType === "setup_complete") {
    return {
      primary_state: "ready",
      reaction: `${name} looks around with a small ear twitch, then settles like the new routine is starting to make sense.`,
      memory_tag: "Setup finished and profile saved.",
      action_hint: "none"
    };
  }

  if (intent === "come") {
    if (trait === "stubborn") {
      return {
        primary_state: "hesitant",
        reaction: `${name} glances over first, takes a second to decide, then starts padding your way a little slower than you hoped.`,
        memory_tag: "Responded slowly to recall.",
        action_hint: "move_to_speaker"
      };
    }
    if (trait === "shy") {
      return {
        primary_state: "cautious",
        reaction: `${name} hangs back for a beat, then edges closer with a careful little step and a soft look.`,
        memory_tag: "Responded cautiously to recall.",
        action_hint: "move_to_speaker"
      };
    }
    return {
      primary_state: "responsive",
      reaction: `${name} perks up and starts padding over, tail giving an easy wag.`,
      memory_tag: "Responded to recall.",
      action_hint: "move_to_speaker"
    };
  }

  if (intent === "treat") {
    if (trait === "greedy") {
      return {
        primary_state: "food-focused",
        reaction: `${name} dives in quick for the treat, nearly catching your fingers in the rush.`,
        memory_tag: "Snatched a treat fast.",
        action_hint: "accept_treat"
      };
    }
    if (trait === "gentle") {
      return {
        primary_state: "soft",
        reaction: `${name} leans in and takes the treat carefully, lips brushing your hand without a fuss.`,
        memory_tag: "Took a treat gently.",
        action_hint: "accept_treat"
      };
    }
    if (trait === "picky") {
      return {
        primary_state: "picky",
        reaction: `${name} sniffs the treat once, then looks up at you like that one might not be worth it.`,
        memory_tag: "Refused a treat.",
        action_hint: "refuse_treat"
      };
    }
    return {
      primary_state: "interested",
      reaction: `${name} focuses right in on your hand and steps closer for the treat.`,
      memory_tag: "Accepted a treat.",
      action_hint: "accept_treat"
    };
  }

  if (intent === "groom") {
    if (String(location).toLowerCase().indexOf("groom") === -1) {
      return {
        primary_state: "wary",
        reaction: `${name} leans back a little like grooming should happen somewhere more official than this.`,
        memory_tag: "Groom denied outside groomer.",
        action_hint: "deny_groom"
      };
    }
    return {
      primary_state: "handled",
      reaction: `${name} stands there with a watchful little look, trying to decide whether this groom is acceptable today.`,
      memory_tag: "Grooming started.",
      action_hint: "none"
    };
  }

  if (eventType === "random_tick") {
    const hint = nextNeedHint(state, profile);
    return {
      primary_state: "ambient",
      reaction: `${name} ${hint}.`,
      memory_tag: `Ambient event: ${hint}.`,
      action_hint: "none"
    };
  }

  if (eventType === "daycare_checkin") {
    return {
      primary_state: "alert",
      reaction: `${name} takes in the room slowly, nose working while the ears stay half-up and watchful.`,
      memory_tag: "Checked into daycare.",
      action_hint: "none"
    };
  }

  if (eventType === "daycare_checkout") {
    return {
      primary_state: "relieved",
      reaction: `${name} seems to loosen up at checkout, body softening as the routine changes again.`,
      memory_tag: "Checked out of daycare.",
      action_hint: "none"
    };
  }

  if (eventType === "location_change") {
    return {
      primary_state: "aware",
      reaction: `${name} pauses to take in ${location}, sniffing once before deciding how to feel about it.`,
      memory_tag: `Entered ${location}.`,
      action_hint: "none"
    };
  }

  if (dislike === "storms") {
    return {
      primary_state: "uneasy",
      reaction: `${name} looks a little unsettled, sticking closer and checking the room like something feels off.`,
      memory_tag: "General unease.",
      action_hint: "none"
    };
  }

  return {
    primary_state: "neutral",
    reaction: `${name} watches closely, ears twitching while trying to make sense of what's going on.`,
    memory_tag: `General reaction to ${eventType || triggerText || "event"}.`,
    action_hint: "none"
  };
}

function buildSystemPrompt() {
  return `
You are the behavior engine for a realistic roleplay dog in Second Life.

Rules:
- Never think or speak like a human.
- Never write full human dialogue from the dog.
- Output 1 to 3 short sentences maximum.
- Describe body language, movement, hesitation, sounds, posture, and instinctive behavior.
- Make the dog feel real, not like a human mind in a dog body.
- Use personality, current location, owner/friend/household context, and smart situation awareness.
- Smart random events should feel realistic: potty, thirsty, hungry, wants play, wants quiet, misses daycare, misses home, misses a household person, watches the gate, avoids rough energy, perks up at favorite routines.
- Treat reactions should vary by personality: gentle, snatchy, hesitant, refusing, food-focused.
- Stubborn dogs can delay.
- Shy dogs can hesitate.
- Clingy dogs react harder to separation.
- Avoidant dogs hang back.
- Groom only makes sense at the groomer.
- Come/go-to actions should be calm and believable, not teleport-like.

Return JSON only:
{
  "primary_state": "string",
  "reaction": "string",
  "memory_tag": "string",
  "action_hint": "none|move_to_speaker|move_to_target|roam_play|deny_groom|accept_treat|refuse_treat"
}
`;
}

function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (e2) {
      return null;
    }
  }
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
    state.setup_complete = true;
    state.updated_at = nowIso();

    pushLimited(state.recent_events, {
      type: "setup_complete",
      at: nowIso()
    });

    return res.json({
      ok: true,
      dog_id: profile.dog_id,
      message: "Dog profile saved."
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to save profile." });
  }
});

app.post("/dog/react", async (req, res) => {
  try {
    const dogId = clampString(req.body?.dog_id);
    const eventType = clampString(req.body?.event_type, "general");
    const triggerText = clampString(req.body?.trigger_text, "");
    const extraNotes = clampString(req.body?.extra_notes, "");

    if (!dogId) {
      return res.status(400).json({ error: "dog_id is required." });
    }

    const state = getDogState(dogId);

    if (!state.profile || !state.setup_complete) {
      return res.status(404).json({ error: "Dog profile not set up yet." });
    }

    if (eventType === "location_change" && triggerText) {
      state.current_location = triggerText;
    }

    if (eventType === "home_set" && triggerText) {
      state.home_name = triggerText;
    }

    if (eventType === "daycare_checkin") {
      state.in_daycare = true;
    }

    if (eventType === "daycare_checkout") {
      state.in_daycare = false;
    }

    if (eventType === "random_tick") {
      state.ticks += 1;
    }

    state.updated_at = nowIso();

    const profile = state.profile;
    const intent = detectIntent(triggerText, profile.name);

    const userPrompt = `
Dog profile:
- name: ${profile.name}
- breed: ${profile.breed}
- age_group: ${profile.age_group}
- sex: ${profile.sex}
- fixed_status: ${profile.fixed_status}
- traits: ${profile.traits.join(", ") || "none"}
- likes: ${profile.likes.join(", ") || "none"}
- dislikes: ${profile.dislikes.join(", ") || "none"}
- household_names: ${profile.household_names.join(", ") || "none"}
- friend_names: ${profile.friend_names.join(", ") || "none"}
- owner_contact: ${profile.owner_contact || "none"}
- vet_info: ${profile.vet_info || "none"}
- shot_records: ${profile.shot_records || "none"}
- allergies: ${profile.allergies || "none"}
- daycare_history: ${profile.daycare_history || "none"}
- behavior_notes: ${profile.behavior_notes || "none"}

Current state:
- current_location: ${state.current_location}
- home_name: ${state.home_name}
- in_daycare: ${state.in_daycare}
- ticks: ${state.ticks}
- recent_memory: ${state.memories.join("; ") || "none"}

Current event:
- event_type: ${eventType}
- trigger_text: ${triggerText || "none"}
- detected_intent: ${intent}
- extra_notes: ${extraNotes || "none"}

Write a realistic dog reaction in JSON.
`;

    let parsed = null;

    try {
      const response = await client.responses.create({
        model: "gpt-5.4",
        input: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: userPrompt }
        ]
      });

      parsed = extractJson(response.output_text || "");
    } catch (modelError) {
      console.error("OpenAI error:", modelError);
    }

    if (!parsed) {
      parsed = fallbackReaction({
        profile,
        state,
        eventType,
        triggerText,
        intent
      });
    }

    if (parsed.memory_tag) {
      pushLimited(state.memories, parsed.memory_tag, 50);
    }

    pushLimited(state.recent_events, {
      type: eventType,
      trigger_text: triggerText,
      reaction: parsed.reaction,
      at: nowIso()
    });

    state.last_reaction = parsed.reaction || "";

    return res.json({
      ok: true,
      dog_id: dogId,
      primary_state: parsed.primary_state || "neutral",
      reaction: parsed.reaction || `${profile.name} watches closely.`,
      memory_tag: parsed.memory_tag || "",
      action_hint: parsed.action_hint || "none"
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to generate reaction." });
  }
});

app.get("/dog/:dog_id", (req, res) => {
  const dogId = req.params.dog_id;
  const state = getDogState(dogId);

  res.json({
    ok: true,
    dog_id: dogId,
    setup_complete: state.setup_complete,
    profile: state.profile,
    current_location: state.current_location,
    home_name: state.home_name,
    in_daycare: state.in_daycare,
    memories: state.memories,
    recent_events: state.recent_events,
    last_reaction: state.last_reaction
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("WAGGLE PET SERVER running on port " + PORT);
});
