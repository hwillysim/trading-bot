import { replayDatabase } from './index.ts';

function usage() {
  console.error('Usage: node --experimental-strip-types src/replay/cli.ts <database> [--fee-bps N] [--slippage-bps N] [--summary-only]');
}
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) { usage(); process.exit(args.includes('--help') ? 0 : 2); }
const dbPath = args.shift()!;
const summaryOnly = args.includes('--summary-only');
let feeBps = 10, slippageBps = 5;
for (let i=0;i<args.length;i++) {
  const key=args[i];
  if (key === '--summary-only') continue;
  const value=Number(args[++i]);
  if ((key !== '--fee-bps' && key !== '--slippage-bps') || !Number.isFinite(value) || value < 0) {
    usage(); process.exit(2);
  }
  if (key === '--fee-bps') feeBps=value; else slippageBps=value;
}
try {
  const result=replayDatabase(dbPath,{feeBps,slippageBps});
  const output=summaryOnly?{coverage:result.coverage,summary:result.summary}:result;
  console.log(JSON.stringify(output,null,summaryOnly?undefined:2));
}
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1; }
