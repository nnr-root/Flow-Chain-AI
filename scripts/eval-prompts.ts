/**
 * npm run eval:prompts -- --cap <usd> [--repeats 3] [--cases a,b] [--no-judge] [--save-baseline]
 *
 * THE OWNER'S COMMAND. It calls the real model and spends money (phase 9 spec §6); an agent never runs it.
 * The key and the model are read from the shell environment, never from .env; pass both, or the eval may measure another model than the studio uses. For example:
 *   GEMINI_API_KEY=$(grep ^GEMINI_API_KEY= .env | cut -d= -f2-) GEMINI_MODEL=$(grep ^GEMINI_MODEL= .env | cut -d= -f2-) npm run eval:prompts -- --cap 2
 * It writes eval-out/<prompt version>/ (git-ignored) and compares with test/eval/baseline.json when there is one.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { loadEnv, loadPrices } from "../src/config.js";
import { CASES } from "../src/eval/cases.js";
import { estimateUsd, parseArgs } from "../src/eval/cost.js";
import { runEval } from "../src/eval/driver.js";
import { judgeSchema } from "../src/eval/judge.js";
import { modelMismatch, withoutEmpty } from "../src/eval/model.js";
import { resilientJudge, resilientLlm } from "../src/eval/resilient.js";
import { type Baseline, compare, summaryText } from "../src/eval/stats.js";
import { GeminiLlm } from "../src/providers/gemini.js";
import { PROMPT_VERSION } from "../src/providers/prompt-version.js";

const BASELINE = "test/eval/baseline.json";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    process.exit(1);
  }
  const env = loadEnv(withoutEmpty(process.env));
  const prices = loadPrices();
  const cases = args.cases ? CASES.filter((c) => args.cases!.includes(c.id)) : CASES;
  const unknown = (args.cases ?? []).filter((id) => !CASES.some((c) => c.id === id));
  if (unknown.length || !cases.length) {
    console.error(`no such case: ${unknown.join(", ") || "(none selected)"}; the cases are ${CASES.map((c) => c.id).join(", ")}`);
    process.exit(1);
  }
  const estimate = estimateUsd(prices, cases, args.repeats, args.judge);
  console.log(`prompt version ${PROMPT_VERSION}: ${cases.length} cases x ${args.repeats} repeats, judge ${args.judge ? "on" : "off"}; expected cost $${estimate.toFixed(4)} (cap $${args.cap})`);
  if (estimate > args.cap) {
    console.error("the expected cost is over the cap: raise --cap, lower --repeats, or pick --cases");
    process.exit(1);
  }

  const llm = new GeminiLlm(env.GEMINI_API_KEY, env.GEMINI_MODEL);
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  // the id the API reports for the model, not the alias asked for: an alias moves, and the baseline must name what scored it
  let judgeModelSeen = "";
  const rawJudge = args.judge
    ? async (prompt: string): Promise<unknown> => {
        const res = await ai.models.generateContent({ model: env.GEMINI_MODEL, contents: prompt, config: { responseMimeType: "application/json", responseJsonSchema: judgeSchema(), temperature: 0 } });
        if (!judgeModelSeen && res.modelVersion) judgeModelSeen = res.modelVersion;
        return res.text ? JSON.parse(res.text) : null;
      }
    : null;
  const judge = rawJudge ? resilientJudge(rawJudge) : null;

  const out = await runEval({ llm: resilientLlm(llm), judge, cases, repeats: args.repeats, capUsd: args.cap, prices });
  if (out.stoppedByCap) console.warn("stopped at the cap: the last repeat is incomplete, so this run is not a baseline");
  if (args.judge) console.log(`judge scored ${out.judged} of ${out.judged + out.judgeMissing} runs`);
  if (out.aborted) console.warn(`cut short by an error (${out.aborted}): the runs so far are written below, and this run is not a baseline`);

  const dir = join("eval-out", PROMPT_VERSION);
  await mkdir(dir, { recursive: true });
  for (const r of out.runs) await writeFile(join(dir, `${r.caseId}.${r.repeat}.json`), `${JSON.stringify(r, null, 2)}\n`);

  let base: Baseline | null = null;
  try {
    base = JSON.parse(await readFile(BASELINE, "utf8")) as Baseline;
  } catch {
    base = null;
  }
  const judgeModel = judgeModelSeen || env.GEMINI_MODEL;
  const mismatch = base && args.judge ? modelMismatch(base.judgeModel, judgeModel) : null;
  if (mismatch) console.warn(mismatch);
  const text = summaryText(PROMPT_VERSION, out.metrics, base ? compare(out.metrics, base.metrics) : null);
  await writeFile(join(dir, "summary.md"), text);
  console.log(text);
  console.log(`spent about $${out.spentUsd.toFixed(4)} by the estimate; outputs in ${dir}/`);

  if (args.saveBaseline && args.judge && out.judgeMissing > 0) {
    console.warn(`no baseline written: the judge scored only ${out.judged} of ${out.judged + out.judgeMissing} runs, and a baseline without every judge score would hide later judge regressions`);
  } else if (args.saveBaseline && !out.stoppedByCap && !out.aborted) {
    const next: Baseline = { promptVersion: PROMPT_VERSION, judgeModel, repeats: args.repeats, metrics: out.metrics };
    await mkdir("test/eval", { recursive: true });
    await writeFile(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`baseline written to ${BASELINE}: review it, then commit it`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
