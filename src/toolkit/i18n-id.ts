/**
 * Bahasa Indonesia catalogue.
 *
 * ## Register
 *
 * Standard, polite Bahasa Indonesia — the kind written in official documentation
 * and used in professional communication. Not street slang ("gaada", "nggak",
 * "banget", "dong") and not stiff translationese ("Berikut adalah hasil dari
 * permintaan Anda").
 *
 * Pronouns are kept consistently polite in this catalogue: **saya** for the bot,
 * **Anda** for the user. Earlier drafts mixed in "kamu" for warmth, which read as
 * too familiar for a tool someone is operating.
 *
 * ## What is deliberately not translated
 *
 * Command names, unit symbols, HTTP header names, and ISO codes stay as-is.
 * Translating `content-type` into `tipe-konten` helps nobody, and a command a
 * user must translate in their head defeats the purpose.
 *
 * ## Typography
 *
 * Emoji are used only where they carry meaning, never decoratively. A message
 * with three emoji in it is the clearest tell of generated text.
 */

export type IdLocale = 'id';

/**
 * The catalogue.
 *
 * Placeholders use `{name}` and are substituted by `t()`. A missing key falls
 * back to the key itself rather than rendering `undefined`.
 */
export const ID: Record<string, string> = {
  /* ── greeting / identity ───────────────────────────────────────────── */

  'greeting': 'Halo, saya Flux. Ada yang bisa saya bantu?',
  'greeting.short': 'Halo! Ada yang bisa saya bantu?',
  'help.intro': 'Flux siap digunakan. Ketik `flux help` untuk melihat daftar perintah.',
  'footer': '_made by Nyx_',
  'owner.label': 'Dibuat oleh',
  'role.label': 'Peran',

  /* ── usage ─────────────────────────────────────────────────────────── */

  'usage.generic': 'Format: {command} {args}',
  'usage.hint': 'Ketik `flux help` untuk melihat daftar lengkap.',
  'usage.noText': 'Silakan masukkan teks terlebih dahulu.',
  'usage.prompt': 'Contoh: `{example}`',

  /* ── dispatch ──────────────────────────────────────────────────────── */

  'prefix.required': 'Perintah ini memerlukan awalan `{prefix}`, jadi `{prefix} {token}`.',
  'prefix.legacy': 'Awalan `/` masih berfungsi, tetapi `{prefix}` yang standar.',
  'dispatch.empty': 'Perintah belum diisi. Silakan gunakan `{prefix} <perintah>`.',

  /* ── fuzzy ─────────────────────────────────────────────────────────── */

  'fuzzy.none': 'Perintah `{token}` tidak ada.',
  'fuzzy.noneHelp': 'Flux memiliki {count} perintah. Ketik `menu` atau `help` untuk melihat semuanya.',
  'fuzzy.head': 'Tidak ada perintah `{token}`. Perintah yang paling mirip:',
  'fuzzy.footer': 'Persentase menunjukkan seberapa mirip teksnya, bukan tingkat keyakinan. Silakan gunakan nama yang tepat.',
  'fuzzy.noClose': 'Perintah `{token}` tidak ditemukan, dan tidak ada perintah yang mirip.',

  /* ── errors ────────────────────────────────────────────────────────── */

  'error.unknown': 'Perintah `{token}` belum tersedia.',
  'error.badNumber': '`{value}` bukan angka yang valid.',
  'error.outOfRange': 'Nilai harus berada di antara {min} dan {max}.',
  'error.tooShort': 'Panjang masukan tidak sesuai untuk diproses.',
  'error.noPermission': 'Perintah ini hanya dapat digunakan oleh pemilik.',
  'error.rateLimited': 'Permintaan terlalu sering. Silakan tunggu {seconds} detik.',
  'error.busy': 'Sedang sibuk, silakan coba kembali sebentar lagi.',
  'error.failed': 'Gagal: {reason}',
  'error.notFound': 'Tidak ditemukan: {what}',
  'error.network': 'Koneksi ke server gagal. Silakan periksa koneksi Anda.',
  'error.timeout': 'Waktu proses habis sebelum selesai. Server mungkin sedang lambat.',

  /* ── families ──────────────────────────────────────────────────────── */

  'unit.unknown': 'Satuan `{unit}` tidak dikenal.',
  'unit.known': 'Satuan yang tersedia: {list}',
  'unit.mixedKinds': 'Harus menggunakan satu jenis satuan, misalnya kg ke lb atau C ke F.',
  'unit.usage': 'Format: convert <angka> <dari> ke <ke>',

  'calc.error': 'Tidak dapat menghitung: {reason}',
  'calc.divZero': 'Pembagian dengan nol tidak diperbolehkan.',
  'calc.negative': 'Akar kuadrat dari bilangan negatif.',
  'calc.unbalanced': 'Tanda kurung tidak berpasangan.',
  'calc.unknownName': '`{name}` bukan nama fungsi yang dikenal.',

  'hash.usage': 'Format: hash-{algo} <teks>',
  'api.timeout': '{label} melebihi batas waktu {seconds} detik.',
  'api.notJson': '{label} mengirim {kind}, bukan JSON.',
  'api.needKey': '{label} kini memerlukan API key.',
  'api.gone': '{label} sudah tidak tersedia (404).',
  'api.rateLimited': '{label} terkena pembatasan. Silakan coba kembali beberapa saat lagi.',

  'tz.unknown': 'Zona waktu `{zone}` tidak dikenal.',
  'tz.now': 'Waktu di {zone} saat ini {local} ({offset}).',

  'country.unknown': 'Negara `{name}` tidak ditemukan dalam daftar.',
  'color.unknown': 'Warna `{name}` tidak dikenal.',

  /* ── games ─────────────────────────────────────────────────────────── */

  'game.chainStart': 'Permainan dimulai. Kata pertama adalah **{word}**. Kata berikutnya harus diawali huruf **{letter}**.',
  'game.chainNext': 'Baik, **{word}**. Lanjutkan dengan huruf **{letter}**.',
  'game.chainRepeat': 'Kata **{word}** sudah pernah digunakan. Silakan pilih kata lain.',
  'game.chainLetter': 'Kata harus diawali huruf **{letter}**, bukan **{got}**.',
  'game.chainUnknown': 'Kata **{word}** tidak ada dalam daftar ini.',
  'game.chainRunning': 'Permainan sudah berjalan. Silakan balas dengan `chain <kata>`.',
  'game.chainNotStarted': 'Belum ada permainan yang berjalan. Mulailah dengan `wordchain`.',

  'game.mathStart': '**{problem} = ?**',
  'game.mathWrong': 'Jawaban belum benar. {problem} = ?',
  'game.mathRight': 'Benar! {problem} = {answer}',
  'game.mathRunning': 'Soal sudah dikeluarkan. Silakan jawab terlebih dahulu.',
  'game.mathNone': 'Belum ada soal. Mulailah dengan `mathduel`.',
  'game.winner': 'Pemenang: {user}',

  'game.rpsUsage': 'Format: rps <batu|kertas|gunting>',
  'game.rpsDraw': 'Seri.',
  'game.rpsWin': 'Anda menang.',
  'game.rpsLose': 'Bot menang.',

  'game.raffleUsage': 'Format: raffle <nama1>, <nama2>, <nama3>',
  'game.eightUsage': 'Format: eightball <pertanyaan>',

  'game.cooldown': 'Silakan tunggu {seconds} detik lagi.',
  'game.tooFast': 'Terlalu cepat. Mohon tunggu sebentar.',
};

/**
 * Substitute `{name}` placeholders.
 *
 * An unresolved placeholder is left visible rather than silently becoming
 * `undefined`, so a broken template is obvious instead of confusing.
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
 * `1234567.89` is written `1.234.567,89`. Reading the English form back as
 * Indonesian is off by a factor of a thousand, so this is not cosmetic.
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
 * Pronoun set.
 *
 * `formal: true` is the default across this catalogue. The `false` form exists
 * because a warmer register is occasionally correct for a game or a joke, and
 * it should be a deliberate choice at the call site rather than an accident of
 * which string a developer reached for first.
 */
export function pronoun(formal = true): { self: string; user: string } {
  return formal
    ? { self: 'saya', user: 'Anda' }
    : { self: 'saya', user: 'kamu' };
}