/*
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
import { existsSync, readFileSync } from "node:fs";
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
import { BUILT_IN_VOICES, SPEECH_LANGUAGES, type SpeechLanguage, VOICE_DESIGNS, type VoiceId, VOICES } from "../src/voice/language.js";
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
  sw: "Kila hadithi kubwa huanza na swali moja. Kaa nami kwa muda, nami nitakuonyesha jinsi hii inavyoisha.",
  vi: "Mỗi câu chuyện lớn đều bắt đầu từ một câu hỏi. Hãy ở lại với tôi một chút, tôi sẽ cho bạn thấy câu chuyện này kết thúc thế nào.",
};

type Sample = { seconds: number; words: number };
type Listed = { madeOn: string | null; samples: Partial<Record<VoiceId, Partial<Record<SpeechLanguage, Sample>>>> };
const LIST = "web/content/voice-samples.json";

/** The voices there is something to hear of: the worker's own and the designed ones that have a clip. */
const readyVoices = (): VoiceId[] => [...BUILT_IN_VOICES, ...(designedVoices() as VoiceId[])];

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

  const take = async (voice: VoiceId, language: SpeechLanguage, seed: number): Promise<Take | null> => {
    const line = SAMPLE_LINES[language];
    const id = await client.run(endpoint, { task: "design", workflow: "voice-voxcpm2@1", description: VOICE_DESIGNS[voice].description, text: line, language, seed }, { executionTimeout: 300_000, ttl: 3_600_000 }, new AbortController().signal);
    let job = await client.status(endpoint, id);
    while (job && !["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(job.status)) {
      await new Promise((r) => setTimeout(r, 2000));
      job = await client.status(endpoint, id);
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
  const keep = async (voice: VoiceId, language: SpeechLanguage, chosen: Take) => {
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
  const keptIn = async (language: SpeechLanguage): Promise<Map<VoiceId, VoiceFeatures>> => {
    const kept = new Map<VoiceId, VoiceFeatures>();
    for (const voice of Object.keys(VOICES) as VoiceId[]) {
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
      const wanted = (Object.keys(VOICES) as VoiceId[]).filter((v) => !kept.has(v));
      if (wanted.length === 0) continue;
      const seeds = language === "en" ? [11, 23, 37, 53] : [11, 29];
      const takes = await pool(wanted.flatMap((voice) => seeds.map((seed) => async () => ({ voice, take: await take(voice, language, seed + language.charCodeAt(0) * 1000 + language.charCodeAt(1)) }))));
      for (const voice of wanted) {
        const usable = takes.filter((t) => t.voice === voice && t.take && t.take.heard >= 0.8).map((t) => t.take!);
        if (usable.length === 0) {
          console.log(`${language} ${voice}: NOT KEPT (no take said its line)`);
          continue;
        }
        const nearestOther = (t: Take) => Math.min(Infinity, ...[...kept.values()].map((f) => voiceDistance(t.features, f)));
        const sexFits = (t: Take) => (pitchFits(t.features, VOICE_DESIGNS[voice].sex) ? 0 : 2);
        const target = english?.get(voice);
        const score = (t: Take) =>
          target
            ? voiceDistance(t.features, target) + sexFits(t) + (nearestOther(t) < TOO_ALIKE ? 3 : 0)
            : -nearestOther(t) + sexFits(t);
        const chosen = usable.sort((x, y) => score(x) - score(y))[0];
        await keep(voice, language, chosen);
        kept.set(voice, chosen.features);
        const apart = nearestOther(chosen);
        console.log(`${language} ${voice}: kept (${Math.round(chosen.features.f0)} Hz${target ? `, ${voiceDistance(chosen.features, target).toFixed(2)} from its English voice` : ""}${Number.isFinite(apart) && apart < TOO_ALIKE ? `; CLOSE to another voice (${apart.toFixed(2)})` : ""})`);
      }
    }
  } finally {
    await rest.update("endpoints", endpoint, { workersMax: before?.workersMax ?? 1 });
    await rm(tmp, { recursive: true, force: true });
  }
  console.log(`designing cost about $${usd.toFixed(4)}`);
}

async function main(): Promise<void> {
  process.loadEnvFile(".env");
  const env = loadEnv();
  if (process.argv[2] === "--design") return design(env, process.argv.slice(3));
  const asked = process.argv.slice(2);
  const unknown = asked.filter((l) => !Object.hasOwn(SPEECH_LANGUAGES, l));
  if (unknown.length > 0) throw new Error(`no such language: ${unknown.join(", ")} (the languages are ${Object.keys(SPEECH_LANGUAGES).join(", ")})`);
  const languages = (asked.length > 0 ? asked : Object.keys(SPEECH_LANGUAGES)) as SpeechLanguage[];
  const chosen = newRunProviders(env, "480p");
  const { tts } = createProviders(env, { llm: env.GEMINI_MODEL, tts: newRunVoice(env).model, image: chosen.image, video: chosen.video }, loadPrices());
  const outDir = "web/public/voices";
  await mkdir(outDir, { recursive: true });
  const listed: Listed = existsSync(LIST) ? (JSON.parse(readFileSync(LIST, "utf8")) as Listed) : { madeOn: null, samples: {} };
  let usd = 0;
  const failed: string[] = [];
  for (const language of languages) {
    for (const voice of readyVoices()) {
      const text = SAMPLE_LINES[language];
      // a sample that is there is not bought again (delete it from the list to make it again)
      if (listed.samples[voice]?.[language] && existsSync(join(outDir, `${voice}.${language}.mp3`))) continue;
      try {
        const said = await tts.speak({ text, voiceId: voice, language });
        const raw = join(outDir, `_${voice}.${language}.raw`);
        await writeFile(raw, said.audio);
        const file = join(outDir, `${voice}.${language}.mp3`);
        await ffmpeg(["-i", raw, "-ac", "1", "-b:a", "64k", file]);
        await rm(raw, { force: true });
        const seconds = Math.round((await probeDuration(file)) * 100) / 100;
        const words = text.split(/\s+/).filter(Boolean).length;
        (listed.samples[voice] ??= {})[language] = { seconds, words };
        usd += said.costUsd ?? 0;
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
  console.log(`${languages.length * readyVoices().length - failed.length} sample(s) made for about $${usd.toFixed(4)}${failed.length > 0 ? `; not made: ${failed.join(", ")}` : ""}.`);
}

// (imported by a test for the lines alone: only run as a command does it buy anything)
if (process.argv[1]?.endsWith("make-voices.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
