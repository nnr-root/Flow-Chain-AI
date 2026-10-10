/*
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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnv, loadPrices } from "../src/config.js";
import { ffmpeg, probeDuration } from "../src/media/ffmpeg.js";
import { createProviders } from "../src/providers/factory.js";
import { newRunProviders, newRunVoice } from "../src/providers/new-run.js";
import { SPEECH_LANGUAGES, type SpeechLanguage, type VoiceId, VOICES } from "../src/voice/language.js";

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

async function main(): Promise<void> {
  process.loadEnvFile(".env");
  const env = loadEnv();
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
    for (const voice of Object.keys(VOICES) as VoiceId[]) {
      const text = SAMPLE_LINES[language];
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
  console.log(`${languages.length * Object.keys(VOICES).length - failed.length} sample(s) made for about $${usd.toFixed(4)}${failed.length > 0 ? `; not made: ${failed.join(", ")}` : ""}.`);
}

// (imported by a test for the lines alone: only run as a command does it buy anything)
if (process.argv[1]?.endsWith("make-voices.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
