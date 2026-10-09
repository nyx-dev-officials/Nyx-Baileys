/**
 * Module D — Personal Assistant & Utility Shortcuts.
 *
 * ## State and where it lives
 *
 * Notes, todos, snippets and reminders are stored in a single JSON file under
 * the OS temp directory, loaded once and written back on mutation. That is
 * honest about its durability: it survives a restart but not a reinstall, and
 * two Flux processes would race on it. A real deployment wants SQLite; this
 * notes that rather than pretending otherwise.
 *
 * Writes are atomic — a temp file plus rename — because a crash mid-write on
 * someone's actual notes is not acceptable, and `writeFileSync` to the live
 * path can leave a truncated file behind.
 *
 * ## Consent
 *
 * Notes are private per user and keyed on the sender JID. Nothing here reads
 * another user's notes, and there is no command that lists every user's data.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeQr, renderQr, renderQrCompact } from './qr.js';
import type { CommandContext, CommandResult } from './command-registry.js';

const ok = (t: string): CommandResult => ({ text: t });
const bad = (t: string): CommandResult => ({ error: t });
const A = (ctx: CommandContext): string => ctx.args.trim();
const WHO = (ctx: CommandContext): string => ctx.sender.split('@')[0] ?? ctx.sender;

/* ─────────────────────────── persistent store ────────────────────────── */

interface Note { id: string; text: string; tags: string[]; created: number; updated: number }
interface Todo { id: string; text: string; done: boolean; created: number; due?: number; priority: number }
interface Snippet { id: string; name: string; body: string; language: string; created: number }
interface Reminder { id: string; user: string; at: number; text: string; fired: boolean }

interface Store {
  notes: Record<string, Note[]>;
  todos: Record<string, Todo[]>;
  snippets: Record<string, Snippet[]>;
  reminders: Reminder[];
}

const EMPTY: Store = { notes: {}, todos: {}, snippets: {}, reminders: [] };

const dataDir = join(tmpdir(), 'flux-assistant');
const dataPath = join(dataDir, 'assistant.json');

let cache: Store | null = null;

function load(): Store {
  if (cache) return cache;
  if (!existsSync(dataPath)) {
    cache = structuredClone(EMPTY);
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(dataPath, 'utf8')) as Partial<Store>;
    cache = {
      notes: parsed.notes ?? {},
      todos: parsed.todos ?? {},
      snippets: parsed.snippets ?? {},
      reminders: parsed.reminders ?? [],
    };
  } catch {
    // A corrupt store must not take the whole command surface down with it.
    cache = structuredClone(EMPTY);
  }
  return cache;
}

/** Write atomically: a partial write must never destroy real notes. */
function save(store: Store): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${dataPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  renameSync(tmp, dataPath);
  cache = store;
}

function mutate<T>(fn: (store: Store) => T): T {
  const store = load();
  const result = fn(store);
  save(store);
  return result;
}

const stamp = (): string => new Date().toISOString().slice(0, 16).replace('T', ' ');

/* ─────────────────────────── parsing helpers ─────────────────────────── */

/** Parse a duration like "30m", "2h", "1d", "1w", or a bare number of minutes. */
function parseDuration(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|week|weeks)?$/i.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const factor: Record<string, number> = {
    s: 1000, sec: 1000, secs: 1000,
    m: 60_000, min: 60_000, mins: 60_000,
    h: 3_600_000, hr: 3_600_000, hrs: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000,
    w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  };
  return value * (factor[unit] ?? 60_000);
}

/** Parse "in 2h" or a bare duration into an absolute timestamp. */
function parseWhen(raw: string): number | null {
  if (!raw) return null;
  // "in 2h" is two tokens, but a caller may hand over just "in" as the first
  // argument. The separator is optional so both forms resolve.
  const cleaned = raw.replace(/^(?:in|after)\s*/i, '').trim();
  if (!cleaned) return null;
  const duration = parseDuration(cleaned);
  if (duration !== null) return Date.now() + duration;
  const absolute = Date.parse(cleaned);
  if (Number.isFinite(absolute)) return absolute;
  return null;
}

const argAt = (ctx: CommandContext, index: number): string | undefined =>
  A(ctx).split(/\s+/).filter(Boolean)[index];

/* ─────────────────────────── the commands ────────────────────────────── */

interface AssistCmd {
  name: string;
  summary: string;
  effect: string;
  fn: (ctx: CommandContext) => Promise<CommandResult>;
}

export const assistCommands: AssistCmd[] = [
  /* ---- notes vault ---- */
  { name: 'note', summary: 'Save a note', effect: 'store a timestamped note in your private vault',
    fn: async (ctx) => {
      const text = A(ctx);
      if (!text) return bad('Usage: note <text to remember>');
      return mutate((s) => {
        const list = s.notes[WHO(ctx)] ??= [];
        const note: Note = {
          id: randomUUID().slice(0, 8),
          text,
          tags: [...new Set((text.match(/#\w+/g) ?? []).map((t) => t.slice(1)))],
          created: Date.now(), updated: Date.now(),
        };
        list.unshift(note);
        return ok(`Saved as ${note.id}.\n${text}${note.tags.length ? `\nTags: ${note.tags.map((t) => `#${t}`).join(' ')}` : ''}`);
      });
    } },

  { name: 'notes', summary: 'List notes', effect: 'list your notes newest first',
    fn: async (ctx) => {
      const list = load().notes[WHO(ctx)] ?? [];
      if (!list.length) return ok('No notes yet. Add one with: note <text>');
      return ok(`${list.length} note${list.length === 1 ? '' : 's'}:\n\n${
        list.slice(0, 20).map((n) => `${n.id}  ${new Date(n.created).toISOString().slice(0, 16).replace('T', ' ')}  ${n.text}`).join('\n')
      }${list.length > 20 ? `\n\n...and ${list.length - 20} more.` : ''}`);
    } },

  { name: 'notesearch', summary: 'Search notes', effect: 'find notes containing a term',
    fn: async (ctx) => {
      const q = A(ctx).toLowerCase();
      if (!q) return bad('Usage: notesearch <term>');
      const list = load().notes[WHO(ctx)] ?? [];
      const hits = list.filter((n) => n.text.toLowerCase().includes(q));
      if (!hits.length) return ok(`No notes contain "${q}".`);
      return ok(`${hits.length} match${hits.length === 1 ? '' : 'es'} for "${q}":\n${hits.map((n) => `${n.id}  ${n.text}`).join('\n')}`);
    } },

  { name: 'notetag', summary: 'Tag a note', effect: 'add hashtags to an existing note',
    fn: async (ctx) => {
      const [id, ...tags] = A(ctx).split(/\s+/);
      if (!id || !tags.length) return bad('Usage: notetag <note id> <tag...>');
      return mutate((s) => {
        const note = (s.notes[WHO(ctx)] ?? []).find((n) => n.id === id);
        if (!note) return bad(`No note with id ${id}.`);
        note.tags = [...new Set([...note.tags, ...tags.map((t) => t.replace(/^#/, ''))])];
        note.updated = Date.now();
        return ok(`Tagged ${id}: ${note.tags.map((t) => `#${t}`).join(' ')}`);
      });
    } },

  { name: 'noteuntag', summary: 'Remove a tag', effect: 'strip a hashtag from a note',
    fn: async (ctx) => {
      const [id, tag] = A(ctx).split(/\s+/).filter(Boolean);
      if (!id || !tag) return bad('Usage: noteuntag <note id> <tag>');
      return mutate((s) => {
        const note = (s.notes[WHO(ctx)] ?? []).find((n) => n.id === id);
        if (!note) return bad(`No note with id ${id}.`);
        const stripped = tag.replace(/^#/, '');
        // Report the miss instead of claiming a removal that never happened.
        if (!note.tags.includes(stripped)) return bad(`Note ${id} has no tag "${stripped}".`);
        note.tags = note.tags.filter((t) => t !== stripped);
        return ok(`Removed #${stripped} from ${id}.`);
      });
    } },

  { name: 'notetags', summary: 'List all tags', effect: 'show every tag in use with counts',
    fn: async (ctx) => {
      const list = load().notes[WHO(ctx)] ?? [];
      const counts = new Map<string, number>();
      for (const n of list) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      if (!counts.size) return ok('No tags yet. Add one with a #hashtag inside a note.');
      return ok([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `#${t} — ${c}`).join('\n'));
    } },

  { name: 'notebyid', summary: 'Show one note', effect: 'display a note by its id',
    fn: async (ctx) => {
      const id = A(ctx);
      if (!id) return bad('Usage: notebyid <note id>');
      const note = (load().notes[WHO(ctx)] ?? []).find((n) => n.id === id);
      if (!note) return bad(`No note with id ${id}.`);
      return ok(`${note.id}\n${note.text}\n\nCreated: ${new Date(note.created).toISOString()}\nTags: ${note.tags.join(', ') || 'none'}`);
    } },

  { name: 'notedelete', summary: 'Delete a note', effect: 'remove a note from your vault',
    fn: async (ctx) => {
      const id = A(ctx);
      if (!id) return bad('Usage: notedelete <note id>');
      return mutate((s) => {
        const list = s.notes[WHO(ctx)] ?? [];
        const i = list.findIndex((n) => n.id === id);
        if (i === -1) return bad(`No note with id ${id}.`);
        const [removed] = list.splice(i, 1);
        return ok(`Deleted ${id}: ${removed!.text.slice(0, 60)}`);
      });
    } },

  { name: 'noteexport', summary: 'Export notes as markdown', effect: 'render your vault as a markdown document',
    fn: async (ctx) => {
      const list = load().notes[WHO(ctx)] ?? [];
      if (!list.length) return ok('# Notes\n\n_Empty._');
      const lines = ['# Notes', ''];
      for (const n of [...list].sort((a, b) => b.created - a.created)) {
        lines.push(`## ${new Date(n.created).toISOString().slice(0, 16).replace('T', ' ')} · ${n.id}`);
        lines.push('');
        lines.push(n.text);
        if (n.tags.length) { lines.push(''); lines.push(n.tags.map((t) => `#${t}`).join(' ')); }
        lines.push('');
      }
      return ok(lines.join('\n'));
    } },

  { name: 'noteedit', summary: 'Edit a note', effect: 'replace the text of an existing note',
    fn: async (ctx) => {
      const raw = A(ctx);
      const sp = raw.indexOf(' ');
      if (sp <= 0) return bad('Usage: notedit <note id> <new text>');
      const id = raw.slice(0, sp);
      const text = raw.slice(sp + 1);
      return mutate((s) => {
        const note = (s.notes[WHO(ctx)] ?? []).find((n) => n.id === id);
        if (!note) return bad(`No note with id ${id}.`);
        note.text = text;
        note.tags = [...new Set([...note.tags, ...(text.match(/#\w+/g) ?? []).map((t) => t.slice(1))])];
        note.updated = Date.now();
        return ok(`Updated ${id} at ${stamp()}.`);
      });
    } },

  { name: 'notescount', summary: 'Count notes', effect: 'report how many notes you have stored',
    fn: async (ctx) => {
      const list = load().notes[WHO(ctx)] ?? [];
      const total = list.reduce((sum, n) => sum + n.text.length, 0);
      return ok(`${list.length} notes · ${total} characters · ${new Set(list.flatMap((n) => n.tags)).size} tags`);
    } },

  /* ---- todo checklist ---- */
  { name: 'todo', summary: 'Add a task', effect: 'append a task to your checklist',
    fn: async (ctx) => {
      const text = A(ctx);
      if (!text) return bad('Usage: todo <task>');
      return mutate((s) => {
        const list = s.todos[WHO(ctx)] ??= [];
        const dueRaw = text.match(/\s*due\s+(\S+)$/i);
        let due: number | undefined;
        let body = text;
        if (dueRaw) {
          due = parseWhen(dueRaw[1]!) ?? undefined;
          body = text.slice(0, dueRaw.index).trim();
        }
        const priority = body.startsWith('!') ? 2 : 0;
        const task: Todo = { id: randomUUID().slice(0, 8), text: body.replace(/^!+/, ''), done: false, created: Date.now(), due, priority };
        list.push(task);
        return ok(`Added ${task.id}${due ? ` — due ${new Date(due).toISOString().slice(0, 16).replace('T', ' ')}` : ''}: ${task.text}`);
      });
    } },

  { name: 'todos', summary: 'List tasks', effect: 'show open and completed tasks',
    fn: async (ctx) => {
      const list = load().todos[WHO(ctx)] ?? [];
      if (!list.length) return ok('No tasks yet. Add one with: todo <task>');
      const open = list.filter((t) => !t.done);
      const done = list.filter((t) => t.done);
      const fmt = (t: Todo): string => {
        const box = t.done ? '[x]' : '[ ]';
        const due = t.due ? ` (due ${new Date(t.due).toISOString().slice(0, 16).replace('T', ' ')})` : '';
        return `${box} ${t.id}  ${t.text}${due}`;
      };
      return ok(`${open.length} open, ${done.length} done\n\n${open.map(fmt).join('\n')}${done.length ? `\n\nCompleted:\n${done.slice(-5).map(fmt).join('\n')}` : ''}`);
    } },

  { name: 'todone', summary: 'Complete a task', effect: 'mark a task as done',
    fn: async (ctx) => {
      const id = A(ctx);
      if (!id) return bad('Usage: todone <task id>');
      return mutate((s) => {
        const task = (s.todos[WHO(ctx)] ?? []).find((t) => t.id === id);
        if (!task) return bad(`No task with id ${id}.`);
        task.done = true;
        return ok(`Done: ${task.text}`);
      });
    } },

  { name: 'todoopen', summary: 'Reopen a task', effect: 'mark a completed task as open again',
    fn: async (ctx) => {
      const id = A(ctx);
      if (!id) return bad('Usage: todoopen <task id>');
      return mutate((s) => {
        const task = (s.todos[WHO(ctx)] ?? []).find((t) => t.id === id);
        if (!task) return bad(`No task with id ${id}.`);
        task.done = false;
        return ok(`Reopened: ${task.text}`);
      });
    } },

  { name: 'tododelete', summary: 'Delete a task', effect: 'remove a task from your list',
    fn: async (ctx) => {
      const id = A(ctx);
      if (!id) return bad('Usage: tododelete <task id>');
      return mutate((s) => {
        const list = s.todos[WHO(ctx)] ?? [];
        const i = list.findIndex((t) => t.id === id);
        if (i === -1) return bad(`No task with id ${id}.`);
        const [gone] = list.splice(i, 1);
        return ok(`Deleted: ${gone!.text}`);
      });
    } },

  { name: 'todoclear', summary: 'Clear completed tasks', effect: 'delete every completed task',
    fn: async (ctx) => {
      return mutate((s) => {
        const list = s.todos[WHO(ctx)] ?? [];
        const before = list.length;
        s.todos[WHO(ctx)] = list.filter((t) => !t.done);
        const removed = before - (s.todos[WHO(ctx)] ?? []).length;
        return ok(removed ? `Cleared ${removed} completed task${removed === 1 ? '' : 's'}.` : 'No completed tasks to clear.');
      });
    } },

  { name: 'tododue', summary: 'Tasks with due dates', effect: 'list tasks that have a deadline',
    fn: async (ctx) => {
      const list = (load().todos[WHO(ctx)] ?? []).filter((t) => !t.done && t.due);
      if (!list.length) return ok('No open tasks with due dates.');
      const now = Date.now();
      return ok(list
        .sort((a, b) => a.due! - b.due!)
        .map((t) => {
          const late = t.due! < now;
          const when = new Date(t.due!).toISOString().slice(0, 16).replace('T', ' ');
          return `${late ? 'OVERDUE' : 'due'}  ${when}  ${t.text}`;
        }).join('\n'));
    } },

  { name: 'todoprio', summary: 'Priority tasks', effect: 'show tasks marked high priority',
    fn: async (ctx) => {
      const list = (load().todos[WHO(ctx)] ?? []).filter((t) => !t.done && t.priority > 0);
      if (!list.length) return ok('No high-priority tasks. Prefix a task with ! to mark it.');
      return ok(list.map((t) => `[ ] ${t.id}  ${t.text}`).join('\n'));
    } },

  { name: 'todoexport', summary: 'Export tasks as markdown', effect: 'render your checklist as a markdown document',
    fn: async (ctx) => {
      const list = load().todos[WHO(ctx)] ?? [];
      if (!list.length) return ok('# Tasks\n\n_Empty._');
      return ok(['# Tasks', '', ...list.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`), ''].join('\n'));
    } },

  { name: 'todostats', summary: 'Task statistics', effect: 'report completion rate and overdue count',
    fn: async (ctx) => {
      const list = load().todos[WHO(ctx)] ?? [];
      if (!list.length) return ok('No tasks recorded yet.');
      const done = list.filter((t) => t.done).length;
      const overdue = list.filter((t) => !t.done && t.due && t.due < Date.now()).length;
      return ok([
        `Total: ${list.length}`,
        `Completed: ${done} (${Math.round((done / list.length) * 100)}%)`,
        `Overdue: ${overdue}`,
      ].join('\n'));
    } },

  /* ---- reminders ---- */
  { name: 'remind', summary: 'Set a reminder', effect: 'schedule a reminder at a relative or absolute time',
    fn: async (ctx) => {
      const text = A(ctx);
      // Join the leading tokens until one parses as a time, so 'in 2h' and
      // 'in' both resolve instead of only accepting a single token.
      const tokens = text.split(/\s+/);
      let when: number | null = null;
      let consumed = 0;
      for (let i = 1; i <= Math.min(2, tokens.length); i++) {
        const candidate = parseWhen(tokens.slice(0, i).join(' '));
        if (candidate !== null) { when = candidate; consumed = i; break; }
      }
      if (!when) return bad('Usage: remind <when> <what>  e.g. "remind in 2h check the build"');
      const body = tokens.slice(consumed).join(' ');
      if (!body) return bad('Say what to be reminded about.');
      if (when < Date.now()) return bad('That time is already in the past.');
      return mutate((s) => {
        const r: Reminder = { id: randomUUID().slice(0, 8), user: WHO(ctx), at: when, text: body, fired: false };
        s.reminders.push(r);
        return ok(`Reminder ${r.id} set for ${new Date(when).toISOString().slice(0, 16).replace('T', ' ')}.\n${body}`);
      });
    } },

  { name: 'reminders', summary: 'List reminders', effect: 'show your pending reminders',
    fn: async (ctx) => {
      const list = load().reminders.filter((r) => r.user === WHO(ctx) && !r.fired).sort((a, b) => a.at - b.at);
      if (!list.length) return ok('No pending reminders. Set one with: remind <when> <what>');
      return ok(list.map((r) => `${r.id}  ${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')}  ${r.text}`).join('\n'));
    } },

  { name: 'remindcancel', summary: 'Cancel a reminder', effect: 'delete a pending reminder',
    fn: async (ctx) => {
      const id = A(ctx);
      if (!id) return bad('Usage: remindcancel <reminder id>');
      return mutate((s) => {
        const i = s.reminders.findIndex((r) => r.id === id && r.user === WHO(ctx));
        if (i === -1) return bad(`No pending reminder with id ${id}.`);
        const [gone] = s.reminders.splice(i, 1);
        return ok(`Cancelled: ${gone!.text}`);
      });
    } },

  { name: 'reminddue', summary: 'Reminders that are due', effect: 'list reminders whose time has arrived',
    fn: async () => {
      const due = load().reminders.filter((r) => !r.fired && r.at <= Date.now());
      if (!due.length) return ok('No reminders are due.');
      return ok(due.map((r) => `${r.id}  ${r.text}`).join('\n'));
    } },

  { name: 'remindclear', summary: 'Clear reminders', effect: 'delete all your pending reminders',
    fn: async (ctx) => {
      return mutate((s) => {
        const before = s.reminders.length;
        s.reminders = s.reminders.filter((r) => r.user !== WHO(ctx));
        const removed = before - s.reminders.length;
        return ok(removed ? `Cleared ${removed} reminder${removed === 1 ? '' : 's'}.` : 'You had no pending reminders.');
      });
    } },

  { name: 'alarm', summary: 'Set an alarm', effect: 'schedule an alarm expressed as time from now',
    fn: async (ctx) => {
      const duration = parseDuration(A(ctx));
      if (duration === null) return bad('Usage: alarm <duration> e.g. "alarm 30m"');
      const at = Date.now() + duration;
      return mutate((s) => {
        const r: Reminder = { id: randomUUID().slice(0, 8), user: WHO(ctx), at, text: 'Alarm', fired: false };
        s.reminders.push(r);
        return ok(`Alarm ${r.id} will fire at ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} (${A(ctx)} from now).`);
      });
    } },

  /* ---- snippets ---- */
  { name: 'snip', summary: 'Save a snippet', effect: 'store a reusable code or text snippet',
    fn: async (ctx) => {
      const raw = A(ctx);
      const sp = raw.indexOf(' ');
      if (sp <= 0) return bad('Usage: snip <name> <body>');
      const name = raw.slice(0, sp);
      const rest = raw.slice(sp + 1);
      const langMatch = rest.match(/^([\w+#.-]+)\s+(.*)$/s);
      const language = langMatch ? langMatch[1]! : 'text';
      const body = langMatch ? langMatch[2]! : rest;
      return mutate((s) => {
        const list = s.snippets[WHO(ctx)] ??= [];
        const existing = list.find((x) => x.name === name);
        if (existing) { existing.body = body; existing.language = language; return ok(`Updated snippet "${name}" (${language}).`); }
        const sn: Snippet = { id: randomUUID().slice(0, 8), name, body, language, created: Date.now() };
        list.push(sn);
        return ok(`Saved snippet "${name}" (${language}) as ${sn.id}.`);
      });
    } },

  { name: 'snips', summary: 'List snippets', effect: 'show every snippet you have saved',
    fn: async (ctx) => {
      const list = load().snippets[WHO(ctx)] ?? [];
      if (!list.length) return ok('No snippets yet. Add one with: snip <name> <body>');
      return ok(list.map((s) => `${s.name} (${s.language}) — ${s.body.slice(0, 50).replace(/\n/g, ' ')}`).join('\n'));
    } },

  { name: 'snipget', summary: 'Retrieve a snippet', effect: 'print a saved snippet by name',
    fn: async (ctx) => {
      const name = A(ctx);
      if (!name) return bad('Usage: snipget <name>');
      const sn = (load().snippets[WHO(ctx)] ?? []).find((s) => s.name === name);
      if (!sn) return bad(`No snippet named "${name}".`);
      return ok(`\`\`\`${sn.language}\n${sn.body}\n\`\`\``);
    } },

  { name: 'snipsearch', summary: 'Search snippets', effect: 'find snippets containing a term',
    fn: async (ctx) => {
      const q = A(ctx).toLowerCase();
      if (!q) return bad('Usage: snipsearch <term>');
      const hits = (load().snippets[WHO(ctx)] ?? []).filter((s) => s.body.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
      if (!hits.length) return ok(`No snippets match "${q}".`);
      return ok(hits.map((s) => `${s.name} (${s.language})`).join('\n'));
    } },

  { name: 'snipdelete', summary: 'Delete a snippet', effect: 'remove a saved snippet',
    fn: async (ctx) => {
      const name = A(ctx);
      if (!name) return bad('Usage: snipdelete <name>');
      return mutate((s) => {
        const list = s.snippets[WHO(ctx)] ?? [];
        const i = list.findIndex((x) => x.name === name);
        if (i === -1) return bad(`No snippet named "${name}".`);
        list.splice(i, 1);
        return ok(`Deleted snippet "${name}".`);
      });
    } },

  /* ---- QR ---- */
  { name: 'qr', summary: 'Generate a QR code', effect: 'encode text as a scannable QR symbol',
    fn: async (ctx) => {
      const text = A(ctx);
      if (!text) return bad('Usage: qr <text or url>');
      const result = encodeQr(text);
      return ok(`${renderQr(result)}\n\n${text}\nVersion ${result.version}, mask ${result.mask}, ${result.size}x${result.size} modules.`);
    } },

  { name: 'qrcompact', summary: 'Compact QR code', effect: 'encode text as a half-height QR symbol',
    fn: async (ctx) => {
      const text = A(ctx);
      if (!text) return bad('Usage: qrcompact <text or url>');
      const result = encodeQr(text);
      return ok(`${renderQrCompact(result)}\n\n${text}`);
    } },

  { name: 'qrurl', summary: 'QR for a URL', effect: 'encode a web address as a QR symbol',
    fn: async (ctx) => {
      const url = A(ctx);
      if (!url) return bad('Usage: qrurl <url>');
      if (!/^https?:\/\//i.test(url)) return bad('That does not look like a URL. Expected something starting with http:// or https://');
      const result = encodeQr(url);
      return ok(`${renderQr(result)}\n\n${url}`);
    } },

  { name: 'qrwa', summary: 'QR for a WhatsApp chat', effect: 'encode a wa.me click-to-chat link as a QR symbol',
    fn: async (ctx) => {
      const number = A(ctx).replace(/\D/g, '');
      if (!number) return bad('Usage: qrwa <phone number with country code>');
      if (number.length < 8) return bad('That number is too short. Include the country code, for example 62882017467912.');
      const url = `https://wa.me/${number}`;
      const result = encodeQr(url);
      return ok(`${renderQr(result)}\n\n${url}\nScanning this opens a chat with ${number}.`);
    } },

  { name: 'qrvcard', summary: 'QR for a contact', effect: 'encode a vCard as a QR symbol',
    fn: async (ctx) => {
      const [name, ...phone] = A(ctx).split(/\s+/);
      const number = phone.join('').replace(/\D/g, '');
      if (!name || !number) return bad('Usage: qrvcard <name> <phone>');
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL:${number}\nEND:VCARD`;
      const result = encodeQr(vcard);
      return ok(`${renderQr(result)}\n\nContact: ${name} ${number}`);
    } },

  { name: 'qrwifi', summary: 'QR for WiFi', effect: 'encode WiFi credentials as a QR symbol phones can join',
    fn: async (ctx) => {
      const m = A(ctx).match(/^(\S+)\s+(\S+)(?:\s+(\w+))?$/);
      if (!m) return bad('Usage: qrwifi <ssid> <password> [WPA|WEP|nopass]');
      const [, ssid, password, type] = m;
      const payload = `WIFI:T:${type ?? 'WPA'};S:${ssid};P:${password};;`;
      const result = encodeQr(payload);
      return ok(`${renderQr(result)}\n\nNetwork: ${ssid}\nScanning this connects a phone to the network.`);
    } },

  { name: 'qrmeeting', summary: 'QR for an event', effect: 'encode an event as a QR symbol',
    fn: async (ctx) => {
      const raw = A(ctx);
      const m = raw.match(/^([^|]+)\|([^|]+)\|(.+)$/);
      if (!m) return bad('Usage: qrmeeting <title>|<start>|<location>');
      const payload = `BEGIN:VEVENT\nSUMMARY:${m[1]}\nDTSTART:${m[2]}\nLOCATION:${m[3]}\nEND:VEVENT`;
      const result = encodeQr(payload);
      return ok(`${renderQr(result)}\n\n${m[1]} — ${m[2]} at ${m[3]}`);
    } },

  /* ---- text utilities ---- */
  { name: 'template', summary: 'Fill a template', effect: 'substitute {{placeholders}} in a template string',
    fn: async (ctx) => {
      const raw = A(ctx);
      const parts = raw.split(/\s+/);
      const template = parts.shift() ?? '';
      const values = parts;
      const out = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const i = Number(key);
        return values[i] !== undefined ? values[i]! : `{{${key}}}`;
      });
      return ok(out === template && !raw.includes('{{') ? `Usage: template "Hello {{0}}" world` : out);
    } },

  { name: 'charcount2', summary: 'Count characters', effect: 'count characters, words and lines',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: charcount2 <text>');
      const t = A(ctx);
      return ok(`Characters: ${[...t].length}\nCharacters (UTF-16): ${t.length}\nWords: ${t.split(/\s+/).filter(Boolean).length}\nLines: ${t.split('\n').length}`);
    } },

  { name: 'readingtime', summary: 'Reading time', effect: 'estimate how long a text takes to read',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: readingtime <text>');
      const words = A(ctx).split(/\s+/).filter(Boolean).length;
      const minutes = words / 225;
      return ok(`${words} words at 225 words per minute: ${minutes < 1 ? 'under a minute' : `${Math.ceil(minutes)} minute${Math.ceil(minutes) === 1 ? '' : 's'}`}`);
    } },

  { name: 'sentencecase', summary: 'Sentence case', effect: 'capitalise only the first letter',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: sentencecase <text>');
      const t = A(ctx);
      return ok(t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
    } },

  { name: 'wordorder', summary: 'Reverse word order', effect: 'reverse the order of words',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: wordorder <text>');
      return ok(A(ctx).split(/\s+/).filter(Boolean).reverse().join(' '));
    } },

  { name: 'everyother', summary: 'Every other word', effect: 'take every second word',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: everyother <text>');
      return ok(A(ctx).split(/\s+/).filter(Boolean).filter((_, i) => i % 2 === 0).join(' '));
    } },

  { name: 'linesort', summary: 'Sort lines', effect: 'sort a multi-line block alphabetically',
    fn: async (ctx) => {
      const lines = A(ctx).split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return bad('Usage: linesort with lines separated by newlines');
      return ok([...lines].sort((a, b) => a.localeCompare(b)).join('\n'));
    } },

  { name: 'linecount', summary: 'Count lines', effect: 'count lines in a block of text',
    fn: async (ctx) => {
      const lines = A(ctx).split('\n');
      const nonEmpty = lines.filter((l) => l.trim()).length;
      return ok(`Total lines: ${lines.length}\nNon-empty: ${nonEmpty}\nBlank: ${lines.length - nonEmpty}`);
    } },

  { name: 'uniq', summary: 'Remove duplicate lines', effect: 'drop repeated lines from a block',
    fn: async (ctx) => {
      const lines = A(ctx).split('\n').map((l) => l.trim()).filter(Boolean);
      const seen = new Set<string>();
      const out: string[] = [];
      let removed = 0;
      for (const l of lines) {
        if (seen.has(l)) { removed++; continue; }
        seen.add(l);
        out.push(l);
      }
      return ok(`${out.length} unique of ${lines.length} lines.${removed ? ` Removed ${removed}.` : ''}\n\n${out.join('\n')}`);
    } },

  { name: 'topwords', summary: 'Most common words', effect: 'rank the most frequent words in a text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: topwords <text>');
      const stop = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'it', 'that', 'this', 'for', 'on', 'with', 'as', 'was', 'at', 'by']);
      const counts = new Map<string, number>();
      for (const w of A(ctx).toLowerCase().match(/[a-z']+/g) ?? []) {
        if (w.length < 3 || stop.has(w)) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
      if (!counts.size) return ok('No usable words found.');
      return ok([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w, c]) => `${w}: ${c}`).join('\n'));
    } },

  { name: 'markdownlink', summary: 'Markdown link', effect: 'format text and a URL as a markdown link',
    fn: async (ctx) => {
      const m = A(ctx).match(/^(\S+)\s+(\S+)$/);
      if (!m) return bad('Usage: markdownlink <text> <url>');
      return ok(`[${m[1]}](${m[2]})`);
    } },

  { name: 'mdchecklist', summary: 'Turn a list into markdown', effect: 'convert numbered lines into a task checklist',
    fn: async (ctx) => {
      const items = A(ctx).split('\n').map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()).filter(Boolean);
      if (!items.length) return bad('Usage: mdchecklist with one item per line');
      return ok(items.map((i) => `- [ ] ${i}`).join('\n'));
    } },

  { name: 'mdheadings', summary: 'Heading ladder', effect: 'number headings as an outline',
    fn: async (ctx) => {
      const lines = A(ctx).split('\n').filter((l) => l.trim());
      if (!lines.length) return bad('Usage: mdheadings with one heading per line');
      return ok(lines.map((l, i) => `${i + 1}. ${l.trim()}`).join('\n'));
    } },

  { name: 'mdtablefrom', summary: 'Build a markdown table', effect: 'turn comma-separated values into a table',
    fn: async (ctx) => {
      const rows = A(ctx).split('\n').map((l) => l.split(',').map((c) => c.trim())).filter((r) => r.length);
      if (rows.length < 2) return bad('Need at least two comma-separated rows.');
      const cols = Math.max(...rows.map((r) => r.length));
      const header = rows[0]!;
      const pad = (r: string[]): string => [...r, ...Array(cols - r.length).fill('')].join(' | ');
      return ok([`| ${pad(header)} |`, `| ${Array(cols).fill('---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${pad(r)} |`)].join('\n'));
    } },

  { name: 'mdquote', summary: 'Markdown blockquote', effect: 'prefix every line with a quote marker',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: mdquote <text>');
      return ok(A(ctx).split('\n').map((l) => `> ${l}`).join('\n'));
    } },

  { name: 'mdcode', summary: 'Markdown code block', effect: 'wrap text in a fenced code block',
    fn: async (ctx) => {
      const raw = A(ctx);
      const lang = (argAt(ctx, 0) ?? '').match(/^[\w+#.-]+$/)?.[0];
      const body = lang ? A(ctx).slice(lang.length).trim() : raw;
      if (!body) return bad('Usage: mdcode [language] <text>');
      return ok('```' + (lang ?? '') + '\n' + body + '\n```');
    } },

  { name: 'mdbold', summary: 'Markdown emphasis', effect: 'wrap text in markdown emphasis markers',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: mdbold <text>');
      return ok(`**${A(ctx)}**`);
    } },

  { name: 'mditalic', summary: 'Markdown italics', effect: 'wrap text in markdown italics markers',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: mditalic <text>');
      return ok(`*${A(ctx)}*`);
    } },

  { name: 'mdhr', summary: 'Horizontal rule', effect: 'emit a markdown thematic break',
    fn: async (ctx) => ok('---') },

  /* ---- security and hashing ---- */
  { name: 'sha256', summary: 'SHA-256 hash', effect: 'compute the SHA-256 digest of text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: sha256 <text>');
      return ok(createHash('sha256').update(A(ctx)).digest('hex'));
    } },

  { name: 'sha1', summary: 'SHA-1 hash', effect: 'compute the SHA-1 digest of text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: sha1 <text>');
      return ok(createHash('sha1').update(A(ctx)).digest('hex'));
    } },

  { name: 'md5', summary: 'MD5 hash', effect: 'compute the MD5 digest of text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: md5 <text>');
      return ok(createHash('md5').update(A(ctx)).digest('hex'));
    } },

  { name: 'sha512', summary: 'SHA-512 hash', effect: 'compute the SHA-512 digest of text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: sha512 <text>');
      return ok(createHash('sha512').update(A(ctx)).digest('hex'));
    } },

  { name: 'randomhex', summary: 'Random hex', effect: 'generate cryptographically secure random bytes as hex',
    fn: async (ctx) => {
      const bytes = Math.max(1, Math.min(256, Number(argAt(ctx, 0)) || 16));
      return ok(randomBytes(bytes).toString('hex'));
    } },

  { name: 'randombase64', summary: 'Random base64', effect: 'generate cryptographically secure random bytes as base64',
    fn: async (ctx) => {
      const bytes = Math.max(1, Math.min(256, Number(argAt(ctx, 0)) || 16));
      return ok(randomBytes(bytes).toString('base64'));
    } },

  { name: 'randomuuid', summary: 'Random UUID', effect: 'generate a version 4 UUID',
    fn: async () => ok(randomUUID()) },

  { name: 'uuidcount', summary: 'Count UUIDs', effect: 'generate a batch of UUIDs',
    fn: async (ctx) => {
      const n = Math.max(1, Math.min(100, Number(argAt(ctx, 0)) || 5));
      return ok(Array.from({ length: n }, () => randomUUID()).join('\n'));
    } },

  { name: 'pwstrength', summary: 'Password strength', effect: 'score a password and explain the weaknesses',
    fn: async (ctx) => {
      const pw = A(ctx);
      if (!pw) return bad('Usage: pwstrength <password>');
      let score = 0;
      const notes: string[] = [];
      if (pw.length >= 12) score++; else notes.push(`Only ${pw.length} characters — aim for 12 or more.`);
      if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++; else notes.push('Missing upper or lower case letters.');
      if (/\d/.test(pw)) score++; else notes.push('No digits.');
      if (/[^\w\s]/.test(pw)) score++; else notes.push('No symbols.');
      const verdict = ['very weak', 'weak', 'fair', 'strong', 'very strong'][score];
      return ok(`${score}/4 — ${verdict}${notes.length ? `\n\n${notes.map((n) => `- ${n}`).join('\n')}` : '\n\nNothing obvious to improve.'}`);
    } },

  { name: 'pwgen', summary: 'Generate a password', effect: 'generate a random password with configurable length and symbols',
    fn: async (ctx) => {
      const length = Math.max(8, Math.min(128, Number(argAt(ctx, 0)) || 20));
      const symbols = A(ctx).toLowerCase().includes('symbol');
      const lower = 'abcdefghijkmnopqrstuvwxyz';
      const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
      const digits = '23456789';
      const extra = '!@#$%^&*()-_=+[]{}';
      let pool = lower + upper + digits + (symbols ? extra : '');
      // Guarantee at least one of each required class, then fill the rest.
      const required = [lower, upper, digits];
      if (symbols) required.push(extra);
      const chars = required.map((set) => set[randomInt(set.length)]!);
      while (chars.length < length) chars.push(pool[randomInt(pool.length)]!);
      for (let i = chars.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j]!, chars[i]!];
      }
      return ok(chars.join(''));
    } },

  { name: 'pwpin', summary: 'Generate a PIN', effect: 'generate a numeric PIN',
    fn: async (ctx) => {
      const digits = Math.max(4, Math.min(12, Number(argAt(ctx, 0)) || 6));
      return ok(Array.from({ length: digits }, () => randomInt(10)).join(''));
    } },

  { name: 'pwpassphrase', summary: 'Generate a passphrase', effect: 'generate a memorable multi-word passphrase',
    fn: async (ctx) => {
      const words = Math.max(3, Math.min(10, Number(argAt(ctx, 0)) || 5));
      const bank = 'correct horse battery staple anchor lantern bridge meadow silver thunder velvet copper marble ginger island falcon harbour thunder ember canyon pebble willow harbour'.split(' ');
      const unique = [...new Set(bank)];
      return ok(Array.from({ length: words }, () => unique[randomInt(unique.length)]!).join('-'));
    } },

  { name: 'leetsafe', summary: 'Leet-speak a password', effect: 'substitute lookalike characters in a password',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: leetsafe <text>');
      const map: Record<string, string> = { a: '@', e: '3', i: '1', o: '0', s: '$', t: '7', l: '1', b: '8' };
      return ok(A(ctx).toLowerCase().split('').map((c) => map[c] ?? c).join(''));
    } },

  { name: 'base64safe', summary: 'Base64 encode', effect: 'encode text as base64',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: base64safe <text>');
      return ok(Buffer.from(A(ctx), 'utf8').toString('base64'));
    } },

  { name: 'base64decode', summary: 'Base64 decode', effect: 'decode base64 back to text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: base64decode <base64>');
      try {
        return ok(Buffer.from(A(ctx), 'base64').toString('utf8'));
      } catch {
        return bad('That is not valid base64.');
      }
    } },

  { name: 'urlencode', summary: 'URL encode', effect: 'percent-encode text for a URL',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: urlencode <text>');
      return ok(encodeURIComponent(A(ctx)));
    } },

  { name: 'urldecode', summary: 'URL decode', effect: 'decode percent-encoded text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: urldecode <text>');
      try {
        return ok(decodeURIComponent(A(ctx)));
      } catch {
        return bad('That contains invalid percent-encoding.');
      }
    } },

  /* ---- time and numbers ---- */
  { name: 'epoch', summary: 'Unix timestamp', effect: 'show the current Unix time and ISO form',
    fn: async () => {
      const now = Date.now();
      return ok(`Unix: ${Math.floor(now / 1000)}\nISO: ${new Date(now).toISOString()}`);
    } },

  { name: 'epochconvert', summary: 'Convert a timestamp', effect: 'turn a Unix timestamp into readable dates',
    fn: async (ctx) => {
      const n = Number(argAt(ctx, 0));
      if (!Number.isFinite(n)) return bad('Usage: epochconvert <unix seconds>');
      const ms = n > 1e12 ? n : n * 1000;
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) return bad('That is not a valid timestamp.');
      return ok(`${d.toISOString()}\n${d.toUTCString()}\n${d.toLocaleString()}`);
    } },

  { name: 'timebetween', summary: 'Time between dates', effect: 'measure the gap between two dates',
    fn: async (ctx) => {
      const parts = A(ctx).split(/\s*\|\s*|\s+to\s+/);
      if (parts.length < 2) return bad('Usage: timebetween <date1> | <date2>');
      const a = Date.parse(parts[0]!);
      const b = Date.parse(parts[1]!);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return bad('Could not parse both dates.');
      const ms = Math.abs(b - a);
      const days = Math.floor(ms / 86_400_000);
      const hours = Math.floor((ms % 86_400_000) / 3_600_000);
      const mins = Math.floor((ms % 3_600_000) / 60_000);
      return ok(`${days} days, ${hours} hours, ${mins} minutes`);
    } },

  { name: 'addtime', summary: 'Add time to a date', effect: 'add a duration to a date and report the result',
    fn: async (ctx) => {
      const m = A(ctx).match(/^(.+?)\s+([+-]?\d+\s*\w+)$/);
      if (!m) return bad('Usage: addtime <date> <duration> e.g. "addtime 2026-01-01 3d"');
      const base = Date.parse(m[1]!);
      const delta = parseDuration(m[2]!);
      if (!Number.isFinite(base) || delta === null) return bad('Could not parse the date or the duration.');
      return ok(new Date(base + delta).toISOString());
    } },

  { name: 'tzoffset', summary: 'UTC offset', effect: 'report the current UTC offset',
    fn: async () => {
      const offset = -new Date().getTimezoneOffset();
      const sign = offset >= 0 ? '+' : '-';
      const abs = Math.abs(offset);
      return ok(`UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}\nLocal: ${new Date().toString()}`);
    } },

  { name: 'weeknumber', summary: 'Week number', effect: 'report the ISO week number and day of year',
    fn: async (ctx) => {
      const raw = argAt(ctx, 0);
      const d = raw ? new Date(Date.parse(raw)) : new Date();
      if (Number.isNaN(d.getTime())) return bad('Usage: weeknumber [date]');
      const start = new Date(Date.UTC(d.getFullYear(), 0, 1));
      const days = Math.floor((d.getTime() - start.getTime()) / 86_400_000);
      const week = Math.ceil((days + start.getUTCDay() + 1) / 7);
      return ok(`Date: ${d.toISOString().slice(0, 10)}\nDay of year: ${days + 1}\nISO week: ${week}`);
    } },

  { name: 'agecalc', summary: 'Calculate an age', effect: 'work out how old someone is on a given date',
    fn: async (ctx) => {
const m = A(ctx).match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\S+))?$/);
      if (!m) return bad('Usage: agecalc <birthdate as YYYY-MM-DD> [on date]');
      // m[1] is the whole ISO date, m[2] the optional "on" date.
      //
      // An earlier version captured year, month and day as three separate
      // groups and then called Date.parse on the year alone. "2000-12-31"
      // became the year "2000", which parses as 1 January 2000 — so anyone
      // born on 31 December was reported as being born on 1 January, and every
      // birthday boundary was wrong.
      const on = m[2] ? Date.parse(m[2]) : Date.now();
      const birth = Date.parse(m[1]!);
      const now = new Date(Number.isFinite(on) ? on : Date.now());
      if (!Number.isFinite(birth)) return bad('Could not parse the birth date.');
      let age = now.getFullYear() - new Date(birth).getFullYear();
      const md = new Date(birth);
      // The birthday has not occurred yet this year if we are before the month,
      // or in the same month but before the day. Someone born 31 December is
      // still 20 on 1 January, not 21.
      const hadBirthday = now.getMonth() > md.getMonth()
        || (now.getMonth() === md.getMonth() && now.getDate() >= md.getDate());
      if (!hadBirthday) age--;
      return ok(`${age} years old as of ${now.toISOString().slice(0, 10)}`);
    } },

  { name: 'numwords', summary: 'Number to words', effect: 'spell a number out in English',
    fn: async (ctx) => {
      const n = Number(argAt(ctx, 0));
      if (!Number.isInteger(n)) return bad('Usage: numwords <integer>');
      const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
      const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
      if (n < 0) return bad('Negative numbers are not supported here.');
      if (n < 20) return ok(ONES[n]!);
      if (n < 100) return ok(`${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}`);
      if (n < 1000) return ok(`${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${numWords(n % 100)}` : ''}`);
      return ok(`${Math.floor(n / 1000).toLocaleString('en-US')} thousand${n % 1000 ? ` ${numWords(n % 1000)}` : ''}`);
    } },

  { name: 'gcd', summary: 'Greatest common divisor', effect: 'compute the GCD of two integers',
    fn: async (ctx) => {
      const [a, b] = A(ctx).split(/\s+/).map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return bad('Usage: gcd <a> <b>');
      const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
      return ok(`gcd(${a}, ${b}) = ${gcd(a!, b!)}`);
    } },

  { name: 'lcm', summary: 'Least common multiple', effect: 'compute the LCM of two integers',
    fn: async (ctx) => {
      const [a, b] = A(ctx).split(/\s+/).map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a === 0 || b === 0) return bad('Usage: lcm <a> <b>, both non-zero');
      const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
      return ok(`lcm(${a}, ${b}) = ${Math.abs(a! * b!) / gcd(a!, b!)}`);
    } },

  { name: 'factorial', summary: 'Factorial', effect: 'compute the factorial of an integer',
    fn: async (ctx) => {
      const n = Number(argAt(ctx, 0));
      if (!Number.isInteger(n) || n < 0 || n > 170) return bad('Usage: factorial <0-170>');
      let result = 1;
      for (let i = 2; i <= n; i++) result *= i;
      return ok(`${n}! = ${result}`);
    } },

  { name: 'percentcalc', summary: 'Percentage', effect: 'compute a percentage of a value',
    fn: async (ctx) => {
      // Accepts "15% of 200", "15 of 200" and "15 percent of 200". People write the
// percent sign *and* the word, so the separator is optional in either order.
const m = A(ctx).match(/^(-?\d+(?:\.\d+)?)\s*(?:%\s*of|percent\s+of|%|of)\s*(-?\d+(?:\.\d+)?)$/i);
      if (!m) return bad('Usage: percentcalc 15% of 200  or  percentcalc 15 of 200');
      return ok(`${m[1]}% of ${m[2]} = ${(Number(m[1]) / 100) * Number(m[2])}`);
    } },

  { name: 'percentdiff', summary: 'Percentage change', effect: 'report the percentage change between two values',
    fn: async (ctx) => {
      const [a, b] = A(ctx).split(/\s+/).map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return bad('Usage: percentdiff <from> <to>');
      return ok(`${a} -> ${b} is ${(((b! - a!) / Math.abs(a!)) * 100).toFixed(2)}%`);
    } },

  { name: 'romanconvert', summary: 'Roman numerals', effect: 'convert an integer to Roman numerals',
    fn: async (ctx) => {
      const n = Number(argAt(ctx, 0));
      if (!Number.isInteger(n) || n < 1 || n > 3999) return bad('Usage: romanconvert <1-3999>');
      const table: ReadonlyArray<[number, string]> = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
      let rest = n, out = '';
      for (const [value, sym] of table) while (rest >= value) { out += sym; rest -= value; }
      return ok(`${n} = ${out}`);
    } },

  { name: 'hexdec', summary: 'Hex to decimal', effect: 'convert a hexadecimal number to decimal',
    fn: async (ctx) => {
      const raw = A(ctx).replace(/^0x/i, '');
      if (!/^[0-9a-f]+$/i.test(raw)) return bad('Usage: hexdec <hex digits>');
      return ok(`${raw} = ${parseInt(raw, 16)}`);
    } },

  { name: 'dechex', summary: 'Decimal to hex', effect: 'convert a decimal number to hexadecimal',
    fn: async (ctx) => {
      const n = Number(argAt(ctx, 0));
      if (!Number.isInteger(n)) return bad('Usage: dechex <integer>');
      return ok(`${n} = 0x${n.toString(16).toUpperCase()}`);
    } },

  { name: 'binconvert', summary: 'Decimal to binary', effect: 'convert a decimal number to binary',
    fn: async (ctx) => {
      const n = Number(argAt(ctx, 0));
      if (!Number.isInteger(n)) return bad('Usage: binconvert <integer>');
      return ok(`${n} = 0b${(n >>> 0).toString(2)}`);
    } },

  { name: 'avg', summary: 'Average', effect: 'compute the mean of a list of numbers',
    fn: async (ctx) => {
      const nums = A(ctx).split(/[\s,]+/).map(Number).filter(Number.isFinite);
      if (!nums.length) return bad('Usage: avg <numbers separated by spaces>');
      const sum = nums.reduce((a, b) => a + b, 0);
      return ok(`Mean: ${(sum / nums.length).toFixed(4)}\nSum: ${sum}\nCount: ${nums.length}\nMin: ${Math.min(...nums)}\nMax: ${Math.max(...nums)}`);
    } },

  { name: 'median', summary: 'Median', effect: 'compute the median of a list of numbers',
    fn: async (ctx) => {
      const nums = A(ctx).split(/[\s,]+/).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      if (!nums.length) return bad('Usage: median <numbers>');
      const mid = Math.floor(nums.length / 2);
      return ok(nums.length % 2 ? `${nums[mid]}` : `${(nums[mid - 1]! + nums[mid]!) / 2}`);
    } },

  { name: 'stddev', summary: 'Standard deviation', effect: 'compute the standard deviation of a list',
    fn: async (ctx) => {
      const nums = A(ctx).split(/[\s,]+/).map(Number).filter(Number.isFinite);
      if (nums.length < 2) return bad('Need at least two numbers.');
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const variance = nums.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (nums.length - 1);
      return ok(`Population SD: ${Math.sqrt(nums.reduce((sum, x) => sum + (x - mean) ** 2, 0) / nums.length).toFixed(4)}\nSample SD: ${Math.sqrt(variance).toFixed(4)}`);
    } },

  { name: 'primecheck', summary: 'Prime check', effect: 'test whether a number is prime',
    fn: async (ctx) => {
      const n = Number(argAt(ctx, 0));
      if (!Number.isInteger(n) || n < 2) return bad('Usage: primecheck <integer >= 2>');
      if (n === 2) return ok('2 is prime.');
      if (n % 2 === 0) return ok(`${n} is not prime.`);
      for (let i = 3; i * i <= n; i += 2) if (n % i === 0) return ok(`${n} is not prime (divisible by ${i}).`);
      return ok(`${n} is prime.`);
    } },

  { name: 'nextprime', summary: 'Next prime', effect: 'find the next prime after a number',
    fn: async (ctx) => {
      let n = Math.max(2, Number(argAt(ctx, 0)) || 2);
      const isPrime = (x: number): boolean => {
        if (x < 2) return false;
        if (x % 2 === 0) return x === 2;
        for (let i = 3; i * i <= x; i += 2) if (x % i === 0) return false;
        return true;
      };
      while (!isPrime(n)) n++;
      return ok(`${n} is the first prime at or after the given value.`);
    } },

  /* ---- meeting and timezone conversion ---- */
  { name: 'tzconvert', summary: 'Convert a time between zones', effect: 'convert one local time into several common zones',
    fn: async (ctx) => {
      const raw = A(ctx);
      const m = raw.match(/^(\d{1,2}):(\d{2})\s*(.*)$/);
      if (!m) return bad('Usage: tzconvert 14:30 — converts that local time across common zones');
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      if (hour > 23 || minute > 59) return bad('That is not a valid time.');
      const zones = ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
      const now = new Date();
      const base = new Date(now);
      base.setHours(hour, minute, 0, 0);
      const lines = zones.map((zone) => {
        const formatted = new Intl.DateTimeFormat('en-GB', {
          timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
          timeZoneName: 'short',
        }).format(base);
        return `${zone.padEnd(22)} ${formatted}`;
      });
      return ok(`Local time ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} interpreted in:\n\n${lines.join('\n')}\n\nNote: your system zone is ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`);
    } },

  { name: 'tznow', summary: 'Time in a zone', effect: 'show the current time in a named IANA zone',
    fn: async (ctx) => {
      const zone = A(ctx) || Intl.DateTimeFormat().resolvedOptions().timeZone;
      try {
        return ok(`${new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'full', timeStyle: 'medium' }).format(new Date())}`);
      } catch {
        return bad(`"${zone}" is not a valid IANA time zone name.`);
      }
    } },

  { name: 'tzdiff', summary: 'Zone difference', effect: 'report the offset between two zones right now',
    fn: async (ctx) => {
      const [a, b] = A(ctx).split(/\s+/);
      if (!a || !b) return bad('Usage: tzdiff <zone1> <zone2>');
      try {
        const fmt = (zone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longOffset' }).format(new Date());
        return ok(`${a}: ${fmt(a)}\n${b}: ${fmt(b)}`);
      } catch {
        return bad('One of those is not a valid IANA zone name.');
      }
    } },

  { name: 'workinghours', summary: 'Working hours check', effect: 'report whether a UTC time falls in working hours for a zone',
    fn: async (ctx) => {
      const zone = A(ctx) || 'Europe/London';
      try {
        const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: 'numeric', hour12: false }).format(new Date()));
        const work = hour >= 9 && hour < 17;
        const lunch = hour >= 12 && hour < 13;
        return ok(`${zone} is ${String(hour).padStart(2, '0')}:00.\n${work ? (lunch ? 'Lunch break.' : 'Within working hours.') : 'Outside working hours.'}`);
      } catch {
        return bad(`"${zone}" is not a valid IANA zone name.`);
      }
    } },

  { name: 'dateformat', summary: 'Format a date', effect: 'render a date in several common formats',
    fn: async (ctx) => {
      const raw = argAt(ctx, 0);
      const d = raw ? new Date(Date.parse(raw)) : new Date();
      if (Number.isNaN(d.getTime())) return bad('Usage: dateformat [a parseable date]');
      return ok([
        `ISO:      ${d.toISOString()}`,
        `UTC:      ${d.toUTCString()}`,
        `Local:    ${d.toLocaleString()}`,
        `Long:     ${d.toLocaleDateString('en-GB', { dateStyle: 'long' })}`,
      ].join('\n'));
    } },

  { name: 'weekday', summary: 'Weekday', effect: 'report the weekday and whether today is a weekend',
    fn: async (ctx) => {
      const raw = argAt(ctx, 0);
      const d = raw ? new Date(Date.parse(raw)) : new Date();
      if (Number.isNaN(d.getTime())) return bad('Usage: weekday [date]');
      const name = d.toLocaleDateString('en-GB', { weekday: 'long' });
      return ok(`${name}\n${d.getDay() === 0 || d.getDay() === 6 ? 'Weekend.' : 'Weekday.'}`);
    } },

  { name: 'meetingpick', summary: 'Suggest meeting times', effect: 'find hours that suit several zones',
    fn: async (ctx) => {
      const zones = A(ctx).split(/\s+/).filter(Boolean);
      if (zones.length < 2) return bad('Usage: meetingpick <zone1> <zone2> [...]');
      const results: string[] = [];
      for (const start of [8, 9, 10, 13, 14, 15]) {
        const probe = new Date();
        probe.setUTCHours(start, 0, 0, 0);
        try {
          const times = zones.map((z) => `${z.split('/').pop()}: ${new Intl.DateTimeFormat('en-GB', { timeZone: z, hour: '2-digit', minute: '2-digit', hour12: false }).format(probe)}`);
          results.push(`UTC ${String(start).padStart(2, '0')}:00 — ${times.join(' | ')}`);
        } catch {
          return bad(`"${zones.find((z) => { try { new Intl.DateTimeFormat('en-GB', { timeZone: z }); return false; } catch { return true; } })}" is not a valid IANA zone.`);
        }
      }
      return ok(`Candidate slots for ${zones.length} zones:\n\n${results.join('\n')}`);
    } },

  /* ---- URL handling ---- */
  { name: 'urlparams', summary: 'List URL parameters', effect: 'show the query parameters of a URL',
    fn: async (ctx) => {
      const url = A(ctx);
      if (!url) return bad('Usage: urlparams <url>');
      try {
        const u = new URL(url);
        const entries = [...u.searchParams.entries()];
        if (!entries.length) return ok(`No query parameters.\n${u.protocol}//${u.host}${u.pathname}`);
        return ok(`${u.protocol}//${u.host}${u.pathname}\n\n${entries.map(([k, v]) => `${k} = ${v}`).join('\n')}`);
      } catch {
        return bad('That is not a valid absolute URL.');
      }
    } },

  { name: 'urlbuild', summary: 'Build a URL', effect: 'construct a URL from parts',
    fn: async (ctx) => {
      const m = A(ctx).match(/^(\S+?):\/\/([^/]+)(\S*)$/);
      if (!m) return bad('Usage: urlbuild <protocol>://<host>/<path>');
      return ok(`${m[1]}://${m[2]}${m[3]}`);
    } },

  { name: 'urlslug', summary: 'URL slug', effect: 'convert text into a URL slug',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: urlslug <text>');
      return ok(A(ctx).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'));
    } },

  { name: 'urlstrip', summary: 'Strip tracking parameters', effect: 'remove common tracking parameters from a URL',
    fn: async (ctx) => {
      const url = A(ctx);
      if (!url) return bad('Usage: urlstrip <url>');
      try {
        const u = new URL(url);
        const TRACKERS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
          'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src', 'yclid', '_ga', 'dclid'];
        let removed = 0;
        for (const key of TRACKERS) {
          if (u.searchParams.has(key)) { u.searchParams.delete(key); removed++; }
        }
        const cleaned = u.toString().replace(/\?$/, '');
        return ok(`${cleaned}\n\n${removed} tracking parameter${removed === 1 ? '' : 's'} removed.`);
      } catch {
        return bad('That is not a valid absolute URL.');
      }
    } },

  { name: 'urldomain', summary: 'Domain only', effect: 'extract the host from a URL',
    fn: async (ctx) => {
      try {
        return ok(new URL(A(ctx)).host);
      } catch {
        return bad('That is not a valid absolute URL.');
      }
    } },

  { name: 'urlshorten', summary: 'Shorten a URL locally', effect: 'produce a compact link form and report the saving',
    fn: async (ctx) => {
      const url = A(ctx);
      if (!url) return bad('Usage: urlshorten <url>');
      try {
        const u = new URL(url);
        u.hash = '';
        for (const key of [...u.searchParams.keys()]) {
          if (key.startsWith('utm_')) u.searchParams.delete(key);
        }
        const cleaned = u.toString();
        const saved = url.length - cleaned.length;
        return ok(`${cleaned}\n\n${saved >= 0 ? `${saved} characters saved` : `${-saved} characters longer`} after removing tracking parameters and the fragment.\n\nNote: this does not create a public short link. It cleans the URL; shortening it further needs a shortening service.`);
      } catch {
        return bad('That is not a valid absolute URL.');
      }
    } },
];

/** Random integer helper, kept local so this file has no shared mutable state. */
function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

/** Recursive spelling helper used by numwords. */
function numWords(n: number): string {
  const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${numWords(n % 100)}` : ''}`;
  return `${Math.floor(n / 1000)} thousand${n % 1000 ? ` ${numWords(n % 1000)}` : ''}`;
}

export function installAssistCommands(reg: {
  command(c: { name: string; summary: string; effect: string; family?: string; handler: (ctx: CommandContext) => Promise<CommandResult> }): unknown;
}): void {
  for (const c of assistCommands) {
    reg.command({
      name: c.name,
      summary: c.summary,
      effect: c.effect,
      family: 'assistant',
      handler: async (ctx: CommandContext): Promise<CommandResult> => {
        try {
          return await c.fn(ctx);
        } catch (err) {
          return bad(`${c.name}: ${(err as Error).message.slice(0, 180)}`);
        }
      },
    });
  }

  // Generated from the registry rather than written by hand. The hand-written
  // version of this list went stale twice within a single session — commands
  // were added and never appeared, and nothing noticed because it still
  // rendered happily. A test asserts every command is present.
  reg.command({
    name: 'assist',
    summary: 'Module D help',
    effect: 'list every registered assistant command grouped by purpose',
    family: 'assistant',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const registry = ctx.registry;
      const all = (registry?.list({ family: 'assistant' }) ?? assistCommands)
        .map((c) => c.name)
        .filter((n) => n !== 'assist');

      const GROUPS: ReadonlyArray<[string, RegExp]> = [
        ['Notes', /^note/],
        ['Tasks', /^todo/],
        ['Reminders', /^(remind|alarm)/],
        ['Snippets', /^snip/],
        ['QR codes', /^qr/],
        ['Markdown', /^(md|template)/],
        ['Time and dates', /^(epoch|timebetween|addtime|tzoffset|weeknumber|weekday|dateformat|agecalc)/],
        ['Time zones', /^(tzconvert|tznow|tzdiff|workinghours|meetingpick)/],
        ['Hashing', /^(sha|md5|random)/],
        ['Passwords', /^pw|leetsafe/],
        ['Encoding', /^(base64|url)/],
        ['Numbers', /^(numwords|gcd|lcm|factorial|percent|roman|hex|dechex|bin|avg|median|stddev|prime)/],
        ['Text', /^(charcount2|readingtime|titlecase2|sentencecase|wordorder|everyother|line|uniq|topwords|markdownlink)/],
      ];
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const [label, pattern] of GROUPS) {
        const names = all.filter((n) => !seen.has(n) && pattern.test(n)).sort();
        if (!names.length) continue;
        names.forEach((n) => seen.add(n));
        lines.push(`${label}:`);
        for (const n of names) lines.push(`  ${n}`);
        lines.push('');
      }
      const leftovers = all.filter((n) => !seen.has(n)).sort();
      if (leftovers.length) {
        lines.push('Other:');
        for (const n of leftovers) lines.push(`  ${n}`);
        lines.push('');
      }
      lines.push('Notes, tasks and snippets are private per user and stored locally.');
      return ok(lines.join('\n'));
    },
  });
}

export { dataPath as assistantDataPath };