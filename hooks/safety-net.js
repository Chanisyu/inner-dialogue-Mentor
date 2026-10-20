#!/usr/bin/env node
// <!-- version: 1.0.0 -->
//
// safety-net.js — UserPromptSubmit hook: mechanical crisis-language backstop.
//
// This is a BACKSTOP, not the safety system. The prose protocol in
// `.therapy/safety-protocol.md` remains the primary and authoritative
// crisis-handling instruction; this hook only injects a reminder when a
// cheap pattern match fires, in case the model's attention has drifted.
//
// The Emergency Resources text injected below is sourced verbatim from
// `safety-protocol.md` (Emergency Resources block). If that block changes,
// this file must be updated to match — a test extracts the fenced block
// from `safety-protocol.md` and asserts the injected text contains it
// verbatim, line for line.
//
// SCOPING (per the recorded product ruling, 2026-07-05): first-person
// crisis language FIRES, recall-first within first-person space.
// Third-person reports ("my brother has been suicidal"), grief, media,
// topical, and professional mentions stay SILENT — the mechanical notice
// is for the client's own crisis, not reports about someone else's.
// The prose protocol still governs both cases at the model level.
//
// 中文化说明：保留原英文匹配，并并列加入中文第一人称与省略主语模式。
// 两种语言均采用原有的“召回优先”范围；口语夸张、第三人称叙述使用
// 各自的误报护栏。匹配只注入提醒，实际语境仍由模型按文字方案判断。
// 资源文本与 safety-protocol.md 的围栏内容保持一致，修改后由测试核对。
//
// Parse-mode note: this file is copied into installs where no package.json
// declares a module type, so it may be parsed as CommonJS there and as ESM
// inside this repo ("type": "module"). It therefore uses ONLY globals —
// no import/export/require — and is valid under both parse modes.
//
// Fail-open contract: on ANY error (malformed JSON, empty stdin, missing
// or non-string prompt, closed stdout, stdin that never ends, a sync throw
// during stdio setup), exit 0 with no output. Oversized payloads are
// bounded, not fatal: the first 4MB is retained and scanned raw, the rest
// is treated as no-match. A broken hook must never break a session.
//
// Pattern convention: input is normalized (lowercased, unicode punctuation
// folded, whitespace collapsed) before matching, so every pattern source
// below must be lowercase. A test enforces this.

'use strict';

// --- Shared word classes (round-4 F45 structural) -------------------------
// One adverb/intensifier class is consumed by BOTH the first-person gap
// (FP_GAP) and the third-person chain (TP_CHAIN). The two grammars kept
// drifting apart when maintained as separate inline lists ("i'm honestly
// suicidal" fired while "my brother has honestly been suicidal" also fired
// because only one list knew "honestly"). A drift-guard test asserts both
// composites reference this constant and that SL_HEAD stays a subset of the
// FP_GAP filler class.
var ADVERBS =
  'so|very|really|extremely|incredibly|pretty|honestly|genuinely' +
  '|seriously|truly|literally|actually|basically|apparently|just|still' +
  '|also|too|often|always|constantly|sometimes|occasionally|usually' +
  '|never|ever|kinda|lately|recently|again|now|almost|even|fucking' +
  '|freaking|goddamn|damn|completely|totally|deeply|dangerously|quite' +
  '|super|real|lowkey|low-key|hella';

// First-person anchor + bounded filler gap. Crisis keywords composed with
// fp() fire only when an explicit first-person subject precedes them,
// separated by at most six words from a closed class of auxiliaries,
// modals, volitional verbs, and the shared adverbs. Any other intervening
// word (a name, "my brother", "she", "people who") breaks the anchor and
// the pattern stays silent. The enumeration lookbehind keeps true
// enumeration heads ("chapter i", "act i") from reading the roman numeral
// as a first-person subject — it applies ONLY to bare "i": contractions
// ("i'm", "i've") can never be roman numerals, and everyday nouns that
// merely can take numbering (class, war, stage, level, season) are not in
// the list, so "after class i was so suicidal" fires (round-4 F40).
// The first-person token class is SHARED between FP_HEAD and the
// third-person clause rescue in tpBlock() (round-5 F51 — same move as
// ADVERBS): the rescue must recognize every subject form FP_HEAD accepts,
// including the apostrophe-less "im"/"ive", or "ive got the pills to end
// it all" reads as a det+noun subject instead of a first-person clause.
var FP_SUFFIX = "'m|'ve|'d|'ll|m|ve";
var FP_TOKEN = 'i(?:' + FP_SUFFIX + ')?';
var FP_HEAD =
  '\\b(?:i(?:' + FP_SUFFIX + ')|(?<!\\b(?:chapter|act|section|appendix' +
  '|exhibit|figure|table|volume|phase)\\s)i)';
var FP_GAP_FILLERS =
  'am|are|was|be|been|being|has|have|having|had|feel|feels|felt' +
  '|feeling|keep|keeps|kept|get|gets|got|getting|gotten|start|started' +
  "|starting|stop|stopped|can't|cant|cannot|couldn't|couldnt|won't|wont" +
  "|will|would|wouldn't|wouldnt|might|may|could|should|must|want|wanted" +
  '|wanting|wanna|need|needed|gonna|going|about|of|to|think|thinking' +
  '|thought|like|this|that|a|an|tried|try|trying|plan|plans|planned' +
  '|planning|decided|decide|intend|hoping|hope|take|took|taking|taken';
var FP_GAP = '(?:\\s+(?:' + FP_GAP_FILLERS + '|' + ADVERBS + ')){0,6}';

function fp(tail) {
  return new RegExp(FP_HEAD + FP_GAP + '\\s+' + tail);
}

// Third-person anti-anchor for subjectless and bare-gerund patterns: a
// negative lookbehind that goes silent when a third-person subject plus a
// closed chain of verbs, modals, and the shared adverbs immediately
// precedes the match ("my friend is attempting suicide", "she said she
// would be better off dead"). The chain class deliberately excludes
// first-person tokens ("i", "i've") and conjunctions, so "my mom died and
// i want to die" and "she knows i want to die" keep firing — the chain
// breaks and the anchor survives.
//
// Two branches:
//  - pronoun subjects (he/she/they/you/it...). First-person plural "we"
//    forms are NOT here: per the recorded PM ruling (F41, 2026-07-05),
//    "we want to die" fires; generic-you stays silent.
//  - determiner + noun subjects ("my brother", "the article"). This branch
//    only blocks when NO first-person token appears earlier in the same
//    clause (round-4 F38/F39; the token class is the shared FP_TOKEN, so
//    apostrophe-less "im"/"ive" also rescue — round-5 F51): a det+noun
//    inside a first-person clause is an object, not a subject — "i have
//    the pills to end it all", "i told my mom that i want to die" fire,
//    while "my brother wants to end it all" stays silent. The noun slot
//    additionally excludes first-person tokens ("that i want to die").
//    The SELF_NOUNS exemption (plan/mind/part/voices/urge... — the
//    speaker's own state: "my plan is to end it all", IFS parts language)
//    applies ONLY to first-person/neutral determiners; third-person
//    possessives (his/her/their/your) block ALL nouns — "his plan is to
//    end it all" is a report about someone else (round-5 F49).
//    The clause scan is bounded (80 chars back to a clause boundary) so
//    matching stays linear on adversarial input.
// Apostrophe-less contractions (hes/shes/theyre/...) are included for
// parity with FP_HEAD accepting "im"/"ive" — they are unambiguous
// third-person tokens (none is an English word on its own; ambiguous
// forms like "shed"/"hed"/"its" are deliberately excluded).
var TP_PRON =
  "(?:he|she|they|you|it|who|he's|she's|it's|they're|you're" +
  "|he'd|she'd|they'd|you'd|they've|you've|he'll|she'll|they'll|you'll" +
  "|it'll|hes|shes|theyre|youre|theyve|youve)";
var TP_CHAIN_LINKS =
  'is|are|was|were|be|been|being|has|have|having|had|says|said|say' +
  '|saying|keeps|keep|kept|wants|want|wanted|wanting|feels|feel|felt' +
  '|feeling|thinks|think|thought|thinking|talks|talk|talked|talking' +
  '|seems|seem|seemed|described|discussed|mentioned|admitted|would|will' +
  "|might|may|could|should|must|can't|cant|won't|wont|wouldn't|wouldnt" +
  '|to|about|of|that|he|she|they|it|you|her|him|them|his|their' +
  '|with|struggles|struggle|struggled|struggling|deals|deal|dealt' +
  '|dealing|lives|live|lived|living';
var TP_CHAIN = '(?:\\s+(?:' + TP_CHAIN_LINKS + '|' + ADVERBS + ')){0,5}';
// Same chain with at least one link: consumed via tpBlock(TP_CHAIN_MIN1)
// by patterns where det+adjective directly before the keyword must read
// as a modifier, not a subject ("my intrusive suicidal thoughts are back"
// fires; verb-mediated "my son has suicidal thoughts" stays silent) —
// round-5 F48.
var TP_CHAIN_MIN1 = '(?:\\s+(?:' + TP_CHAIN_LINKS + '|' + ADVERBS + ')){1,5}';
var TP_DET_THIRD = '(?:his|her|their|your)';
var TP_DET_NEUTRAL = '(?:my|our|the|this|that|a|an)';
var SELF_NOUNS =
  'plan|plans|goal|goals|decision|decisions|mind|brain|head|heart|body' +
  '|soul|gut|part|parts|voice|voices|urge|urges';
// Any first-person token (shared FP_TOKEN plus longer contractions).
var TP_NOUN_FP = '(?:' + FP_TOKEN + "|i'[a-z]+)";
var TP_NOUN_ANY = '(?!' + TP_NOUN_FP + "\\b)[a-z']+";
var TP_NOUN = '(?!(?:' + TP_NOUN_FP + '|' + SELF_NOUNS + ")\\b)[a-z']+";
var TP_SUBJ =
  '(?:' +
  TP_DET_THIRD +
  '\\s+' +
  TP_NOUN_ANY +
  '(?:\\s+' +
  TP_NOUN_ANY +
  ')?' +
  '|' +
  TP_DET_NEUTRAL +
  '\\s+' +
  TP_NOUN +
  '(?:\\s+' +
  TP_NOUN +
  ')?)';

function tpBlock(detChain) {
  return (
    '(?<!\\b' +
    TP_PRON +
    TP_CHAIN +
    '\\s)' +
    '(?<!(?:^|[.!?\\n;])(?:(?!\\b' +
    FP_TOKEN +
    '\\b)[^.!?\\n;]){0,80}?\\b' +
    TP_SUBJ +
    detChain +
    '\\s)'
  );
}
var TP_BLOCK = tpBlock(TP_CHAIN);

// Subjectless first-person forms ("feeling suicidal again", "planning to
// commit suicide"): a closed class of dropped-subject heads (progressive /
// perfect / volitional), anti-anchored so third-person subject chains
// ("she has been feeling suicidal") stay silent. Per the recorded ruling's
// fire-list, these are treated as elided first person.
var SL_HEAD =
  '\\b(?:feeling|feel|felt|been|being|having|planning|planned|plan' +
  '|wanting|wanted|want|hoping|trying|tried|thinking|decided|going|gonna)';

function sl(tail) {
  return new RegExp(TP_BLOCK + SL_HEAD + FP_GAP + '\\s+' + tail);
}

function tp(source) {
  return new RegExp(TP_BLOCK + source);
}

// Shared overdose tail for the fp()/sl() composites below. The
// prevention/awareness guard is general; the call guard is inverted to a
// continuation blocklist (round-6 F54, narrowed round-8 F59): "call(s)"
// reads as the professional noun compound and stays silent ONLY when
// followed by an unambiguous compound continuation — a bare
// preposition/adverb ("call at work", "call yesterday") or a compound
// noun ("call center", "call logs"). The round-6 determiner+time-noun
// branch was REMOVED per the PM asymmetric-close ruling (2026-07-05): it
// swallowed help imperatives ("call the night nurse", "call a couple
// friends" — F59, the F47 shape again), so its professional readings
// ("call an hour into my shift", "call the other day") now FIRE as
// accepted over-fires — Plan-2 eval candidates. Any other continuation —
// a digit, a person, a service, "for", "now", end of message — reads as
// a help imperative or idiom inside crisis language ("overdose call
// 911", "call mom", "call for help") and fires. Recall-first: unknown
// continuations fire.
// Round-8 F62 (final strike, PM option-A ruling 2026-07-05): six tokens
// (during|while|today|tonight|once|every) were REMOVED from the blocklist
// because they silenced first-person overdose imperatives ("i overdosed
// call every hotline", "call once you get this", "call tonight please",
// "call while you still can", "call during the night"). Only the tokens
// pinned by a professional-silent fixture stay — "call at work" (at),
// "call yesterday" (yesterday), "call center" (cent...). Professional
// variants headed by a stripped token ("i took an overdose call during
// the night") now FIRE — the ruled over-fire direction, Plan-2 candidates.
var OVERDOSE_TAIL =
  'overdos(?:e|ed|ing)\\b(?!\\s+(?:prevention|awareness)\\b)' +
  '(?!\\s+calls?\\s+(?:at|from|earlier|yesterday' +
  '|last|twice' +
  '|cent(?:er|re)s?|lines?|logs?|volume|training|shifts?)\\b)';

// NOTE — die-of-embarrassment idiom guard: attempted (crisis-eval-precision
// T-005) and WITHDRAWN (T-009) after three adversarial review rounds each
// found a live first-person false-silence corridor in a successive repair
// (round-1 F1 "of shame" composites; round-2 F17 mid-message punctuation;
// round-3 F25 newline connectors + F26 method-noun continuations, e.g.
// "i want to die of embarrassment about the pills" silent). A regex suffix
// guard on "want to die of X" cannot distinguish hyperbole from a crisis
// composite, so per the asymmetric-close ruling (over-fire side always)
// the idiom OVER-FIRES by design: "i want to die of embarrassment" gets
// the notice, and the notice's own text tells the model to assess context.
// Measured + gate-locked in evals (05-venting-die-embarrassment,
// 06-idiom-die-shame). Do not reintroduce a guard here without a PM ruling
// and corridor-free evidence at eval depth.

// Tier 1: explicit suicidal-ideation / self-harm / method language.
// Recall-first: within clearly first-person crisis space, prefer to match.
var TIER1_PATTERNS = [
  tp('\\bwant(?:ed)?\\s+to\\s+die\\b'),
  tp('\\bwanna\\s+die\\b'),
  /\bwish\s+i\s+(?:was|were)\s+dead\b/,
  /\bwish\s+i\s+(?:wasn'?t|weren'?t|was\s+not|were\s+not)\s+alive\b/,
  /\bk[i1!]ll(?:ing|ed)?\s+myself\b/,
  /\bunaliv(?:e|ing|ed)\s+(?:myself|me)\b/,
  /^[^a-z0-9]*(?:[a-z']+\s+){0,2}kms(?:\s+[a-z']+){0,2}[^a-z0-9]*$/,
  // First-person kms grammar, composed from the shared anchor/gap: the
  // gap absorbs auxiliaries ("i've been wanting to kms") and a volitional
  // verb is still required right before "kms", so "i think kms is the
  // right aws service" stays silent.
  fp(
    "(?:want(?:ed|ing)?\\s+to|wanna|gonna|going\\s+to|about\\s+to" +
      '|th(?:ink(?:ing)?|ought)\\s+(?:about|of)|might|could|should|will' +
      '|would|need(?:ed)?\\s+to|have\\s+to|hoping\\s+to|tr(?:ying|ied)' +
      '\\s+to|to)\\s+(?:just\\s+)?kms\\b'
  ),
  // Trailing vent: ", kms" / newline + "kms" at the very end of the
  // message. Distance/technical uses never sit alone after a clause break
  // at end of message.
  /(?:[.!?,;:…]|\n)\s*kms\b[^a-z0-9]*$/,
  /\bend(?:ing)?\s+my\s+(?:own\s+)?life\b/,
  tp('\\bend(?:ing)?\\s+it\\s+all\\b'),
  /\bwant(?:ed)?\s+to\s+end\s+it\b/,
  // Round-2 review F19 (recall addition per the asymmetric-close ruling —
  // "no explicit first-person crisis phrase may be silent"): the plain
  // future declaration "i am going to end it" matched nothing (tier-1 had
  // want/thinking/plan heads but not going/gonna). Anti-anchored so
  // third-person reports ("she is going to end it") stay silent. Accepted
  // consequence, over-fire side of the ruling: breakup phrasing ("going to
  // end it with him") fires — measured + gate-locked in the eval corpus;
  // no "with"-guard because "end it with pills" is method language.
  tp('\\b(?:going\\s+to|gonna)\\s+end\\s+it\\b'),
  /\bthink(?:ing)?\s+(?:about|of)\s+ending\s+it\b/,
  /\b(?:don'?t|do\s+not)\s+(?:want\s+to|wanna)\s+be\s+here\b/,
  /\b(?:don'?t|do\s+not)\s+(?:want\s+to|wanna)\s+live\b/,
  /\b(?:want(?:ed)?\s+to|wanna)\s+be\s+dead\b/,
  /\bbetter\s+off\s+without\s+me\b/,
  tp('\\bbetter\\s+off\\s+dead\\b'),
  /\b(?:no\s+one|no-one|nobody)\s+would\s+miss\s+me\b/,
  /\b(?:cut|cutting|hurt|hurting|harm|harming|harmed|hang|hanging|hanged)\s+myself\b/,
  /\bsh(?:oot|ooting|ot)\s+myself\b(?!\s+in\s+the\s+foot)/,
  /\b(?:to|gonna|might|could|should|would|wanna|will|i'?ll|i)\s+(?:just\s+)?off\s+myself\b/,
  /\boffing\s+myself\b/,
  // The separator width tracks normalize(): zero-width concatenation
  // ("selfharm", censor-avoidant) through up to three whitespace chars
  // ("self \n harm") match, but at most ONE newline — a blank line is a
  // paragraph break, not a split word, so "my old self\n\nharm reduction
  // is the topic at work" stays silent (round-4 F46, round-5 F50).
  /\bself(?!(?: ?\n){2})[-\s]{0,3}harm(?!\s+(?:awareness|prevention)\b)/,
  fp('suicidal\\b'),
  sl('suicidal\\b'),
  // Anti-anchored, not allowlisted (round-4 F37): elided-first-person
  // determiners ("these/those/constant suicidal thoughts", bare "suicidal
  // thoughts wont stop") fire; explicit third-person possessives and
  // subject chains ("his suicidal thoughts", "my son has suicidal
  // thoughts") and topical "patients with suicidal ideation" stay silent.
  // Round-5 F48: the det branch requires >=1 chain verb here, so
  // det+adjective directly before "suicidal" reads as a modifier, not a
  // subject ("my intrusive suicidal thoughts are back" fires). The
  // with-guard is scoped to professional/topical subjects (up to two
  // non-first-person words before "with" cover "teens who struggle
  // with..."), so first-person struggle idioms ("i'm struggling with
  // suicidal thoughts", "living with suicidal ideation is exhausting")
  // fire.
  // Round-6 F53, narrowed round-8 F57/F58 (PM asymmetric-close ruling,
  // 2026-07-05: no explicit first-person crisis phrase may be silent;
  // every remaining boundary takes the over-fire side): the only
  // possessive-of-other guard left is a third-person possessive pronoun
  // (his/her/their/your) IMMEDIATELY before the keyword — "his suicidal
  // thoughts scared his wife" stays silent. The round-6 bare-s/genitive
  // noun lookbehind and the pronoun modifier gap were REMOVED: they
  // silenced first-person forms ("i have serious suicidal thoughts", "my
  // depression causes suicidal thoughts", "i can't tell her these
  // suicidal thoughts are getting worse" — F57/F58 false-silences).
  // Genitive reports ("my brother's / the patients suicidal ideation")
  // and modified pronoun possessives ("his intrusive suicidal thoughts")
  // now FIRE as accepted over-fires — Plan-2 eval candidates.
  // Round-6 F55: the with-guard gets the same bounded first-person clause
  // rescue the det branch uses ("i'm one of those people struggling with
  // suicidal thoughts" fires) plus an "as someone/people..."
  // self-apposition carve-out ("as someone dealing with suicidal thoughts
  // i need help" fires); subjectless professional/topical forms
  // ("patients with...", "so many people struggle with...") stay silent.
  // Its over-fires on first-person professional framing ("i see patients
  // with suicidal ideation every day at work") and descriptive "as
  // people with..." apposition are accepted per the same ruling (F60).
  new RegExp(
    tpBlock(TP_CHAIN_MIN1) +
      '(?<!\\b(?:' + TP_DET_THIRD + ')[^\\S\\n])' +
      '(?<!(?:^|[.!?\\n;])(?:(?!\\b' +
      FP_TOKEN +
      '\\b)[^.!?\\n;]){0,80}?\\b(?<!\\bas\\s)' +
      '(?:patients?|people|person|clients?|teens?|teenagers?' +
      '|adolescents?|adults?|kids?|children|students?|veterans?|those' +
      '|anyone|someone|somebody|folks)\\s+(?:(?!' +
      FP_TOKEN +
      "\\b)[a-z']+\\s+){0,2}with\\s)" +
      '\\bsuicidal\\s+(?:thoughts?|ideation)\\b'
  ),
  fp('th(?:ink(?:ing)?|ought)\\s+(?:about|of)\\s+suicide\\b'),
  // Subjectless thinking-about-suicide, anchored to the start of a clause
  // where the dropped subject reads as elided first person (round-4 F43:
  // "been thinking about suicide a lot", "thinking about suicide again").
  // Mid-clause gerunds keep their subject ("he is thinking about suicide",
  // "an article about teens thinking about suicide") and stay silent.
  /(?:^|[.!?\n;])\s*(?:been\s+)?th(?:ink(?:ing)?|ought)\s+(?:about|of)\s+suicide\b/,
  fp('commit(?:ted|ting)?\\s+suicide\\b'),
  sl('commit(?:ted|ting)?\\s+suicide\\b'),
  fp('attempt(?:ed|ing)?\\s+suicide\\b'),
  tp('\\battempting\\s+suicide\\b'),
  // The topical-suffix guard mirrors the self-harm awareness/prevention
  // guard (round-4 F44): "taking an overdose prevention course" / "took an
  // overdose call at work" are professional/topical, not crisis. The call
  // guard is scoped to the noun-compound reading only (round-5 F47):
  // "overdose call" followed by an object token is an unpunctuated help
  // imperative ("overdose call 911", "overdose call an ambulance") or an
  // idiom ("overdose call me crazy") inside crisis language, and fires.
  fp(OVERDOSE_TAIL),
  sl(OVERDOSE_TAIL),
  tp('\\bthink(?:ing)?\\s+(?:about|of)\\s+overdosing\\b'),
  /\bmy\s+suicide\s+(?:note|plan|attempt)\b/,
  tp('\\bplan(?:ning|ned)?\\s+to\\s+(?:die|kill|end\\s+(?:it|my\\s+life))\\b'),
  /\bplan(?:ning|ned)?\s+my\s+(?:own\s+)?suicide\b/,
  /\b(?:tak(?:e|ing)|took)\s+my\s+(?:own\s+)?life\b/
];

// Tier 2: conservative warning-sign phrasings (kept minimal on purpose;
// tuning happens later with evals). The can't-go-on family is anchored to
// the end of a clause so everyday objects stay silent.
var TIER2_PATTERNS = [
  /\b(?:giv(?:e|ing|en)|gave)\s+(?:away\s+)?(?:all\s+(?:of\s+)?)?my\s+(?:things|stuff|belongings|possessions)(?:\s+away)?\b/,
  /\bsaying\s+(?:my\s+)?goodbyes?\b/,
  /\bfinal\s+goodbyes?\b/,
  /\bwon'?t\s+matter\s+soon\b/,
  // The can't-go-on family is anchored to the end of a clause: end of
  // message, a newline (normalize preserves newlines as clause
  // boundaries), or any non-alphanumeric tail (punctuation, emoji). When
  // an "anymore"/"like this" tail is present the phrase is unambiguous,
  // so coordinated continuation is allowed ("...anymore and i'm scared").
  /\b(?:can'?t|cannot)\s+(?:do\s+this|go\s+on|take\s+(?:it|this))(?:\s+(?:anymore|any\s+more|like\s+this)\b|(?= *(?:$|\n|[^a-z0-9\s])))/,
  /\bno\s+reason\s+to\s+(?:live|go\s+on|keep\s+going)\b/,
  /\bnothing\s+(?:left\s+)?to\s+live\s+for\b/,
  /\bno\s+point\s+in\s+(?:living|going\s+on)\b/,
  // Transactional-noun suffix guard (crisis-eval-precision T-005/T-B;
  // retreated in T-006; end-of-message-bounded in T-008; `\s*$` in T-009
  // after review round-3 F25): ONLY "of <det> contract/lease" — `contract`
  // is the measured F12 over-fire noun (06-idiom-f12-no-way-out-contract);
  // `lease` is inferred from the same measured message ("I read the lease
  // again...") and fixture-pinned, not separately measured. The determiner
  // class is broader than the measured "this" — determiners are
  // semantically neutral for the transactional reading. The guard applies
  // ONLY when the noun ends the WHOLE MESSAGE (optional trailing
  // punctuation/whitespace, then true end of input — NOT end of line:
  // round-3 F25 live-proved "no way out of this contract\ni am done with
  // everything" must fire; Enter is a connector in distressed typing, the
  // same class as round-2 F17's comma). Corridor-free by construction:
  // the only silenced shape is a message that literally ends at the
  // transactional noun. Recall-first: bare "no way out", "of this
  // life/pain", "of the contract of my life", and any continuation beyond
  // a trailing punctuation run — a newline or any text — fires.
  /\bno\s+way\s+out\b(?!\s+of\s+(?:this|the|that|my|our|a|an)\s+(?:contract|lease)\b *[.!?,;:…]*\s*$)/,
  /\bbetter\s+off\s+if\s+i\s+(?:was|were)\s+gone\b/
];

// 中文匹配使用第一人称锚点、有界填充词和危机表达，不套用英文词边界。
// 填充词之外的字符会中断匹配，使“我妈说她……”不被当作本人意念。
// “笑死我了”“想死你了”等常见口语通过词尾护栏保持静默；显式的
// “我想死”等表达仍按召回优先触发，不能用夸张口语代替真实风险判断。
var ZH_FP = '(?<!让|叫|逼)(?:我|咱|俺)';
var ZH_FILLERS =
  '想|想要|好想|真想|超想|不想|要|打算|计划|准备|希望|觉得|感觉|感到' +
  '|考虑|想过|试过|过|差点|差一点|险些|自己' +
  '|在|正在|写|写了|写好|买|买了|攒|攒了|存|存了' +
  '|一直|总是|经常|老是|最近|就|都|也|还是|真的|真|特别|非常|好|有点|有些' +
  '|已经|快要|快|忍不住|控制不住|不如|干脆|只想|又想|不想再|再也不想';
var ZH_GAP = '(?:' + ZH_FILLERS + '){0,4}';
// 句首锚:中文常省略主语,「不想活了」本身就是完整的第一人称表达。
// 只允许出现在句首或标点/换行之后,所以它不会把第三人称叙述
// (「他说他想自杀」)读成主语省略。**必须包含中文全角标点** ——
// 中文用户打的是「，」「。」「；」,只认半角会让整条规则失效。
var ZH_CLAUSE = '(?:^|[。．.！!？?；;：:，,、…\\n])\\s*';

var ZH_TIER1_PATTERNS = [
  // 直接意念
  new RegExp(ZH_FP + ZH_GAP + '(?:想|好想|真想|超想)死(?![你])'),
  new RegExp(ZH_FP + ZH_GAP + '去死(?!你)'),
  new RegExp(ZH_FP + ZH_GAP + '要死(?![你了])'),
  new RegExp(ZH_FP + ZH_GAP + '死(?:了)?算了'),
  new RegExp(ZH_FP + ZH_GAP + '一死了之'),
  new RegExp(ZH_FP + ZH_GAP + '(?:自杀|轻生|自残)'),
  new RegExp(ZH_FP + ZH_GAP + '(?:不想|不愿|不想再|再也不想)活'),
  new RegExp(ZH_FP + ZH_GAP + '活(?:不下去|不了)'),
  new RegExp(ZH_FP + ZH_GAP + '结束(?:自己的)?(?:生命|一切)'),
  new RegExp(ZH_FP + ZH_GAP + '了结(?:自己|生命|一生)'),
  new RegExp(ZH_FP + ZH_GAP + '(?:跳楼|割腕|上吊|吞药|烧炭|卧轨|跳河|跳海|安眠药)'),
  new RegExp(ZH_FP + ZH_GAP + '遗书'),
  new RegExp(ZH_FP + ZH_GAP + '解脱'),
  // 无主语形式(句首锚)
  new RegExp(ZH_CLAUSE + '(?:不想|不愿)(?:再)?活'),
  new RegExp(ZH_CLAUSE + '活(?:不下去|不了)(?:了)?'),
  new RegExp(ZH_CLAUSE + '(?:想|要)(?:自杀|轻生|结束这一切|解脱)'),
  new RegExp(ZH_CLAUSE + '不如(?:死|去死)了?算了')
];

// Tier 2: 警告信号(与英文侧同构,保守,锚在句首或第一人称之后)
var ZH_TIER2_PATTERNS = [
  new RegExp(ZH_FP + ZH_GAP + '(?:撑不住|撑不下去|扛不住)了'),
  new RegExp(ZH_CLAUSE + '(?:已经)?(?:快)?(?:撑不住|撑不下去|扛不住)了'),
  new RegExp(ZH_FP + ZH_GAP + '活着(?:真|好|太|很)?(?:没意思|没意义|没劲)'),
  new RegExp(ZH_CLAUSE + '(?:我)?活着(?:真|好|太|很)?(?:没意思|没意义|没劲)'),
  new RegExp(ZH_FP + ZH_GAP + '(?:就是|是|像个?|成为|成了)(?:别人的)?(?:个)?(?:负担|累赘|麻烦)'),
  new RegExp(ZH_CLAUSE + '没有(?:活下去的|活着的)(?:意义|理由)'),
  new RegExp(ZH_CLAUSE + '(?:不如|干脆)(?:死|去死)了?算了'),
  new RegExp(ZH_CLAUSE + '(?:我)?(?:是不是)?(?:死了|消失|不在|走了)(?:会)?更好'),
  new RegExp(ZH_CLAUSE + '要是(?:我)?(?:死了|不在了|不见了|消失)(?:就)?(?:好了|多好)'),
  new RegExp('(?:没有|没)(?:人|有人)(?:会)?(?:在意|在乎|记得|想)我'),
  new RegExp(ZH_FP + ZH_GAP + '(?:死了|走了)(?:也)?(?:没人|没有人)(?:会)?(?:在意|想|难过)'),
  new RegExp(ZH_FP + ZH_GAP + '想消失')
];

// Verbatim from safety-protocol.md > Emergency Resources. Do not edit here
// without editing there (and vice versa).
// 中文版本默认列出中国大陆资源，同时保留国际与美国兼容信息。
var EMERGENCY_RESOURCES = "如果你正处于危机中，请立即联系能够提供现实支持的专业人员：\n\n中国大陆：\n- 12356 — 全国统一心理援助热线\n- 110 / 120 — 有立即人身危险时\n- 精神卫生中心或医院精神科急诊\n\n国际： https://findahelpline.com\n\n美国：988；Crisis Text Line：发送 HOME 至 741741；紧急情况：911。\n\n以上为真人支持资源，接入方式与服务时间以所在地信息为准。";

// 保留英文机器标志供实时探针识别，其余注入内容使用中文。
// 这里不增加咨询策略，只翻译原提醒并指向同一份危机回应方案。
var ADDITIONAL_CONTEXT =
  '自动安全提示（AUTOMATED SAFETY NOTICE）：模式匹配器发现了可能的危机表达。\n\n' +
  EMERGENCY_RESOURCES + '\n\n' +
  '请重读 .therapy/safety-protocol.md，并遵循其中的危机回应顺序。\n\n' +
  '这是机械关键词匹配，不能理解语境。请判断实际对话：来访者而非模式匹配器，' +
  '才是其经历的权威。若明显属于口头禅、引用或谈论过去，正常继续，同时保持留意。';

// Shared timeout for the stdin self-timeout and the stdout flush guard.
// SAFETY_NET_STDIN_TIMEOUT_MS overrides the 5000ms default (used by tests
// to keep the suite fast).
var TIMEOUT_MS = 5000;
var envTimeout = Number(process.env.SAFETY_NET_STDIN_TIMEOUT_MS);
if (envTimeout > 0) {
  TIMEOUT_MS = envTimeout;
}

// Bound the stdin buffer: past this many characters the hook stops
// accumulating, so a pathological payload can never OOM into a nonzero
// exit. The retained prefix is still scanned (raw, since truncated JSON
// can't parse): raw mode normalizes and matches the WHOLE retained JSON
// text — keys, braces, and escape sequences included, not just the prompt
// value. Newlines inside the prompt arrive as the two-character JSON
// escape (backslash + "n") in this mode, so newline-dependent patterns
// (clause anchors, the self-harm separator) do not see real newlines;
// plain keyword patterns still fire. Crisis language in the first 4MB of
// an oversized payload fires; anything past the bound is treated as
// no-match. Real prompts are orders of magnitude smaller.
var MAX_STDIN_CHARS = 4 * 1024 * 1024;

function normalize(text) {
  // Newlines are preserved as clause boundaries (distressed typing is
  // often unpunctuated and multi-line); only intra-line whitespace is
  // collapsed. Patterns still match across lines via \s+.
  return text
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‛ʼ`´]/g, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .toLowerCase();
}

function matchesAny(patterns, text) {
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i].test(text)) return true;
  }
  return false;
}

function emitNotice() {
  var out =
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: ADDITIONAL_CONTEXT
      }
    }) + '\n';
  // A never-draining stdout must not leave the process hangable: keep a
  // live (ref'd) timer armed until the write callback fires, then let
  // the loop drain to a natural exit 0. If the pipe never drains, the
  // timer exits 0 after TIMEOUT_MS. The stdout 'error' handler below
  // covers EPIPE, and the write callback still fires on error, clearing
  // the timer.
  var flushTimer = setTimeout(function () {
    process.exit(0);
  }, TIMEOUT_MS);
  try {
    process.stdout.write(out, function () {
      clearTimeout(flushTimer);
    });
  } catch (err) {
    clearTimeout(flushTimer);
  }
}

function scanAndEmit(text) {
  if (
    matchesAny(TIER1_PATTERNS, text) ||
    matchesAny(TIER2_PATTERNS, text) ||
    matchesAny(ZH_TIER1_PATTERNS, text) ||
    matchesAny(ZH_TIER2_PATTERNS, text)
  ) {
    emitNotice();
  }
}

function main(input) {
  var payload = JSON.parse(input);
  var prompt = payload && payload.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return;
  }
  scanAndEmit(normalize(prompt));
}

// Runtime wiring. Wrapped so that ANY synchronous throw during stdio setup
// fails open (exit 0, silent) instead of crashing with a nonzero exit.
try {
  // Never crash on stdout errors (e.g. EPIPE when the reader closed the
  // pipe). Fail-open means exit 0 silently, never a nonzero write crash.
  process.stdout.on('error', function () {});

  // Self-timeout: if stdin never ends (harness bug, unusual spawn), exit 0
  // silently rather than hanging until the harness kills us. The timer is
  // unref'd so it never delays a normal run.
  var stdinTimer = setTimeout(function () {
    process.exit(0);
  }, TIMEOUT_MS);
  if (stdinTimer.unref) stdinTimer.unref();

  var chunks = [];
  var received = 0;
  var overflowed = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk) {
    if (overflowed) return;
    received += chunk.length;
    if (received > MAX_STDIN_CHARS) {
      // Keep the prefix up to the bound and stop accumulating: the
      // retained text is still scanned on end (recall-first), while memory
      // stays bounded no matter how large the payload grows.
      overflowed = true;
      chunks.push(chunk.slice(0, chunk.length - (received - MAX_STDIN_CHARS)));
      return;
    }
    chunks.push(chunk);
  });
  process.stdin.on('end', function () {
    clearTimeout(stdinTimer);
    try {
      if (overflowed) {
        // Oversized payload: the truncated input can't JSON.parse, so scan
        // the retained raw prefix directly (whole-payload semantics — see
        // the MAX_STDIN_CHARS note). Crisis language early in a
        // pathological payload still fires; past the bound is no-match.
        scanAndEmit(normalize(chunks.join('')));
      } else {
        main(chunks.join(''));
      }
    } catch (err) {
      // Fail-open: swallow and fall through to a natural exit 0.
    }
    // No process.exit() here: a pending stdout write (the crisis notice)
    // must be allowed to flush. With stdin ended and the timers handled,
    // the event loop drains and the process exits 0 on its own.
  });
  process.stdin.on('error', function () {
    process.exit(0);
  });
} catch (err) {
  process.exit(0);
}
