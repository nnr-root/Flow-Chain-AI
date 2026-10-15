/*
 * npm run make:voices -- --hosted-candidates <language>: looks for the hosted service's voices native to a
 * language (its library, and the account's own voices), writes what it found to .superpowers/voices/<language>.json and
 * downloads each one's preview beside it, for choosing by ear and by measure (phase 5 spec §11). Reads only; it
 * buys nothing, but it is the owner's account: the owner's click.
 *
 * npm run make:voices -- --hosted-add <role> <language> <voiceId> [<publicOwnerId>] [--label <name>]: gives one of
 * the studio's voices that hosted voice in that language and writes it to assets/voices/elevenlabs.json. A library
 * voice speaks without being in the account; with its `publicOwnerId` it is added to the account first, which keeps
 * it for the notice its owner set should they withdraw it (the key needs the voices_write permission). Buys
 * nothing; the owner's click.
 *
 * npm run make:voices -- --hosted-keep: adds every library voice in the catalogue to the account, so that it is kept
 * for the notice its owner set should they withdraw it (library voices take none of the account's voice slots). The
 * key needs the voices_write permission. Safe to run again: a voice already in the account is left. Buys nothing;
 * changes the account: the owner's click.
 *
 * npm run make:voices -- --measure: measures every sample's speech, pauses taken out, and writes src/voice/rates.ts:
 * each language's rate (its narrators') and each voice's pace against them in each language (phase 7 spec §20).
 * Free: it reads the samples on disk. Run it after samples are made.
 *
 * npm run make:voices -- --design [<language> …]: makes every voice in every language natively (see `design`),
 * on the studio's voice engine, and keeps the clips in assets/voices/ and their samples on the form. **It buys
 * speech** (a few takes a voice and language) and sets the endpoint to four workers while it runs.
 *
 * npm run make:voices [-- <language> …]: makes the sample a person hears for each voice in each language on the
 * new-video form, on the studio's own voice engine. **It buys speech** (one line a voice and language, a
 * fraction of a cent each, and the engine's start): the owner's click, like every command that spends.
 *
 * A sample is the voice saying two sentences in that language, bought the way a video's narration is: so a
 * sample that is made is also proof that the engine speaks the language and that what it said was heard as
 * the line (a line that is not, is refused by the provider, as in a video). The samples are written to
 * web/public/voices/ and listed, with how long each took to say, in web/content/voice-samples.json: the form
 * reads which there are, and the length is what the words a second of each language were worked out from.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { RunpodRest } from "../src/deploy/runpod.js";
import { join } from "node:path";
import { type Env, loadEnv, loadPrices } from "../src/config.js";
import { ffmpeg, probeDuration } from "../src/media/ffmpeg.js";
import { createProviders } from "../src/providers/factory.js";
import { newRunProviders, newRunVoice } from "../src/providers/new-run.js";
import { runpodRates } from "../src/config.js";
import { RunpodClient } from "../src/providers/runpod.js";
import { heardShare } from "../src/voice/align.js";
import { pitchFits, TOO_ALIKE, voiceDistance, type VoiceFeatures, voiceFeatures } from "../src/voice/features.js";
import { BUILT_IN_VOICES, OWN_VOICE_IDS, type OwnVoiceId, SPEECH_LANGUAGES, type SpeechLanguage, VOICE_DESIGNS, type VoiceId, VOICES } from "../src/voice/language.js";
import { SERVICE_CODE } from "../src/providers/elevenlabs.js";
import { countUnits } from "../src/voice/words.js";
import { HOSTED_FILE, hostedCatalogue, hostedLanguages, hostedRoles, hostedVoice } from "../src/voice/hosted.js";
import { designedDir, designedVoices } from "../src/voice/library.js";

/** The same two sentences in every language: an opening, as a narrator would say one. */
export const SAMPLE_LINES: Record<SpeechLanguage, string> = {
  en: "Every great story begins with a single question. Stay with me for a moment, and I will show you how this one ends.",
  tr: "Her büyük hikâye tek bir soruyla başlar. Bir an benimle kalın, size bu hikâyenin nasıl bittiğini göstereyim.",
  es: "Toda gran historia empieza con una sola pregunta. Quédate conmigo un momento y te mostraré cómo termina esta.",
  fr: "Toute grande histoire commence par une seule question. Restez avec moi un instant, et je vous montrerai comment celle-ci se termine.",
  de: "Jede große Geschichte beginnt mit einer einzigen Frage. Bleiben Sie einen Moment bei mir, und ich zeige Ihnen, wie diese endet.",
  it: "Ogni grande storia comincia con una sola domanda. Resta con me un momento e ti mostrerò come finisce questa.",
  pt: "Toda grande história começa com uma única pergunta. Fique comigo por um momento e eu mostro como esta termina.",
  nl: "Elk groot verhaal begint met één enkele vraag. Blijf even bij me, dan laat ik je zien hoe dit verhaal afloopt.",
  pl: "Każda wielka historia zaczyna się od jednego pytania. Zostań ze mną na chwilę, a pokażę ci, jak kończy się ta.",
  ru: "Каждая великая история начинается с одного вопроса. Останьтесь со мной на минуту, и я покажу, чем закончится эта.",
  sv: "Varje stor berättelse börjar med en enda fråga. Stanna hos mig en stund, så visar jag hur den här slutar.",
  da: "Enhver stor historie begynder med et enkelt spørgsmål. Bliv hos mig et øjeblik, så viser jeg dig, hvordan denne ender.",
  no: "Enhver stor historie begynner med ett enkelt spørsmål. Bli hos meg et øyeblikk, så skal jeg vise deg hvordan denne ender.",
  fi: "Jokainen suuri tarina alkaa yhdestä kysymyksestä. Pysy hetki kanssani, niin näytän, miten tämä tarina päättyy.",
  el: "Κάθε μεγάλη ιστορία ξεκινά με μία μόνο ερώτηση. Μείνετε μαζί μου για λίγο και θα σας δείξω πώς τελειώνει αυτή.",
  id: "Setiap kisah besar dimulai dari satu pertanyaan. Tetaplah bersama saya sebentar, dan saya akan menunjukkan bagaimana kisah ini berakhir.",
  ms: "Setiap kisah hebat bermula dengan satu soalan. Tunggu bersama saya sebentar, dan saya akan tunjukkan bagaimana kisah ini berakhir.",
  tl: "Bawat dakilang kuwento ay nagsisimula sa iisang tanong. Samahan mo ako sandali, at ipapakita ko kung paano ito nagtatapos.",
  vi: "Mỗi câu chuyện lớn đều bắt đầu từ một câu hỏi. Hãy ở lại với tôi một chút, tôi sẽ cho bạn thấy câu chuyện này kết thúc thế nào.",
  bg: "Всяка голяма история започва с един-единствен въпрос. Остани с мен за момент и ще ти покажа как завършва тази.",
  ro: "Orice poveste mare începe cu o singură întrebare. Rămâi cu mine o clipă și îți voi arăta cum se termină aceasta.",
  cs: "Každý velký příběh začíná jedinou otázkou. Zůstaň chvíli se mnou a ukážu ti, jak tenhle skončí.",
  hr: "Svaka velika priča počinje jednim jedinim pitanjem. Ostani sa mnom na trenutak i pokazat ću ti kako ova završava.",
  sk: "Každý veľký príbeh sa začína jedinou otázkou. Zostaň chvíľu so mnou a ukážem ti, ako sa tento skončí.",
  uk: "Кожна велика історія починається з одного-єдиного запитання. Побудь зі мною хвилинку, і я покажу, чим закінчиться ця.",
  hu: "Minden nagy történet egyetlen kérdéssel kezdődik. Maradj velem egy pillanatra, és megmutatom, hogyan ér véget ez.",
  ja: "すべての偉大な物語は、ひとつの問いから始まります。少しだけ私と一緒にいてください。この物語がどう終わるのか、お見せします。",
  zh: "每一个伟大的故事，都始于一个问题。请陪我片刻，我会告诉你这个故事是如何结束的。",
  ko: "모든 위대한 이야기는 하나의 질문에서 시작됩니다. 잠시만 저와 함께해 주세요. 이 이야기가 어떻게 끝나는지 보여 드릴게요.",
  hi: "हर महान कहानी एक ही सवाल से शुरू होती है। एक पल मेरे साथ रहिए, और मैं आपको दिखाऊँगा कि यह कहानी कैसे ख़त्म होती है।",
  ar: "كل قصة عظيمة تبدأ بسؤال واحد. ابقَ معي للحظة، وسأريك كيف تنتهي هذه القصة.",
};

type Sample = { seconds: number; words: number };
type Listed = { madeOn: string | null; samples: Partial<Record<VoiceId, Partial<Record<SpeechLanguage, Sample>>>> };
const LIST = "web/content/voice-samples.json";

/** The voices there is something to hear of: the hosted ones chosen, else the worker's own and the designed ones. */
const readyVoices = (hosted: boolean): VoiceId[] =>
  hosted ? (hostedRoles().filter((v) => Object.hasOwn(VOICES, v)) as VoiceId[]) : [...BUILT_IN_VOICES, ...(designedVoices() as VoiceId[])];

/** A clip's sound as 16 kHz mono samples, for measuring it. */
async function samplesOf(file: string): Promise<Float32Array> {
  const { stdout } = await execa("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { encoding: "buffer", stripFinalNewline: false });
  const buf = Buffer.from(stdout);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

type Take = { file: string; features: VoiceFeatures; heard: number; seconds: number };

/**
 * Makes every voice in every language natively (phase 7 spec §16): for each voice and language without a clip,
 * a few takes from its description with different seeds, of which one is kept.
 * - In English, the take kept is the one furthest from every voice kept before it, of the voice's own sex: so
 *   that no two voices on the list are one voice in two moods.
 * - In another language, the take kept is the one nearest the voice's English clip that is not too near another
 *   voice in that language: the same voice as far as the model allows, speaking the language as its own.
 * A take whose line was not heard as written is never kept. The worker's own clips (the narrators' English and
 * Turkish) are measured and kept as they are. Several takes are made at once on several workers, which pays here
 * (hundreds of jobs; phase 7 spec §11), and the endpoint is put back to one worker afterwards.
 */
async function design(env: Env, asked: string[]): Promise<void> {
  const languages = (asked.length > 0 ? asked : Object.keys(SPEECH_LANGUAGES)) as SpeechLanguage[];
  const endpoint = env.RUNPOD_VOICE_ENDPOINT;
  if (!endpoint || !env.RUNPOD_API_KEY) throw new Error("RUNPOD_VOICE_ENDPOINT and RUNPOD_API_KEY must be set");
  const client = new RunpodClient(env.RUNPOD_API_KEY);
  const rate = runpodRates(loadPrices()).voiceUsdPerSec;
  const dir = designedDir();
  const listFile = join(dir, "voices.json");
  const list = JSON.parse(readFileSync(listFile, "utf8")) as Record<string, Record<string, string>>;
  const tmp = join(dir, "_takes");
  await mkdir(tmp, { recursive: true });
  let usd = 0;

  const take = async (voice: OwnVoiceId, language: SpeechLanguage, seed: number): Promise<Take | null> => {
    const line = SAMPLE_LINES[language];
    const id = await client.run(endpoint, { task: "design", workflow: "voice-voxcpm2@1", description: VOICE_DESIGNS[voice].description, text: line, language, seed }, { executionTimeout: 300_000, ttl: 3_600_000 }, new AbortController().signal);
    // Reading a job's state is safe to repeat, and RunPod now and then answers it with a server error: one such
    // answer ended a whole run of takes once, throwing away the ones already paid for. So it is asked again.
    const status = async () => {
      for (let tries = 0; ; tries++) {
        try {
          return await client.status(endpoint, id);
        } catch (err) {
          if (tries >= 10) throw err;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    let job = await status();
    while (job && !["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(job.status)) {
      await new Promise((r) => setTimeout(r, 2000));
      job = await status();
    }
    usd += job?.executionTime ? (job.executionTime / 1000) * rate : 0;
    const out = job?.output as { audio?: string; words?: Array<{ text: string; start: number; end: number }>; seconds?: number } | undefined;
    if (job?.status !== "COMPLETED" || !out?.audio) return null;
    const file = join(tmp, `${voice}.${language}.${seed}.flac`);
    await writeFile(file, Buffer.from(out.audio, "base64"));
    return { file, features: voiceFeatures(await samplesOf(file)), heard: heardShare(line, out.words ?? []), seconds: out.seconds ?? 0 };
  };
  /** Runs jobs four at a time. */
  const pool = async <T>(jobs: Array<() => Promise<T>>): Promise<T[]> => {
    const out: T[] = new Array(jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }));
    return out;
  };
  const keep = async (voice: OwnVoiceId, language: SpeechLanguage, chosen: Take) => {
    await rename(chosen.file, join(dir, `${voice}.${language}.flac`));
    (list[voice] ??= {})[language] = SAMPLE_LINES[language];
    await writeFile(listFile, `${JSON.stringify(list, null, 2)}\n`);
    // its sample on the form is the clip itself
    await mkdir("web/public/voices", { recursive: true });
    await ffmpeg(["-i", join(dir, `${voice}.${language}.flac`), "-ac", "1", "-b:a", "64k", join("web/public/voices", `${voice}.${language}.mp3`)]);
    const samples = existsSync(LIST) ? (JSON.parse(readFileSync(LIST, "utf8")) as Listed) : { madeOn: null, samples: {} };
    (samples.samples[voice] ??= {})[language] = { seconds: Math.round(chosen.seconds * 100) / 100, words: SAMPLE_LINES[language].split(/\s+/).filter(Boolean).length };
    samples.madeOn = new Date().toISOString().slice(0, 10);
    await writeFile(LIST, `${JSON.stringify(samples, null, 2)}\n`);
  };
  /** What each voice sounds like in a language, as far as it has been kept. */
  const keptIn = async (language: SpeechLanguage): Promise<Map<OwnVoiceId, VoiceFeatures>> => {
    const kept = new Map<OwnVoiceId, VoiceFeatures>();
    for (const voice of OWN_VOICE_IDS) {
      const own = BUILT_IN_VOICES.includes(voice) && ["en", "tr"].includes(language) ? join("worker-voice/voices", `${voice}.${language}.flac`) : join(dir, `${voice}.${language}.flac`);
      if (existsSync(own)) kept.set(voice, voiceFeatures(await samplesOf(own)));
    }
    return kept;
  };

  const rest = new RunpodRest(env.RUNPOD_API_KEY);
  const before = (await rest.list("endpoints")).find((e) => e.id === endpoint) as { workersMax?: number } | undefined;
  await rest.update("endpoints", endpoint, { workersMax: 4 });
  try {
    for (const language of (["en", ...languages.filter((l) => l !== "en")] as SpeechLanguage[]).filter((l) => languages.includes(l))) {
      const kept = await keptIn(language);
      const english = language === "en" ? null : await keptIn("en");
      const wanted = OWN_VOICE_IDS.filter((v) => !kept.has(v));
      if (wanted.length === 0) continue;
      // Takes are made in rounds: a voice is kept from the first round that has a take fitting it, and the voices
      // with none get another round of new seeds, up to four. A take fits when its line was heard, its pitch is
      // that of the sex the voice was described as, and it is not too near a voice kept already in the language.
      let left = wanted;
      for (let round = 0; round < 4 && left.length > 0; round++) {
        const seeds = (language === "en" && round === 0 ? [11, 23, 37, 53] : [11, 29]).map((s) => s + round * 101);
        const takes = await pool(left.flatMap((voice) => seeds.map((seed) => async () => ({ voice, take: await take(voice, language, seed + language.charCodeAt(0) * 1000 + language.charCodeAt(1)) }))));
        const still: OwnVoiceId[] = [];
        for (const voice of left) {
          const nearestOther = (t: Take) => Math.min(Infinity, ...[...kept.entries()].filter(([v]) => v !== voice).map(([, f]) => voiceDistance(t.features, f)));
          const target = english?.get(voice);
          const fits = takes
            .filter((t) => t.voice === voice && t.take && t.take.heard >= 0.8 && pitchFits(t.take.features, VOICE_DESIGNS[voice].sex) && nearestOther(t.take) >= TOO_ALIKE)
            .map((t) => t.take!);
          if (fits.length === 0) {
            // what each take was, so that a voice that is never kept says why
            const why = takes.filter((t) => t.voice === voice).map((t) => (t.take ? `${Math.round(t.take.features.f0)} Hz, ${Math.round(t.take.heard * 100)}% heard, ${nearestOther(t.take).toFixed(2)} apart` : "no take"));
            console.log(`${language} ${voice}: round ${round + 1} had no take that fits (${why.join("; ")})`);
            still.push(voice);
            continue;
          }
          // in English the one furthest from the others; in another language the one nearest its English voice
          const score = (t: Take) => (target ? voiceDistance(t.features, target) : -nearestOther(t));
          const chosen = fits.sort((x, y) => score(x) - score(y))[0];
          await keep(voice, language, chosen);
          kept.set(voice, chosen.features);
          console.log(`${language} ${voice}: kept in round ${round + 1} (${Math.round(chosen.features.f0)} Hz, ${nearestOther(chosen).toFixed(2)} from the nearest other voice${target ? `, ${voiceDistance(chosen.features, target).toFixed(2)} from its English voice` : ""})`);
        }
        left = still;
      }
      for (const voice of left) console.log(`${language} ${voice}: NOT KEPT (no take fitted it in four rounds)`);
    }
  } finally {
    await rest.update("endpoints", endpoint, { workersMax: before?.workersMax ?? 1 });
    await rm(tmp, { recursive: true, force: true });
  }
  console.log(`designing cost about $${usd.toFixed(4)}`);
}

const HOSTED_API = (): string => process.env.ELEVENLABS_API_BASE ?? "https://api.elevenlabs.io";

async function hosted<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY must be set");
  const res = await fetch(`${HOSTED_API()}${path}`, { ...init, headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json", ...init.headers } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

type Candidate = {
  voiceId: string;
  publicOwnerId?: string;
  name: string;
  gender?: string;
  age?: string;
  accent?: string;
  description?: string;
  useCase?: string;
  /** How much it has been used across the service in a year: a voice many use is one that has held up. */
  usage?: number;
  preview?: string;
  source: "account" | "library";
  /** The language the library has it as its own (a voice may also be verified in others, with its own accent). */
  nativeLanguage?: string;
};

/**
 * The hosted voices native to a language, with what is said of each and its preview: the library's (by use, most
 * used first) and the account's own. Nothing is bought; the previews are the service's own files.
 */
async function hostedCandidates(env: Env, language: string | undefined, pages = 3): Promise<void> {
  if (!language || !Object.hasOwn(SPEECH_LANGUAGES, language)) throw new Error(`say a language: one of ${Object.keys(SPEECH_LANGUAGES).join(", ")}`);
  const found: Candidate[] = [];
  for (let page = 0; page < pages; page++) {
    const got = await hosted<{ voices: Array<Record<string, unknown>>; has_more: boolean }>(
      env,
      `/v1/shared-voices?page_size=100&page=${page}&language=${SERVICE_CODE[language] ?? language}&sort=usage_character_count_1y`,
    );
    for (const v of got.voices) {
      found.push({
        voiceId: String(v.voice_id), publicOwnerId: String(v.public_owner_id), name: String(v.name),
        gender: v.gender as string | undefined, age: v.age as string | undefined, accent: v.accent as string | undefined,
        description: v.description as string | undefined, useCase: v.use_case as string | undefined,
        // its preview in this language where it has one: a voice's own preview is often in English, which says nothing of how it speaks this one
        usage: v.usage_character_count_1y as number | undefined, source: "library", nativeLanguage: v.language as string | undefined,
        preview: ((v.verified_languages as Array<{ language: string; preview_url?: string }> | undefined)?.find((x) => x.language === (SERVICE_CODE[language] ?? language) && x.preview_url)?.preview_url) ?? (v.preview_url as string | undefined),
      });
    }
    if (!got.has_more) break;
  }
  if (language === "en") {
    const own = await hosted<{ voices: Array<{ voice_id: string; name: string; category?: string; labels?: Record<string, string>; preview_url?: string; description?: string }> }>(env, "/v1/voices");
    for (const v of own.voices) {
      found.push({
        voiceId: v.voice_id, name: v.name, gender: v.labels?.gender, age: v.labels?.age, accent: v.labels?.accent,
        description: v.labels?.description ?? v.description, useCase: v.labels?.use_case, preview: v.preview_url, source: "account",
      });
    }
  }
  const dir = join(".superpowers/voices", language);
  await mkdir(dir, { recursive: true });
  let previews = 0;
  // eight at a time: one after another, a hundred previews took five minutes
  const wanted = found.filter((c) => c.preview && !existsSync(join(dir, `${c.voiceId}.mp3`)));
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let c = wanted.shift(); c; c = wanted.shift()) {
      const res = await fetch(c.preview!).catch(() => null);
      if (!res?.ok) continue;
      await writeFile(join(dir, `${c.voiceId}.mp3`), Buffer.from(await res.arrayBuffer()));
      previews++;
    }
  }));
  await writeFile(join(".superpowers/voices", `${language}.json`), `${JSON.stringify(found, null, 2)}\n`);
  console.log(`${found.length} candidate(s) for ${language}, ${previews} preview(s) downloaded, in .superpowers/voices/`);
}

/**
 * What the form calls a hosted voice and says of it: the first name its owner gave it ("Frederick Surrey - Smooth
 * and Velvety" is Frederick), unless one is given, and its sex, age and, in English, accent, from the service's
 * labels. Pure, for a test.
 */
export function shownAs(name: string, labels: Record<string, string | undefined>, language: string, label?: string): { label: string; about?: string } {
  const first = name.split(/\s+[-–]\s+|[-–]/)[0].trim().split(/\s+/)[0];
  const word = (w?: string) => (w ? w.replace(/[_-]+/g, " ").trim() : "");
  const parts = [word(labels.gender), language === "en" ? word(labels.accent) : "", word(labels.age)].filter(Boolean);
  const about = parts.length ? parts.map((p, i) => (i === 0 ? p[0].toUpperCase() + p.slice(1) : p)).join(", ").replace(/\bamerican\b/, "American").replace(/\bbritish\b/, "British").replace(/\baustralian\b/, "Australian") : undefined;
  return { label: (label ?? first).slice(0, 24), ...(about ? { about: about.slice(0, 60) } : {}) };
}

/** Gives one of the studio's voices a hosted voice in a language, adding a library voice to the account first. */
async function hostedAdd(env: Env, args: string[]): Promise<void> {
  const at = args.indexOf("--label");
  const label = at >= 0 ? args[at + 1] : undefined;
  const [role, language, voiceId, publicOwnerId] = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
  if (!role || !Object.hasOwn(VOICES, role)) throw new Error(`say which voice: one of ${Object.keys(VOICES).join(", ")}`);
  if (!language || !Object.hasOwn(SPEECH_LANGUAGES, language)) throw new Error(`say a language: one of ${Object.keys(SPEECH_LANGUAGES).join(", ")}`);
  if (!voiceId || !/^[A-Za-z0-9]{8,40}$/.test(voiceId)) throw new Error("say the hosted voice's id");
  let id = voiceId;
  if (publicOwnerId) {
    // a library voice is used through the account: added once, under a name that says what it is for here
    const added = await hosted<{ voice_id: string }>(env, `/v1/voices/add/${encodeURIComponent(publicOwnerId)}/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      body: JSON.stringify({ new_name: `flowchain ${role} ${language}` }),
    });
    id = added.voice_id;
  }
  // What it is called and how it sounds: as the library shared it, where it came from there (a library voice
  // speaks without being in the account, and the account does not know it then), else as the account has it.
  const shared = JSON.parse(existsSync(join(".superpowers/voices", `${language}.json`)) ? readFileSync(join(".superpowers/voices", `${language}.json`), "utf8") : "[]") as Candidate[];
  const original = shared.find((c) => c.voiceId === voiceId);
  const voice = original && !publicOwnerId ? { name: original.name, labels: {} as Record<string, string> } : await hosted<{ name: string; labels?: Record<string, string> }>(env, `/v1/voices/${encodeURIComponent(id)}`);
  const name = original?.name ?? voice.name;
  const labels = { gender: original?.gender ?? voice.labels?.gender, age: original?.age ?? voice.labels?.age, accent: original?.accent ?? voice.labels?.accent };
  const shown = shownAs(name, labels, language, label);
  const catalogue = hostedCatalogue();
  (catalogue.voices[role] ??= {})[language] = { id, name, ...shown };
  await writeFile(join(designedDir(), HOSTED_FILE), `${JSON.stringify(catalogue, null, 2)}\n`);
  console.log(`${role} in ${language}: ${shown.label}${shown.about ? ` (${shown.about})` : ""} — ${name} (${id})`);
}

/** Adds every library voice of the catalogue to the account (see the head of this file). */
async function hostedKeep(env: Env): Promise<void> {
  // who shared each voice: the library said so when it was found (.superpowers/voices/<language>.json)
  const owners = new Map<string, string>();
  for (const f of existsSync(".superpowers/voices") ? readdirSync(".superpowers/voices").filter((f) => f.endsWith(".json")) : []) {
    for (const c of JSON.parse(readFileSync(join(".superpowers/voices", f), "utf8")) as Candidate[]) if (c.publicOwnerId) owners.set(c.voiceId, c.publicOwnerId);
  }
  const mine = new Set((await hosted<{ voices: Array<{ voice_id: string }> }>(env, "/v1/voices")).voices.map((v) => v.voice_id));
  const catalogue = hostedCatalogue();
  let added = 0;
  const unknown: string[] = [];
  for (const [role, by] of Object.entries(catalogue.voices)) {
    for (const [language, entry] of Object.entries(by)) {
      if (mine.has(entry.id)) continue;
      const owner = owners.get(entry.id);
      // (the service's own voices are the account's already; one found nowhere is said, not guessed at)
      if (!owner) {
        unknown.push(`${role}.${language}`);
        continue;
      }
      const got = await hosted<{ voice_id: string }>(env, `/v1/voices/add/${encodeURIComponent(owner)}/${encodeURIComponent(entry.id)}`, {
        method: "POST",
        body: JSON.stringify({ new_name: `flowchain ${role} ${language}` }),
      });
      // a voice that comes back under another id is that id from now on (a voice chosen again is another voice)
      if (got.voice_id !== entry.id) entry.id = got.voice_id;
      mine.add(got.voice_id);
      added++;
      await writeFile(join(designedDir(), HOSTED_FILE), `${JSON.stringify(catalogue, null, 2)}\n`);
    }
  }
  console.log(`${added} voice(s) added to the account${unknown.length ? `; not found in the library lists: ${unknown.join(", ")}` : ""}`);
}

/**
 * How long a sample speaks, its pauses taken out: what a video's lines are once their silence is trimmed. Silence is
 * what is 35 dB under the sample's own loudest: some voices are recorded far quieter than others (a whispering one
 * peaked at -29 dB), and a fixed threshold took most of their speech for silence.
 */
async function speechSeconds(file: string): Promise<number> {
  const probe = await execa("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { reject: false });
  const peak = Number(/max_volume: (-?[\d.]+) dB/.exec(String(probe.stderr))?.[1] ?? 0);
  const { stdout } = await execa("ffmpeg", ["-v", "error", "-i", file, "-af", `silenceremove=stop_periods=-1:stop_duration=0.15:stop_threshold=${Math.round(peak - 35)}dB`, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { encoding: "buffer" });
  return Buffer.from(stdout).byteLength / 4 / 16000;
}

/** Writes src/voice/rates.ts from the samples (see the head of this file). */
async function measure(ratesOnly = false): Promise<void> {
  const listed = existsSync(LIST) ? (JSON.parse(readFileSync(LIST, "utf8")) as Listed) : { madeOn: null, samples: {} };
  const rate: Record<string, Record<string, number>> = {};
  for (const [voice, by] of Object.entries(listed.samples)) {
    for (const language of Object.keys(by ?? {}) as SpeechLanguage[]) {
      const file = join("web/public/voices", `${voice}.${language}.mp3`);
      if (!existsSync(file) || !SAMPLE_LINES[language]) continue;
      (rate[voice] ??= {})[language] = countUnits(SAMPLE_LINES[language], language) / (await speechSeconds(file));
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const narrators: Record<string, number> = {};
  for (const language of Object.keys(SPEECH_LANGUAGES)) {
    const [m, f] = [rate["narrator-m"]?.[language], rate["narrator-f"]?.[language]];
    if (m && f) narrators[language] = round((m + f) / 2);
  }
  const pace: Record<string, Record<string, number>> = {};
  for (const [voice, by] of Object.entries(rate)) {
    for (const [language, r] of Object.entries(by)) {
      const p = narrators[language] ? round(r / narrators[language]) : 1;
      // (within a twentieth of the narrators is the narrators' pace)
      if (Math.abs(p - 1) >= 0.05) (pace[voice] ??= {})[language] = p;
    }
  }
  // --rates-only: the narrators' rates again, the voices' paces as they were (when only the narrators' samples were
  // made again, as when the model changed: the paces are each voice against the narrators in the same model)
  if (ratesOnly) {
    const { VOICE_PACE } = await import("../src/voice/rates.js");
    for (const k of Object.keys(pace)) delete pace[k];
    Object.assign(pace, VOICE_PACE);
  }
  const body = [
    `// Written by \`npm run make:voices -- --measure\` on ${new Date().toISOString().slice(0, 10)} from the samples in web/public/voices`,
    "// (phase 7 spec §20). Do not edit by hand: make the samples again and measure.",
    "",
    "/** The narrators' speech in each language, pauses taken out: words a second (characters in Chinese and Japanese). */",
    `export const SPEECH_RATE: Readonly<Record<string, number>> = ${JSON.stringify(narrators)};`,
    "",
    "/** How fast each voice speaks against the narrators, language by language, where it differs by a twentieth or more. */",
    `export const VOICE_PACE: Readonly<Record<string, Readonly<Record<string, number>>>> = ${JSON.stringify(pace)};`,
    "",
  ].join("\n");
  await writeFile("src/voice/rates.ts", body);
  console.log(`rates of ${Object.keys(narrators).length} languages and the paces of ${Object.keys(pace).length} voices written to src/voice/rates.ts`);
}

async function main(): Promise<void> {
  // (measuring reads only the samples: it needs no key)
  if (process.argv[2] === "--measure") return measure(process.argv.includes("--rates-only"));
  process.loadEnvFile(".env");
  const env = loadEnv();
  if (process.argv[2] === "--design") return design(env, process.argv.slice(3));
  // (a third word: how many hundreds of the most used to look at; three by default)
  if (process.argv[2] === "--hosted-candidates") return hostedCandidates(env, process.argv[3], process.argv[4] ? Number(process.argv[4]) : undefined);
  if (process.argv[2] === "--hosted-add") return hostedAdd(env, process.argv.slice(3));
  if (process.argv[2] === "--hosted-keep") return hostedKeep(env);
  // --again: make the samples that are there again (they were made by another voice or model)
  const again = process.argv.includes("--again");
  // --voices a,b: only these voices' samples
  const at = process.argv.indexOf("--voices");
  const only = at >= 0 ? new Set(process.argv[at + 1]?.split(",")) : null;
  const asked = process.argv.slice(2).filter((a, i, all) => a !== "--again" && a !== "--voices" && all[i - 1] !== "--voices");
  const unknown = asked.filter((l) => !Object.hasOwn(SPEECH_LANGUAGES, l));
  if (unknown.length > 0) throw new Error(`no such language: ${unknown.join(", ")} (the languages are ${Object.keys(SPEECH_LANGUAGES).join(", ")})`);
  const languages = (asked.length > 0 ? asked : Object.keys(SPEECH_LANGUAGES)) as SpeechLanguage[];
  const chosen = newRunProviders(env, "480p");
  const hosted = !newRunVoice(env).model.startsWith("runpod:");
  // each language in the model that speaks it, as a run in it would be (phase 5 spec §11)
  const ttsFor = (language: SpeechLanguage) => createProviders(env, { llm: env.GEMINI_MODEL, tts: newRunVoice(env, language).model, image: chosen.image, video: chosen.video }, loadPrices()).tts;
  const outDir = "web/public/voices";
  await mkdir(outDir, { recursive: true });
  const listed: Listed = existsSync(LIST) ? (JSON.parse(readFileSync(LIST, "utf8")) as Listed) : { madeOn: null, samples: {} };
  let usd = 0;
  const failed: string[] = [];
  let made = 0;
  for (const language of languages) {
    for (const voice of readyVoices(hosted)) {
      if (only && !only.has(voice)) continue;
      // A hosted voice is heard in the languages it has a voice chosen in, and the narrators in every language
      // (the form offers them where no voice is native, in their English voice).
      if (hosted && !hostedLanguages(voice).includes(language) && !(BUILT_IN_VOICES as readonly string[]).includes(voice)) continue;
      const text = SAMPLE_LINES[language];
      // a sample that is there is not bought again (delete it from the list, or say --again, to make it again)
      if (!again && listed.samples[voice]?.[language] && existsSync(join(outDir, `${voice}.${language}.mp3`))) continue;
      try {
        const said = await ttsFor(language).speak({ text, voiceId: hosted ? hostedVoice(voice, language)! : voice, language });
        const raw = join(outDir, `_${voice}.${language}.raw`);
        await writeFile(raw, said.audio);
        const file = join(outDir, `${voice}.${language}.mp3`);
        await ffmpeg(["-i", raw, "-ac", "1", "-b:a", "64k", file]);
        await rm(raw, { force: true });
        const seconds = Math.round((await probeDuration(file)) * 100) / 100;
        // (in characters for Chinese and Japanese, as their scripts are counted)
        const words = countUnits(text, language);
        (listed.samples[voice] ??= {})[language] = { seconds, words };
        usd += said.costUsd ?? 0;
        made++;
        console.log(`${language} ${voice}: ${seconds} s for ${words} words (${(words / seconds).toFixed(2)} a second)`);
      } catch (err) {
        failed.push(`${language} ${voice}`);
        console.log(`${language} ${voice}: NOT MADE: ${err instanceof Error ? err.message : String(err)}`);
      }
      // (written after every line: a run that stops half-way has listed what it made)
      listed.madeOn = new Date().toISOString().slice(0, 10);
      await writeFile(LIST, `${JSON.stringify(listed, null, 2)}\n`);
    }
  }
  // (the ones that were there already are not counted: they were not made)
  console.log(`${made} sample(s) made for about $${usd.toFixed(4)}${failed.length > 0 ? `; not made: ${failed.join(", ")}` : ""}.`);
}

// (imported by a test for the lines alone: only run as a command does it buy anything)
if (process.argv[1]?.endsWith("make-voices.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
