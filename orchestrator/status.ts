import { loadConfig } from './config.ts';
import { GitClient } from './git.ts';
import { createCore, resolveRepoFromOrigin } from './runtime.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const git = new GitClient();
  const repo = config.repo ?? (await resolveRepoFromOrigin(git, config.repoDir));
  const core = createCore(config, repo);
  const text = await core.commands.status();
  process.stdout.write(`${text}\n`);
}

void main();
