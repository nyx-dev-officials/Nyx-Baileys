/**
 * Bahasa Indonesia catalogue.
 *
 * ## Register
 *
 * Natural Indonesian, not translated Indonesian. The difference is visible:
 * machine output says "Silakan utilize fungsi ini" and "Berikut adalah hasil
 * dari permintaan Anda", which nobody types and everybody recognises as a
 * machine. Real usage is warmer and shorter — "pakai", "kayaknya", "udah",
 * "banget".
 *
 * The pronoun is not fixed. "Anda" in a greeting, "kamu" once the bot is being
 * genuinely helpful, and dropping the pronoun entirely in short replies, which
 * is what Indonesian actually does — pronouns are often implied. Forcing one
 * pronoun everywhere is what makes it read as stiff.
 *
 * ## What is deliberately not translated
 *
 * Command names, unit symbols, HTTP header names, ISO codes and anything a user
 * would paste elsewhere stay as-is. Translating `content-type` into "tipe-konten"
 * helps nobody.
 *
 * ## Emoji
 *
 * Used where they carry meaning, never decoratively. A wall of emoji is the
 * clearest tell of a generated message.
 */

export type IdLocale = 'id';

/**
 * The catalogue.
 *
 * Placeholders use `{name}` and are substituted by `t()`. A key with no entry
 * falls back to the supplied default rather than rendering the key itself.
 */
export const ID: Record<string, string> = {
  /* ── greeting / identity ───────────────────────────────────────────── */

  'greeting': 'Halo, saya Flux. Ada yang bisa dibantu?',
  'greeting.short': 'Halo! Ada yang bisa saya bantu?',
  'help.intro': 'Flux siap. Ketik `flux help` buat lihat semua perintah.',
  'footer': '_made by Nyx_',
  'owner.label': 'Pembuatnya',
  'role.label': 'Peran',

  /* ── usage ─────────────────────────────────────────────────────────── */

  'usage.generic': 'Format: {command} {args}',
  'usage.hint': 'Coba `flux help` buat daftar lengkap.',
  'usage.noText': 'Tulis sesuatu dulu, dong.',
  'usage.prompt': 'Contoh: `{example}`',

  /* ── dispatch ──────────────────────────────────────────────────────── */

  'prefix.required': 'Perintahnya perlu awalan `{prefix}`, jadi `{prefix} {token}`.',
  'prefix.legacy': 'Awalan `/` masih jalan, tapi `{prefix}` yang baku.',
  'dispatch.empty': 'Perintah belum ditulis. Coba `{prefix} <perintah>`.',

  /* ── fuzzy ─────────────────────────────────────────────────────────── */

  'fuzzy.none': 'Perintah `{token}` ga ada.',
  'fuzzy.noneHelp': 'Flux punya {count} perintah. Coba `{prefix} menu` buat lihat semuanya.',
  'fuzzy.head': 'Ga ada perintah `{token}`. Yang paling mirip:',
  'fuzzy.footer': 'Angkanya seberapa mirip teksnya, bukan tingkat keyakinan. Panggil ulang pakai nama yang persis.',
  'fuzzy.noClose': 'Ga ada perintah `{token}`, dan yang mirip juga ga ada.',

  /* ── errors ────────────────────────────────────────────────────────── */

  'error.unknown': 'Perintah `{token}` belum ada di Flux.',
  'error.badNumber': '`{value}` itu bukan angka.',
  'error.outOfRange': 'Harus antara {min} sampai {max}.',
  'error.tooShort': 'Inputnya kepanjangan atau kependekan buat diproses.',
  'error.noPermission': 'Perintah ini cuma buat owner.',
  'error.rateLimited': 'Terlalu cepat. Tunggu {seconds} detik lagi ya.',
  'error.busy': 'Sibuk bentar, coba lagi sebentar.',
  'error.failed': 'Gagal: {reason}',
  'error.notFound': 'Ga nemu: {what}',
  'error.network': 'Ga nyambung ke server. Cek koneksi dulu.',
  'error.timeout': 'Waktu habis sebelum selesai. Servernya kayanya lagi lambat.',

  /* ── families ──────────────────────────────────────────────────────── */

  'unit.unknown': 'Satuan `{unit}` ga dikenal.',
  'unit.known': 'Satuan yang bisa dipakai: {list}',
  'unit.mixedKinds': 'Harus satu jenis satuan, misal kg ke lb atau C ke F.',
  'unit.usage': 'Format: convert <angka> <dari> ke <ke>',

  'calc.error': 'Nggak bisa dihitung: {reason}',
  'calc.divZero': 'Pembagiannya nol, dong.',
  'calc.negative': 'Akar kuadrat dari angka negatif.',
  'calc.unbalanced': 'Kurung nya nggak berpasangan.',
  'calc.unknownName': '`{name}` bukan nama fungsi yang saya kenal.',

  'hash.usage': 'Format: hash-{algo} <teks>',
  'api.timeout': '{label} melebihi {seconds} detik.',
  'api.notJson': '{label} kirim {kind}, bukan JSON.',
  'api.needKey': '{label} sekarang butuh API key.',
  'api.gone': '{label} sudah nggak ada (404).',
  'api.rateLimited': '{label} kena rate limit. Sabar bentar ya.',

  'tz.unknown': 'Zona `{zone}` ga dikenal.',
  'tz.now': 'Waktu di {zone} sekarang {local} ({offset}).',

  'country.unknown': 'Negara `{name}` ga ada di daftar.',
  'color.unknown': 'Warna `{name}` ga ada.',

  /* ── games ─────────────────────────────────────────────────────────── */

  'game.chainStart': 'Sudah mulai! Kata pertama **{word}**. Kalau buat game kata, kata berikutnya harus diawali huruf **{letter}**.',
  'game.chainNext': 'Oke, **{word}**. Lanjut pakai huruf **{letter}**.',
  'game.chainRepeat': 'Kata **{word}** udah kepakai. Cari yang lain ya.',
  'game.chainLetter': 'Harus diawali huruf **{letter}**, bukan **{got}**.',
  'game.chainUnknown': 'Kata **{word}** nggak ada di daftar ini.',
  'game.chainRunning': 'Sudah ada yang jalan. Balas pakai `chain <kata>` dulu.',
  'game.chainNotStarted': 'Belum ada yang jalan. Mulai dulu pakai `wordchain`.',

  'game.mathStart': '**{problem} = ?**',
  'game.mathWrong': 'Belum benar. {problem} = ?',
  'game.mathRight': 'Benar! {problem} = {answer}',
  'game.mathRunning': 'Soalnya udah keluar. Jawab dulu yang itu.',
  'game.mathNone': 'Belum ada soal. Mulai pakai `mathduel`.',
  'game.winner': 'Menang: {user}',

  'game.rpsUsage': 'Format: rps <batu|kertas|gunting>',
  'game.rpsDraw': 'Seri.',
  'game.rpsWin': 'Kamu menang.',
  'game.rpsLose': 'Bot menang.',

  'game.raffleUsage': 'Format: raffle <nama1>, <nama2>, <nama3>',
  'game.eightUsage': 'Format: eightball <pertanyaan>',

  'game.cooldown': 'Tunggu {seconds} detik lagi ya.',
  'game.tooFast': 'Terlalu cepat. Sabar dikit.',
};

/**
 * Substitute `{name}` placeholders.
 *
 * A missing placeholder is left visible rather than silently becoming
 * "undefined" — a broken template should be obvious.
 */
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const template = ID[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    return v === undefined ? whole : String(v);
  });
}

/**
 * Number formatting for Indonesian locale.
 *
 * `1234567.89` is written `1.234.567,89` — thousands dot, decimal comma. Reading
 * the English form back in Indonesian is off by a factor of a thousand, so this
 * is not cosmetic.
 */
export function formatNumber(n: number, decimals = 2): string {
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(n);
}

/** Date and time in Indonesian locale. */
export function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(d);
}

/**
 * Pick the register.
 *
 * Off for greetings and for anything the user did not open warmly — "kamu" in a
 * system error reads as condescending, and "Anda" in a one-word reply reads as
 * stiff. So the choice follows the tone of the surrounding message.
 */
export function pronoun(formal: boolean): { self: string; user: string } {
  return formal
    ? { self: 'saya', user: 'Anda' }
    : { self: 'saya', user: 'kamu' };
}