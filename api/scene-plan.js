const { refuseIfLocked } = require('../lib/mystio-gate');
// api/scene-plan.js
// POST { instruction, found: [{ index, text, width, height }] } -> a plan
//
// Turns one sentence -- "replace the licence plate number but keep the HZK" --
// into a decision about which piece of writing in the photograph is the target
// and how much of it survives.
//
// Note what is NOT asked here: where anything is. The app has already read the
// photograph with Vision and knows the exact corners of every piece of text in
// it, to the pixel, with its real perspective. Asking a model for coordinates
// was tried and does not work -- it put the box on the grille above the plate,
// then on the bumper below it. So the model is given the STRINGS and asked the
// only question it is better at than code: which of these did the performer
// mean, and which part of it should stay.
//
// A language decision made by a language model; a measurement made by a
// measuring tool. Each doing what it is good at is the whole design.

const MODEL = process.env.SCENE_PLAN_MODEL || 'gpt-4o';

const SYSTEM = [
  'A performer has a photograph and wants a value revealed inside it, written',
  'onto something already in the picture. You are given every piece of text the',
  'photograph contains, already located exactly, and one sentence describing',
  'what they want. Decide which piece of text is the target and how much of it',
  'is kept.',
  '',
  'Return STRICT JSON only:',
  '{"index": <number>, "keep": "<text that stays, or empty>",',
  ' "kind": "number"|"word", "note": "<one short sentence in plain words>"}',
  '',
  'index is the index of the chosen piece of text, from the list given.',
  '',
  'keep is the part of that text which must REMAIN, with the revealed value',
  'going after it. For "replace the plate number but keep the HZK" on a plate',
  'reading "HZK 1313", keep is "HZK". For "replace the whole house number",',
  'keep is empty. Copy the kept part EXACTLY as it appears in the text you were',
  'given, including its capitals -- it is going to be redrawn character for',
  'character, and a letter changed here is a letter changed on the plate.',
  '',
  'kind is what the performer will be revealing: "number" for digits, "word"',
  'for letters. Read it from the sentence; if it does not say, infer it from',
  'the part being replaced -- digits replaced by digits, letters by letters.',
  '',
  'Choose the target by what the sentence describes, not by size or position.',
  'A licence plate, a house number and a shop sign may all be in one photo.',
  'If the sentence names something that is not in the list at all, set index to',
  '-1 and explain in the note. Do not substitute the nearest thing: a plan for',
  'the wrong piece of writing looks exactly like a plan that worked, and the',
  'performer finds out in front of an audience.',
].join('\n');

module.exports = async (req, res) => {
  // Help me (2026-10-28) rides here too, and is for every tester rather than
  // the two modules below: any code that has anything at all may ask how the
  // app works. Checked before the narrower lock for that reason.
  if (req.method === 'POST' && req.body && typeof req.body === 'object' && req.body.helpMe) {
    if (await refuseIfLocked(req, res, HELP_ANY_MODULE)) return;
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
    return helpMe(req.body.helpMe, res);
  }
  // The server lock (lib/mystio-gate.js): off until MYSTIO_LOCK=on.
  if (await refuseIfLocked(req, res, 'photostudio,routinemaker')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    // The routine maker rides on this endpoint (Vercel Hobby allows 12
    // functions and api/ is at 12). See routineMaker below.
    if (body && body.routineMaker) return routineMaker(body.routineMaker, res);

    const { instruction, found } = body || {};
    const want = (typeof instruction === 'string' ? instruction : '').trim();
    if (!want) return res.status(400).json({ error: 'Say what you want replaced' });
    if (!Array.isArray(found) || !found.length) {
      return res.status(400).json({ error: 'No writing was found in this photo' });
    }

    const list = found
      .map((f, i) => `${i}: "${f.text}"  (${Math.round(f.width)} x ${Math.round(f.height)} pixels)`)
      .join('\n');

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        response_format: { type: 'json_object' },
        max_tokens: 300,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: `The performer says: "${want}"\n\nText found in the photograph:\n${list}`,
          },
        ],
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ error: `Model refused (${r.status}): ${text.slice(0, 300)}` });
    }
    const out = JSON.parse((await r.json())?.choices?.[0]?.message?.content || '{}');

    const index = Number(out.index);
    if (!Number.isInteger(index) || index < 0) {
      return res.status(404).json({
        error: out.note || `Nothing in this photo matches "${want}"`,
      });
    }
    if (index >= found.length) {
      return res.status(502).json({ error: 'The model chose a piece of text that does not exist' });
    }

    // The kept part must genuinely be part of the chosen text. A model that
    // invents or reformats it would have the app redraw something that was
    // never on the plate, which is the one failure that still looks correct.
    let keep = typeof out.keep === 'string' ? out.keep.trim() : '';
    if (keep && !found[index].text.includes(keep)) {
      return res.status(502).json({
        error: `It wanted to keep "${keep}", which is not part of "${found[index].text}"`,
      });
    }

    res.json({
      index,
      keep,
      kind: out.kind === 'word' ? 'word' : 'number',
      note: typeof out.note === 'string' ? out.note.slice(0, 300) : '',
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};

// ---------------------------------------------------------------------------
// Routine maker: POST { routineMaker: { request, catalog } } -> a routine spec
//
// Shine says what he wants in one sentence -- "I will swipe a card and it
// should print the cat's photo with the card on it" -- and MystIO builds the
// routine. The APP sends the catalog (every input, processing step, output,
// option and saved photo it has, with a line on what each one is for), so the
// app stays the one place that knows what exists; this only chooses from it.
// Anything chosen that is not in the catalog is dropped here and again in the
// app. Something asked for that the catalog cannot do goes in `missing`, never
// onto the nearest thing: a routine wired to the wrong output looks exactly
// like one that works until the reveal.

const ROUTINE_MODEL = process.env.ROUTINE_MODEL || 'gpt-4.1';

const ROUTINE_SYSTEM = [
  'You set up routines in MystIO, a mentalist\'s performance app. A routine is:',
  'one or more INPUTS (how the secret value reaches the phone), ONE processing',
  'step (what is done to the value), OUTPUTS (where the value is revealed),',
  'at most one PROP, an optional app to open when the routine is armed, and',
  'OPTIONS that configure the chosen outputs.',
  '',
  'You are given the performer\'s description and a CATALOG. Use ONLY ids from',
  'the catalog. Read every hint: they say which choice fits which wording, and',
  'which options an output needs switched on to do anything at all. Switching',
  'on the options the description implies is the most important part of the',
  'job -- an output with its options off does nothing.',
  '',
  'Return STRICT JSON only:',
  '{"name": "<short routine name, 2-5 words>",',
  ' "inputs": ["<input id>", ...],',
  ' "processing": "<processing id>",',
  ' "outputs": ["<output id>", ...],',
  ' "prop": "<prop id or empty>",',
  ' "launchApp": "<url from the apps list, or empty>",',
  ' "options": {"<option key>": <true|false|"text">, ...},',
  ' "missing": ["<plain sentence: something asked for that the catalog cannot do>"],',
  ' "assumptions": ["<plain sentence: a choice you made that the description did not state>"]}',
  '',
  'Rules:',
  '- Only include an option when the description implies it or a hint says the',
  '  output needs it. Use the option\'s exact key and type.',
  '- For a "pick" option, the value must be one of its listed choices exactly.',
  '- Never invent ids, keys or choices. If nothing fits, leave it out and say so',
  '  in missing.',
  '- If the description is silent about the processing, use "none".',
  '- Keep assumptions few and concrete, written to the performer ("you"), and',
  '  only for choices the description did NOT state. Do not restate what they said.',
  '- Write missing and assumptions in plain words. Never mention ids, option',
  '  keys or JSON -- say "printing is on", not "cardPhotoPrint".',
  '- Never put in missing something the routine you are returning already does.',
  '- missing is only for things the catalog cannot do. Something the catalog\'s',
  '  setup section says is already in place is not missing.',
].join('\n');

async function routineMaker(input, res) {
  const request = typeof input.request === 'string' ? input.request.trim() : '';
  const catalog = input.catalog;
  if (!request) return res.status(400).json({ error: 'Say what the routine should do' });
  if (!catalog || !Array.isArray(catalog.inputs) || !Array.isArray(catalog.outputs)) {
    return res.status(400).json({ error: 'No catalog sent' });
  }
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: ROUTINE_MODEL,
        response_format: { type: 'json_object' },
        max_tokens: 900,
        temperature: 0,
        messages: [
          { role: 'system', content: ROUTINE_SYSTEM },
          { role: 'user', content: `CATALOG:\n${JSON.stringify(catalog)}\n\nThe performer says: "${request}"` },
        ],
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ error: `Model refused (${r.status}): ${text.slice(0, 300)}` });
    }
    const out = JSON.parse((await r.json())?.choices?.[0]?.message?.content || '{}');

    const ids = (list) => new Set((list || []).map((x) => x.id));
    const inIds = ids(catalog.inputs), outIds = ids(catalog.outputs);
    const procIds = ids(catalog.processing), propIds = ids(catalog.props);
    const apps = new Set((catalog.apps || []).map((a) => a.url));
    const optByKey = new Map((catalog.options || []).map((o) => [o.key, o]));
    const dropped = [];
    const keep = (list, valid, what) => (Array.isArray(list) ? list : []).filter((x) => {
      if (valid.has(x)) return true;
      dropped.push(`${what} "${x}"`); return false;
    });

    const options = {};
    for (const [k, v] of Object.entries(out.options || {})) {
      const o = optByKey.get(k);
      if (!o) { dropped.push(`option "${k}"`); continue; }
      if (o.type === 'bool' && typeof v === 'boolean') options[k] = v;
      else if (o.type === 'text' && typeof v === 'string') options[k] = v;
      else if (o.type === 'pick' && typeof v === 'string' && (o.choices || []).includes(v)) options[k] = v;
      else dropped.push(`option "${k}" = ${JSON.stringify(v)}`);
    }

    res.json({
      name: typeof out.name === 'string' ? out.name.trim().slice(0, 60) : '',
      inputs: keep(out.inputs, inIds, 'input'),
      processing: procIds.has(out.processing) ? out.processing : 'none',
      outputs: keep(out.outputs, outIds, 'output'),
      prop: propIds.has(out.prop) ? out.prop : '',
      launchApp: apps.has(out.launchApp) ? out.launchApp : '',
      options,
      missing: (Array.isArray(out.missing) ? out.missing : []).filter((x) => typeof x === 'string'),
      assumptions: (Array.isArray(out.assumptions) ? out.assumptions : []).filter((x) => typeof x === 'string'),
      dropped,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}


// ── Help me ─────────────────────────────────────────────────────────────────
//
// The performer types what they want ("make the Thumper stop pressing
// Return", "my card reader is not connecting") and MystIO answers, takes them
// to the screen, or changes the setting or routine for them. Same rule as the
// routine maker: the APP sends what exists on this phone (screens, settings
// with current values, routines, devices), filtered to the modules this code
// has, and the answer may only name what it was sent. The app checks every id
// again and asks before changing anything.

const HELP_MODEL = process.env.HELP_MODEL || 'gpt-4.1';
const HELP_ANY_MODULE = 'voice,routinemaker,remote_mb,remote_thumper,remote_wilson,remote_synaptic,calculator,readers,audience,cardphoto,motherboard,customurl';

const HELP_SYSTEM = [
  'You are the help inside MystIO, a mentalist\'s performance app on an iPhone.',
  'You talk to the performer: short, plain, friendly, no jargon. Never mention',
  'ids, keys, JSON or code. Never mention anything that is not in CONTEXT: if a',
  'feature is not listed, this performer does not have it, and you say only',
  'that you cannot see a way to do that here.',
  '',
  'CONTEXT has:',
  '- screens: places you can send them (id, title, where it is, what is there).',
  '- settings: app-wide settings (key, label, where, type, current value, hint).',
  '  "changeable" ones you may change for them; the rest you send them to.',
  '- routines: their routines with inputs, processing, outputs and options as',
  '  they are now, and which one is armed.',
  '- routineCatalog: every input, processing, output and routine option that',
  '  exists, with hints. A routine change may only use these ids and keys.',
  '- devices: what is connected right now, for troubleshooting.',
  '',
  'How to help:',
  '- If they want something changed, find the setting or routine option that',
  '  does it. Prefer changing it for them (an action) over describing the taps.',
  '  Say in one sentence what will change. Always also give an open action to',
  '  where it lives, so they can see it.',
  '- If it is a routine, say which routine and what changes. If it is unclear',
  '  which routine they mean, ask, listing the likely ones by name.',
  '- If something is not working, use devices and the current values to find',
  '  the likely cause, say it plainly, and offer the fix as an action.',
  '- If you need to know something, ask one short question.',
  '- Keep the reply under 90 words. Numbered steps only when they must tap',
  '  through something themselves.',
  '',
  'Return STRICT JSON only:',
  '{"reply": "<what you say>",',
  ' "actions": [',
  '   {"kind": "open", "screen": "<screen id>"},',
  '   {"kind": "set", "key": "<changeable setting key>", "value": <true|false|number>},',
  '   {"kind": "routine", "id": "<routine id>",',
  '    "addInputs": ["<input id>"], "removeInputs": [], "addOutputs": ["<output id>"],',
  '    "removeOutputs": [], "processing": "<processing id or empty>",',
  '    "options": {"<option key>": <true|false|"text">}}',
  ' ]}',
  '',
  'Rules:',
  '- Only ids, keys and choices that are in CONTEXT. Never invent one.',
  '- A set value must match the setting type (bool or number in its range).',
  '- Leave out fields of a routine action that do not change.',
  '- actions may be empty. Never more than 4.',
  '- Do not repeat an action that the conversation shows was already done.',
].join('\n');

async function helpMe(input, res) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const context = input.context;
  const turns = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Ask a question' });
  }
  if (!context || typeof context !== 'object') return res.status(400).json({ error: 'No context sent' });
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: HELP_MODEL,
        response_format: { type: 'json_object' },
        max_tokens: 900,
        temperature: 0.2,
        messages: [
          { role: 'system', content: HELP_SYSTEM },
          { role: 'system', content: 'CONTEXT:\n' + JSON.stringify(context) },
          ...turns,
        ],
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || `Help failed (${r.status})` });
    let out = {};
    try { out = JSON.parse(j.choices[0].message.content); } catch { out = {}; }
    const reply = typeof out.reply === 'string' ? out.reply.replace(/—/g, ',') : '';
    const actions = Array.isArray(out.actions) ? out.actions.slice(0, 4) : [];
    if (!reply) return res.status(502).json({ error: 'Help did not answer. Try again.' });
    return res.status(200).json({ reply, actions });
  } catch (e) {
    return res.status(500).json({ error: 'Help failed: ' + e.message });
  }
}
