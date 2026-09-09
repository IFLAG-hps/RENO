import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const files = {
  backend: '.github/workflows/deploy-backend.yml',
  main: '.github/workflows/main-deploy.yml',
  localstack: '.github/workflows/localstack-test.yml',
  frontend: '.github/workflows/frontend-blue-green.yml',
  sync: '.github/workflows/sync-fork.yml',
  promote: '.github/workflows/promote-tested-issue-branch.yml',
  archive: '.github/workflows/archive-closed-issue-branches.yml',
  archiveUnused: '.github/workflows/archive-unused-issue-branches.yml',
  live: '.github/workflows/live-site-e2e.yml'
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
assert.match(workflows.main, /Run backend unit tests/, 'application validation backend unit tests are missing');
assert.match(workflows.main, /test_unit_\*\.py/, 'application validation backend unit test command is missing');
assert.match(workflows.main, /Run React unit tests/, 'application validation React unit tests are missing');
assert.match(workflows.main, /npm run test:unit:react/, 'application validation React unit test command is missing');
assert.match(workflows.main, /description: Git ref to validate/, 'application validation manual ref input is missing');
assert.match(workflows.main, /inputs\.release_id \|\| github\.sha/, 'application validation release run name is missing');
assert.match(workflows.main, /cache: pip/, 'application validation pip cache is missing');
assert.match(workflows.main, /cache: npm/, 'application validation npm cache is missing');
assert.match(workflows.main, /Cache Playwright browsers/, 'application validation Playwright cache is missing');
assert.match(workflows.main, /~\/\.cache\/ms-playwright/, 'application validation Playwright cache path is missing');
assert.match(workflows.localstack, /cache: pip/, 'LocalStack pip cache is missing');
assert.match(workflows.frontend, /DEPLOY: Blue\/green frontend/, 'blue/green frontend workflow is missing');
assert.match(workflows.frontend, /aws amplify start-job/, 'blue/green candidate deployment is missing');
assert.match(workflows.frontend, /gh run view/, 'blue/green CI polling is missing');
assert.match(workflows.frontend, /actions: write/, 'blue/green workflow dispatch permission is missing');
assert.match(workflows.frontend, /workflow_run_id/, 'blue/green dispatched CI run ID is missing');
assert.match(workflows.frontend, /RELEASE_ID/, 'blue/green CI fallback correlation is missing');
assert.match(workflows.frontend, /aws amplify update-domain-association/, 'blue/green domain cutover is missing');
assert.match(workflows.frontend, /Restoring the previous public branch/, 'blue/green rollback is missing');
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
assert.match(workflows.archive, /issues:/, 'closed issue archive trigger is missing');
assert.match(workflows.archive, /types:\s*\n\s+- closed/, 'closed issue event filter is missing');
assert.match(workflows.archive, /workflow_dispatch:/, 'manual closed issue archive trigger is missing');
assert.match(workflows.archive, /issue_number:/, 'manual issue number input is missing');
assert.match(workflows.archive, /gh issue view/, 'closed issue state check is missing');
assert.match(workflows.archive, /archive\/issue-\$\{ISSUE_NUMBER\}/, 'issue archive namespace is missing');
assert.match(workflows.archive, /refs\/heads\/\$archive_branch/, 'archive branch creation is missing');
assert.match(workflows.archive, /git push \"\$remote\" --delete \"\$branch\"/, 'original branch deletion is missing');
assert.match(workflows.archive, /DaisukeShirai\/RENO\.git/, 'fork archive target is missing');
assert.match(workflows.archiveUnused, /schedule:/, 'unused issue branch archive schedule is missing');
assert.match(workflows.archiveUnused, /refs\/heads\/\[1-9\]\*-\*/, 'issue branch scan filter is missing');
assert.match(workflows.archiveUnused, /gh issue view/, 'issue state lookup is missing');
assert.match(workflows.archiveUnused, /issue_state.*CLOSED/, 'closed issue archive gate is missing');
assert.match(workflows.archiveUnused, /archive\/issue-\$\{issue_number\}/, 'scanned issue archive namespace is missing');
assert.match(workflows.live, /schedule:/, 'live-site nightly schedule is missing');
assert.match(workflows.live, /cron: "0 15 \* \* \*"/, 'live-site midnight JST schedule is missing');
assert.match(workflows.live, /reno\.taskra\.jp/, 'live-site production URL is missing');
assert.match(workflows.live, /Upload Playwright report/, 'live-site report upload is missing');
assert.match(workflows.live, /if: always\(\)/, 'live-site report must upload after test failure');
const samTemplate = await readFile('backend/template.yaml', 'utf8');
assert.match(samTemplate, /Environment:\r?\n    Type: String/, 'SAM environment parameter is missing');
assert.match(samTemplate, /reno-mvp-\$\{Environment\}-users/, 'Cognito user pool environment isolation is missing');
const amplifyConfig = await readFile('amplify.yml', 'utf8');
assert.match(amplifyConfig, /npm ci/, 'Amplify dependency installation is missing');
assert.match(amplifyConfig, /npm run build:react/, 'Amplify React build is missing');
assert.match(amplifyConfig, /baseDirectory: dist/, 'Amplify artifact directory is missing');

console.log('Workflow validation passed: Amplify frontend and AWS backend deployments are separated.');
