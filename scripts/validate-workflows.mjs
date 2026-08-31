import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const files = {
  main: '.github/workflows/main-deploy.yml',
  sync: '.github/workflows/sync-fork.yml'
};

const workflows = {};
for (const [name, file] of Object.entries(files)) {
  workflows[name] = await readFile(file, 'utf8');
}

assert.match(workflows.main, /github\.ref == 'refs\/heads\/main'/, 'main-deploy: main branch restriction is missing');
assert.match(workflows.main, /LocalStack tests/, 'main-deploy: LocalStack test is missing');
assert.match(workflows.main, /Smoke-test deployed API/, 'main-deploy: deployed API smoke test is missing');
assert.match(workflows.main, /Run frontend E2E against deployed API/, 'main-deploy: deployed frontend E2E is missing');
assert.match(workflows.main, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/, 'main-deploy: OpenAI key configuration is missing');
assert.match(workflows.sync, /workflow_run:/, 'fork sync workflow trigger is missing');
assert.match(workflows.sync, /github\.event\.workflow_run\.conclusion == 'success'/, 'fork sync success gate is missing');
assert.match(workflows.sync, /github\.repository == 'IFLAG-hps\/RENO'/, 'fork sync source repository guard is missing');
assert.match(workflows.sync, /secrets\.FORK_REPO_TOKEN/, 'fork sync token configuration is missing');
assert.match(workflows.sync, /DaisukeShirai\/RENO\.git/, 'fork repository target is missing');
const amplifyConfig = await readFile('amplify.yml', 'utf8');
assert.match(amplifyConfig, /npm ci/, 'Amplify dependency installation is missing');
assert.match(amplifyConfig, /npm run build:react/, 'Amplify React build is missing');
assert.match(amplifyConfig, /baseDirectory: dist/, 'Amplify artifact directory is missing');

console.log('Workflow validation passed: Amplify frontend and AWS backend deployments are separated.');
