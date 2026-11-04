import { discoverClaudeModels } from './claude-model-catalog.ts';
import { discoverCodexModels } from './codex-model-catalog.ts';
import { discoverCursorModels } from './cursor-model-catalog.ts';
import { discoverJunieModels } from './junie-model-catalog.ts';
import { discoverOpencodeModels } from './opencode-model-catalog.ts';
import { RunnerModelCatalog } from './runner-model-catalog.ts';

export function createRunnerModelCatalog(cwd: string): RunnerModelCatalog {
  return new RunnerModelCatalog({
    adapters: {
      claude: { discover: () => discoverClaudeModels({ cwd }) },
      codex: { discover: () => discoverCodexModels({ cwd }) },
      opencode: { discover: () => discoverOpencodeModels({ cwd }) },
      junie: { discover: () => discoverJunieModels({ cwd }) },
      cursor: { discover: () => discoverCursorModels() },
    },
  });
}
