import type { Rule } from './types.js';

type PresetRule = Omit<Rule, 'preset'>;

const SECRET_PATHS = [
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '!.env.defaults',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  '~/.ssh/**',
  '!~/.ssh/*.pub',
  '!~/.ssh/known_hosts',
  '~/.aws/credentials',
  '~/.config/gcloud/**',
  '~/.azure/**',
  '~/.kube/config',
  '~/.docker/config.json',
  '~/.netrc',
  '~/.git-credentials',
];

const GUARDRAIL_FILES = [
  'polyfence.yaml',
  '.polyfence.yaml',
  '.polyfence/**',
  '~/.config/polyfence/**',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '~/.claude/settings.json',
  '.codex/hooks.json',
  '.codex/config.toml',
  '.codex/rules/**',
  '~/.codex/hooks.json',
  '~/.codex/config.toml',
  '~/.codex/rules/**',
  '.gemini/settings.json',
  '.gemini/policies/**',
  '~/.gemini/settings.json',
  '~/.gemini/policies/**',
  '~/.gemini/config/hooks.json',
  '.agents/hooks.json',
];

const recommended: PresetRule[] = [
  {
    id: 'no-rm-rf-root',
    decision: 'deny',
    reason: 'Recursive delete of /, ~, $HOME, . or * is blocked. Delete specific paths instead.',
    match: {
      command: [
        '/^rm\\s(?:.*\\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\s(?:.*\\s)?(?:\\/|\\/\\*|~|~\\/|~\\/\\*|\\$HOME|\\$HOME\\/|\\$HOME\\/\\*|\\.|\\.\\/|\\.\\/\\*|\\.\\.|\\.\\.\\/|\\*)(?:\\s|$)/',
      ],
    },
  },
  {
    id: 'no-disk-wipe',
    decision: 'deny',
    reason: 'Formatting or overwriting disks is blocked.',
    match: { command: ['/^mkfs(?:\\.\\w+)?\\s/', '/^dd\\s.*\\bof=\\/dev\\//', '/^diskutil\\s+(?:erase\\w*|zeroDisk|secureErase|partitionDisk)\\b/'] },
  },
  {
    id: 'no-force-push',
    decision: 'deny',
    reason: 'Force-pushing rewrites shared history. Push a new commit, or ask the human to force-push.',
    match: {
      command: ['/^git\\s+push\\b(?:.*\\s)?(?:--force|-[a-zA-Z]*f[a-zA-Z]*)(?:\\s|$)/', '/^git\\s+push\\b.*\\s\\+\\S+/'],
    },
  },
  {
    id: 'ask-force-with-lease',
    decision: 'ask',
    reason: 'Force-push with lease still rewrites remote history.',
    match: { command: ['/^git\\s+push\\b.*\\s--force-(?:with-lease|if-includes)\\b/'] },
  },
  {
    id: 'no-hook-bypass',
    decision: 'deny',
    reason: 'Skipping git hooks hides failing checks. Fix the failure instead of using --no-verify.',
    match: {
      command: ['/^git\\s+(?:commit|push|merge|rebase|am|cherry-pick)\\b.*\\s--no-verify(?:\\s|$)/', '/^git\\s+commit\\b(?:.*\\s)?-[a-zA-Z]*n[a-zA-Z]*(?:\\s|$)/'],
    },
  },
  {
    id: 'no-husky-bypass',
    decision: 'deny',
    reason: 'Disabling hooks with HUSKY=0 or SKIP= hides failing checks.',
    match: { commandLine: ['/(?:^|[\\s;&|(])(?:HUSKY=0|SKIP=\\S+\\s+git\\b)/'] },
  },
  {
    id: 'ask-destructive-git',
    decision: 'ask',
    reason: 'This git command can throw away uncommitted or unpushed work.',
    match: {
      command: [
        'git reset --hard *',
        '/^git\\s+clean\\b.*\\s-[a-zA-Z]*f/',
        'git checkout -- *',
        'git checkout .',
        '/^git\\s+restore\\s+(?!.*--staged)/',
        'git branch -D *',
        'git stash drop *',
        'git stash clear *',
        '/^git\\s+push\\b.*\\s(?:--delete|-d)\\s/',
        '/^git\\s+push\\s+\\S+\\s+:\\S+/',
        'git filter-branch *',
        'git update-ref -d *',
      ],
    },
  },
  {
    id: 'no-pipe-to-shell',
    decision: 'deny',
    reason: 'Piping a download straight into a shell runs unreviewed code. Download, inspect, then run.',
    match: {
      commandLine: [
        '/\\b(?:curl|wget|fetch|iwr|Invoke-WebRequest)\\b[^|;&]*\\|\\s*(?:sudo\\s+)?(?:ba|z|da|k|fi)?sh\\b/',
        '/\\b(?:ba|z)?sh\\s+(?:-c\\s+)?["\']?(?:\\$\\(|<\\()\\s*(?:curl|wget)\\b/',
      ],
    },
  },
  {
    id: 'protect-secrets',
    decision: 'deny',
    reason: 'Secrets and credentials are off-limits to agents. Ask the human for the specific value you need.',
    match: { path: SECRET_PATHS },
  },
  {
    id: 'protect-guardrails',
    decision: 'deny',
    reason: 'Agents may not edit their own guardrails or agent settings. Ask the human to make this change.',
    match: { writePath: GUARDRAIL_FILES },
  },
  {
    id: 'ask-outside-workspace',
    decision: 'ask',
    reason: 'This writes outside the project directory.',
    match: { outsideWorkspace: true },
  },
  {
    id: 'ask-sudo',
    decision: 'ask',
    reason: 'Commands with elevated privileges need a human.',
    match: { commandLine: ['/(?:^|[\\s;&|(])(?:sudo|doas)\\s/'] },
  },
  {
    id: 'ask-world-writable',
    decision: 'ask',
    reason: 'Making files world-writable is rarely what you want.',
    match: { command: ['/^chmod\\s+(?:-R\\s+)?(?:0?777|a\\+rwx|o\\+w)\\b/'] },
  },
  {
    id: 'ask-publish',
    decision: 'ask',
    reason: 'Publishing a release is visible to the world and hard to undo.',
    match: {
      command: [
        'npm publish *',
        'pnpm publish *',
        'yarn publish *',
        'yarn npm publish *',
        'bun publish *',
        'cargo publish *',
        'twine upload *',
        'poetry publish *',
        'uv publish *',
        'gem push *',
        'docker push *',
        'gh release create *',
        'vsce publish *',
      ],
    },
  },
  {
    id: 'ask-infra-changes',
    decision: 'ask',
    reason: 'This changes or destroys real infrastructure.',
    match: {
      command: [
        'terraform apply *',
        'terraform destroy *',
        'tofu apply *',
        'tofu destroy *',
        'pulumi up *',
        'pulumi destroy *',
        'kubectl delete *',
        'kubectl apply *',
        'helm uninstall *',
        'helm upgrade *',
        'aws s3 rm *',
        'aws s3 rb *',
        '/^aws\\s+\\S+\\s+(?:delete|terminate|remove)-/',
        '/^gcloud\\s.*\\sdelete\\b/',
        '/^(?:fly|flyctl)\\s+(?:destroy|apps\\s+destroy)\\b/',
      ],
    },
  },
  {
    id: 'ask-db-destroy',
    decision: 'ask',
    reason: 'This can destroy database data.',
    match: {
      commandLine: [
        '/\\b(?:DROP\\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\\s+TABLE)\\b/i',
        '/\\bprisma\\s+(?:migrate\\s+reset|db\\s+push\\s+.*--force-reset)\\b/',
        '/\\b(?:dropdb|dropuser)\\s/',
        '/\\bFLUSH(?:ALL|DB)\\b/i',
        '/\\brails\\s+db:(?:drop|reset)\\b/',
      ],
    },
  },
];

const strict: PresetRule[] = [
  ...recommended,
  {
    id: 'ask-install-deps',
    decision: 'ask',
    reason: 'New dependencies are a supply-chain decision for a human.',
    match: {
      command: [
        '/^npm\\s+(?:install|i|add)\\s+(?!-)\\S/',
        '/^(?:pnpm|yarn|bun)\\s+add\\s/',
        '/^(?:pip|pip3|uv\\s+pip)\\s+install\\s/',
        'uv add *',
        'poetry add *',
        'cargo add *',
        'go get *',
        'gem install *',
        'brew install *',
      ],
    },
  },
  {
    id: 'ask-git-push',
    decision: 'ask',
    reason: 'Pushing makes changes visible to others.',
    match: { command: ['git push *'] },
  },
  {
    id: 'ask-network-fetch',
    decision: 'ask',
    reason: 'Fetching from the network is gated in strict mode.',
    match: { tool: 'fetch' },
  },
];

export const PRESETS: Record<string, PresetRule[]> = { recommended, strict };
