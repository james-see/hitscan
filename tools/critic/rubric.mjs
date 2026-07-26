/**
 * The quality rubric the critic scores against.
 *
 * The point of writing this down is that "does it look AAA" is not a
 * decidable question, but "is there visible texture tiling" is. Every
 * category below is phrased so two people looking at the same frame would
 * agree on the score, and the disqualifiers are all binary presence checks.
 */

export const CATEGORIES = [
  {
    id: 'lighting',
    name: 'Lighting and exposure',
    prompt:
      'Is the lighting physically believable with a clear key direction? Is there real tonal range — deep shadows AND bright highlights — rather than a grey or blown-out wash? Are the black levels correct (not milky, not crushed)?',
  },
  {
    id: 'shadows',
    name: 'Shadow quality',
    prompt:
      'Are shadows present, correctly shaped and correctly anchored? Do they soften with distance from the occluder (contact hardening)? Any acne, peter-panning, visible cascade seams, or aliased/stair-stepped edges?',
  },
  {
    id: 'materials',
    name: 'Material response',
    prompt:
      'Do surfaces read as their actual substance — concrete like concrete, metal like metal? Is the specular response and roughness variation convincing? Anything looking like uniform plastic?',
  },
  {
    id: 'ao_gi',
    name: 'Ambient occlusion and indirect light',
    prompt:
      'Are objects grounded, with contact darkening where surfaces meet? Does indirect light look plausible, or is ambient flat and uniform? Any AO halos or over-darkening?',
  },
  {
    id: 'texture_detail',
    name: 'Texture detail and tiling',
    prompt:
      'Is texel density adequate and consistent across surfaces? Is there VISIBLE REPETITION of a tiling pattern? Any blurring, stretching, or mismatched scale between adjacent surfaces?',
  },
  {
    id: 'geometry',
    name: 'Geometry and silhouette',
    prompt:
      'Does the environment read as a real constructed place? Is there architectural detail, chamfered edges, thickness and varied silhouette — or are these textured boxes? Is the scene dressed and lived-in, or empty?',
  },
  {
    id: 'composition',
    name: 'Composition and art direction',
    prompt:
      'Does the frame have a focal point, depth layering and a coherent colour script? Would this pass as a marketing screenshot, or does it look like a tech demo?',
  },
  {
    id: 'post',
    name: 'Post-processing',
    prompt:
      'Are bloom, tonemapping and grading tasteful and film-like? Any blown highlights, muddy blacks, heavy-handed vignette or chromatic aberration? Does it look graded or raw?',
  },
  {
    id: 'temporal',
    name: 'Temporal stability',
    prompt:
      'Any aliasing crawl on high-contrast edges, specular shimmer, TAA ghosting or smearing, or visible noise that should have been denoised?',
  },
  {
    id: 'vfx',
    name: 'Effects quality',
    prompt:
      'Do particles, decals and effects integrate with the scene? Soft-particle depth fade present? Decals conforming to geometry rather than floating? (Score 5 as neutral if no effects are visible in this frame.)',
  },
  {
    id: 'weapon',
    name: 'Weapon presentation',
    prompt:
      'Does the viewmodel read as a real weapon in silhouette and material? Is its screen placement and scale right? (Score 5 as neutral if no viewmodel is visible in this frame.)',
  },
  {
    id: 'ui',
    name: 'HUD and UI',
    prompt:
      'Is the HUD legible, restrained and well-typeset? Does it feel designed, or default-styled? (Score 5 as neutral if no HUD is visible in this frame.)',
  },
];

/**
 * Binary defects. Any one of these present fails the gate regardless of
 * category scores, because each is individually enough to break the illusion.
 */
export const DISQUALIFIERS = [
  { id: 'visible_tiling', desc: 'Obvious repeating texture pattern on any large surface' },
  { id: 'flat_ambient', desc: 'Flat ambient-only shading with no directional shadow contribution' },
  { id: 'peter_panning', desc: 'Shadows detached from the object casting them' },
  { id: 'shadow_acne', desc: 'Self-shadowing stripe artefacts' },
  { id: 'taa_ghosting', desc: 'Smearing or trailing behind moving elements' },
  { id: 'aliasing_crawl', desc: 'Jagged or crawling high-contrast edges' },
  { id: 'uniform_albedo', desc: 'Large surfaces of a single flat untextured colour' },
  { id: 'missing_contact_shadows', desc: 'Objects appear to float; no contact darkening' },
  { id: 'plastic_metal', desc: 'Metal surfaces reading as matte plastic' },
  { id: 'blown_highlights', desc: 'Large regions clipped to pure white with no detail' },
  { id: 'untextured_boxes', desc: 'Geometry reading as raw untextured primitives' },
  { id: 'floating_decals', desc: 'Decals not conforming to the surface beneath them' },
];

/** Thresholds. The loop exits when all of these hold. */
export const GATE = {
  minCategoryScore: 8,
  minMeanScore: 8.5,
  maxDisqualifiers: 0,
  minFps: 60,
  maxIterations: 6,
};

/** JSON shape the critic must return. Enforced by `validateVerdict`. */
export const VERDICT_SCHEMA = {
  scores: 'object, keyed by category id, each { score: 1-10, note: string }',
  disqualifiers: 'array of disqualifier ids actually observed',
  worstProblem: 'string, the single highest-impact defect to fix next',
  fixes: 'array of specific, actionable fixes ordered by visual impact',
  verdict: 'string, one of: pass | fail',
};

export function buildCriticPrompt({ shotIds, iteration }) {
  return `You are a HARSH senior art director reviewing frames from a real-time browser FPS. You have shipped AAA titles. Your standard of comparison is a modern Call of Duty campaign screenshot.

Be genuinely critical. Inflated scores are worse than useless here: they end the improvement loop early and ship a mediocre product. A score of 8 means "would survive review at a AAA studio". Most first drafts deserve 3-5. Do not be encouraging. Do not grade on effort or on the constraints of the platform.

This is iteration ${iteration}. Frames under review: ${shotIds.join(', ')}.

Score each category from 1-10 and justify tersely:

${CATEGORIES.map((c) => `- ${c.id} (${c.name}): ${c.prompt}`).join('\n')}

Then list every disqualifier you actually OBSERVE in the images (do not list ones you merely suspect):

${DISQUALIFIERS.map((d) => `- ${d.id}: ${d.desc}`).join('\n')}

Return ONLY valid JSON, no prose outside it:
{
  "scores": { "<category_id>": { "score": <1-10>, "note": "<one sentence>" }, ... },
  "disqualifiers": ["<id>", ...],
  "worstProblem": "<the single highest-impact defect>",
  "fixes": ["<specific actionable fix>", ...],
  "verdict": "pass" | "fail"
}

The gate is: every category >= ${GATE.minCategoryScore}, mean >= ${GATE.minMeanScore}, and zero disqualifiers. Set "verdict" accordingly.`;
}

/** Validates and normalises a critic response. Throws on malformed input. */
export function validateVerdict(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    // Tolerate fenced code blocks and surrounding prose.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON object found in critic response');
    parsed = JSON.parse(match[0]);
  }

  if (!parsed.scores || typeof parsed.scores !== 'object') {
    throw new Error('verdict missing "scores"');
  }

  const scores = {};
  const missing = [];
  for (const category of CATEGORIES) {
    const entry = parsed.scores[category.id];
    if (!entry || typeof entry.score !== 'number') {
      missing.push(category.id);
      continue;
    }
    scores[category.id] = {
      score: Math.max(1, Math.min(10, entry.score)),
      note: String(entry.note ?? ''),
    };
  }
  if (missing.length > 0) throw new Error(`verdict missing categories: ${missing.join(', ')}`);

  const disqualifiers = Array.isArray(parsed.disqualifiers)
    ? parsed.disqualifiers.filter((d) => DISQUALIFIERS.some((x) => x.id === d))
    : [];

  return {
    scores,
    disqualifiers,
    worstProblem: String(parsed.worstProblem ?? ''),
    fixes: Array.isArray(parsed.fixes) ? parsed.fixes.map(String) : [],
  };
}

/** Applies the gate. Returns pass/fail plus the reasons it failed. */
export function evaluate(verdict, perf = {}) {
  const values = Object.values(verdict.scores).map((s) => s.score);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const below = Object.entries(verdict.scores)
    .filter(([, s]) => s.score < GATE.minCategoryScore)
    .map(([id, s]) => `${id}=${s.score}`);

  const reasons = [];
  if (below.length > 0) reasons.push(`below ${GATE.minCategoryScore}: ${below.join(', ')}`);
  if (mean < GATE.minMeanScore) reasons.push(`mean ${mean.toFixed(2)} < ${GATE.minMeanScore}`);
  if (verdict.disqualifiers.length > 0) {
    reasons.push(`disqualifiers: ${verdict.disqualifiers.join(', ')}`);
  }
  if (perf.fps !== undefined && perf.fps < GATE.minFps) {
    reasons.push(`fps ${perf.fps.toFixed(0)} < ${GATE.minFps}`);
  }

  return { passed: reasons.length === 0, mean, reasons, below };
}
