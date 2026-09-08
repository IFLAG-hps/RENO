import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const files = {
  backend: '.github/workflows/deploy-backend.yml',
  main: '.github/workflows/main-deploy.yml',
  localstack: '.github/workflows/localstack-test.yml',
  sync: '.github/workflows/sync-fork.yml',
  promote: '.github/workflows/promote-tested-issue-branch.yml'
};

const workflows = {};
for (const [name, file] of Object.entries(files)) {
  workflows[name] = await readFile(file, 'utf8');
}

assert.match(workflows.backend, /- dev/, 'backend: dev push trigger is missing');
assert.match(workflows.backend, /workflow_dispatch:/, 'backend: manual deployment trigger is missing');
assert.match(workflows.backend, /staging:staging/, 'backend: staging branch guard is missing');
assert.match(workflows.backend, /production:main/, 'backend: production branch guard is missing');
assert.match(workflows.backend, /staging\) TARGET=staging/, 'backend: staging push target is missing');
assert.match(workflows.backend, /main\) TARGET=production/, 'backend: production push target is missing');
assert.match(workflows.backend, /Environment=\$DEPLOYMENT_ENVIRONMENT/, 'backend: CloudFormation environment parameter is missing');
assert.match(workflows.backend, /uses: \.\/\.github\/workflows\/localstack-test\.yml/, 'backend: LocalStack test is missing');
assert.match(workflows.backend, /needs: \[prepare, localstack-test\]/, 'backend: test dependency is missing');

assert.match(workflows.localstack, /workflow_call:/, 'LocalStack workflow_call is missing');
assert.match(workflows.backend, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/, 'backend OpenAI key configuration is missing');
assert.match(workflows.main, /workflow_call:/, 'application validation workflow_call is missing');
assert.match(workflows.main, /inputs\.ref \|\| github\.sha/, 'application validation ref input is missing');
assert.match(workflows.sync, /github\.repository == 'IFLAG-hps\/RENO'/, 'fork sync source repository guard is missing');
assert.match(workflows.sync, /secrets\.FORK_REPO_TOKEN/, 'fork sync token configuration is missing');
assert.match(workflows.sync, /DaisukeShirai\/RENO\.git/, 'fork repository target is missing');
assert.match(workflows.sync, /\[1-9\]\*-\*/, 'fork sync issue branch allow-list is missing');
assert.match(workflows.sync, /--force "HEAD:refs\/heads\/\$BRANCH"/, 'fork sync issue mirror update is missing');
assert.match(workflows.promote, /workflow_run:/, 'origin promotion workflow trigger is missing');
assert.match(workflows.promote, /SYNC: Mirror tested issue branches to fork/, 'origin promotion sync dependency is missing');
assert.match(workflows.promote, /github\.event\.workflow_run\.conclusion == 'success'/, 'origin promotion sync success gate is missing');
assert.match(workflows.promote, /uses: \.\/\.github\/workflows\/main-deploy\.yml/, 'origin promotion validation reuse is missing');
assert.match(workflows.promote, /github\.event\.workflow_run\.head_sha/, 'origin promotion validated ref is missing');
assert.match(workflows.promote, /contents: write/, 'origin promotion contents write permission is missing');
assert.match(workflows.promote, /git merge --no-ff "origin\/\$BRANCH"/, 'origin main merge command is missing');
assert.match(workflows.promote, /HEAD:refs\/heads\/main/, 'origin main push is missing');
const samTemplate = await readFile('backend/template.yaml', 'utf8');
assert.match(samTemplate, /Environment:\r?\n    Type: String/, 'SAM environment parameter is missing');
assert.match(samTemplate, /reno-mvp-\$\{Environment\}-users/, 'Cognito user pool environment isolation is missing');
const amplifyConfig = await readFile('amplify.yml', 'utf8');
assert.match(amplifyConfig, /npm ci/, 'Amplify dependency installation is missing');
assert.match(amplifyConfig, /npm run build:react/, 'Amplify React build is missing');
assert.match(amplifyConfig, /baseDirectory: dist/, 'Amplify artifact directory is missing');

console.log('Workflow validation passed: Amplify frontend and AWS backend deployments are separated.');
