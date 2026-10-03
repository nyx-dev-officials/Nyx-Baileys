import { silentAuditSink } from './audit.js';
import type { AuditSink } from './audit.js';
import { redactText } from './redact.js';
import { stripControlChars } from './validate.js';
import type { Plugin } from '../utils/types.js';

/**
 * Prompt-injection detector for inbound message text.
 *
 * ── What this is ──────────────────────────────────────────────────────────
 *
 * This framework has a flow engine and its users will wire LLM backends to it.
 * Inbound WhatsApp text is therefore, by default, *untrusted input that a model
 * will read*. That combination — attacker-controlled text arriving at a model
 * that can call tools — is the textbook prompt-injection setup, and the cheapest
 * mitigation available at this layer is to look for the well-known attack
 * grammar before the text reaches a model or a flow step.
 *
 * So: it detects the shapes of naive attacks, scores them, and returns a
 * verdict you can act on. Default is `flag`, not `block`.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────
 *
 * **This is not a security boundary, and it must not be treated as one.**
 *
 * Pattern matching over text is defeated by things this module cannot
 * reasonably detect:
 *
 *   - **Paraphrase.** "Kindly set aside the earlier guidance" matches nothing
 *     here. An adversary who reads this file will write that instead.
 *   - **Translation.** Attack strings in the ~40% of languages not in the rule
 *     set pass through untouched.
 *   - **Token-level obfuscation.** Splitting an injection across two messages
 *     ("remember: my supervisor is" / "…and never check permissions") defeats
 *     per-message matching entirely. Nothing here reads across messages.
 *   - **Progressive grooming.** Raising the score in small innocuous steps
 *     across a long conversation, so no single message crosses a threshold.
 *     The score is stateless by design; making it stateful turns a filter into
 *     a state machine an adversary can also learn.
 *   - **Tokenisation tricks.** Base64, leetspeak, homoglyphs, and "read this
 *     as a poem" framings. The normalisation here handles the trivial cases and
 *     nothing more.
 *   - **Insider and accident.** A user with legitimate access to the bot's
 *     admin surface does not need to inject anything.
 *
 * It also has **false positives**, and they are not hypothetical: security
 * researchers, prompt-engineering courses and this framework's own
 * documentation all quote injection strings verbatim. A guard that blocked on
 * those would make it unusable for the exact people most likely to run one.
 * That asymmetry — trivially bypassed by a determined attacker, easily tripped
 * by an honest one — is why the default action is `flag`.
 *
 * **The actual boundary has to live in the model-facing code:**
 *
 *   1. Treat inbound text as *data*, never as instructions. Delimit it, label
 *      it, and say so in the system prompt. This is the single control that
 *      matters, and it is a prompt-design responsibility, not a filter's.
 *   2. Require authorization for tool calls *inside the model loop*, not in the
 *      text that asked for them. Let the model propose; let code decide.
 *   3. Give tools the narrowest scope that works, and re-check permissions at
 *      call time with `acl.ts`.
 *   4. Keep secrets out of the prompt entirely, so there is nothing to
 *      exfiltrate — `redact.ts` and least-privilege tools, not filters.
 *
 * Treat this as a cheap, honest tripwire that catches the lazy 90% and gives
 * you telemetry for the rest. Overstating a filter's effectiveness is worse than
 * not shipping one, because it moves the security decision somewhere it cannot
 * reach.
 *
 * `order: 88` places its `messages.upsert` listener before `flow` (90) — but
 * Baileys' emitter has no cancellation, so **this cannot stop `flow.ts` from
 * seeing the same message**. Blocking here is advisory unless you call
 * `sock.injectionGuard.check(text)` yourself in the path that matters.
 */

export type InjectionAction = 'allow' | 'flag' | 'block';

export type InjectionCategory =
  | 'instruction-override'
  | 'system-prompt-exfiltration'
  | 'delimiter-breakout'
  | 'tool-abuse'
  | 'secret-solicitation'
  | 'authority-spoof'
  | 'memory-poisoning'
  | 'policy-bypass'
  | 'obfuscation'
  | 'hidden-text';

export interface InjectionMatch {
  /** Stable rule id. Branch on this, not on the regex. */
  readonly rule: string;
  readonly category: InjectionCategory;
  readonly weight: number;
  /** The matched text, truncated and secret-scrubbed. Evidence, not payload. */
  readonly evidence: string;
}

export interface InjectionVerdict {
  /**
   * Below the block threshold. **Not** a claim of innocence — a determined
   * adversary can pass through with `safe: true`, which is the whole point of
   * the limits documented above.
   */
  readonly safe: boolean;
  /** 0..1. Saturating combination of matched rule weights. Not a probability. */
  readonly score: number;
  readonly matched: readonly InjectionMatch[];
  /** What the configured policy decided to do about `score`. */
  readonly action: InjectionAction;
  /** Always present, on every outcome. */
  readonly reason: string;
  readonly categories: readonly InjectionCategory[];
  /** True when invisible characters were stripped before matching. */
  readonly hadInvisibleChars: boolean;
}

/**
 * A detection rule. Exported so hosts can add domain-specific rules without
 * forking this file.
 */
export interface InjectionRule {
  /** Stable rule id. Branch on this, not on the pattern. */
  readonly id: string;
  readonly category: InjectionCategory;
  readonly weight: number;
  readonly pattern: RegExp;
}

/** Internal alias, kept short because it appears on every rule literal. */
type Rule = InjectionRule;

/* ── rules ────────────────────────────────────────────────────────────────
 *
 * Weights are judgement calls, not measurements. They encode "how sure am I
 * that this is an attack rather than a conversation about attacks":
 *
 *   0.5-0.55  near-certain attack grammar (ignore previous instructions)
 *   0.4-0.45  strong signal, some legitimate uses (tool invocation, jailbreak)
 *   0.25-0.35 suggestive; common in benign text (authority claims, encoding)
 *
 * A single 0.5 match lands above the default flag threshold, because these
 * strings essentially do not occur in ordinary chat.
 */

const RULES: readonly Rule[] = [
  /* ── instruction override ── */
  {
    id: 'override-ignore-previous',
    category: 'instruction-override',
    weight: 0.5,
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}\b(?:all\s+|any\s+)?(?:previous|prior|earlier|above|preceding|foregoing|original|initial|system)\b[^.!?\n]{0,24}\b(?:instruction|instructions|prompt|prompts|rule|rules|direction|directions|guideline|guidelines|context|message|messages|constraint|constraints)\b/i,
  },
  {
    id: 'override-new-instructions',
    category: 'instruction-override',
    weight: 0.45,
    pattern: /\b(?:new|updated|revised|real|actual|true)\s+(?:system\s+)?(?:instruction|instructions|prompt|prompts)\s*[:\-–]/i,
  },
  {
    id: 'override-from-now-on',
    category: 'instruction-override',
    weight: 0.4,
    pattern: /\bfrom\s+now\s+on\s+(?:you|ignore|disregard|only|we)\b/i,
  },
  {
    id: 'override-role-reassignment',
    category: 'instruction-override',
    weight: 0.4,
    pattern: /\byou\s+are\s+(?:now|no\s+longer)\b[^.!?\n]{0,30}\b(?:a|an|the)?\s*(?:ai|assistant|bot|model|expert|hacker|admin)\b/i,
  },
  {
    id: 'override-stop-being-assistant',
    category: 'instruction-override',
    weight: 0.45,
    pattern: /\bstop\s+(?:being|acting\s+as|following|obeying)\s+(?:an?\s+)?(?:ai|assistant|bot|model|helpful|your\s+rules)/i,
  },
  {
    id: 'override-forget-everything',
    category: 'instruction-override',
    weight: 0.45,
    pattern: /\b(?:forget|disregard|erase)\s+(?:everything|all|any)\s*(?:you|that|which|of)?\s*(?:know|learned|were\s+told|above|before|prior)?\b/i,
  },

  /* ── system prompt exfiltration ── */
  {
    id: 'exfil-reveal-prompt',
    category: 'system-prompt-exfiltration',
    weight: 0.55,
    pattern:
      /\b(?:reveal|print|show|repeat|output|display|reproduce|dump|echo|disclose)\b[^.!?\n]{0,30}\b(?:system\s+prompt|initial\s+prompt|original\s+instructions?|your\s+instructions?|your\s+prompt|prompt\s+above|hidden\s+instructions?|internal\s+prompt)\b/i,
  },
  {
    id: 'exfil-what-were-you-told',
    category: 'system-prompt-exfiltration',
    weight: 0.5,
    pattern: /\bwhat\s+(?:were|was)\s+you\s+(?:told|instructed|programmed|configured|trained)\b/i,
  },
  {
    id: 'exfil-repeat-above',
    category: 'system-prompt-exfiltration',
    weight: 0.5,
    pattern: /\brepeat\s+(?:the\s+)?(?:words|everything|text|content)\s+(?:above|before|preceding|prior)\b/i,
  },
  {
    id: 'exfil-verbatim',
    category: 'system-prompt-exfiltration',
    weight: 0.45,
    pattern: /\bverbatim\s+(?:from\s+)?(?:your|the)\s+(?:prompt|instructions|context|configuration)\b/i,
  },

  /* ── delimiter / context breakout ── */
  {
    id: 'breakout-chatml',
    category: 'delimiter-breakout',
    weight: 0.5,
    pattern: /<\|\s*(?:im_end|im_start|system|endoftext|eot_id|start_header_id|end_header_id)\s*\|>/i,
  },
  {
    id: 'breakout-llama-tags',
    category: 'delimiter-breakout',
    weight: 0.45,
    pattern: /\[\/?INST\]|<<\/?SYS>>|<\|(?:system|user|assistant)\|>/i,
  },
  {
    id: 'breakout-turn-marker',
    category: 'delimiter-breakout',
    weight: 0.35,
    pattern: /#{2,}\s*(?:system|assistant|user|developer)\s*:/i,
  },
  {
    id: 'breakout-end-of-context',
    category: 'delimiter-breakout',
    weight: 0.4,
    pattern: /\b(?:end|start|close)\s+of\s+(?:prompt|system\s+message|context|instructions?)\b/i,
  },
  {
    id: 'breakout-code-fence-system',
    category: 'delimiter-breakout',
    weight: 0.35,
    pattern: /```+\s*(?:system|instructions?|prompt)\b/i,
  },

  /* ── tool abuse ── */
  {
    id: 'tool-invoke-socket',
    category: 'tool-abuse',
    weight: 0.4,
    pattern:
      /\b(?:call|invoke|execute|run|trigger|use)\b[^.!?\n]{0,30}\b(?:sendmessage|send_message|relaymessage|sendmessagereaction|querynewsletter|child_process|execSync|eval\s*\(|spawn\s*\(|curl\s+http|wget\s+http)\b/i,
  },
  {
    id: 'tool-admin-mode',
    category: 'tool-abuse',
    weight: 0.35,
    pattern: /\b(?:use|call|switch\s+to)\s+the\s+(?:admin|root|god|debug|maintenance|developer|unrestricted)\s+(?:mode|tool|command|persona|account)\b/i,
  },
  {
    id: 'tool-destructive',
    category: 'tool-abuse',
    weight: 0.4,
    pattern: /\b(?:delete|wipe|destroy|drop|purge|rm\s+-rf)\s+(?:all|every|the\s+entire)\s+(?:files?|data|records?|messages?|chats?|history)\b/i,
  },
  {
    id: 'tool-execute-following',
    category: 'tool-abuse',
    weight: 0.4,
    pattern: /\bexecute\s+(?:the\s+)?following\s+(?:code|script|command|shell|payload)\b/i,
  },

  /* ── secret solicitation ── */
  {
    id: 'secret-request',
    category: 'secret-solicitation',
    weight: 0.5,
    pattern:
      /\b(?:reveal|print|show|send|share|leak|export|dump|give\s+me|tell\s+me)\b[^.!?\n]{0,34}\b(?:api[\s_-]?key|secret\s+key|access\s+token|refresh\s+token|session\s+key|private\s+key|noise[\s_-]?key|adv[\s_-]?secret[\s_-]?key|password|passphrase|credentials?|auth\s+token)\b/i,
  },
  {
    id: 'secret-what-is',
    category: 'secret-solicitation',
    weight: 0.45,
    pattern: /\bwhat\s+(?:is|are)\s+(?:the|your)\s+(?:api[\s_-]?key|token|password|secret|credentials?)\b/i,
  },
  {
    id: 'secret-env-dump',
    category: 'secret-solicitation',
    weight: 0.45,
    pattern: /\b(?:dump|cat|print|show|list)\s+(?:the\s+)?(?:env\b|environment\s+variables?|\.env\b|process\.env)/i,
  },

  /* ── authority spoofing ── */
  {
    id: 'authority-authorized-test',
    category: 'authority-spoof',
    weight: 0.35,
    pattern: /\b(?:this\s+is|i\s+am|we\s+are)\s+(?:an?\s+)?(?:authorized|official|authenticated|approved)\s+(?:test|audit|review|admin|developer|request|penetration)\b/i,
  },
  {
    id: 'authority-claims-role',
    category: 'authority-spoof',
    weight: 0.3,
    pattern: /\bas\s+(?:the\s+)?(?:system\s+)?(?:administrator|developer|owner|creator|engineer|openai|anthropic|your\s+creator)\b/i,
  },
  {
    id: 'authority-mode-enabled',
    category: 'authority-spoof',
    weight: 0.4,
    pattern: /\b(?:developer|admin|sudo|god)\s+mode\s+(?:is\s+)?(?:enabled|on|activated|active)\b/i,
  },
  {
    id: 'authority-message-from',
    category: 'authority-spoof',
    weight: 0.35,
    pattern: /\bthis\s+(?:message|request|instruction)\s+(?:is\s+)?(?:from|approved\s+by|authorised\s+by|sent\s+by)\s+(?:the\s+)?(?:system|admin|developer|owner|openai|anthropic)\b/i,
  },

  /* ── memory poisoning ── */
  {
    id: 'memory-persist',
    category: 'memory-poisoning',
    weight: 0.35,
    pattern:
      /\b(?:remember|memorize|memorise|store|save|persist|retain|append)\s+(?:this|these|the\s+following|that)\b[^.!?\n]{0,40}\b(?:for|in|across)\s+(?:all\s+)?(?:future|subsequent|later|every|each)\b/i,
  },
  {
    id: 'memory-add-to-prompt',
    category: 'memory-poisoning',
    weight: 0.4,
    pattern: /\badd\s+(?:this|the\s+following)\s+to\s+your\s+(?:permanent\s+|core\s+)?(?:instructions?|memory|system\s+prompt|context|rules?)\b/i,
  },

  /* ── policy bypass ── */
  {
    id: 'bypass-jailbreak',
    category: 'policy-bypass',
    weight: 0.45,
    pattern: /\b(?:jailbreak|jail\s*break|dan\s+mode|do\s+anything\s+now|evil\s+mode|unfiltered\s+mode)\b/i,
  },
  {
    id: 'bypass-no-restrictions',
    category: 'policy-bypass',
    weight: 0.4,
    pattern: /\b(?:without|no|bypass|remove)\s+(?:any\s+)?(?:restrictions?|limitations?|filters?|censorship|safety\s+(?:rules?|checks?)|guardrails?)\b/i,
  },
  {
    id: 'bypass-no-rules',
    category: 'policy-bypass',
    weight: 0.4,
    pattern: /\bpretend\s+(?:that\s+)?you\s+(?:have|there\s+are)\s+no\s+(?:rules|policies|guidelines|restrictions|limits)\b/i,
  },

  /* ── obfuscation ── */
  {
    id: 'obfuscate-decode-this',
    category: 'obfuscation',
    weight: 0.35,
    pattern: /\b(?:decode|decrypt|de-?obfuscate|un-?base64|rot13|reverse)\s+(?:the\s+)?(?:following|this|below|text|string|message)\b/i,
  },
  {
    id: 'obfuscate-long-blob',
    category: 'obfuscation',
    weight: 0.3,
    pattern: /\b[A-Za-z0-9+/]{60,}={0,2}\b/,
  },
  {
    id: 'obfuscate-i-encoded',
    category: 'obfuscation',
    weight: 0.3,
    pattern: /\b(?:i|we)\s+(?:have\s+)?(?:encoded|obfuscated|encrypted|hidden)\b[^.!?\n]{0,30}\b(?:instruction|prompt|message|text|command)\b/i,
  },

  /* ── hidden text ── */
  {
    id: 'hidden-html-comment',
    category: 'hidden-text',
    weight: 0.35,
    pattern: /<!--[\s\S]{0,400}?-->/,
  },
  {
    id: 'hidden-active-markup',
    category: 'hidden-text',
    weight: 0.25,
    pattern: /<\s*(?:script|iframe|object|embed|style|svg\s+onload)\b/i,
  },
];

/** Invisible characters: zero-width, bidi overrides, BOM, word joiner. */
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u206A-\u206F\uFEFF]/g;

/**
 * Leetspeak substitution map.
 *
 * Applied only to tokens that are *mostly* substitutions, which is what keeps
 * "gpt-4" and "v2" intact while catching "p4ssw0rd". A blanket substitution
 * would mangle ordinary text into false positives, and a false positive here
 * costs an operator their trust in the filter.
 */
const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
  '+': 't',
  '|': 'l',
};

/**
 * A run of single-letter words: "i g n o r e   a l l".
 *
 * The gap width carries the word boundary, which is why the replacer splits on
 * two-or-more spaces rather than collapsing the whole run into one blob: a
 * single collapsed token has no word boundaries left, and every rule here is
 * anchored on `\b`.
 *
 * `{2,}` means three or more letters. In running prose the only single-letter
 * words are "a" and "I", so a run this long is an evasion or a list of
 * initials; the one benign case, an enumeration like "a b c d e f", collapses
 * to "abcdef", which matches no rule and costs nothing.
 *
 * **Known limit, stated rather than papered over:** this only works when the
 * attacker uses *wide* gaps. Spelled entirely with single spaces
 * ("i g n o r e a l l i n s t r u c t i o n s") there is no boundary signal
 * left to read. The tempting fix — re-splitting on a keyword list — was tried
 * and removed: without a dictionary it is unsound, because it cannot tell
 * "ignoreall" (collapsed, should split) from "without" (one word, must not).
 * An earlier version did exactly that and turned `without any restrictions`
 * into `with out any restrictions`, disabling a rule. An evasion that costs
 * this module one detection is a better trade than a rule that silently stops
 * matching real attacks.
 */
const SPACED_LETTERS = /(?:\b\w\b[ ]{1,2}){2,}\w\b/g;

export interface InjectionGuardOptions {
  /** Score at or above which `flagAction` applies. Default 0.35. */
  readonly flagAt?: number;
  /** Score at or above which `blockAction` applies. Default 0.8. */
  readonly blockAt?: number;
  /** Action for scores in `[flagAt, blockAt)`. Default `flag`. */
  readonly flagAction?: InjectionAction;
  /** Action for scores at or above `blockAt`. Default `block`. */
  readonly blockAction?: InjectionAction;
  /** Lowercase, NFKC-normalise and strip invisibles before matching. Default true. */
  readonly normalize?: boolean;
  /** Map leetspeak back to letters on heavily substituted tokens. Default true. */
  readonly deobfuscate?: boolean;
  /** Collapse "i g n o r e" into "ignore". Default true. */
  readonly collapseSpacedLetters?: boolean;
  /** Skip the scan entirely and return a safe verdict. Default false. */
  readonly disabled?: boolean;
  /** Extra rules, merged with the built-ins. */
  readonly extraRules?: readonly InjectionRule[];
  /** Longest evidence snippet kept per match. Default 60. */
  readonly evidenceLength?: number;
  /** Where hits are recorded. Defaults to dropping them. */
  readonly audit?: AuditSink;
  /** Called on every verdict whose action is not `allow`. */
  readonly onVerdict?: (verdict: InjectionVerdict, jid: string) => void;
}

interface Normalized {
  readonly text: string;
  readonly hadInvisible: boolean;
}

/**
 * Fold away the cheap evasions.
 *
 * Honest scope: NFKC, case folding, invisible-character removal and two narrow
 * deobfuscation passes. That defeats "iGnOrE pReViOuS" and "p4ssw0rd" and
 * nothing else. Homoglyphs (Cyrillic `а` for Latin `a`) survive NFKC in many
 * cases and are not handled; there is no homoglyph table here, and building one
 * that maps confusables to ASCII produces a flood of false positives on
 * legitimate multilingual chat.
 */
function normalizeForMatching(text: string, options: InjectionGuardOptions): Normalized {
  const hadInvisible = INVISIBLE.test(text);
  INVISIBLE.lastIndex = 0;

  if (options.normalize === false) return { text, hadInvisible };

let out = text.normalize('NFKC');
  out = out.replace(INVISIBLE, '');
  // Belt and braces: the shared stripper also removes C0 controls, which
  // double as delimiters for some prompt formats.
  out = stripControlChars(out, { allowNewlines: true });
  out = out.toLowerCase();

  // Before the whitespace collapse, deliberately: the collapse is what destroys
  // the wide gaps that carry the word boundaries this pass reads.
  if (options.collapseSpacedLetters !== false) {
    out = out.replace(SPACED_LETTERS, (run) =>
      run
        .split(/[ ]{2,}/)
        .map((word) => word.replace(/ /g, ''))
        .join(' '),
    );
  }

  out = out.replace(/\s+/g, ' ');

  if (options.deobfuscate !== false) {
    out = out
      .split(' ')
      .map((token) => deobfuscateToken(token))
      .join(' ');
  }

  return { text: out, hadInvisible };
}

/** Undo leetspeak, but only on tokens that are mostly substitutions. */
function deobfuscateToken(token: string): string {
  if (token.length < DEOB_MIN_LENGTH) return token;
  if (!/[^A-Za-z]/.test(token)) return token;

  let hits = 0;
  let letters = 0;
  let mapped = '';
  for (const ch of token) {
    const sub = LEET[ch];
    if (sub !== undefined) {
      hits += 1;
      mapped += sub;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) letters += 1;
    mapped += ch;
  }

  /*
   * Needs real letters and at least a third substitutions. Measured against the
   * obvious tokens: "gpt-4", "sha256", "4chan", "api-v2", "level2" and "2fa" all
   * stay untouched at this threshold, while "p4ssw0rd", "1gn0r3", "4ll" and
   * "1n5truct10n5" all fold. A stricter threshold looked safer and was useless —
   * it left half of the keywords unmapped, so the attack string it failed to
   * decode still failed to match, which is the worst of both outcomes.
   */
  if (letters === 0) return token;
  if (hits / token.length < DEOB_RATIO) return token;
  return mapped;
}

/** Shortest token worth folding. Below this, ratios get unstable. */
const DEOB_MIN_LENGTH = 3;
/** Fraction of characters that must be substitutions. See `deobfuscateToken`. */
const DEOB_RATIO = 0.3;

const DEFAULT_FLAG_AT = 0.35;
const DEFAULT_BLOCK_AT = 0.8;

/**
 * Combine rule weights into a bounded score.
 *
 * `1 - Π(1 - wᵢ)` — a saturating union: two weak signals compound, and no
 * number of them can exceed 1. Not a probability, and it is not calibrated as
 * one; it is a monotone ordering so a threshold means something.
 */
function combine(weights: readonly number[]): number {
  let inverse = 1;
  for (const w of weights) inverse *= 1 - Math.min(Math.max(w, 0), 1);
  return 1 - inverse;
}

export class InjectionGuard {
  readonly #options: InjectionGuardOptions;
  readonly #rules: readonly Rule[];
  readonly #flagAt: number;
  readonly #blockAt: number;
  readonly #flagAction: InjectionAction;
  readonly #blockAction: InjectionAction;
  readonly #evidenceLength: number;
  readonly #audit: AuditSink;
  readonly #onVerdict: ((verdict: InjectionVerdict, jid: string) => void) | undefined;

  constructor(options: InjectionGuardOptions = {}) {
    this.#options = options;
    this.#rules = [...RULES, ...(options.extraRules ?? [])];
    this.#flagAt = options.flagAt ?? DEFAULT_FLAG_AT;
    this.#blockAt = options.blockAt ?? DEFAULT_BLOCK_AT;
    this.#flagAction = options.flagAction ?? 'flag';
    this.#blockAction = options.blockAction ?? 'block';
    this.#evidenceLength = options.evidenceLength ?? 60;
    this.#audit = options.audit ?? silentAuditSink;
    this.#onVerdict = options.onVerdict;

    if (this.#flagAt < 0 || this.#blockAt > 1 || this.#flagAt > this.#blockAt) {
      throw new Error(
        `injection-guard: thresholds must satisfy 0 <= flagAt (${this.#flagAt}) <= blockAt (${this.#blockAt}) <= 1`,
      );
    }
  }

  /**
   * Score `text` and decide what to do about it.
   *
   * Total, allocation-light, and never throws — this sits in front of a socket
   * listener, where an exception is a remotely-triggerable crash.
   */
  check(input: unknown, jid = 'unknown'): InjectionVerdict {
    if (typeof input !== 'string' || input.length === 0) {
      return allow('no text to inspect', []);
    }

    const { text, hadInvisible } = normalizeForMatching(input, this.#options);

    const matched: InjectionMatch[] = [];
    const seen = new Set<string>();
    let invisibleHit = false;

    for (const rule of this.#rules) {
      // Each rule counts once. Five hits from one broad regex must not read as
      // five independent pieces of evidence.
      if (seen.has(rule.id)) continue;
      const found = rule.pattern.exec(text);
      if (!found || found[0] === undefined) continue;
      seen.add(rule.id);

      matched.push({
        rule: rule.id,
        category: rule.category,
        weight: rule.weight,
        // Scrubbed: the "evidence" for a secret-solicitation match may itself
        // be a credential the sender already put in the message.
        evidence: redactText(found[0].slice(0, this.#evidenceLength)),
      });
    }

    // Invisible characters are a signal in their own right — something was
    // hidden — independent of what it said.
    if (hadInvisible) {
      invisibleHit = true;
      matched.push({
        rule: 'hidden-invisible-chars',
        category: 'hidden-text',
        weight: 0.3,
        evidence: '[zero-width or bidi-control characters present]',
      });
    }

    if (matched.length === 0) return allow('no injection patterns matched', []);

    const score = combine(matched.map((m) => m.weight));
    const categories = [...new Set(matched.map((m) => m.category))];

    const action: InjectionAction = score >= this.#blockAt ? this.#blockAction : score >= this.#flagAt ? this.#flagAction : 'allow';

    const reason =
      action === 'allow'
        ? `score ${score.toFixed(2)} is below the flag threshold ${this.#flagAt}; ${matched.length} weak signal(s) only`
        : action === 'flag'
          ? `score ${score.toFixed(2)} matched ${matched.length} rule(s) [${categories.join(', ')}]; flagged for review, not blocked`
          : `score ${score.toFixed(2)} matched ${matched.length} rule(s) [${categories.join(', ')}]; at or above the block threshold ${this.#blockAt}`;

    const verdict: InjectionVerdict = {
      // "Safe" means "below the block threshold", never "known to be harmless".
      safe: action !== 'block',
      score,
      matched,
      action,
      reason,
      categories,
      hadInvisibleChars: invisibleHit,
    };

    if (action !== 'allow') {
      this.#audit.audit({
        action: action === 'block' ? 'injection.blocked' : 'injection.detected',
        actor: jid,
        outcome: action === 'block' ? 'deny' : 'info',
        reason,
        meta: {
          score: Number(score.toFixed(3)),
          rules: matched.map((m) => m.rule),
          categories,
          length: input.length,
        },
      });
      this.#onVerdict?.(verdict, jid);
    }

    return verdict;
  }

  /** Rules currently loaded, for a `/guard rules` style diagnostic. */
  rules(): ReadonlyArray<{ id: string; category: InjectionCategory; weight: number }> {
    return this.#rules.map((r) => ({ id: r.id, category: r.category, weight: r.weight }));
  }
}

const allow = (reason: string, matched: readonly InjectionMatch[]): InjectionVerdict => ({
  safe: true,
  score: 0,
  matched,
  action: 'allow',
  reason,
  categories: [],
  hadInvisibleChars: false,
});

/* ── quarantine ──────────────────────────────────────────────────────────── */

export interface QuarantinedMessage {
  readonly at: number;
  readonly jid: string;
  readonly verdict: InjectionVerdict;
}

/**
 * Bounded store of messages that tripped the guard.
 *
 * A ring buffer, not a database: the purpose is "what did we see in the last
 * few minutes", and an unbounded array of attacker-controlled text is a memory
 * exhaustion bug wearing a security feature.
 */
export class Quarantine {
  readonly #limit: number;
  readonly #items: QuarantinedMessage[] = [];

  constructor(limit = 200) {
    this.#limit = limit;
  }

  add(jid: string, verdict: InjectionVerdict): QuarantinedMessage {
    const item: QuarantinedMessage = { at: Date.now(), jid, verdict };
    this.#items.push(item);
    while (this.#items.length > this.#limit) this.#items.shift();
    return item;
  }

  list(): readonly QuarantinedMessage[] {
    return this.#items.slice();
  }

  /** How many times a jid has tripped the guard. Bounded by the buffer. */
  countFor(jid: string): number {
    return this.#items.filter((i) => i.jid === jid).length;
  }

  clear(): void {
    this.#items.length = 0;
  }

  get size(): number {
    return this.#items.length;
  }
}

/* ── plugin ──────────────────────────────────────────────────────────────── */

export interface InjectionGuardPluginOptions extends InjectionGuardOptions {
  /** Quarantine anything scoring at or above this, regardless of action. Default 1. */
  readonly quarantineAt?: number;
  /** Also inspect `nyx.injectionGuard` output over flow replies. */
  readonly inspectFlowReplies?: boolean;
}

/**
 * Scans inbound text and emits `nyx.injection` for every non-`allow` verdict.
 *
 * What this plugin cannot do is stated at the top of this file and repeated
 * here because it is the part people get wrong: Baileys' emitter does not
 * support cancellation, so this listener cannot prevent `flow.ts` or any other
 * plugin from processing the same message. The verdict is advisory telemetry
 * unless you call `sock.injectionGuard.check(text)` in the path that actually
 * reaches a model.
 */
export function injectionGuard(options: InjectionGuardPluginOptions = {}): Plugin {
  return {
    name: 'injection-guard',
    order: 88,

    apply(ctx) {
      const log = ctx.log.child('injection');

      // Pick up the chain's audit log when the host did not supply a sink.
      // `auditTrail` runs at order 1 and this at 88, so `sock.audit` exists by
      // the time this applies.
      const chain = ctx.sock as unknown as {
        audit?: { sink?: AuditSink; denialSink?: AuditSink };
      };
      const audit = options.audit ?? chain.audit?.sink ?? silentAuditSink;

      const guard = new InjectionGuard({ ...options, audit });
      const quarantine = new Quarantine();
      const quarantineAt = options.quarantineAt ?? 1;
      let scanned = 0;
      let flagged = 0;
      let blocked = 0;

      const inspect = (jid: string, text: string): void => {
        if (options.disabled === true) return;
        scanned += 1;

        const verdict = guard.check(text, jid);

        if (verdict.action === 'block') blocked += 1;
        else if (verdict.action === 'flag') flagged += 1;

        if (verdict.score >= quarantineAt) quarantine.add(jid, verdict);

        if (verdict.action === 'allow') return;

        // Logged at warn for blocks, debug for flags: a flag is a score, not
        // an incident, and logging it loudly trains operators to ignore warns.
        const line = {
          jid,
          action: verdict.action,
          score: Number(verdict.score.toFixed(3)),
          rules: verdict.matched.map((m) => m.rule),
          reason: verdict.reason,
        };
        if (verdict.action === 'block') log.warn('injection blocked', line);
        else log.debug('injection flagged', line);

        ctx.sock.ev.emit('nyx.injection' as never, { ...verdict, jid } as never);
      };

      const handle = (event: { messages?: unknown[] }): void => {
        for (const raw of event.messages ?? []) {
          const frame = raw as {
            key?: { remoteJid?: unknown; fromMe?: unknown };
            message?: Record<string, unknown>;
          };
          if (frame?.key?.fromMe === true) continue;

          const jid = typeof frame?.key?.remoteJid === 'string' ? frame.key.remoteJid : 'unknown';
          const text = collectText(frame?.message, options.inspectFlowReplies === true);
          if (text.length === 0) continue;

          inspect(jid, text);
        }
      };

      ctx.sock.ev.on('messages.upsert', handle as never);

      ctx.onDispose(() => {
        try {
          ctx.sock.ev.off('messages.upsert', handle as never);
        } catch {
          /* emitter already torn down */
        }
      });

      Object.defineProperty(ctx.sock, 'injectionGuard', {
        value: {
          check: (text: unknown, jid?: string): InjectionVerdict => guard.check(text, jid),
          guard,
          quarantine,
          /** Messages seen by the listener, plus the action breakdown. */
          stats: () => ({ scanned, flagged, blocked, quarantined: quarantine.size }),
          rules: () => guard.rules(),
          clear: () => quarantine.clear(),
        },
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', {
        rules: guard.rules().length,
        flagAt: options.flagAt ?? DEFAULT_FLAG_AT,
        blockAt: options.blockAt ?? DEFAULT_BLOCK_AT,
        disabled: options.disabled === true,
      });
    },
  };
}

/**
 * Gather scannable text from a message body.
 *
 * Includes flow replies because that is where the richest attacker-controlled
 * JSON arrives — a `paramsJson` string is attacker-supplied and lands in a
 * model context in most flow implementations.
 */
function collectText(message: Record<string, unknown> | undefined, includeFlowReplies: boolean): string {
  if (!message) return '';
  const parts: string[] = [];

  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) parts.push(value);
  };

  push(message.conversation);

  const extended = message.extendedTextMessage as { text?: unknown } | undefined;
  push(extended?.text);

  for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2'] as const) {
    const inner = message[wrapper] as { message?: Record<string, unknown> } | undefined;
    if (inner?.message) parts.push(collectText(inner.message, includeFlowReplies));
  }

  for (const kind of ['documentMessage', 'imageMessage', 'videoMessage'] as const) {
    push((message[kind] as { caption?: unknown } | undefined)?.caption);
  }

  if (includeFlowReplies) {
    const native = (
      message.interactiveResponseMessage as
        | { nativeFlowResponseMessage?: { paramsJson?: string | null } | null }
        | undefined
    )?.nativeFlowResponseMessage;
    push(native?.paramsJson);
  }

  return parts.filter((p) => p.length > 0).join('\n');
}

export default injectionGuard;